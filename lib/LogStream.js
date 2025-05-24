'use strict';

const { EventEmitter } = require('events');
const config = require('config');
const { publishToStream } = require('./redisUtils');
const dockerUtils = require('./dockerUtils');

/**
 * LogStream class for handling individual or combined Docker container log streams
 * @extends EventEmitter
 */
class LogStream extends EventEmitter {
  /**
   * Create a new LogStream
   * @param {Object} streamInfo - Stream configuration
   */
  constructor (streamInfo) {
    super();
    this.streamInfo = { ...streamInfo };
    this.streamId = streamInfo.streamId;
    this.expiresAt = streamInfo.expiresAt;
    this.daemon = streamInfo.daemon;
    this.isCombined = this._isCombinedStream();
    this.processes = [];
    this.containerIds = {};
    this.heartbeatTimer = null;
    this.active = false;
  }

  /**
   * Check if this is a combined stream based on streamInfo
   * @returns {boolean} True if this is a combined stream
   * @private
   */
  _isCombinedStream () {
    const { daemon, daemons, isCombinedStream } = this.streamInfo;
    return (
      isCombinedStream === true ||
      daemon === 'all' ||
      daemon === 'combined' ||
      (Array.isArray(daemons) && daemons.length > 0)
    );
  }

  /**
   * Process the daemons array to ensure it's valid
   * @returns {Array} Processed daemons array
   * @private
   */
  _processDaemonsList () {
    // If we have a valid array, just use it
    if (Array.isArray(this.streamInfo.daemons) && this.streamInfo.daemons.length > 0) {
      console.log(`Using user-specified daemons: ${this.streamInfo.daemons.join(', ')}`);
      return this.streamInfo.daemons;
    }

    // Try to parse if it's a JSON string
    if (typeof this.streamInfo.daemons === 'string') {
      try {
        this.streamInfo.daemons = JSON.parse(this.streamInfo.daemons);
      } catch (e) {
        console.error(`Failed to parse daemons JSON: ${e.message}`);
      }
    }

    // If it's still not an array, try to convert it from an object
    if (!Array.isArray(this.streamInfo.daemons) || this.streamInfo.daemons.length === 0) {
      if (this.streamInfo.daemons && typeof this.streamInfo.daemons === 'object') {
        // Convert object to values array
        this.streamInfo.daemons = Object.values(this.streamInfo.daemons);
      } else {
        // Use defaults
        this.streamInfo.daemons = config.app.liveLogsDaemons || ['discord', 'http', 'irc', 'prometheus'];
        console.log(`Using default daemons: ${this.streamInfo.daemons.join(', ')}`);
      }
    }

    // Final check
    if (!Array.isArray(this.streamInfo.daemons) || this.streamInfo.daemons.length === 0) {
      throw new Error('No valid daemons found in the daemons array');
    }

    return this.streamInfo.daemons;
  }

  /**
   * Start the log stream
   * @returns {Promise<boolean>} Success status
   */
  async start () {
    if (this.active) {
      console.log(`Log stream already active for ${this.streamId}`);
      return true;
    }

    this.active = true;
    this._startHeartbeat();

    try {
      if (this.isCombined) {
        return await this._startCombinedStream();
      } else {
        return await this._startSingleStream();
      }
    } catch (error) {
      this.active = false;
      this._stopHeartbeat();
      throw error;
    }
  }

  /**
   * Start heartbeat timer
   * @private
   */
  _startHeartbeat () {
    this._stopHeartbeat();

    this.heartbeatTimer = setInterval(() => {
      if (Date.now() > this.expiresAt) {
        this.stop();
        return;
      }

      publishToStream(this.streamId, 'heartbeat', '');
    }, 30000); // 30 seconds
  }

  /**
   * Stop heartbeat timer
   * @private
   */
  _stopHeartbeat () {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Start a single daemon stream
   * @returns {Promise<boolean>} Success status
   * @private
   */
  async _startSingleStream () {
    // Make sure we're not trying to get a container for "all"
    if (this.daemon === 'all') {
      throw new Error('Cannot get container for "all" - use combined stream mode with daemons array instead');
    }

    // Get container ID
    const containerId = await dockerUtils.getContainerId(this.daemon);
    console.log(`[${this.streamId}] Found container ID: ${containerId} for daemon: ${this.daemon}`);
    this.containerId = containerId;

    // Send info message
    publishToStream(this.streamId, 'info', `Setting up log stream for daemon: ${this.daemon}`, {
      isClientMessage: true
    });

    // Get and send initial logs
    try {
      const initialLogs = await dockerUtils.getInitialLogs(containerId);

      if (initialLogs && initialLogs.trim()) {
        publishToStream(this.streamId, 'info', `--- Recent logs from ${this.daemon} (historical) ---`, {
          isClientMessage: true
        });

        publishToStream(this.streamId, 'log', initialLogs);

        publishToStream(this.streamId, 'info', '--- End of historical logs, now streaming live logs ---', {
          isClientMessage: true
        });
      } else {
        publishToStream(this.streamId, 'info',
          `No recent logs available for ${this.daemon}. New logs will appear automatically.`, {
            isClientMessage: true
          });
      }
    } catch (error) {
      console.error(`[${this.streamId}] Error getting initial logs:`, error);
      publishToStream(this.streamId, 'error', `Error loading initial logs: ${error.message}`, {
        isClientMessage: true
      });
      // Continue anyway - we'll just stream new logs
    }

    // Start log streaming process
    this.process = dockerUtils.createLogStream(containerId);

    // Handle stdout data
    this.process.stdout.on('data', (data) => {
      const message = data.toString();
      if (message.trim()) {
        publishToStream(this.streamId, 'log', message);
      }
    });

    // Handle stderr data
    this.process.stderr.on('data', (data) => {
      const message = data.toString();
      publishToStream(this.streamId, 'error', message);
    });

    // Handle process exit
    this.process.on('close', (code) => {
      console.log(`[${this.streamId}] Log process for ${this.daemon} exited with code ${code}`);

      publishToStream(this.streamId, 'info',
        `Log stream ended with code ${code}. Attempting to restart...`, {
          isClientMessage: true
        });

      // Automatically restart if still active
      if (this.active && Date.now() < this.expiresAt) {
        console.log(`[${this.streamId}] Restarting log stream for ${this.daemon}`);

        // Wait a bit and restart
        setTimeout(() => {
          if (Date.now() < this.expiresAt) {
            this.restart();
          }
        }, 5000);
      } else {
        this.stop();
      }
    });

    // Handle process errors
    this.process.on('error', (error) => {
      console.error(`[${this.streamId}] Error with log process:`, error);

      publishToStream(this.streamId, 'error', `Log process error: ${error.message}`, {
        isClientMessage: true
      });
    });

    // Emit ready event
    this.emit('ready', this.streamId);
    return true;
  }

  /**
   * Start a combined stream with multiple daemons
   * @returns {Promise<boolean>} Success status
   * @private
   */
  async _startCombinedStream () {
    // Process daemons array
    const daemons = this._processDaemonsList();

    // Send info message
    publishToStream(this.streamId, 'info',
      `Setting up combined log stream for daemons: ${daemons.join(', ')}`, {
        isClientMessage: true
      });

    // Set up each daemon's log stream
    let successCount = 0;

    const daemonSetupPromises = daemons.map(async (daemonName) => {
      try {
        // Get container ID for this daemon
        const containerId = await dockerUtils.getContainerId(daemonName);
        console.log(`[${this.streamId}] Found container ID: ${containerId} for daemon: ${daemonName}`);
        this.containerIds[daemonName] = containerId;

        // Get and send initial logs for this daemon
        try {
          const initialLogs = await dockerUtils.getInitialLogs(containerId);

          if (initialLogs && initialLogs.trim()) {
            publishToStream(this.streamId, 'info',
              `--- Recent logs from ${daemonName} (historical) ---`, {
                isClientMessage: true
              });

            publishToStream(this.streamId, 'log', initialLogs, {
              daemon: daemonName
            });

            publishToStream(this.streamId, 'info',
              `--- End of historical logs for ${daemonName}, now streaming live logs ---`, {
                isClientMessage: true
              });
          } else {
            publishToStream(this.streamId, 'info',
              `No recent logs available for ${daemonName}. New logs will appear automatically.`, {
                isClientMessage: true
              });
          }
        } catch (error) {
          console.error(`[${this.streamId}] Error getting initial logs for ${daemonName}:`, error);
          publishToStream(this.streamId, 'error',
            `Error loading initial logs for ${daemonName}: ${error.message}`, {
              isClientMessage: true
            });
          // Continue anyway - we'll just stream new logs
        }

        // Start log streaming process for this daemon
        const logProcess = dockerUtils.createLogStream(containerId);

        // Add to processes array
        this.processes.push({
          process: logProcess,
          daemon: daemonName,
          containerId
        });

        // Set up event handlers for this process
        this._setupProcessEventHandlers(logProcess, daemonName, containerId);

        // Mark this daemon's setup as successful
        successCount++;
        return true;
      } catch (error) {
        // Special handling for containers that exist but aren't running
        if (error && error.notRunning === true) {
          console.log(`[${this.streamId}] Container for daemon ${daemonName} exists but is not running`);

          publishToStream(this.streamId, 'info',
            `Daemon ${daemonName} container exists but is not running. No logs will be shown for this daemon.`, {
              isClientMessage: true
            });

          // Don't count this as a failure in combined mode
          return false;
        }

        console.error(`[${this.streamId}] Error setting up log stream for daemon ${daemonName}:`, error);

        publishToStream(this.streamId, 'error',
          `Failed to set up log stream for daemon ${daemonName}: ${error.message || 'Unknown error'}`, {
            isClientMessage: true
          });

        return false;
      }
    });

    // Wait for all daemon setups to complete
    await Promise.all(daemonSetupPromises);

    // Check if at least one daemon was successfully set up
    if (successCount > 0) {
      // Emit ready event
      this.emit('ready', this.streamId);
      return true;
    } else {
      throw new Error('Failed to set up any daemon log streams');
    }
  }

  /**
   * Set up event handlers for a log process
   * @param {ChildProcess} logProcess - The process to handle
   * @param {string} daemonName - Daemon name
   * @param {string} containerId - Container ID
   * @private
   */
  _setupProcessEventHandlers (logProcess, daemonName, containerId) {
    // Handle stdout data
    logProcess.stdout.on('data', (data) => {
      const message = data.toString();
      if (message.trim()) {
        publishToStream(this.streamId, 'log', message, {
          daemon: daemonName
        });
      }
    });

    // Handle stderr data
    logProcess.stderr.on('data', (data) => {
      const message = data.toString();
      publishToStream(this.streamId, 'error', message, {
        daemon: daemonName
      });
    });

    // Handle process exit (with restart logic)
    logProcess.on('close', (code) => {
      console.log(`[${this.streamId}] Log process for ${daemonName} exited with code ${code}`);

      publishToStream(this.streamId, 'info',
        `Log stream for daemon ${daemonName} ended with code ${code}. Attempting to restart...`, {
          isClientMessage: true
        });

      // Automatically restart this daemon's process if the stream is still active
      if (this.active && Date.now() < this.expiresAt) {
        console.log(`[${this.streamId}] Restarting log stream for daemon: ${daemonName}`);

        // Remove the old process from the processes array
        this.processes = this.processes.filter(p => p.daemon !== daemonName);

        // Wait a bit and restart just this daemon's process
        setTimeout(() => {
          if (this.active && Date.now() < this.expiresAt) {
            try {
              // Start a new log process for this daemon
              const newLogProcess = dockerUtils.createLogStream(containerId);

              // Update the processes array with the new process
              this.processes.push({
                process: newLogProcess,
                daemon: daemonName,
                containerId
              });

              // Set up the same event handlers for the new process
              this._setupProcessEventHandlers(newLogProcess, daemonName, containerId);

              publishToStream(this.streamId, 'info',
                `Successfully restarted log stream for daemon ${daemonName}`, {
                  isClientMessage: true
                });
            } catch (error) {
              console.error(`[${this.streamId}] Error restarting log process for ${daemonName}:`, error);

              publishToStream(this.streamId, 'error',
                `Failed to restart log stream for daemon ${daemonName}: ${error.message}`, {
                  isClientMessage: true
                });
            }
          }
        }, 5000);
      }
    });

    // Handle process errors
    logProcess.on('error', (error) => {
      console.error(`[${this.streamId}] Error with log process for ${daemonName}:`, error);

      publishToStream(this.streamId, 'error', `Log process error for ${daemonName}: ${error.message}`, {
        isClientMessage: true
      });
    });
  }

  /**
   * Stop the stream and cleanup
   * @returns {boolean} Success status
   */
  stop () {
    if (!this.active) return false;

    this._stopHeartbeat();

    if (this.isCombined) {
      // Stop all processes in a combined stream
      this.processes.forEach(process => {
        if (process.process) {
          try {
            process.process.kill();
            console.log(`Killed log process for daemon: ${process.daemon}`);
          } catch (error) {
            console.error(`Error killing process for ${process.daemon}:`, error);
          }
        }
      });
      // Clear processes array
      this.processes = [];
    } else if (this.process) {
      // Stop a single stream process
      try {
        this.process.kill();
        console.log(`Killed log process for daemon: ${this.daemon}`);
      } catch (error) {
        console.error(`Error killing process for ${this.daemon}:`, error);
      }
      this.process = null;
    }

    publishToStream(this.streamId, 'info', 'Log stream has been stopped', {
      isClientMessage: true
    });

    this.active = false;
    this.emit('stopped', this.streamId);

    return true;
  }

  /**
   * Restart the stream
   * @returns {Promise<boolean>} Success status
   */
  async restart () {
    this.stop();

    // Update stream info for restart
    this.streamInfo.restartCount = (this.streamInfo.restartCount || 0) + 1;
    this.streamInfo.lastRestart = Date.now();

    // Wait a moment before restarting
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Only restart if not expired
    if (Date.now() < this.expiresAt) {
      return this.start();
    }

    return false;
  }

  /**
   * Check if the stream is expired
   * @returns {boolean} True if expired
   */
  isExpired () {
    return Date.now() > this.expiresAt;
  }

  /**
   * Get stream info for reporting
   * @returns {Object} Stream information
   */
  getInfo () {
    const result = {
      streamId: this.streamId,
      expiresAt: this.expiresAt,
      timeRemaining: Math.max(0, this.expiresAt - Date.now()),
      active: this.active
    };

    if (this.isCombined) {
      result.daemon = 'all';
      result.daemons = this.streamInfo.daemons;
      result.processCount = this.processes.length;
    } else {
      result.daemon = this.daemon;
    }

    return result;
  }
}

module.exports = LogStream;
