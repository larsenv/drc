'use strict';

const { spawn, exec } = require('child_process');

/**
 * Check if Docker is accessible
 * @returns {Promise<boolean>} True if Docker is accessible
 */
function checkDockerAccess () {
  return new Promise((resolve, reject) => {
    exec('docker --version', (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`Docker is not accessible: ${error.message}`));
        return;
      }

      console.log(`Docker is available: ${stdout.trim()}`);
      resolve(true);
    });
  });
}

/**
 * Get container ID from daemon name - handles different container naming patterns
 * @param {string} daemon - Daemon name
 * @returns {Promise<string>} Container ID
 */
function getContainerId (daemon) {
  return new Promise((resolve, reject) => {
    // Try different possible container name patterns
    // 1. Exact daemon name
    // 2. drc-daemon-1 format
    // 3. Allowing case differences
    const possibleNames = [
      daemon,
      `drc-${daemon}-1`,
      `drc_${daemon}_1`
    ];

    console.log(`Looking for container for daemon '${daemon}', trying: ${possibleNames.join(', ')}`);

    // First get all container IDs and names - note we include stopped containers
    exec('docker ps -a | grep -i "drc\\|discord\\|http\\|irc\\|prometheus"', (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`Failed to list containers: ${error.message}`));
        return;
      }

      // Parse the output to find matching containers
      const lines = stdout.trim().split('\n');
      if (lines.length === 0) {
        reject(new Error('No containers found in docker ps output'));
        return;
      }

      // Look for matches in each line
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const parts = line.split(/\s+/);
        // Docker PS format: ID | IMAGE | COMMAND | CREATED | STATUS | PORTS | NAME
        const containerId = parts[0]; // First column is container ID
        const containerName = parts[parts.length - 1]; // Last column is the name
        // Check if container is running (status column contains "Up")
        const isRunning = line.includes(' Up ');

        // Expected container name for this daemon
        const expectedName = `drc-${daemon}-1`;

        // Check if this container name matches our daemon
        // First try an exact match with our expected pattern
        let matchesPattern = containerName.toLowerCase() === expectedName.toLowerCase();

        // If no exact match, check for general matches
        if (!matchesPattern) {
          matchesPattern = containerName.toLowerCase().includes(daemon.toLowerCase());
        }

        // Finally, try our pattern list
        if (!matchesPattern) {
          matchesPattern = possibleNames.some(pattern => {
            return containerName.toLowerCase().includes(pattern.toLowerCase());
          });
        }

        if (matchesPattern) {
          console.log(`Found matching container: ${containerName} with ID: ${containerId}, running: ${isRunning}`);

          // If container exists but is not running, return special error object
          if (!isRunning) {
            const notRunningError = new Error(`Container ${containerName} exists but is not running`);
            notRunningError.containerId = containerId;
            notRunningError.containerName = containerName;
            notRunningError.notRunning = true;
            reject(notRunningError);
            return;
          }

          // We already have the container ID from docker ps output
          resolve(containerId);
          return;
        }
      }

      // If we get here and haven't returned, no matching container was found
      reject(new Error(`No container found for daemon: ${daemon}`));
    });
  });
}

/**
 * Get initial logs from container
 * @param {string} containerId - Container ID
 * @param {number} limit - Maximum number of log lines to retrieve
 * @returns {Promise<string>} Container logs
 */
function getInitialLogs (containerId, limit = 20) {
  return new Promise((resolve, reject) => {
    exec(`docker logs --tail=${limit} --timestamps ${containerId}`, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`Failed to get initial logs: ${error.message}`));
        return;
      }

      resolve(stdout);
    });
  });
}

/**
 * Create a Docker log stream process
 * @param {string} containerId - Container ID
 * @param {Object} options - Options for the log stream
 * @returns {ChildProcess} Spawned process for log streaming
 */
function createLogStream (containerId, options = {}) {
  const { since = '1s' } = options;

  return spawn('docker', ['logs', '--follow', `--since=${since}`, '--timestamps', containerId], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

module.exports = {
  checkDockerAccess,
  getContainerId,
  getInitialLogs,
  createLogStream
};
