'use strict';

/**
 * Log Manager Daemon
 *
 * This is a standalone daemon that can run outside of Docker to collect
 * logs from Docker containers and stream them to Redis for consumption by other services.
 *
 * The daemon monitors Redis for log stream requests, fetches logs from Docker,
 * and publishes them back to Redis where the HTTP server can serve them via WebSockets.
 */

const config = require('config');
const { PREFIX } = require('./util');

// Import utility modules
const dockerUtils = require('./lib/dockerUtils');
const redisUtils = require('./lib/redisUtils');
const streamManager = require('./lib/StreamManager');

// Logger setup
require('./logger')('logmgr');
console.log('Starting Log Manager Daemon...');

/**
 * Initialize Redis subscribers for commands and keyspace events
 * @returns {Object} Redis subscriber client
 */
function setupRedisSubscribers () {
  const subscriber = redisUtils.getRedisSubscriber();

  // Channel definitions
  const controlChannel = `${PREFIX}:liveLogs:control`;
  const requestChannel = `${PREFIX}:liveLogs:request`;
  const healthRequestChannel = `${PREFIX}:liveLogs:health:request`;
  const keyspacePrefix = `__keyspace@${config.redis.db || 0}__:${PREFIX}:liveLogs:*`;

  // Enable keyspace notifications
  redisUtils.enableKeyspaceNotifications();

  // Subscribe to keyspace events
  subscriber.psubscribe(keyspacePrefix, (err) => {
    if (err) {
      console.error(`Error subscribing to keyspace events ${keyspacePrefix}:`, err);
    } else {
      console.log(`Subscribed to Redis keyspace events: ${keyspacePrefix}`);
    }
  });

  // Subscribe to control channels
  const channels = [controlChannel, requestChannel, healthRequestChannel];

  channels.forEach(channel => {
    subscriber.subscribe(channel, (err) => {
      if (err) {
        console.error(`Error subscribing to ${channel}:`, err);
      } else {
        console.log(`Subscribed to ${channel}`);
      }
    });
  });

  /**
   * Process messages from all channels
   * @param {string} channel - Redis channel
   * @param {string} message - Message content
   */
  const processMessage = (channel, message) => {
    try {
      // Handle keyspace notifications about key expiry
      if (channel.includes('__keyspace@') && message === 'expired') {
        const keyParts = channel.split(':');
        if (keyParts.length >= 4 && keyParts[keyParts.length - 2] === 'liveLogs') {
          const streamId = keyParts[keyParts.length - 1];
          console.log(`Key expiry notification for stream ${streamId}`);
          streamManager.stopStream(streamId);
        }
        return;
      }

      // Don't try to parse the message as JSON for keyspace events
      if (channel.includes('__keyspace@') || channel.includes('__keyevent@')) {
        return;
      }

      // For control and request channels, parse as JSON
      const data = JSON.parse(message);

      // Handle control messages
      if (channel === controlChannel) {
        if (data.action === 'stop' && data.streamId) {
          streamManager.stopStream(data.streamId);
        }
      }

      // Handle health check requests
      if (channel === healthRequestChannel) {
        if (data.action === 'healthCheck' && data.requestId) {
          console.log(`Received health check request: ${data.requestId}`);

          // Health response for HTTP daemon and live logs
          const healthData = {
            action: 'healthCheck',
            requestId: data.requestId,
            status: 'ok',
            uptime: process.uptime(),
            activeStreams: streamManager.getActiveStreamCount(),
            timestamp: Date.now()
          };

          // Publish to the health response channel
          redisUtils.publishToChannel(`${PREFIX}:liveLogs:health:response`, healthData);

          // Also publish to the isXRunning response channel for system info
          redisUtils.publishToChannel(PREFIX, {
            type: 'isXRunning:isLogMgrRunningResponse',
            data: {
              reqId: data.requestId,
              status: 'ok',
              uptime: process.uptime(),
              activeStreams: streamManager.getActiveStreamCount()
            }
          });
        }
      }

      // Handle new stream requests
      if (channel === requestChannel) {
        if (data.action === 'start' && data.streamInfo) {
          streamManager.createStream(data.streamInfo)
            .then(() => {
              console.log(`Successfully started log stream: ${data.streamInfo.streamId}`);
            })
            .catch((error) => {
              console.error(`Failed to start log stream: ${error.message}`);
            });
        }
      }
    } catch (error) {
      // Don't log JSON parse errors for 'expired' messages
      if (message !== 'expired') {
        console.error('Error processing message:', error);
      }
    }
  };

  // Handle regular messages
  subscriber.on('message', (channel, message) => {
    processMessage(channel, message);
  });

  // Handle pattern messages
  subscriber.on('pmessage', (_pattern, channel, message) => {
    processMessage(channel, message);
  });

  return subscriber;
}

/**
 * Set up handlers for process termination
 */
function setupShutdownHandlers () {
  const shutdown = () => {
    console.log('Shutting down Log Manager Daemon...');
    streamManager.shutdown();
    redisUtils.closeRedisConnections();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/**
 * Startup sequence
 */
async function startup () {
  try {
    // Check if Docker is accessible
    await dockerUtils.checkDockerAccess();

    // Initialize Redis subscribers
    setupRedisSubscribers();

    // Setup shutdown handlers
    setupShutdownHandlers();

    console.log('Log Manager Daemon is ready and listening for stream requests');
  } catch (error) {
    console.error('Startup failed:', error);
    process.exit(1);
  }
}

// Start the daemon
startup();
