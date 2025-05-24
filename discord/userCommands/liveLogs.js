'use strict';

const { servePage } = require('../lib/serveMessages');
const { nanoid } = require('nanoid');
const { MessageEmbed } = require('discord.js');
const { fqUrlFromPath, scopedRedisClient } = require('../../util');

async function f (context) {
  const args = context.argObj._;
  const ttl = context.argObj.ttl || context.argObj.t;
  const allDaemons = context.argObj.all || false;
  const listSessions = context.argObj.listSessions || false;
  const attachToSession = context.argObj.attachToSession;

  // Get the default daemons from config
  const config = require('config');
  const ALL_DAEMONS = config.app.liveLogsDaemons || ['discord', 'http', 'irc', 'prometheus'];

  // Validate daemon names
  const VALID_DAEMON_NAMES = new Set(ALL_DAEMONS);

  // Handle --listSessions option
  if (listSessions) {
    await listActiveSessions(context);
    return;
  }

  // Handle --attachToSession option
  if (attachToSession) {
    await attachToExistingSession(context, attachToSession);
    return;
  }

  let daemon;
  let selectedDaemons = [];
  let isCombinedStream = false;

  if (allDaemons) {
    // --all flag was provided, use all available daemons
    daemon = 'combined'; // Better name than 'all' which can cause issues
    selectedDaemons = [...ALL_DAEMONS]; // Copy the array
    isCombinedStream = true;

    // Log the configuration for debugging
    console.log(`Using combined logs mode with all daemons: ${selectedDaemons.join(', ')}`);

    if (!selectedDaemons || selectedDaemons.length === 0) {
      context.sendToBotChan('Error: No daemons configured for combined logs view. Check config.app.liveLogsDaemons.');
      return;
    }
  } else if (!args || args.length === 0) {
    context.sendToBotChan('Please specify one or more daemon names, e.g. `!liveLogs discord` or `!liveLogs discord irc http` or use `!liveLogs --all` to view all daemons.');
    return;
  } else if (args.length === 1) {
    // Single daemon mode
    daemon = args[0];

    // Validate daemon name
    if (!VALID_DAEMON_NAMES.has(daemon)) {
      context.sendToBotChan(`Invalid daemon name: "${daemon}". Valid daemons are: ${ALL_DAEMONS.join(', ')}`);
      return;
    }
  } else {
    // Multiple daemons were specified - create a combined stream
    selectedDaemons = [];
    const invalidDaemons = [];

    // Validate each daemon name
    for (const name of args) {
      if (VALID_DAEMON_NAMES.has(name)) {
        selectedDaemons.push(name);
      } else {
        invalidDaemons.push(name);
      }
    }

    // Notify about any invalid daemon names
    if (invalidDaemons.length > 0) {
      context.sendToBotChan(`Warning: Ignoring invalid daemon names: ${invalidDaemons.join(', ')}. Valid daemons are: ${ALL_DAEMONS.join(', ')}`);

      // If no valid daemons remain, cancel the operation
      if (selectedDaemons.length === 0) {
        context.sendToBotChan('Error: No valid daemon names provided. Valid daemons are: ' + ALL_DAEMONS.join(', '));
        return;
      }
    }

    // Set up combined stream mode
    daemon = 'combined';
    isCombinedStream = true;
    console.log(`Using combined logs mode with selected daemons: ${selectedDaemons.join(', ')}`);
  }

  const streamId = nanoid();
  let expiryMinutes = 30; // Default expiry time in minutes

  // Override with --ttl value if provided
  if (ttl) {
    const parsedTtl = parseInt(ttl, 10);
    if (!isNaN(parsedTtl) && parsedTtl > 0) {
      expiryMinutes = parsedTtl;
    } else {
      context.sendToBotChan('Invalid TTL value. Using default of 30 minutes.');
    }
  }

  const expiresAt = Date.now() + (expiryMinutes * 60 * 1000);

  try {
    // Show initial message to let user know we're working
    if (isCombinedStream) {
      context.sendToBotChan(`Setting up combined live logs for daemons: ${selectedDaemons.join(', ')}...`, true);
    } else {
      context.sendToBotChan(`Setting up live logs for daemon: ${daemon}...`, true);
    }

    // Store stream info in Redis for the HTTP server to pick up
    let streamInfo;

    if (isCombinedStream) {
      // For the combined mode, we use 'combined' as the daemon name
      // and provide the actual daemons array for the log manager to handle
      streamInfo = {
        streamId,
        daemon: 'combined', // Using 'combined' name instead of 'all'
        daemons: selectedDaemons, // Specify which daemons to monitor
        expiresAt,
        createdAt: Date.now(),
        createdBy: context.user?.id || 'unknown',
        isCombinedStream: true // Explicit flag to ensure it's treated as combined
      };

      // Log for debugging
      console.log(`Setting up combined stream with daemons: ${JSON.stringify(selectedDaemons)}`);
    } else {
      // Regular single-daemon mode
      streamInfo = {
        streamId,
        daemon,
        expiresAt,
        createdAt: Date.now(),
        createdBy: context.user?.id || 'unknown'
      };
    }

    await scopedRedisClient(async (client, prefix) => {
      await client.set(
        `${prefix}:liveLogs:${streamId}`,
        JSON.stringify(streamInfo),
        'EX',
        expiryMinutes * 60 // TTL in seconds
      );
    });

    // Create HTTP endpoint and get page URL (non-blocking)
    const pageData = {
      streamId,
      daemon,
      expiresAt,
      wsEndpoint: `/ws/liveLogs/${streamId}`,
      // Add daemons list for combined view
      daemons: isCombinedStream ? selectedDaemons : undefined,
      // Creating a raw endpoint without template escaping
      rawWsEndpoint: true
    };

    // Create the page and send the response when ready (all async)
    servePage(context, pageData, 'liveLogs')
      .then(name => {
        // Create embed response
        const embed = new MessageEmbed()
          .setColor('BLUE')
          .setTitle(isCombinedStream
            ? `Combined Live Logs: ${selectedDaemons.length} Daemons`
            : `Live Logs: ${daemon}`)
          .setDescription(fqUrlFromPath(name))
          .addField('Expires In', `${expiryMinutes} minutes`)
          .setFooter(`Stream ID: ${streamId}`)
          .addField('Note', 'This page will automatically stop streaming logs after the expiry time.');

        if (isCombinedStream) {
          embed.addField('Monitoring', selectedDaemons.join(', '));
        }

        context.sendToBotChan({ embeds: [embed] }, true);
      })
      .catch(error => {
        console.error('Error creating live logs page:', error);
        context.sendToBotChan(`Error setting up live logs page: ${error.message}`, true);
      });

    // Register a cleanup handler to remove Redis key when command is cleaned up
    context.registerOneTimeHandler(`liveLogs:cleanup:${streamId}`, streamId, () => {
      scopedRedisClient(async (client, prefix) => {
        try {
          // Send a message to notify the HTTP server to stop the log stream
          await client.publish(`${prefix}:liveLogs:control`, JSON.stringify({
            action: 'stop',
            streamId
          }));

          // Clean up Redis
          await client.del(`${prefix}:liveLogs:${streamId}`);
          console.log(`Cleaned up log stream info: ${streamId} for daemon: ${daemon}`);
        } catch (error) {
          console.error(`Error cleaning up log stream: ${error.message}`);
        }
      });
    });
  } catch (error) {
    console.error('Error starting log stream:', error);
    context.sendToBotChan(`Error starting log stream: ${error.message}`, true);
  }
}

/**
 * List all active log stream sessions
 * @param {Object} context - Command context
 */
async function listActiveSessions (context) {
  try {
    context.sendToBotChan('Retrieving active live log sessions...', true);

    const activeSessions = await scopedRedisClient(async (client, prefix) => {
      // Get all keys matching the pattern for live logs
      const keys = await client.keys(`${prefix}:liveLogs:*`);

      if (!keys || keys.length === 0) {
        return [];
      }

      // Get values for all found keys
      const sessions = [];

      for (const key of keys) {
        // Skip control or stream channels, we want only the session info keys
        if (key.includes(':control:') || key.includes(':stream:')) {
          continue;
        }

        const data = await client.get(key);
        if (!data) continue;

        try {
          // Parse the session data
          const sessionInfo = JSON.parse(data);

          // Add the key for reference (to extract the session ID)
          sessionInfo.key = key;

          // Ensure createdAt exists (for older sessions that might not have it)
          if (!sessionInfo.createdAt) {
            sessionInfo.createdAt = Date.now();
          }

          // Calculate remaining time
          if (sessionInfo.expiresAt) {
            const now = Date.now();
            sessionInfo.remainingMs = Math.max(0, sessionInfo.expiresAt - now);
            sessionInfo.remainingMinutes = Math.floor(sessionInfo.remainingMs / (60 * 1000));
          }

          sessions.push(sessionInfo);
        } catch (error) {
          console.error(`Error parsing session data for key ${key}:`, error);
        }
      }

      return sessions;
    });

    if (!activeSessions || activeSessions.length === 0) {
      context.sendToBotChan('No active live log sessions found.');
      return;
    }

    // Sort sessions by expiry time (closest to expiry first)
    activeSessions.sort((a, b) => a.remainingMs - b.remainingMs);

    // Create an embed to display the sessions
    const embed = new MessageEmbed()
      .setColor('BLUE')
      .setTitle('Active Live Log Sessions')
      .setDescription(`Found ${activeSessions.length} active session(s)`);

    // Add each session to the embed
    for (const session of activeSessions) {
      const sessionId = session.streamId;
      let daemonInfo;

      if (session.isCombinedStream) {
        if (Array.isArray(session.daemons) && session.daemons.length > 0) {
          daemonInfo = session.daemons.join(', ');
        } else {
          daemonInfo = 'Combined (all daemons)';
        }
      } else {
        daemonInfo = session.daemon;
      }

      // Format creation time
      const createdDate = session.createdAt ? new Date(session.createdAt).toLocaleString() : 'Unknown';

      // Get the configured command prefix character
      const config = require('config');
      const cmdPrefix = config.app.allowedSpeakersCommandPrefixCharacter || '!';

      // Format details for this session
      embed.addField(
        `Session ID: ${sessionId}`,
        `**Streaming:** ${daemonInfo}\n` +
        `**Created:** ${createdDate}\n` +
        `**Time Remaining:** ${session.remainingMinutes} minutes\n` +
        `**Attach Command:** \`${cmdPrefix}liveLogs --attachToSession ${sessionId}\``
      );
    }

    context.sendToBotChan({ embeds: [embed] }, true);
  } catch (error) {
    console.error('Error listing active sessions:', error);
    context.sendToBotChan(`Error listing active sessions: ${error.message}`);
  }
}

/**
 * Attach to an existing session
 * @param {Object} context - Command context
 * @param {string} sessionId - Session ID to attach to
 */
async function attachToExistingSession (context, sessionId) {
  try {
    // First check if the session exists and is valid
    const sessionInfo = await scopedRedisClient(async (client, prefix) => {
      const data = await client.get(`${prefix}:liveLogs:${sessionId}`);
      if (!data) return null;

      try {
        return JSON.parse(data);
      } catch (error) {
        console.error(`Error parsing session data for ${sessionId}:`, error);
        return null;
      }
    });

    if (!sessionInfo) {
      context.sendToBotChan(`Error: Session ID "${sessionId}" not found or has expired.`);
      return;
    }

    // Check if the session has expired
    const now = Date.now();
    if (sessionInfo.expiresAt && sessionInfo.expiresAt < now) {
      context.sendToBotChan(`Error: Session ID "${sessionId}" has expired.`);
      return;
    }

    context.sendToBotChan(`Attaching to existing log session: ${sessionId}...`, true);

    // Prepare page data based on session info
    const pageData = {
      streamId: sessionId,
      daemon: sessionInfo.daemon,
      expiresAt: sessionInfo.expiresAt,
      wsEndpoint: `/ws/liveLogs/${sessionId}`,
      // Add daemons list for combined view
      daemons: sessionInfo.isCombinedStream ? sessionInfo.daemons : undefined,
      // Creating a raw endpoint without template escaping
      rawWsEndpoint: true
    };

    // Create a new page that attaches to the existing stream
    servePage(context, pageData, 'liveLogs')
      .then(name => {
        // Calculate remaining time in minutes
        const remainingMs = Math.max(0, sessionInfo.expiresAt - now);
        const remainingMinutes = Math.floor(remainingMs / (60 * 1000));

        // Create embed response
        const embed = new MessageEmbed()
          .setColor('GREEN')
          .setTitle(sessionInfo.isCombinedStream
            ? 'Attached to Combined Live Logs Session'
            : `Attached to Live Logs: ${sessionInfo.daemon}`)
          .setDescription(fqUrlFromPath(name))
          .addField('Session ID', sessionId)
          .addField('Expires In', `${remainingMinutes} minutes`);

        if (sessionInfo.isCombinedStream && Array.isArray(sessionInfo.daemons)) {
          embed.addField('Monitoring', sessionInfo.daemons.join(', '));
        }

        context.sendToBotChan({ embeds: [embed] }, true);
      })
      .catch(error => {
        console.error('Error creating page for existing session:', error);
        context.sendToBotChan(`Error attaching to session: ${error.message}`, true);
      });
  } catch (error) {
    console.error('Error attaching to session:', error);
    context.sendToBotChan(`Error attaching to session: ${error.message}`);
  }
}

f.__drcHelp = () => {
  // Get the configured command prefix character
  const config = require('config');
  const cmdPrefix = config.app.allowedSpeakersCommandPrefixCharacter || '!';

  return {
    title: 'Stream live logs from Docker daemons',
    usage: '<daemon-name> [daemon-name...] [--ttl <minutes>] [--all] [--listSessions] [--attachToSession <session-id>]',
    notes: 'Creates an ephemeral HTTP endpoint that streams logs from the specified docker compose daemon(s). ' +
      'The endpoint will be valid for 30 minutes by default, or the time specified with --ttl.\n\n' +
      'Options:\n' +
      '  --ttl, -t <minutes>      Set a custom expiry time in minutes\n' +
      '  --all                    Stream logs from all daemons (discord, http, irc, and prometheus) in a combined view\n' +
      '  --listSessions           List all active log sessions including their IDs and expiry times\n' +
      '  --attachToSession <id>   Attach a new browser view to an existing session without creating a new one\n\n' +
      'Examples:\n' +
      `  \`${cmdPrefix}liveLogs discord\` - Shows live logs from the discord daemon (expires in 30 minutes).\n` +
      `  \`${cmdPrefix}liveLogs discord --ttl 60\` - Shows live logs with a 60-minute expiry time.\n` +
      `  \`${cmdPrefix}liveLogs discord irc\` - Shows combined logs from discord and irc daemons.\n` +
      `  \`${cmdPrefix}liveLogs discord http irc\` - Shows combined logs from the three specified daemons.\n` +
      `  \`${cmdPrefix}liveLogs --all\` - Shows combined logs from all daemons in a single view.\n` +
      `  \`${cmdPrefix}liveLogs --listSessions\` - Lists all currently active log sessions.\n` +
      `  \`${cmdPrefix}liveLogs --attachToSession abc123\` - Opens a new view attached to existing session ID abc123.`
  };
};

module.exports = f;
