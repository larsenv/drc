'use strict';

const { MessageEmbed } = require('discord.js');
const { matchNetwork, searchLogs, fmtDuration, resolveNameForDiscord } = require('../../util');
const { serveMessages } = require('../common');
const { transformAveragesForDigestHTTP, roundSentimentScoreOnMessages } = require('../../lib/sentiments');
const config = require('config').anthropic;
const { Anthropic } = require('@anthropic-ai/sdk');

const search = async (context, network, titleMessage = `Searching **${network}**...`) => {
  const start = new Date();
  context.sendToBotChan(titleMessage);

  console.debug('SEARCH opts', context.options);
  const { totalLines, searchResults, error, sentiments } = await searchLogs(network, context.options);

  if (error) {
    context.sendToBotChan('Search failed: \n```\n' + error + '\n```\n');
    return;
  }

  const durFmtted = fmtDuration(start, true);
  const delta = new Date() - start;
  const foundLines = Object.values(searchResults).reduce((a, x) => a + x.length, 0);
  const { categoriesByName, channelsById } = context;

  if (!foundLines) {
    context.sendToBotChan(`Found no matching lines out of **${totalLines}** total.\n` +
    'Not expecting zero results? Try with `--everything`, `--orKeys`, and/or a different `--type`.\n' +
    `Search completed in **${durFmtted.length ? durFmtted : 'no time'}** (${delta}).`);
  } else {
    const networkCatIds = Object.fromEntries(Object.entries(categoriesByName).filter(([k]) => k === network))[network];
    const networkChannels = Object.entries(channelsById)
      .filter(([, { parent }]) => networkCatIds.includes(parent))
      .reduce((a, [id, { name }]) => ({
        [name]: id,
        ...a
      }), {});

    const embed = new MessageEmbed()
      .setTitle(`**${foundLines}** matching lines`)
      .setColor('DARK_GOLD')
      .setFooter(`Search completed in ${durFmtted.length ? durFmtted : 'no time'} (${delta})`);

    const cTrim = (cs) => cs.replaceAll('#', '').toLowerCase();

    const resolveMeSerially = Object.entries(searchResults)
      .sort(([chanA], [chanB]) => cTrim(chanA).localeCompare(cTrim(chanB)))
      .sort(([, linesA], [, linesB]) => linesB.length - linesA.length)
      .map(async ([chan, lines]) => {
        return [chan, lines, await resolveNameForDiscord(network, chan)];
      });

    for (const r of resolveMeSerially) {
      const [chan, lines, discResolved] = await r;
      const discordChannelId = networkChannels[discResolved];
      if (!discordChannelId) {
        console.warn('No channel ID! (may be expected if channel was a PM channel or was otherwise removed)',
          discordChannelId, networkChannels, cTrim(chan), chan, discResolved);
      }
      let chanStr = discordChannelId ? `<#${discordChannelId}>` : chan;
      if (sentiments && sentiments.perChan[chan]) {
        const { score, comparative } = sentiments.perChan[chan];
        chanStr += `\nsentiment: ${Number(comparative).toFixed(3)} (${Number(score).toFixed(1)})`;
      }
      embed.addField(`${lines.length} line(s) found in`, chanStr);
    }

    context.sendToBotChan({ embeds: [embed] }, true);

    if (!context.options?.doNotServe) {
      let serveData = [];
      const onlySentiment = context.options.justSentiment || context.options.onlySentiment;
      if (!onlySentiment) {
        serveData = Object.values(searchResults)
          .reduce((a, l) => a.concat(l), [])
          .map((data) => ({
            timestamp: data.__drcIrcRxTs,
            data
          }));
      } else {
        context.options.serve = true;
      }

      roundSentimentScoreOnMessages(serveData.map(({ data }) => data));

      let channelSummaries = null;
      if (!context.options?.isDigestCommand || context.options?.serve) {
        channelSummaries = await generateChannelSummaries(network, searchResults, context);
      }

      // Handle summarizeOnly option
      const isSummarizeOnly = context.options?.summarizeOnly && context.options?.serve;
      if (isSummarizeOnly) {
        // If summarizeOnly is specified, we don't include the actual messages
        serveData = [];
      }

      // Process excluded channels list if provided
      const excludedChannels = context.options?.excludeChannels
        ? context.options.excludeChannels.split(',').map(c => c.trim())
        : [];

      // Extract minutes value from the digest command
      const minutesValue = context.options?.isDigestCommand &&
        context.argObj?._.length > 2
        ? Number.parseInt(context.argObj._[2])
        : null;
      console.log('minutes?', minutesValue, context.options?.isDigestCommand, context.argObj);

      serveMessages({ network, ...context }, serveData, {
        extra: {
          sentiments: transformAveragesForDigestHTTP(sentiments),
          channelSummaries: channelSummaries || null,
          summarizeOnly: isSummarizeOnly,
          excludedChannels: excludedChannels.length > 0 ? excludedChannels : null,
          minutes: minutesValue
        }
      });
    }
  }
};

async function f (context) {
  const [netStub, subCmd, subCmdArg1] = context.argObj._;
  const { network } = matchNetwork(netStub);

  if (subCmd) {
    let subParsed;
    if (subCmd === 'digest' && subCmdArg1 && !Number.isNaN((subParsed = Number.parseInt(subCmdArg1)))) {
      context.options = {
        ...context.options,
        from: `-${subParsed}m`,
        doNotServe: !(context.options?.serve ?? false),
        isDigestCommand: true
      };

      return search(context, network, `Producing digest of last **${subParsed} minutes** of activity...`);
    }
  }

  return search(context, network)
    .catch(e => {
      console.error('search failed', e);
      context.sendToBotChan(`Search failed: ${e}`);
    });
}

f.__drcHelp = () => {
  return {
    title: 'Query & search IRC logs',
    usage: '<network> [arguments] [options]',
    notes: 'Anywhere a time value is required, it may be anything parseable by `new Date()`, ' +
      '_or_ a duration value (negative of course, as searching into the future isn\'t quite perfect yet).' +
      '\n\nExamples:\n\t• `-1h` for "one hour in the past".\n\t' +
      '• `2022-12-25T23:59:00` for "right before Santa arrives"\n' +
      '• `"Mon Jan 23 2023 20:58:00 PST"` for "9:58PM on Monday January 23rd 2023 in the Pacific Time Zone"\n' +
      '• `"three days ago"` for "three days ago"\n\n' +
      'Fields that take string arguments (pretty much any *but* time' +
      'fields) may include the SQLite wildcard characters "%" and "_", where their meaning is as-expected.',
    options: [
      ['--from', 'The oldest time from which to fetch messages', true],
      ['--to', 'The youngest time from which to fetch messages', true],
      ['--message', 'The message contents to search for', true],
      ['--nick', 'The nickname to search for', true],
      ['--channel', 'The channel (or target) to search for; `--target` is an allowed synonym.', true],
      ['--host', 'The host (hostname) to search for; `--hostname` is an allowed synonym.', true],
      ['--ident', 'The user ident to search for', true],
      ['--type', 'The message type ("notice", "privmsg", etc) to search for', true],
      ['--columns', 'A comma-separated list of columns to include', true],
      ['--from_server', 'Only include messages that originated from the server', false],
      ['--orKeys', 'Comma-seperated list of the search keys (all of the above) to OR together in the query', false],
      ['--everything', 'Include all sources; default is just channels', false],
      ['--distinct', 'Apply DISTINCT to the search', false],
      ['--template', 'Default template to use for digest rendering (e.g., "modern", "plain"). Can be overridden with ?template= query param', true],
      ['--summarizeOnly', 'When used with --serve for digest, renders only channel summaries and sentiment analysis without showing individual messages', false],
      ['--excludeChannels', 'Comma-separated list of channel names (without # prefix) to exclude from channel summaries', true]
    ]
  };
};

// Initialize Anthropic client
const anthropicClient = new Anthropic({ apiKey: config.secretKey });

/**
 * Generate summaries for each channel's messages using Anthropic's Claude AI
 * @param {string} network - The network name
 * @param {Object} searchResults - The search results grouped by channel
 * @param {Object} context - The command context
 * @returns {Object} - Channel summaries indexed by channel name
 */
async function generateChannelSummaries (network, searchResults, context) {
  // Skip if no API key is configured
  if (!config.secretKey) {
    console.warn('Anthropic API key not configured, skipping channel summaries');
    return null;
  }

  const channelSummaries = {};
  const systemPrompt = require('config').genai.summarySystemPrompt;

  // Parse excluded channels if provided
  const excludedChannels = [];
  if (context.options?.excludeChannels) {
    const excludeList = context.options.excludeChannels.split(',').map(c => c.trim().toLowerCase());
    excludedChannels.push(...excludeList);
    console.log(`Excluding channels from summary: ${excludedChannels.join(', ')}`);
  }

  try {
    context.sendToBotChan('Generating channel summaries using Claude...');
    const model = config.summaryModel || config.model || 'claude-3-haiku-20240307';
    console.info(`Using model "${model}" for channel summaries`);

    // Process each channel's messages
    for (const [channel, messages] of Object.entries(searchResults)) {
      // Skip excluded channels
      const channelName = channel.replace(/^[#]+/, '').toLowerCase();
      if (excludedChannels.includes(channelName)) {
        console.log(`Skipping excluded channel: ${channel}`);
        continue;
      }

      if (messages.length === 0) {
        continue;
      }

      // Format the messages into a string to send to Claude
      const formattedMessages = messages.map(msg => {
        const time = new Date(msg.__drcIrcRxTs).toISOString();
        return `[${time}] <${msg.nick}> ${msg.message}`;
      }).join('\n');

      // Skip if no messages with content
      if (!formattedMessages.trim()) {
        continue;
      }

      // Initialize variables at a scope that will be accessible in the catch block
      let currentMessages = formattedMessages;
      let retryCount = 0;
      let rateLimitRetries = 0;
      const maxRetries = 20;
      let currentMessageCount = messages.length;
      const summaryStartTime = Date.now();

      try {
        while (retryCount <= maxRetries) {
          try {
            // Call the Anthropic API
            const response = await anthropicClient.messages.create({
              model,
              max_tokens: 500,
              temperature: 0.7,
              messages: [{ role: 'user', content: currentMessages }],
              system: systemPrompt
            });

            // Calculate duration in milliseconds
            const summaryDuration = Date.now() - summaryStartTime;

            // Store the summary and timing information
            channelSummaries[channel] = {
              text: response.content?.[0]?.text || '',
              durationMs: summaryDuration,
              retryCount: retryCount,
              rateLimitRetries: rateLimitRetries,
              messageCount: messages.length,
              finalMessageCount: currentMessageCount
            };

            console.log(`Generated summary for channel ${channel} in ${summaryDuration}ms (${(summaryDuration / 1000).toFixed(2)}s)`);
            break;
          } catch (apiError) {
            // Check if the error is due to the prompt being too long
            if (apiError.status === 400 &&
                apiError.error?.error?.type === 'invalid_request_error' &&
                apiError.error?.error?.message?.includes('prompt is too long')) {
              // Extract token counts from error message
              const tokenMatch = apiError.error?.error?.message.match(/(\d+) tokens > (\d+) maximum/);

              // On the first retry, use token counts if available, otherwise use a more aggressive approach
              let reductionRatio = 0.10;

              if (tokenMatch && tokenMatch.length >= 3 && retryCount === 0) {
                const currentTokens = parseInt(tokenMatch[1]);
                const maxTokens = parseInt(tokenMatch[2]);
                const excessTokens = currentTokens - maxTokens;

                // Assume a token is about 3 characters on average
                // Calculate reduction percentage based on excess tokens with a larger safety margin (20%)
                reductionRatio = Math.min(0.9, (excessTokens + excessTokens * 0.2) / currentTokens);

                // Make sure we're reducing by at least 10% to avoid too many retries
                reductionRatio = Math.max(reductionRatio, 0.10);
              } else {
                // For subsequent retries, get more aggressive with each retry
                // Start with 15% reduction, then 25%, 35%, etc. up to 90%
                reductionRatio = Math.min(0.9, 0.15 + (retryCount * 0.1));
              }

              // Calculate how many messages to keep
              const messagesToKeep = Math.floor(currentMessageCount * (1 - reductionRatio));

              // Always keep at least 5% of original messages or 5 messages, whichever is greater
              const minimumMessagesToKeep = Math.max(5, Math.floor(messages.length * 0.05));
              const actualMessagesToKeep = Math.max(messagesToKeep, minimumMessagesToKeep);

              // If we've already reduced to the minimum, cut the content of each message
              if (currentMessageCount <= minimumMessagesToKeep) {
                // Create a shortened version of each message by truncating content
                const truncationRatio = 1 - (retryCount * 0.05);
                const messageArray = currentMessages.split('\n');
                currentMessages = messageArray.map(msg => {
                  const parts = msg.split('> ');
                  if (parts.length < 2) return msg;

                  const prefix = parts[0] + '> ';
                  const content = parts.slice(1).join('> ');
                  const maxContentLength = Math.max(10, Math.floor(content.length * truncationRatio));
                  return prefix + content.substring(0, maxContentLength);
                }).join('\n');
              } else {
                // Take the most recent messages
                const reducedMessages = messages.slice(-actualMessagesToKeep);

                // Update current count for next iteration
                currentMessageCount = reducedMessages.length;

                // Reformat messages
                currentMessages = reducedMessages.map(msg => {
                  const time = new Date(msg.__drcIrcRxTs).toISOString();
                  return `[${time}] <${msg.nick}> ${msg.message}`;
                }).join('\n');
              }

              console.log(`Prompt too long for ${channel}. Reducing from ${messages.length} to ${currentMessageCount} messages (ratio: ${reductionRatio.toFixed(2)}) and retrying.`);
              retryCount++;
              continue;
            }

            // Check if this is a rate limit error
            if (apiError.status === 429) {
              rateLimitRetries++;
              console.log(`Rate limit hit for ${channel}. Waiting ${1 * rateLimitRetries} second(s) before retrying (rate limit retry #${rateLimitRetries})...`);
              // Simple delay function using promises
              await new Promise(resolve => setTimeout(resolve, 1000 * rateLimitRetries));
              continue;
            }

            // If not a token limit error or rate limit error, re-throw
            throw apiError;
          }
        }

        // If we exhausted our retries, add a note to the summary
        if (retryCount > maxRetries) {
          const summaryDuration = Date.now() - summaryStartTime;
          channelSummaries[channel] = {
            text: 'Error: Failed to generate summary after multiple attempts to reduce prompt size.',
            durationMs: summaryDuration,
            retryCount: retryCount,
            rateLimitRetries: rateLimitRetries,
            messageCount: messages.length,
            finalMessageCount: currentMessageCount,
            error: true
          };
          console.warn(`Failed to generate summary for ${channel} after ${maxRetries} retries (${summaryDuration}ms)`);
        }
      } catch (err) {
        const summaryDuration = Date.now() - summaryStartTime;
        console.error(`Error generating summary for channel ${channel}:`, err);
        channelSummaries[channel] = {
          text: `Error generating summary: ${err.message}`,
          durationMs: summaryDuration,
          retryCount: retryCount,
          rateLimitRetries: rateLimitRetries,
          messageCount: messages.length,
          finalMessageCount: currentMessageCount || messages.length,
          error: true
        };
      }
    }

    // Format the summaries for the HTML template
    const formattedSummaries = {
      channels: Object.entries(channelSummaries).map(([channel, summaryData]) => {
        // Handle both string and object formats for backward compatibility
        const isLegacyFormat = typeof summaryData === 'string';
        return {
          channel,
          summary: isLegacyFormat ? summaryData : summaryData.text,
          durationSec: isLegacyFormat ? null : (summaryData.durationMs / 1000).toFixed(2),
          retryCount: isLegacyFormat ? null : summaryData.retryCount,
          rateLimitRetries: isLegacyFormat ? null : summaryData.rateLimitRetries,
          messageCount: isLegacyFormat ? null : summaryData.messageCount,
          finalMessageCount: isLegacyFormat ? null : summaryData.finalMessageCount,
          messagesReduced: isLegacyFormat ? false : summaryData.finalMessageCount < summaryData.messageCount,
          reductionPercent: isLegacyFormat
            ? null
            : summaryData.messageCount
              ? (100 - (summaryData.finalMessageCount / summaryData.messageCount * 100)).toFixed(1)
              : null,
          hasError: isLegacyFormat ? false : !!summaryData.error
        };
      }).sort((a, b) => a.channel.localeCompare(b.channel))
    };

    // Store the summaries in the context for the HTML template
    context.options.channelSummaries = formattedSummaries;

    return formattedSummaries;
  } catch (error) {
    console.error('Error generating channel summaries:', error);
    return null;
  }
}

f.search = search;
f.generateChannelSummaries = generateChannelSummaries;

module.exports = f;
