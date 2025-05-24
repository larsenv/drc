'use strict';

const Redis = require('ioredis');
const config = require('config');
const { PREFIX } = require('../util');

// Singleton Redis connections
let redisPublisher = null;
let redisSubscriber = null;

/**
 * Get Redis publisher connection
 * @returns {Redis} Redis client for publishing
 */
function getRedisPublisher () {
  if (!redisPublisher) {
    redisPublisher = new Redis(config.app.redis);
  }
  return redisPublisher;
}

/**
 * Get Redis subscriber connection
 * @returns {Redis} Redis client for subscribing
 */
function getRedisSubscriber () {
  if (!redisSubscriber) {
    redisSubscriber = new Redis(config.app.redis);
  }
  return redisSubscriber;
}

/**
 * Publish message to a specific stream
 * @param {string} streamId - Stream ID
 * @param {string} type - Message type (log, error, info, heartbeat)
 * @param {string} message - Message content
 * @param {Object} options - Additional options to include in the payload
 * @returns {Promise} Promise that resolves when published
 */
function publishToStream (streamId, type, message, options = {}) {
  const publisher = getRedisPublisher();
  const payload = {
    type,
    message,
    timestamp: Date.now(),
    ...options
  };

  return publisher.publish(`${PREFIX}:liveLogs:stream:${streamId}`, JSON.stringify(payload));
}

/**
 * Publish to any Redis channel
 * @param {string} channel - Channel name
 * @param {Object} payload - Payload to publish
 * @returns {Promise} Promise that resolves when published
 */
function publishToChannel (channel, payload) {
  const publisher = getRedisPublisher();
  return publisher.publish(channel, JSON.stringify(payload));
}

/**
 * Enable Redis keyspace notifications
 * @returns {Promise<boolean>} Success status
 */
async function enableKeyspaceNotifications () {
  const subscriber = getRedisSubscriber();
  try {
    await subscriber.config('SET', 'notify-keyspace-events', 'Ex');
    console.log('Redis keyspace notifications enabled for expired events');
    return true;
  } catch (error) {
    console.warn('Could not enable Redis keyspace notifications:', error.message);
    return false;
  }
}

/**
 * Close all Redis connections
 */
function closeRedisConnections () {
  if (redisPublisher) {
    redisPublisher.quit();
    redisPublisher = null;
  }

  if (redisSubscriber) {
    redisSubscriber.quit();
    redisSubscriber = null;
  }
}

module.exports = {
  getRedisPublisher,
  getRedisSubscriber,
  publishToStream,
  publishToChannel,
  enableKeyspaceNotifications,
  closeRedisConnections
};
