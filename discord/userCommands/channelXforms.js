'use strict';

const config = require('config');
const { matchNetwork, ChannelXforms, expiryDurationFromOptions } = require('../../util');
const { formatKVs, servePage, convertDiscordChannelsToIRCInString } = require('../common');
const { nanoid } = require('nanoid');

async function formattedGet (network) {
  return `\nChannel transforms for **${network}** (\`Discord\` → IRC):\n` +
    formatKVs(Object.fromEntries(Object.entries(
      (await ChannelXforms.forNetwork(network))).map(([k, v]) => [`#${k}`, `#${v}`])), ' → ');
}

const serveCache = {};

const subCommands = {
  get: async (context, network) => formattedGet(network),

  set: async (context, network, dChan, iChan) => {
    iChan = await convertDiscordChannelsToIRCInString(iChan, context);
    await ChannelXforms.set(network, dChan, iChan.replace(/\\/g, ''));
    return formattedGet(network);
  },

  remove: async (context, network, dChan) => {
    await ChannelXforms.remove(network, dChan);
    return formattedGet(network);
  },

  serve: async (context, network) => {
    const transforms = Object.entries(await ChannelXforms.forNetwork(network))
      .map(([discord, irc]) => ({ discord, irc, id: nanoid() }));

    const serveId = await servePage(context, {
      transforms,
      network
    }, 'channelXforms');

    const register = () => context.registerOneTimeHandler(
      'discord:channelXform:httpReq:' + serveId, serveId, xformRequestHandler);

    const xformRequestHandler = async (...a) => {
      console.log('xformRequestHandler!', ...a);
      if (serveCache[serveId]) {
        register();
      }
    };

    serveCache[serveId] = setTimeout(() => delete serveCache[serveId], expiryDurationFromOptions(context.options));

    register();

    return `${config.http.proto ?? 'https'}://${config.http.fqdn}/${serveId}`;
  }
};

const channelXforms = async function (context) {
  const [netStub, subCmd] = context.argObj._;

  if (netStub === 'reload') {
    return ChannelXforms.all();
  }

  const { network } = matchNetwork(netStub);
  return subCommands[subCommands[subCmd] ? subCmd : 'get'](context, network, ...context.argObj._.slice(2));
};

channelXforms.__drcHelp = () => {
  // Get the configured command prefix character
  const config = require('config');
  const cmdPrefix = config.app.allowedSpeakersCommandPrefixCharacter || '!';

  return {
    title: 'Manage channel name transformations between Discord and IRC',
    usage: '<network> <subcommand> [options]',
    notes: 'Manage how channel names are transformed between Discord and IRC.',
    subcommands: {
      get: {
        text: `View current transforms, e.g., \`${cmdPrefix}channelXforms libera get\``
      },
      set: {
        text: `Set a transform, e.g., \`${cmdPrefix}channelXforms libera set discord-channel irc-channel\``
      },
      remove: {
        text: `Remove a transform, e.g., \`${cmdPrefix}channelXforms libera remove discord-channel\``
      },
      serve: {
        text: `Generate a web interface to manage transforms, e.g., \`${cmdPrefix}channelXforms libera serve\``
      }
    }
  };
};

module.exports = channelXforms;
