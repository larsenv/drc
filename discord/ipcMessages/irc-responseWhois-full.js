'use strict';

const {
  fmtDuration,
  ipInfo,
  scopedRedisClient,
  searchLogs,
  userLastSeen,
  userFirstSeen
} = require('../../util');
const { formatKVs, simpleEscapeForDiscord } = require('../common');
const userCommands = require('../userCommands');
const { MessageEmbed } = require('discord.js');
const { fqUrlFromPath } = require('../../util');
const { nanoid } = require('nanoid');
const marked = require('marked');

const logsSearch = async (network, d, aliases = []) => {
  const lookups = [d.actual_ip, d.actual_hostname, d.hostname].filter(Boolean);
  const queryOptsTmpl = { distinct: true, strictStrings: true, columns: 'ident,nick,hostname' };
  if (!aliases.length && d.nick) {
    aliases.push(d.nick);
  }

  const logsSearchRes = [];

  if (d.ident && d.ident.length > 2) {
    const identSearch = await searchLogs(network, Object.assign({ ident: d.ident }, queryOptsTmpl));
    if (identSearch && identSearch.totalLines > 0) {
      logsSearchRes.push(identSearch.searchResults);
    }
  }

  for (const host of lookups.filter(Boolean)) {
    const hostSearch = await searchLogs(network, Object.assign({ host }, queryOptsTmpl));
    if (hostSearch && hostSearch.totalLines > 0) {
      logsSearchRes.push(hostSearch.searchResults);
    }
  }

  for (const alias of aliases) {
    const aliasSearch = await searchLogs(network, Object.assign({ nick: alias }, queryOptsTmpl));
    if (aliasSearch && aliasSearch.totalLines > 0) {
      logsSearchRes.push(aliasSearch.searchResults);
    }
  }

  const seenChannels = logsSearchRes.reduce((accSet, srObj) => {
    Object.keys(srObj).forEach((chan) => accSet.add(chan));
    return accSet;
  }, new Set());

  const uniqSearchRes = logsSearchRes.reduce((accObj, srObj) => {
    Object.values(srObj).forEach((objList) => objList.forEach((intObj) => Object.entries(intObj).forEach(([k, v]) => accObj[k]?.add(v))));
    return accObj;
  }, {
    hostname: new Set(),
    ident: new Set(),
    nick: new Set()
  });

  return {
    logsSearchRes,
    seenChannels: [...seenChannels],
    uniqSearchRes: {
      hostname: [...uniqSearchRes.hostname],
      ident: [...uniqSearchRes.ident],
      nick: [...uniqSearchRes.nick]
    }
  };
};

// Function to add logs search results to an embed
const addLogsSearchToEmbed = (searchResults, embed) => {
  const { seenChannels, uniqSearchRes } = searchResults;

  [
    ['spoken in channels:', seenChannels.map(simpleEscapeForDiscord).join(', ').substring(0, 1023)],
    ['appeared as nicks:', uniqSearchRes.nick.map(simpleEscapeForDiscord).join(', ').substring(0, 1023)],
    ['connected with idents:', uniqSearchRes.ident.map(simpleEscapeForDiscord).join(', ').substring(0, 1023)],
    ['connected from hostnames:', uniqSearchRes.hostname.map(simpleEscapeForDiscord).join(', ').substring(0, 1023)]
  ]
    .forEach(([title, renderedStr]) => {
      if (renderedStr.length) {
        embed.addField(title, renderedStr);
      }
    });
};

module.exports = async function (parsed, context) {
  const whoisRespStart = process.hrtime.bigint();
  const {
    client,
    sendToBotChan,
    runOneTimeHandlers
  } = context;
  const d = parsed.data?.whoisData;
  console.debug('irc-RF-whois data', d, parsed);

  if (!d) {
    console.error('bad!');
    return;
  }

  console.log('WHOIS OPTS', parsed.data?.requestData?.options);
  const msgChan = client.channels.cache.get(parsed.data?.requestData?.channel);
  const network = d.__drcNetwork;

  // Function for sending embeds
  const localSender = async (embed) => {
    if (msgChan) {
      return msgChan.send({ embeds: [embed] });
    } else {
      return sendToBotChan(embed, true);
    }
  };

  // Function for sending plain text
  const sendText = async (text) => {
    if (msgChan) {
      return msgChan.send(text);
    } else {
      return sendToBotChan(text);
    }
  };

  // so they don't show up in the output...
  delete d.__drcNetwork;
  delete d._orig;

  const lookupHost = d.actual_ip || d.actual_hostname || d.hostname;
  const ipInf = await ipInfo(lookupHost);

  const nickTracking = await userCommands('nicks');
  const ident = `${d.ident}@${d.hostname}`;

  // let hostMatchProcTime;
  const moreEmbeds = [];
  const embed = new MessageEmbed()
    .setColor('#2c759c')
    .setTitle(`WHOIS \`${d.nick}\` on \`${network}\`?`);
  const notes = await userCommands('notes')(Object.assign({
    options: parsed.data?.requestData?.options
  }, context), ...parsed.data?.requestData?.options._);

  if (d.error) {
    embed.setDescription('Nickname not found!');
    const logsResults = await logsSearch(network, d);
    addLogsSearchToEmbed(logsResults, embed);
    // Store results for potential HTML generation
    parsed.data._cachedLogsResults = logsResults;
    if (d.nick) {
      const lastSeens = await userLastSeen(network, d);
      if (lastSeens.length) {
        const lsEmbed = new MessageEmbed()
          .setColor('#2c759c')
          .setTitle(`Last seen info for \`${d.nick}\` on \`${network}\``);

        for (const [chan, date] of lastSeens) {
          lsEmbed.addField(date, `in ${chan}`);
        }

        moreEmbeds.push(lsEmbed);
      }
    }
  } else {
    embed.setDescription(formatKVs(d));

    if (ipInf) {
      embed.addField(`IP info for \`${lookupHost}\`:`, formatKVs(ipInf));
    }

    if (parsed.data?.requestData?.options.userFirstSeen) {
      const firstSeens = await userFirstSeen(network, d);
      if (firstSeens.length) {
        const [[chan, date]] = firstSeens;
        embed.addField('First seen on network:', `**${date}** in **${chan}**\n`);
      }
    }

    if (parsed.data?.requestData?.options.full) {
      let lookups = [d.actual_ip, d.actual_hostname, d.hostname];
      let lookupSet = new Set(lookups);

      const aliasesEmbed = new MessageEmbed()
        .setColor('#2c759c')
        .setTitle(`Aliases of \`${d.nick}\` on \`${network}\``);
      moreEmbeds.push(aliasesEmbed);

      await scopedRedisClient(async (rc, pfx) => {
        const hosts = (await rc.smembers(`${pfx}:hosttrack:${network}:${d.ident}`))
          .filter(x => !lookups.includes(x) && x.length);

        if (hosts?.length) {
          aliasesEmbed.addField(`Other known hosts for \`${d.ident}\` (${hosts?.length}):`,
            '`' + hosts.splice(0, 10).join('`, `') + '`' + (hosts?.length > 10 ? ', ...' : ''));
          hosts.forEach(lookupSet.add.bind(lookupSet));
          lookups.push(...hosts);
        }
      });

      const aliases = new Set();
      lookups = [...new Set(lookups)];

      const addIdentToEmbed = async (identLookup, e, searchStr) => {
        const identData = await nickTracking.identLookup(network, identLookup);
        if (identData) {
          e.addField(`Known aliases of <\`${identData.fullIdent}\`>` +
            `${searchStr ? ` (from "${searchStr}")` : ''}:`,
          identData.uniques.map(simpleEscapeForDiscord).join(', ') +
            (identData.lastChanges.length
              ? `\n\nLast nick change was ${fmtDuration(identData.lastChanges[0].timestamp)} ago.`
              : ''));
          identData.uniques.forEach((id) => aliases.add(id));
        }
      };

      const ignoreIdents = await userCommands('identsIgnored')(context, network);
      if (!ignoreIdents.includes(d.ident) && d.ident.length > 2) {
        await addIdentToEmbed(ident, aliasesEmbed);

        lookupSet = new Set([...lookupSet].filter(x => Boolean(x)));
        console.debug('lookupSet', lookupSet);

        for (const lookupHost of lookupSet) {
          const uniqueIdents = await nickTracking.findUniqueIdents(network, lookupHost);
          for (const uniqIdent of uniqueIdents) {
            if (uniqIdent !== ident) {
              await addIdentToEmbed(uniqIdent, aliasesEmbed, lookupHost);
            }
          }
        }

        // Get logs data once and use for both embed and HTML if needed
        const logsResults = await logsSearch(network, d, [...aliases]);

        // Create embed and add results to it
        const logsEmbed = new MessageEmbed()
          .setColor('#2c759c')
          .setTitle(`On \`${network}\`, \`${d.nick}\` has...`);
        addLogsSearchToEmbed(logsResults, logsEmbed);
        moreEmbeds.push(logsEmbed);

        // Store results for HTML generation if needed
        parsed.data._cachedLogsResults = logsResults;
      }
    }

    if (notes && notes.length) {
      const notesEmbed = new MessageEmbed()
        .setColor('#2c759c')
        .setTitle(`Notes regarding \`${d.nick}\` on \`${network}\``);
      moreEmbeds.push(notesEmbed);
      notesEmbed.setDescription(notes.reduce((a, note) => {
        if (typeof note === 'string') {
          a += `• ${note}\n`;
        }
        return a;
      }, ''));
    }
    await scopedRedisClient(async (rc, pfx) => {
      const zScore = await rc.zscore(`${pfx}:kicks:${network}:kickee`, d.nick);
      if (zScore > 2) {
        embed.addField('Toxic user alert!', `**${d.nick}** has been kicked from channels **${zScore}** times on this network!`);
      }
    });
  }

  // Store all embeds to send later
  const embedsToSend = [];

  if (!d.error) {
    const txToProc = Number(new Date()) - parsed.data?.requestData?.txTs;
    const procTime = Number(process.hrtime.bigint() - whoisRespStart) / 1e9;
    const procTimeStr = `Roundtrip took ${(txToProc / 1e3).toFixed(2)} seconds & processing took ${procTime.toFixed(2)} seconds `;
    embed.setFooter(procTimeStr);
  }

  // Add main embed to the list
  embedsToSend.push(embed);

  // Add additional embeds
  embedsToSend.push(...moreEmbeds);

  // Check if HTML view was requested
  if (parsed.data?.requestData?.generateHTML) {
    console.log(`HTML view requested for WHOIS of ${d.nick} on ${network}`);

    try {
      // Prepare data for HTML template with all information
      const whoisHtmlData = {
        network,
        nick: d.nick,
        channel: parsed.data?.requestData?.channel,
        options: parsed.data?.requestData?.options,
        isFound: !d.error,
        whoisData: d,
        ipInfo: ipInf,
        lookupHost,
        kicksCount: 0,
        firstSeen: [],
        lastSeen: [],
        showAliases: false,
        identAliases: null,
        knownHosts: [],
        otherIdents: [],
        showLogs: false,
        spokenChannels: '',
        nickAliases: '',
        identAliasesStr: '',
        hostnameAliases: '',
        showNotes: false,
        notes: []
      };

      // Add kick count if available
      if (!d.error) {
        await scopedRedisClient(async (rc, pfx) => {
          const zScore = await rc.zscore(`${pfx}:kicks:${network}:kickee`, d.nick);
          if (zScore > 2) {
            whoisHtmlData.kicksCount = zScore;
          }
        });
      } else {
        // For not found users, add last seen data
        const lastSeens = await userLastSeen(network, d);
        if (lastSeens.length) {
          whoisHtmlData.showLastSeen = true;
          whoisHtmlData.lastSeen = lastSeens.map(([channel, date]) => ({ channel, date }));
        }
      }

      // Add first seen data if available
      if (parsed.data?.requestData?.options.userFirstSeen && !d.error) {
        const firstSeens = await userFirstSeen(network, d);
        whoisHtmlData.firstSeen = firstSeens.map(([channel, date]) => ({ channel, date }));
      }

      // Add full whois data if full option is enabled
      if (parsed.data?.requestData?.options.full && !d.error) {
        console.log('Adding full WHOIS data to HTML template');
        whoisHtmlData.showAliases = true;

        // Include data from the aliases embed
        const nickTracking = await userCommands('nicks');
        const ident = `${d.ident}@${d.hostname}`;

        // Get known hosts
        await scopedRedisClient(async (rc, pfx) => {
          const lookups = [d.actual_ip, d.actual_hostname, d.hostname].filter(Boolean);
          const hosts = (await rc.smembers(`${pfx}:hosttrack:${network}:${d.ident}`))
            .filter(x => !lookups.includes(x) && x.length);

          if (hosts?.length) {
            whoisHtmlData.knownHosts = hosts.slice(0, 10);
            // Make sure to include the ident for display
            whoisHtmlData.ident = d.ident;
            if (hosts.length > 10) {
              whoisHtmlData.knownHosts.push('...');
            }
          }
        });

        // Get aliases for main ident
        const aliases = new Set();
        const ignoreIdents = await userCommands('identsIgnored')(context, network);

        if (!ignoreIdents.includes(d.ident) && d.ident.length > 2) {
          const identData = await nickTracking.identLookup(network, ident);
          if (identData) {
            whoisHtmlData.identAliases = {
              fullIdent: identData.fullIdent,
              uniques: identData.uniques,
              lastChanges: identData.lastChanges
            };

            if (identData.lastChanges && identData.lastChanges.length) {
              whoisHtmlData.identAliases.lastChangesFormatted = fmtDuration(identData.lastChanges[0].timestamp);
            }

            identData.uniques.forEach((id) => aliases.add(id));
          }

          // Get other idents from the same host(s)
          const lookupSet = new Set([d.actual_ip, d.actual_hostname, d.hostname].filter(Boolean));

          for (const lookupHost of lookupSet) {
            if (lookupHost) {
              const uniqueIdents = await nickTracking.findUniqueIdents(network, lookupHost);
              for (const uniqIdent of uniqueIdents) {
                if (uniqIdent !== ident) {
                  const identData = await nickTracking.identLookup(network, uniqIdent);
                  if (identData) {
                    const identObj = {
                      fullIdent: identData.fullIdent,
                      uniques: identData.uniques,
                      lastChanges: identData.lastChanges,
                      searchStr: lookupHost
                    };

                    if (identObj.lastChanges && identObj.lastChanges.length) {
                      identObj.lastChangesFormatted = fmtDuration(identObj.lastChanges[0].timestamp);
                    }

                    whoisHtmlData.otherIdents.push(identObj);
                    identData.uniques.forEach((id) => aliases.add(id));
                  }
                }
              }
            }
          }

          // Reuse the logs search results from earlier if available
          let logsResults;
          if (parsed.data._cachedLogsResults) {
            console.log('Reusing cached logs search results for HTML generation');
            logsResults = parsed.data._cachedLogsResults;
          } else {
            // If not already cached, perform the search now
            console.log('No cached logs search results found, performing search for HTML generation');
            const aliasesList = [...aliases];
            logsResults = await logsSearch(network, d, aliasesList);
          }

          if (logsResults.logsSearchRes.length > 0) {
            whoisHtmlData.showLogs = true;
            whoisHtmlData.spokenChannels = logsResults.seenChannels.join(', ');
            whoisHtmlData.nickAliases = logsResults.uniqSearchRes.nick.join(', ');
            whoisHtmlData.identAliasesStr = logsResults.uniqSearchRes.ident.join(', ');
            whoisHtmlData.hostnameAliases = logsResults.uniqSearchRes.hostname.join(', ');
          }
        }
      }

      // Only include notes if the includeNotes option is provided
      if (parsed.data?.requestData?.options.includeNotes && notes && notes.length) {
        whoisHtmlData.showNotes = true;
        whoisHtmlData.notes = notes.filter(note => typeof note === 'string').map(marked.parse);
        console.log(`Including ${whoisHtmlData.notes.length} notes for ${d.nick} in HTML output`);
      } else {
        // Ensure notes are not shown in HTML
        whoisHtmlData.showNotes = false;
        whoisHtmlData.notes = [];
        console.log(`Notes ${notes?.length ? 'found but' : 'not found and'} not included in HTML output (use --includeNotes to show them)`);
      }

      // Generate a unique name for the endpoint
      const name = nanoid();
      console.log(`Creating ephemeral HTML endpoint with name: ${name}`);

      // Set the default TTL for the page (30 minutes)
      const ttlMinutes = parsed.data?.requestData?.options?.ttl || 30;

      try {
        // Create the dynamic endpoint - we just need to directly publish the data
        // without worrying about one-time handlers
        await scopedRedisClient(async (client, prefix) => {
          // First register the endpoint
          console.log(`Creating ephemeral endpoint ${name} with TTL: ${ttlMinutes} minutes`);
          await client.publish(prefix, JSON.stringify({
            type: 'discord:createGetEndpoint',
            data: {
              name,
              renderType: 'whois',
              options: { ttl: ttlMinutes }
            }
          }));

          // Wait a moment to let the endpoint register
          await new Promise(resolve => setTimeout(resolve, 100));

          // Then immediately pre-publish the data that will be served
          // This way the HTTP server will have the data in Redis
          // before the first request comes in
          console.log(`Pre-publishing data for ${name}`);
          await client.publish(prefix, JSON.stringify({
            type: 'http:get-res:' + name,
            data: whoisHtmlData
          }));
        });

        // Generate the page URL for the dynamic endpoint
        const pageUrl = fqUrlFromPath(name);
        console.log(`Created WHOIS HTML page: ${pageUrl}`);

        // Send an embed to Discord with the link
        const embed = new MessageEmbed()
          .setColor('#2c759c')
          .setTitle(`WHOIS HTML View for ${d.nick} on ${network}`)
          .setDescription(`Results are available at: ${pageUrl}`)
          .setFooter(`This page will expire in ${ttlMinutes} minutes`);

        // Add the HTML embed to the list
        embedsToSend.push(embed);
      } catch (err) {
        console.error(`Error creating HTML endpoint: ${err.message}`);

        // Create error embed
        const errorEmbed = new MessageEmbed()
          .setColor('#ff0055')
          .setTitle('Error Generating WHOIS HTML View')
          .setDescription(`Failed to create HTML view: ${err.message}`);

        // Add the error embed to the list
        embedsToSend.push(errorEmbed);
      }
    } catch (error) {
      console.error('Error generating WHOIS HTML:', error);

      // Add error as text message
      await sendText(`⚠️ Error generating WHOIS HTML view: ${error.message || 'Unknown error'}`);
    }
  }

  // Now send all embeds at once
  for (const embed of embedsToSend) {
    try {
      await localSender(embed);
    } catch (e) {
      console.error(`Failed to send one embed: ${e}`, e, embed);
    }
  }

  await runOneTimeHandlers(`${network}_${d._orig?.nick ?? d.nick}`);
};
