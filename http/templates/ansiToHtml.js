/**
 * Converts ANSI color codes in a string to HTML spans with appropriate classes
 * Based on ANSI color codes reference: https://en.wikipedia.org/wiki/ANSI_escape_code#Colors
 * @param {string} text - The text containing ANSI color codes to convert
 * @returns {DocumentFragment} A document fragment containing styled spans
 */

const iso8601Regex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

window.convertAnsiToHtml = function (text) {
  // If text is null, empty, or has no ANSI codes, return quickly
  if (!text || typeof text !== 'string' || !text.includes('\u001b[')) {
    return document.createTextNode(text || '');
  }

  // Split the text into segments of text and ANSI escape sequences
  const segments = [];
  // Use a regular expression to match ANSI escape codes
  // eslint-disable-next-line no-control-regex
  const pattern = /\u001b\[((?:\d+;)*\d+)?m/g;
  let match;
  let lastIndex = 0;

  // Find all ANSI sequences
  while ((match = pattern.exec(text)) !== null) {
    // Add the text before the ANSI code
    if (match.index > lastIndex) {
      segments.push({
        type: 'text',
        content: text.substring(lastIndex, match.index)
      });
    }

    // Add the ANSI code
    segments.push({
      type: 'ansi',
      content: match[1] || '0' // Default to '0' (reset) if no code specified
    });

    lastIndex = match.index + match[0].length;
  }

  // Add any remaining text
  if (lastIndex < text.length) {
    segments.push({
      type: 'text',
      content: text.substring(lastIndex)
    });
  }

  // Create a document fragment to hold all the elements
  const fragment = document.createDocumentFragment();

  // Stack of currently active styles
  const styleStack = [];

  // Process each segment
  segments.forEach(segment => {
    if (segment.type === 'ansi') {
      // Handle ANSI codes
      const codes = segment.content.split(';').map(code => parseInt(code, 10));

      if (codes.includes(0)) {
        // Reset all styles
        styleStack.length = 0;
      } else {
        // Apply new styles
        codes.forEach(code => {
          if (code >= 30 && code <= 37) {
            // Foreground colors
            const colorIndex = code - 30;
            const colorClass = getColorClass(colorIndex, false, false);
            styleStack.push(colorClass);
          } else if (code >= 90 && code <= 97) {
            // Bright foreground colors
            const colorIndex = code - 90;
            const colorClass = getColorClass(colorIndex, false, true);
            styleStack.push(colorClass);
          } else if (code >= 40 && code <= 47) {
            // Background colors
            const colorIndex = code - 40;
            const colorClass = getColorClass(colorIndex, true, false);
            styleStack.push(colorClass);
          } else if (code === 1) {
            // Bold
            styleStack.push('ansi-bold');
          } else if (code === 3) {
            // Italic
            styleStack.push('ansi-italic');
          } else if (code === 4) {
            // Underline
            styleStack.push('ansi-underline');
          }
        });
      }
    } else if (segment.type === 'text') {
      if (segment.content.match(iso8601Regex)) {
        return;
      }

      // Check for log level pattern: [level] rest of the message
      const logLevelMatch = segment.content.match(/^\s*\[(\w+)\](.+)/);

      if (logLevelMatch) {
        const logLevel = logLevelMatch[1].toLowerCase();
        const restOfMessage = logLevelMatch[2];

        // Create a log level badge
        const levelBadge = document.createElement('span');
        levelBadge.className = `log-level log-level-${logLevel}`;
        levelBadge.textContent = logLevel;
        fragment.appendChild(levelBadge);

        // Process the rest of the message with existing styles
        if (styleStack.length > 0) {
          const span = document.createElement('span');
          span.className = styleStack.join(' ');
          span.textContent = restOfMessage;
          fragment.appendChild(span);
        } else {
          fragment.appendChild(document.createTextNode(restOfMessage));
        }
      } else {
        // Standard text processing - create a new styled span if we have active styles
        if (styleStack.length > 0) {
          // Create a new span with all current styles
          const span = document.createElement('span');
          span.className = styleStack.join(' ');
          span.textContent = segment.content.replace(/^\s*/, '');
          fragment.appendChild(span);
        } else {
          // No styles, just add the text
          fragment.appendChild(document.createTextNode(segment.content));
        }
      }
    }
  });

  return fragment;
};

// Helper function to get the appropriate color class
function getColorClass (colorIndex, isBackground, isBright) {
  const colors = [
    'black', 'red', 'green', 'yellow',
    'blue', 'magenta', 'cyan', 'white'
  ];

  const prefix = isBackground ? 'ansi-bg-' : 'ansi-';
  const brightPrefix = isBright ? 'bright-' : '';

  return prefix + brightPrefix + colors[colorIndex];
}
