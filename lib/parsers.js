'use strict';

const config = require('../config');

const SERIAL_PIPE_TOKEN = '|>';
const CONC_PIPE_TOKEN = '!>';

function checkMessageStringForPipes (messageString) {
  if (!(messageString.indexOf(SERIAL_PIPE_TOKEN) !== -1 || messageString.indexOf(CONC_PIPE_TOKEN) !== -1)) {
    return false;
  }

  return true;
}

function parseMessageStringForPipes (messageString, commandWrapperFunc = (s) => s) {
  if (!checkMessageStringForPipes(messageString)) {
    return null;
  }

  const funcsParsed = messageString
    .split(SERIAL_PIPE_TOKEN)
    .filter((s) => s.length > 0)
    .map((s) => s.trim())
    .map((s) =>
      async () => Promise.all(s.split(CONC_PIPE_TOKEN)
        .filter((si) => si.length > 0)
        .map((si) => si.trim())
        .map(commandWrapperFunc))
    );

  return async function () {
    const results = [];
    for (const serialChunk of funcsParsed) {
      results.push(await serialChunk());
    }
    return results;
  };
}

function parseArgsForQuotes (args) {
  const results = [];
  let collecting = false;
  let currentQuotedArg = [];

  // Process each argument
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    // Check if this argument starts a quoted section
    if (!collecting && (arg.indexOf('"') === 0 || arg.match(/--\w+="/))) {
      // Start collecting a quoted argument
      collecting = true;
      currentQuotedArg = [arg];

      // If it also ends a quote in the same token, add it and stop collecting
      if (arg.endsWith('"') && (arg.match(/"/g) || []).length >= 2) {
        results.push(currentQuotedArg.join(' '));
        collecting = false;
        currentQuotedArg = [];
      }
    } else if (collecting && arg.match(/[^"]*"$/)) {
      // If we're already collecting and this ends with a quote
      currentQuotedArg.push(arg);
      results.push(currentQuotedArg.join(' '));
      collecting = false;
      currentQuotedArg = [];
    } else if (collecting) {
      // If we're collecting but this doesn't end the quote
      currentQuotedArg.push(arg);
    } else {
      // Just a normal argument, not part of a quote
      results.push(arg);
    }
  }

  // Add any uncompleted quoted args (shouldn't happen with proper quoting)
  if (collecting && currentQuotedArg.length > 0) {
    results.push(currentQuotedArg.join(' '));
  }

  return results;
}

function parseCommandAndArgs (trimContent, {
  autoPrefixCurrentCommandChar = false
} = {}) {
  if (autoPrefixCurrentCommandChar) {
    if (trimContent.indexOf(config.app.allowedSpeakersCommandPrefixCharacter) !== -1) {
      throw new Error(`Programming error: autoPrefixCurrentCommandChar == true but command string already prefixed:\n\t"${trimContent}"`);
    }

    console.info(`Auto-prefixing '${config.app.allowedSpeakersCommandPrefixCharacter}' onto "${trimContent}"`);
    trimContent = config.app.allowedSpeakersCommandPrefixCharacter + trimContent;
  }

  if (trimContent.indexOf(config.app.allowedSpeakersCommandPrefixCharacter) === -1) {
    throw new Error(`Programming error: parseCommandAndArgs called with malformed argument:\n\t"${trimContent}"`);
  }

  const [command, ...args] = trimContent.slice(
    trimContent.indexOf(config.app.allowedSpeakersCommandPrefixCharacter) + 1
  ).trim().split(/\s+/);

  return { command, args };
}

module.exports = {
  parseMessageStringForPipes,
  parseArgsForQuotes,
  parseCommandAndArgs
};
