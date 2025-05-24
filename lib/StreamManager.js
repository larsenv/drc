'use strict';

const { EventEmitter } = require('events');
const LogStream = require('./LogStream');
const { publishToChannel } = require('./redisUtils');
const { PREFIX } = require('../util');

/**
 * Manages multiple log streams
 * @extends EventEmitter
 */
class StreamManager extends EventEmitter {
  /**
   * Create a new StreamManager
   */
  constructor () {
    super();
    this.streams = new Map();
    this._setupCleanupInterval();
  }

  /**
   * Create and start a new stream
   * @param {Object} streamInfo - Stream configuration
   * @returns {Promise<LogStream>} The created stream
   */
  async createStream (streamInfo) {
    const { streamId } = streamInfo;

    // Check if stream already exists
    if (this.streams.has(streamId)) {
      console.log(`Stream ${streamId} already exists, returning existing stream`);
      return this.streams.get(streamId);
    }

    console.log(`Creating new stream: ${streamId}, daemon: ${streamInfo.daemon || 'combined'}`);

    // Create new stream
    const stream = new LogStream(streamInfo);

    // Set up event listeners
    stream.on('stopped', (id) => {
      console.log(`Stream ${id} stopped, removing from manager`);
      this.streams.delete(id);
    });

    // Handle ready event
    stream.on('ready', (id) => {
      this.emit('stream:ready', id);
    });

    // Store stream before starting
    this.streams.set(streamId, stream);

    try {
      // Start the stream
      await stream.start();

      // Notify that the stream is ready
      publishToChannel(`${PREFIX}:liveLogs:response`, {
        action: 'started',
        streamId: streamId,
        success: true
      });

      return stream;
    } catch (error) {
      console.error(`Failed to start stream ${streamId}:`, error);

      // Remove the stream from the map
      this.streams.delete(streamId);

      // Notify about the failure
      publishToChannel(`${PREFIX}:liveLogs:response`, {
        action: 'started',
        streamId: streamId,
        success: false,
        error: error.message
      });

      throw error;
    }
  }

  /**
   * Stop a stream by ID
   * @param {string} streamId - Stream ID to stop
   * @returns {boolean} Success status
   */
  stopStream (streamId) {
    if (this.streams.has(streamId)) {
      const stream = this.streams.get(streamId);
      return stream.stop();
    }
    return false;
  }

  /**
   * Get all active streams info
   * @returns {Array<Object>} Array of stream info objects
   */
  getActiveStreams () {
    const result = [];
    for (const stream of this.streams.values()) {
      result.push(stream.getInfo());
    }
    return result;
  }

  /**
   * Get count of active streams
   * @returns {number} Active stream count
   */
  getActiveStreamCount () {
    return this.streams.size;
  }

  /**
   * Set up interval to clean expired streams
   * @private
   */
  _setupCleanupInterval () {
    setInterval(() => {
      for (const [id, stream] of this.streams.entries()) {
        if (stream.isExpired()) {
          console.log(`Cleaning up expired log stream: ${id}`);
          stream.stop();
        }
      }
    }, 5 * 60 * 1000); // 5 minutes
  }

  /**
   * Stop all streams and clean up
   */
  shutdown () {
    console.log(`Shutting down ${this.streams.size} active streams`);
    for (const stream of this.streams.values()) {
      stream.stop();
    }
    this.streams.clear();
  }
}

// Export as singleton
module.exports = new StreamManager();
