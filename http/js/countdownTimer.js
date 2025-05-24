/**
 * Countdown timer for document expiry
 * Displays time remaining before document self-destructs
 */

(function () {
  'use strict';

  // Initialize countdown when DOM is ready
  document.addEventListener('DOMContentLoaded', function () {
    // Get the expiry timestamp from the page
    const expiryUnixTimestamp = document.getElementById('document-expires-unix');
    if (!expiryUnixTimestamp) return; // No expiry found

    const expiryTimestamp = parseInt(expiryUnixTimestamp.textContent, 10) * 1000; // Convert to milliseconds
    const countdownElement = document.getElementById('countdown-timer');

    if (!countdownElement) return; // No countdown element found

    // Initial update
    updateCountdown();

    // Update countdown every second
    const countdownInterval = setInterval(updateCountdown, 1000);

    function updateCountdown () {
      const now = Date.now();
      const timeRemaining = expiryTimestamp - now;

      // If expired, stop the interval and reload the page
      if (timeRemaining <= 0) {
        clearInterval(countdownInterval);
        countdownElement.textContent = 'Expired! Reloading...';
        setTimeout(() => window.location.reload(), 2000);
        return;
      }

      // Calculate hours, minutes, seconds
      const hours = Math.floor(timeRemaining / (1000 * 60 * 60));
      const minutes = Math.floor((timeRemaining % (1000 * 60 * 60)) / (1000 * 60));
      const seconds = Math.floor((timeRemaining % (1000 * 60)) / 1000);

      // Build display text
      let displayText = '';

      if (hours > 0) {
        displayText += `${hours} hour${hours !== 1 ? 's' : ''} `;
      }

      if (minutes > 0 || hours > 0) {
        displayText += `${minutes} minute${minutes !== 1 ? 's' : ''} `;
      }

      // Only show seconds when less than 2 minutes remain
      if (hours === 0 && minutes < 2) {
        displayText += `${seconds} second${seconds !== 1 ? 's' : ''} `;
      }

      countdownElement.textContent = displayText.trim();
    }
  });
})();
