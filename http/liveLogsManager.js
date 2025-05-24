'use strict';

const Redis = require('ioredis');
const config = require('config');
const { PREFIX } = require('../util');
const { EventEmitter } = require('events');
const { nanoid } = require('nanoid');

// Create a singleton event emitter for managing log streams
const logStreamEvents = new EventEmitter();

// Set up Redis connections
let redisPublisher = null;
let redisSubscriber = null;
let healthCheckResponse = null;

// Track daemon health status
let logManagerAvailable = false;
let lastHealthCheck = 0;
const HEALTH_CHECK_INTERVAL = 60000; // 1 minute

function getRedisPublisher () {
  if (!redisPublisher) {
    redisPublisher = new Redis(config.app.redis);
  }
  return redisPublisher;
}

function getRedisSubscriber () {
  if (!redisSubscriber) {
    redisSubscriber = new Redis(config.app.redis);
  }
  return redisSubscriber;
}

// This module now acts as a bridge between the HTTP server and the external logmgr daemon
// Instead of directly spawning Docker processes, it communicates via Redis

// Initialize response listener
function setupResponseListener () {
  const subscriber = getRedisSubscriber();
  const responseChannel = `${PREFIX}:liveLogs:response`;
  const healthResponseChannel = `${PREFIX}:liveLogs:health:response`;

  subscriber.subscribe(responseChannel, (err) => {
    if (err) {
      console.error(`Error subscribing to ${responseChannel}:`, err);
      return;
    }

    console.log(`Subscribed to ${responseChannel} for log stream responses`);
  });

  subscriber.subscribe(healthResponseChannel, (err) => {
    if (err) {
      console.error(`Error subscribing to ${healthResponseChannel}:`, err);
      return;
    }

    console.log(`Subscribed to ${healthResponseChannel} for daemon health checks`);
  });

  // Handle response messages
  subscriber.on('message', (channel, message) => {
    // Don't try to parse keyspace events as JSON
    if (channel.includes('__keyspace@') || channel.includes('__keyevent@')) {
      return;
    }

    if (channel === responseChannel) {
      try {
        const data = JSON.parse(message);

        if (data.action === 'started' && data.streamId) {
          // Emit an event to notify that the stream is ready (or failed)
          logStreamEvents.emit(`stream:ready:${data.streamId}`, data.success);

          if (!data.success) {
            console.error(`Failed to start log stream ${data.streamId}: ${data.error}`);
          } else {
            console.log(`External log manager confirmed stream ${data.streamId} started successfully`);
          }
        }
      } catch (error) {
        console.error('Error processing response message:', error);
      }
    } else if (channel === healthResponseChannel) {
      try {
        const data = JSON.parse(message);

        if (data.requestId === healthCheckResponse?.requestId) {
          console.log('Received health check response from logmgr daemon');
          logManagerAvailable = true;
          lastHealthCheck = Date.now();

          // Emit the health check event
          if (healthCheckResponse?.resolver) {
            healthCheckResponse.resolver(true);
            healthCheckResponse = null;
          }
        }
      } catch (error) {
        console.error('Error processing health response message:', error);
      }
    }
  });

  // Clean up properly
  process.on('exit', () => {
    if (subscriber) {
      subscriber.quit();
    }
  });

  return subscriber;
}

// Check if the logmgr daemon is running
function checkLogManagerHealth () {
  // If we've checked recently, use cached result
  if ((Date.now() - lastHealthCheck) < HEALTH_CHECK_INTERVAL && logManagerAvailable) {
    return Promise.resolve(true);
  }

  console.log('Performing health check on logmgr daemon...');

  // Create a new health check request
  const requestId = nanoid();

  const publisher = getRedisPublisher();
  publisher.publish(`${PREFIX}:liveLogs:health:request`, JSON.stringify({
    action: 'healthCheck',
    requestId,
    timestamp: Date.now()
  }));

  // Return a promise that resolves when we get a response or times out
  return new Promise((resolve, reject) => {
    healthCheckResponse = {
      requestId,
      resolver: resolve,
      timestamp: Date.now()
    };

    // Set a timeout to fail after 5 seconds
    const timeout = setTimeout(() => {
      if (healthCheckResponse?.requestId === requestId) {
        console.warn('Health check timed out - logmgr daemon may not be running');
        logManagerAvailable = false;
        healthCheckResponse = null;
        reject(new Error('Log manager daemon is not responding. Make sure logmgr.js is running.'));
      }
    }, 5000);

    // Clean up timeout on success
    logStreamEvents.once(`health:response:${requestId}`, () => {
      clearTimeout(timeout);
    });
  });
}

// Start a new log stream - non-blocking
async function startLogStream (streamInfo) {
  const { streamId, daemon } = streamInfo;

  // Check if the logmgr daemon is running first
  try {
    await checkLogManagerHealth();
  } catch (error) {
    console.error('Log manager daemon is not available:', error.message);
    throw new Error('Log manager daemon is not available. Please ensure logmgr.js is running.');
  }

  console.log(`Requesting log stream for daemon: ${daemon}, streamId: ${streamId}`);

  // Send a request to the logmgr daemon to start the stream
  const publisher = getRedisPublisher();
  publisher.publish(`${PREFIX}:liveLogs:request`, JSON.stringify({
    action: 'start',
    streamInfo
  }));

  // Since the stream works even if we don't get a ready event, we'll make this
  // more resilient by not rejecting on timeout, but instead resolving with a warning
  return new Promise((resolve) => {
    // Set up a listener for the stream ready event
    const onStreamReady = (success) => {
      if (success) {
        console.log(`Log stream for ${daemon} (${streamId}) is confirmed ready`);
        clearTimeout(timeout);
        resolve(true);
      } else {
        console.warn(`Log stream setup reported failure for ${daemon} but will try to continue`);
        resolve(false);
      }
    };

    // Set up the event listener
    logStreamEvents.once(`stream:ready:${streamId}`, onStreamReady);

    // Set a timeout, but don't reject - just resolve with a warning
    // This addresses the fact that streams work fine even without getting the ready event
    const timeout = setTimeout(() => {
      console.log(`No ready event received for ${daemon} stream (${streamId}), but continuing anyway`);
      logStreamEvents.removeListener(`stream:ready:${streamId}`, onStreamReady);
      resolve(true); // Still resolve successfully since the stream likely works anyway
    }, 15000);
  });
}

// Stop a log stream
function stopLogStream (streamId) {
  console.log(`Requesting to stop log stream: ${streamId}`);

  // Send a request to the logmgr daemon to stop the stream
  const publisher = getRedisPublisher();
  publisher.publish(`${PREFIX}:liveLogs:control`, JSON.stringify({
    action: 'stop',
    streamId
  }));

  return true;
}

// Get info about active streams - currently returns an empty array
// In the future, we could query the logmgr daemon for active streams
function getActiveStreams () {
  // For now, we don't have a way to get active streams from the external daemon
  // This could be enhanced with a request-response pattern to the logmgr daemon
  console.log('Note: getActiveStreams() currently returns an empty array as streams are managed by external daemon');
  return [];
}

// Initialize response listener
setupResponseListener();

// Run an initial health check
checkLogManagerHealth()
  .then(() => {
    console.log('Log manager daemon is available');
  })
  .catch(error => {
    console.warn('Initial health check failed:', error.message);
  });

// Handle process exit
process.on('exit', () => {
  if (redisPublisher) {
    redisPublisher.quit();
  }
  if (redisSubscriber) {
    redisSubscriber.quit();
  }
});

module.exports = {
  startLogStream,
  stopLogStream,
  getActiveStreams,
  checkLogManagerHealth
};
