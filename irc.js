'use strict';

const fs = require('fs');
const path = require('path');
const config = require('config');
const irc = require('irc-framework');
const inq = require('inquirer');
const Redis = require('ioredis');
const sqlite3 = require('sqlite3');
const redisClient = new Redis(config.redis.url);
const { PREFIX, CTCPVersion, scopedRedisClient, resolveNameForDiscord } = require('./util');
const LiveNicks = require('./irc/liveNicks');
let ipcMessageHandler = require('./irc/ipcMessage');
let genEvHandler = require('./irc/genEvHandler');
const {
  msgRxCounter,
  msgRxCounterWithType,
  eventsCounterWithType,
  msgRxCounterByTarget
} = require('./irc/promMetrics');
const logger = require('./logger');
logger('irc');

const connectedIRC = {
  bots: {},
  users: {}
};

const msgHandlers = {};

const stats = {
  upSince: new Date(),
  errors: 0,
  discordReconnects: 0,
  latency: {}
};

let allowsBotReconnect = false;
const chanPrefixes = {};
const children = {};

let _haveJoinedChannels = false;
const haveJoinedChannels = (set) => {
  if (set !== undefined && set !== null) {
    _haveJoinedChannels = !!set;
  }

  return _haveJoinedChannels;
};

async function connectIRCClient (connSpec) {
  if (connSpec.account && !connSpec.account.password) {
    const { password } = await inq.prompt({
      type: 'password',
      name: 'password',
      message: `Enter nickserv password for ${connSpec.nick}@${connSpec.host}`
    });

    connSpec.account.password = password;
  }

  if (connSpec.client_certificate && connSpec.client_certificate.fromFile) {
    const certFile = (await fs.promises.readFile(path.resolve(connSpec.client_certificate.fromFile))).toString('utf8');
    const boundaryRe = /-{5}(BEGIN|END)\s(PRIVATE\sKEY|CERTIFICATE)-{5}/g;
    const elems = {
      private_key: {},
      certificate: {}
    };

    for (const match of certFile.matchAll(boundaryRe)) {
      const [boundStr, state, type] = match;
      const typeXform = type.toLowerCase().replace(/\s+/g, '_');

      if (state === 'BEGIN') {
        if (type === 'PRIVATE KEY' && match.index !== 0) {
          throw new Error('pk start');
        }

        elems[typeXform].start = match.index;
      } else if (state === 'END') {
        if (elems[typeXform].start === undefined) {
          throw new Error('bad start!');
        }

        elems[typeXform] = certFile
          .substring(elems[typeXform].start, match.index + boundStr.length);
      }
    }

    if (Object.values(elems).some(x => !x)) {
      throw new Error('bad cert parse');
    }

    connSpec.client_certificate = elems;
  }

  const ircClient = new irc.Client();

  const regPromise = new Promise((resolve, reject) => {
    ircClient.on('registered', resolve.bind(null, ircClient));
  });

  ircClient.on('debug', console.debug);
  connSpec.version = CTCPVersion;
  scopedRedisClient((client, pfx) => client.publish(pfx, JSON.stringify({
    type: 'irc:connecting',
    data: { network: connSpec.host }
  })));
  ircClient.connect(connSpec);
  return regPromise;
}

async function main () {
  console.log(`${PREFIX} IRC bridge started.`);
  const pubClient = new Redis(config.redis.url);
  const c2Listener = new Redis(config.redis.url); // TODO: use this more!
  const specServers = {};
  const ircLogPath = path.resolve(config.irc.log.path);

  if (!fs.existsSync(ircLogPath)) {
    fs.mkdirSync(ircLogPath);
  }

  c2Listener.on('pmessage', (_, chan, msg) => {
    const [, subroute] = chan.split('::');
    const [srEntity, srType] = subroute?.split(':');

    if (srEntity === 'irc') {
      if (srType === 'reload') {
        delete require.cache[require.resolve('./irc/ipcMessage')];
        delete require.cache[require.resolve('./irc/genEvHandler')];

        ipcMessageHandler = require(require.resolve('./irc/ipcMessage'));
        genEvHandler = require(require.resolve('./irc/genEvHandler'));

        scopedRedisClient((rc, pfx) => rc.publish(pfx, JSON.stringify({
          type: '__c2::irc:reload',
          data: 'response'
        })));

        console.log('Reloaded ipcMessage and genEvHandler');
      } else if (srType === 'debug_on') {
        logger.enableLevel('debug');
        console.log('Debug logging ENABLED via C2 message');
      } else if (srType === 'debug_off') {
        logger.disableLevel('debug');
        console.log('Debug logging DISABLED via C2 message');
      } else {
        console.warn(`Unhandled IRC C2 "${srType}"`, msg);
      }
    }
  });

  c2Listener.psubscribe(PREFIX + ':__c2::*');

  const disconnectedBots = {};
  redisClient.on('message', (...a) => {
    return ipcMessageHandler({
      connectedIRC,
      msgHandlers,
      specServers,
      chanPrefixes,
      stats,
      haveJoinedChannels,
      children,
      allowsBotReconnect: () => allowsBotReconnect,
      disconnectedBots,
      createNewChanSpec: (name, id, parentId) => ({
        name,
        id,
        parentId,
        parent: parentId,
        liveNicks: new LiveNicks()
      })
    }, ...a);
  });

  await redisClient.subscribe(PREFIX);

  console.log('Connected to Redis.');
  console.log(`Connecting ${Object.entries(config.irc.registered).length} IRC networks...`);

  const readyData = [];
  for (const [host, serverObj] of Object.entries(config.irc.registered)) {
    const { port, user } = serverObj;

    if (!host || !port) {
      throw new Error('bad server spec', serverObj);
    }

    if (connectedIRC.bots[host]) {
      throw new Error('duplicate server spec', serverObj);
    }

    const spec = {
      host,
      port,
      ...user
    };

    console.log(`Connecting '${spec.nick}' to ${host}...`);
    connectedIRC.bots[host] = await connectIRCClient(spec);

    // assumes the parent path already exists!
    // Global buffer for failed SQLite insertions (shared across hosts)
    if (!global.sqliteBuffer) {
      global.sqliteBuffer = {};
    }
    const BUFFER_RETRY_INTERVAL_MS = 5000; // 5 seconds

    // Initialize a retrier for each SQLite file
    const initRetryBuffer = (sqliteFilePath) => {
      if (!global.sqliteBuffer[sqliteFilePath]) {
        console.warn(`Initializing SQLite buffer for ${sqliteFilePath}`);
        global.sqliteBuffer[sqliteFilePath] = {
          entries: [],
          retryIntervalId: setInterval(() => {
            processSqliteBuffer(sqliteFilePath);
          }, BUFFER_RETRY_INTERVAL_MS)
        };
      }
      return global.sqliteBuffer[sqliteFilePath];
    };

    // Process buffered entries for a specific SQLite file
    const processSqliteBuffer = async (sqliteFilePath) => {
      const buffer = global.sqliteBuffer[sqliteFilePath];
      if (!buffer || buffer.entries.length === 0) {
        return;
      }

      // Create a copy of the buffer entries and clear the buffer
      const entriesToProcess = [...buffer.entries];
      buffer.entries = [];

      let db;
      try {
        db = new sqlite3.Database(sqliteFilePath);
        const successfulEntries = [];
        const failedEntries = [];

        // Process each entry
        for (const entry of entriesToProcess) {
          try {
            await new Promise((resolve, reject) => {
              db.run('INSERT INTO channel VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                entry.parsed.type, entry.parsed.from_server ? 1 : 0, entry.parsed.nick,
                entry.parsed.ident, entry.parsed.hostname, entry.parsed.target,
                entry.parsed.message, entry.parsed.__drcNetwork,
                entry.parsed?.__drcIrcRxTs ?? -1, entry.parsed?.__drcLogTs ?? -1,
                JSON.stringify(entry.parsed.tags), null, (err) => {
                  if (err) {
                    reject(err);
                  } else {
                    resolve();
                  }
                });
            });
            successfulEntries.push(entry);
          } catch (e) {
            // If we still get a SQLITE_BUSY error, add back to the failed entries
            if (e.code === 'SQLITE_BUSY') {
              failedEntries.push(entry);
            } else {
              console.error(`Error reinserting buffered entry: ${e.message}`, e, entry.parsed);
            }
          }
        }

        // Put the failed entries back in the buffer
        if (failedEntries.length > 0) {
          buffer.entries.push(...failedEntries);
          console.log(`Re-buffering ${failedEntries.length} entries for ${sqliteFilePath} (${buffer.entries.length} total in buffer)`);
        }

        if (successfulEntries.length > 0) {
          console.log(`Successfully inserted ${successfulEntries.length} buffered entries for ${sqliteFilePath}`);
        }
      } catch (e) {
        // If we can't open the database, re-buffer all entries
        buffer.entries.push(...entriesToProcess);
        console.error(`Failed to process buffer for ${sqliteFilePath}:`, e);
      } finally {
        if (db) {
          db.close();
        }
      }
    };

    const logDataToSqlite = async (prefixPath, parsed) => {
      const sqliteFilePath = `${prefixPath}.sqlite3`;
      let db;
      try {
        /* have to do this because:
            > try { new sqlite3.Database('./dne', sqlite3.OPEN_READWRITE) } catch (e) { console.log(e) }
            Database {}
            > Uncaught [Error: SQLITE_CANTOPEN: unable to open database file] {
              errno: 14,
              code: 'SQLITE_CANTOPEN'
            }
            > node[126476]: ../src/node_util.cc:242:static void node::util::WeakReference::DecRef(const v8::FunctionCallbackInfo<v8::Value>&): Assertion `(weak_ref->reference_count_) >= (1)' failed.
            1: 0xaf3270 node::Abort() [node]
            2: 0xaf32e4  [node]
            3: 0xb952c4 node::util::WeakReference::DecRef(v8::FunctionCallbackInfo<v8::Value> const&) [node]
            4: 0xd28550  [node]
            5: 0xd295ac v8::internal::Builtin_HandleApiCall(int, unsigned long*, v8::internal::Isolate*) [node]
            6: 0x15474ac  [node]
            Aborted (core dumped)
        */
        await fs.promises.stat(sqliteFilePath);
      } catch (e) {
        if (e.code === 'ENOENT') {
          db = await (new Promise((resolve, reject) => {
            (new sqlite3.Database(sqliteFilePath))
              .run('CREATE TABLE channel (type TEXT, from_server INTEGER, nick TEXT, ' +
              'ident TEXT, hostname TEXT, target TEXT, message TEXT, __drcNetwork TEXT, ' +
              '__drcIrcRxTs INTEGER, __drcLogTs INTEGER, tags TEXT, extra TEXT)',
              (err) => {
                if (err) {
                  return reject(err);
                }
                console.log(`Created anew: ${sqliteFilePath}`);
                resolve(db);
              });
          }));
        }
      }

      if (!db) {
        try {
          db = new sqlite3.Database(sqliteFilePath);
        } catch (e) {
          console.error('DB open failed!', sqliteFilePath, e);
          return;
        }
      }

      try {
        const result = await new Promise((resolve, reject) => {
          db.run('INSERT INTO channel VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            parsed.type, parsed.from_server ? 1 : 0, parsed.nick, parsed.ident, parsed.hostname,
            parsed.target, parsed.message, parsed.__drcNetwork, parsed?.__drcIrcRxTs ?? -1,
            parsed?.__drcLogTs ?? -1, JSON.stringify(parsed.tags), null, (err) => {
              if (err) {
                return reject(err);
              }
              resolve(parsed);
            });
        });
        db.close();
        return result;
      } catch (err) {
        db.close();

        // If database is locked, buffer the entry for later
        if (err.code === 'SQLITE_BUSY') {
          const buffer = initRetryBuffer(sqliteFilePath);
          buffer.entries.push({ prefixPath, parsed });
          console.warn(`SQLite database locked! Buffered entry for ${sqliteFilePath} (${buffer.entries.length} total in buffer)`);
          return parsed; // Return parsed to indicate we've handled it (buffered)
        }

        throw err; // Rethrow any other errors
      }
    };

    const logDataToFile = (fileName, data, { isNotice = false, pathExtra = [], isMessage = false, isEvent = false } = {}) => {
      const chanFileDir = path.join(...[ircLogPath, host, ...pathExtra]);
      const chanFilePath = path.join(chanFileDir, fileName);

      fs.stat(chanFileDir, async (err, _stats) => {
        try {
          if (err && err.code === 'ENOENT') {
            console.log(`Making channel file dir ${chanFileDir}`);
            await fs.promises.mkdir(chanFileDir, { recursive: true });
          }

          const lData = Object.assign({}, data, {
            __drcLogTs: Number(new Date())
          });

          if (!isEvent) {
            logDataToSqlite(chanFilePath, lData)
              .catch(async (e) => {
                // Last-ditch effort to persist *somewhere* on disk ("JSON-L" format)
                console.error(chanFilePath, 'logDataToSqlite FAILED', e, lData);
                const fh = await fs.promises.open(chanFilePath, 'a');
                await fh.write(JSON.stringify(lData) + '\n');
                fh.close();
              });
          } else {
            const fh = await fs.promises.open(chanFilePath, 'a');
            await fh.write(JSON.stringify(lData) + '\n');
            fh.close();
          }
        } catch (e) {
          if (e.code !== 'EEXIST') {
            console.error(`logDataToFile(${fileName}) failed: ${e}`);
            console.debug(e, data);
          }
        }
      });
    };

    const channelUserModifyingEvents = ['quit', 'kick', 'join', 'part', 'nick'];
    async function adjustChannelUsersOnEvent (host, event, data) {
      if (!channelUserModifyingEvents.includes(event)) {
        return;
      }

      if (!specServers[host]) {
        console.error(`adjustChannelUsersOnEvent(${host}, ${event}, ->) called before specServers[${host}] initialized!`, data);
        return;
      }

      let { channel, nick } = data;
      let chanSpec;

      if (channel) {
        channel = await resolveNameForDiscord(host, channel);
        const chanSpecs = specServers[host].channels?.filter(x => x.name === channel);

        if (!chanSpecs) {
          console.error(`No chan specs for ${host}/${channel}?!`);
        }

        if (chanSpecs.length > 0) {
          [chanSpec] = chanSpecs;
        }

        if (chanSpecs.length > 1) {
          console.error(`Duplicate channel specs found for ${host}/${channel}, full list:`, chanSpecs);
          pubClient.publish(PREFIX, JSON.stringify({
            type: 'irc:warning:duplicateChannelSpecs',
            data: { host, channel, chanSpecs }
          }));
        }
      }

      try {
        if (event === 'join') {
          console.debug(`<LIVE NICKS> ADD      event=${event} channel=${chanSpec.name} nick=${nick}`);
          chanSpec.liveNicks.add(nick);
        } else if (['part', 'kick'].includes(event)) {
          console.debug(`<LIVE NICKS> DEL      event=${event} channel=${chanSpec.name} nick=${nick}`);
          chanSpec.liveNicks.delete(nick);
        } else if (event === 'quit') {
          // have to find _all_ channels where `nick` was!
          for (const { liveNicks, name } of specServers[host].channels) {
            if (liveNicks.has(nick)) {
              console.debug(`<LIVE NICKS> HAS/DEL  event=${event} channel=${name} nick=${nick}`);
              liveNicks.delete(nick);
            }
          }
        } else if (event === 'nick') {
          const { new_nick } = data; // eslint-disable-line camelcase
          for (const { liveNicks, name } of specServers[host].channels) {
            if (liveNicks.has(nick)) {
              console.debug(`<LIVE NICKS> HAS/SWP  event=${event} channel=${name} nick=${nick} new_nick=${new_nick}`); // eslint-disable-line camelcase
              liveNicks.swap(nick, new_nick);
            }
          }
        }

        console.info(`Channel modifying event '${event}' on ${host} for ${nick} in ${channel} / ${chanSpec?.name}`);
      } catch (e) {
        console.error('adjustChannelUsersOnEvent event handling loop failed: no chanSpec for an event that needs it?');
        console.error({ host, event, data, chanSpec });
        console.error(e);
      }
    }

    ['quit', 'reconnecting', 'close', 'socket close', 'kick', 'ban', 'join',
      'unknown command', 'channel info', 'topic', 'part', 'invited', 'tagmsg',
      'ctcp response', 'ctcp request', 'wallops', 'nick', 'nick in use', 'nick invalid',
      'whois', 'whowas', 'motd', 'info', 'help', 'mode', 'loggedin', 'account']
      .forEach((ev) => {
        connectedIRC.bots[host].on(ev, async (data) => {
          adjustChannelUsersOnEvent(host, ev, data);
          eventsCounterWithType.inc({ host, event: ev });
          return genEvHandler(host, ev, data, {
            logDataToFile
          });
        });
      });

    connectedIRC.bots[host].on('socket close', () => {
      if (!disconnectedBots[host]) {
        delete specServers[host];
        disconnectedBots[host] = new Date();
        console.warn(`IRC socket closed on ${host}`);

        connectedIRC.bots[host].on('motd', () => {
          console.log(`IRC ${host} reconnected after ${new Date() - disconnectedBots[host]}`);
          delete disconnectedBots[host];
          pubClient.publish(PREFIX, JSON.stringify({
            type: 'irc:ready',
            data: {
              readyData: [{
                network: host,
                nickname: spec.nick,
                userModes: connectedIRC.bots[host].user.modes
              }]
            }
          }));
        });
      }
    });

    connectedIRC.bots[host].on('pong', (data) => {
      const nowNum = Number(new Date());
      const splitElems = data.message.split('-');

      if (splitElems.length > 1) {
        const num = Number(splitElems[1]);
        if (!Number.isNaN(num)) {
          stats.latency[host] = nowNum - num;
          console.info(`${host} PONG latency: ${stats.latency[host]}ms`);

          if (splitElems[0].indexOf('drc') === 0) {
            pubClient.publish(PREFIX, JSON.stringify({
              type: 'irc:pong',
              data: {
                __drcNetwork: host,
                latencyToIRC: stats.latency[host],
                ...data
              }
            }));
          }
        }
      }
    });

    const noticePubClient = new Redis(config.redis.url);
    connectedIRC.bots[host].on('message', (data) => {
      console.debug('RAW IRC MESSAGE:', data);
      data.__drcIrcRxTs = Number(new Date());
      data.__drcNetwork = host;

      if (data.type === 'notice' && data.target && !data.from_server && msgHandlers[host]?.[data.target.toLowerCase()]) {
        console.debug(`BAD CLIENT! ${data.nick} sent 'notice' to ${data.target}/${host} when they meant 'privmsg'. Switching it for them...`, data);
        data.type = 'privmsg';
      }

      const isNotice = data.target === spec.nick || (data.type === 'notice' && data.from_server);

      msgRxCounter.inc({ host });
      msgRxCounterWithType.inc({ host, type: data.type });
      msgRxCounterByTarget.inc({ host, target: data.target });

      if (config.irc.log.channelsToFile) {
        const fName = isNotice && data.target === config.irc.registered[host].user.nick /* XXX:really need to keep LIVE track of our nick!! also add !nick DUH */ ? data.nick : data.target;
        logDataToFile(fName, data, { isNotice, isMessage: true });
      }

      if (isNotice) {
        noticePubClient.publish(PREFIX, JSON.stringify({
          type: 'irc:notice',
          data
        }));
        return;
      }

      const handler = msgHandlers[host]?.[data.target.toLowerCase()];

      if (!handler) {
        // IIRC this is expected for aliveCheck bots? seriously gotta untangle that bullshit...
        return;
      }

      const { resName, channel, chanPubClient } = handler;

      if (!resName || !channel || !chanPubClient) {
        throw new Error('bad handler', resName, channel);
      }

      chanPubClient.publish(channel, JSON.stringify({
        type: 'irc:message',
        data
      }));
    });

    console.log(`Connected registered IRC bot user ${spec.nick} to ${host}`);
    console.debug('Connected user', connectedIRC.bots[host].user);
    console.debug('Connected network', connectedIRC.bots[host].network);
    readyData.push({
      network: host,
      nickname: spec.nick,
      userModes: connectedIRC.bots[host].user.modes
    });
  }

  const heartbeatHandle = setInterval(async () => {
    await scopedRedisClient(async (rc, pfx) => {
      await rc.publish(pfx + ':heartbeats:irc', JSON.stringify({
        type: 'irc:heartbeat',
        data: Number(new Date())
      }));
    });
  }, config.irc.heartbeatFrequencyMs);

  process.on('SIGINT', async () => {
    clearTimeout(heartbeatHandle);

    // Clean up all SQLite buffer retry intervals
    if (global.sqliteBuffer) {
      for (const [sqlitePath, bufferData] of Object.entries(global.sqliteBuffer)) {
        if (bufferData.retryIntervalId) {
          clearInterval(bufferData.retryIntervalId);
          console.log(`Cleared retry interval for ${sqlitePath}`);
        }
      }
    }

    // Disconnect IRC bots
    for (const [host, hostBotData] of Object.entries(connectedIRC.bots)) {
      console.log(`quitting ${host}`);
      let res;
      const prom = new Promise((resolve, reject) => { res = resolve; });
      hostBotData.on('close', res);
      hostBotData.quit('Quit.');
      await prom;
      console.log(`closed ${host}`);
    }

    pubClient.publish(PREFIX, JSON.stringify({ type: 'irc:exit' }));
    console.log('Done!');
    process.exit();
  });

  console.log('Ready!');
  pubClient.publish(PREFIX, JSON.stringify({ type: 'irc:ready', data: { readyData } }));
  allowsBotReconnect = true;
}

main();
