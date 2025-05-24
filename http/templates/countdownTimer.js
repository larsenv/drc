/**
 * Template partial for the countdown timer
 * Include this in templates to render the countdown timer
 */

function countdownTimerTemplate () {
  return `
{{#documentExpiresAt}}
<!-- Countdown timer for self-destruct -->
<span id="document-expires-at" style="display: none;">{{ documentExpiresAt }}</span>
<span id="document-expires-unix" style="display: none;">{{ documentExpiresAtUnix }}</span>
&amp; will self-destruct in <strong id="countdown-timer">calculating...</strong>
<script src="/js/countdownTimer.js"></script>
{{/documentExpiresAt}}
  `;
}

module.exports = countdownTimerTemplate;
