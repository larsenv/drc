'use strict';

const config = require('config');
const OpenAI = require('openai');
const { Anthropic } = require('@anthropic-ai/sdk');
const marked = require('marked');
const { fqUrlFromPath } = require('../../util');
const { servePage, isHTTPRunning } = require('../common');

require('../../logger')('discord');

// Initialize API clients
const openaiConfig = config.openai;
const anthropicConfig = config.anthropic;
const openrouterConfig = config.openrouter;
const OAIAPI = new OpenAI({ apiKey: openaiConfig.secretKey, organization: openaiConfig.organization });
const anthropicClient = new Anthropic({ apiKey: anthropicConfig.secretKey });
// Initialize OpenRouter client using the OpenAI SDK with custom baseURL
const openrouterClient = openrouterConfig.apiKey
  ? new OpenAI({
    apiKey: openrouterConfig.apiKey,
    baseURL: openrouterConfig.baseUrl
  })
  : null;

/**
 * Query OpenAI's API with the given parameters
 * @param {Object} params Parameters for the OpenAI query
 * @returns {Object} The response data
 */
async function queryOpenAI (params) {
  const { prompt, model, temperature, maxTokens } = params;
  const dataObj = {
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature,
    max_tokens: maxTokens
  };

  const startTime = new Date();
  console.log(`OpenAI Prompt: ${prompt}`);

  const res = await OAIAPI.chat.completions.create(dataObj);

  const responseText = res.choices?.[0]?.message?.content ?? '';
  const queryTimeS = Number((new Date() - startTime) / 1000).toFixed(1);

  return {
    provider: 'openai',
    model,
    prompt,
    temperature,
    maxTokens,
    response: responseText,
    queryTimeS,
    viaHTML: openaiConfig.viaHTML
  };
}

/**
 * Query Anthropic's API with the given parameters
 * @param {Object} params Parameters for the Anthropic query
 * @returns {Object} The response data
 */
async function queryAnthropic (params) {
  const { prompt, model, temperature, maxTokens, system } = params;

  const startTime = new Date();
  console.log('Anthropic params:', params);
  console.log(`Anthropic Prompt: ${prompt}`);
  console.log(`Anthropic System: ${system}`);

  const res = await anthropicClient.messages.create({
    model,
    max_tokens: maxTokens,
    temperature,
    messages: [{ role: 'user', content: prompt }],
    system
  });

  const responseText = res.content?.[0]?.text ?? '';
  const queryTimeS = Number((new Date() - startTime) / 1000).toFixed(1);

  return {
    provider: 'anthropic',
    model,
    prompt,
    temperature,
    maxTokens,
    system,
    response: responseText,
    queryTimeS,
    viaHTML: anthropicConfig.viaHTML
  };
}

/**
 * Query OpenRouter's API with the given parameters
 * @param {Object} params Parameters for the OpenRouter query
 * @returns {Object} The response data
 */
async function queryOpenRouter (params) {
  const { prompt, model, temperature, maxTokens } = params;
  const dataObj = {
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature,
    max_tokens: maxTokens
  };

  const startTime = new Date();
  console.log(`OpenRouter Prompt (${model}): ${prompt}`);
  console.log(`Sending request to OpenRouter for model: ${model}`);

  let res;
  try {
    res = await openrouterClient.chat.completions.create(dataObj);

    if (!(res && res.choices)) {
      console.error(`Warning: Received empty response object for model ${model}:`, JSON.stringify(res));
    }
  } catch (error) {
    console.error(`Error requesting from OpenRouter model ${model}:`, error.message);
    // Create a minimal response object so we don't break the flow
    res = { choices: [] };
  }

  // Handle undefined or empty responses
  let responseText = '';

  if (res && res.choices && res.choices[0] && res.choices[0].message) {
    responseText = res.choices[0].message.content || '';
  } else {
    console.log(`Warning: Empty or malformed response from ${model}:`, JSON.stringify(res));
    responseText = '*This model did not return a valid response. This can happen with some models on OpenRouter, especially during high traffic periods.*';
  }

  const queryTimeS = Number((new Date() - startTime) / 1000).toFixed(1);

  console.log(`Processed response for ${model}: ${responseText.substring(0, 50)}...`);

  return {
    provider: 'openrouter',
    model,
    prompt,
    temperature,
    maxTokens,
    response: responseText,
    queryTimeS,
    viaHTML: openrouterConfig.viaHTML
  };
}

/**
 * Process a request to a specific AI provider
 * @param {string} provider - The AI provider (openai, anthropic, or openrouter)
 * @param {Object} context - The command context
 * @param {string|null} [specificModel=null] - Optional specific model to use (for OpenRouter)
 * @returns {Promise<Object>} The response from the AI provider
 */
async function processProviderRequest (provider, context, specificModel = null) {
  const prompt = context.argObj._.join(' ');
  let providerConfig, modelOption, result;

  if (provider === 'openai') {
    providerConfig = openaiConfig;
    modelOption = context.options?.openaiModel ?? providerConfig.chatModel;

    if (context.options?.listOpenAIModels) {
      return { provider, models: (await OAIAPI.models.list())?.data?.map(({ id }) => id) };
    }

    result = await queryOpenAI({
      prompt,
      model: modelOption,
      temperature: context.options?.temperature ?? providerConfig.temperature,
      max_tokens: context.options?.maxTokens ?? providerConfig.maxTokens
    });
  } else if (provider === 'anthropic') {
    providerConfig = anthropicConfig;
    modelOption = context.options?.anthropicModel ?? providerConfig.model;

    if (context.options?.listAnthropicModels) {
      const models = await anthropicClient.models.list();
      return { provider, models: models?.data?.map(({ id }) => id) };
    }

    result = await queryAnthropic({
      prompt,
      model: modelOption,
      temperature: context.options?.temperature ?? providerConfig.temperature,
      maxTokens: context.options?.maxTokens ?? providerConfig.maxTokens,
      system: context.options?.system ?? providerConfig.system
    });
  } else if (provider === 'openrouter') {
    providerConfig = openrouterConfig;
    modelOption = specificModel || context.options?.model;

    if (context.options?.listOpenRouterModels) {
      const models = await openrouterClient.models.list();
      return { provider, models: models?.data?.map(({ id }) => id) };
    }

    if (!modelOption) {
      throw new Error('No model specified for OpenRouter. Please use --model to specify at least one model.');
    }

    result = await queryOpenRouter({
      prompt,
      model: modelOption,
      temperature: context.options?.temperature ?? providerConfig.temperature,
      max_tokens: context.options?.maxTokens ?? providerConfig.maxTokens
    });
  }

  return result;
}

async function f (context) {
  // Check for required API keys
  const providers = [];
  if (!openaiConfig.secretKey && !anthropicConfig.secretKey && !openrouterConfig.apiKey) {
    return 'You must specify at least one secret key in either `config.openai.secretKey`, `config.anthropic.secretKey`, or `config.openrouter.apiKey`!';
  }

  if (openaiConfig.secretKey) providers.push('openai');
  if (anthropicConfig.secretKey) providers.push('anthropic');
  if (openrouterConfig.apiKey) providers.push('openrouter');

  // Handle model listing
  if (context.options?.listModels) {
    const results = [];
    for (const provider of providers) {
      try {
        if (provider === 'openai') {
          const models = (await OAIAPI.models.list())?.data?.map(({ id }) => id);
          results.push(`OpenAI Models: ${models.join(', ')}`);
        } else if (provider === 'anthropic') {
          const models = await anthropicClient.models.list();
          results.push(`Anthropic Models: ${models?.data?.map(({ id }) => id).join(', ')}`);
        } else if (provider === 'openrouter') {
          const models = await openrouterClient.models.list();
          results.push(`OpenRouter Models: ${models?.data?.map(({ id }) => id).join(', ')}`);
        }
      } catch (e) {
        results.push(`Error listing ${provider} models: ${e.message}`);
      }
    }
    return results.join('\n\n');
  }

  try {
    // Determine which providers to query
    let requestedProviders = [];

    if (context.options?.openai) {
      requestedProviders.push('openai');
    }

    if (context.options?.claude) {
      requestedProviders.push('anthropic');
    }

    if (context.options?.openRouter) {
      requestedProviders.push('openrouter');
    }

    // If no specific provider was requested, use all available
    if (requestedProviders.length === 0) {
      requestedProviders = [...providers];
    }

    // If we're requesting providers that don't have API keys, remove them
    requestedProviders = requestedProviders.filter(p =>
      (p === 'openai' && openaiConfig.secretKey) ||
      (p === 'anthropic' && anthropicConfig.secretKey) ||
      (p === 'openrouter' && openrouterConfig.apiKey)
    );

    if (requestedProviders.length === 0) {
      return 'No AI providers are available or specified. Please check your configuration.';
    }

    // For OpenRouter with multiple models, we need to handle it differently
    const providerRequests = [];

    // Handle OpenRouter with multiple models
    if (requestedProviders.includes('openrouter')) {
      let openRouterModels = Array.isArray(context.options?.model)
        ? context.options.model
        : context.options?.model ? [context.options.model] : [];

      // If no models specified, use defaults from config
      if (openRouterModels.length === 0 && openrouterConfig.defaultModels && openrouterConfig.defaultModels.length > 0) {
        openRouterModels = [...openrouterConfig.defaultModels];
        console.log(`Using default OpenRouter models: ${JSON.stringify(openRouterModels)}`);
      }

      // Check if we have any models
      if (openRouterModels.length === 0) {
        return 'No models specified for OpenRouter. Either specify models with --model or configure defaultModels in the openrouter config.';
      }

      // Log the parsed models for debugging
      console.log(`OpenRouter parsed models: ${JSON.stringify(openRouterModels)}`);

      // Create a request for each OpenRouter model
      openRouterModels.forEach(model => {
        // Clean up any remaining quotes if needed
        const cleanModel = typeof model === 'string' ? model.replace(/^"+|"+$/g, '') : model;
        providerRequests.push({ provider: 'openrouter', model: cleanModel });
      });

      // Remove 'openrouter' as it's been handled specially
      requestedProviders = requestedProviders.filter(p => p !== 'openrouter');
    }

    // Add all other providers that don't need special handling
    requestedProviders.forEach(provider => {
      providerRequests.push({ provider });
    });

    if (providerRequests.length === 0) {
      return 'No AI providers are available or properly configured. Please check your configuration.';
    }

    const providerNames = providerRequests.map(pr =>
      pr.model ? `${pr.provider} (${pr.model})` : pr.provider
    );
    context.sendToBotChan(`Querying ${providerNames.join(', ')}...`);

    // Query all requested providers and models
    console.log(`Making ${providerRequests.length} provider requests...`);

    const responsePromises = providerRequests.map(pr => {
      console.log(`Starting request for ${pr.provider}${pr.model ? ` (${pr.model})` : ''}`);
      return processProviderRequest(pr.provider, context, pr.model)
        .then(result => {
          console.log(`Received response from ${pr.provider}${pr.model ? ` (${pr.model})` : ''}`);
          return result;
        })
        .catch(err => {
          console.error(`Error from ${pr.provider}${pr.model ? ` (${pr.model})` : ''}:`, err);
          return null; // Return null for failed requests so they're filtered out
        });
    });

    const responses = await Promise.all(responsePromises);

    // Process the responses
    const prompt = context.argObj._.join(' ');
    console.log('Raw responses received:', JSON.stringify(responses.map(r => ({
      provider: r?.provider,
      model: r?.model,
      responseLength: r?.response?.length || 0
    }))));

    const validResponses = responses.filter(r => r && r.response);
    console.log(`Valid responses count: ${validResponses.length}`);

    if (validResponses.length === 0) {
      return 'No valid responses received from any AI provider.';
    }

    // Format responses for HTML display
    console.log('Formatting responses for HTML display. Valid responses:', validResponses.length);

    const formattedResponses = validResponses.map((r, index) => {
      console.log(`Processing response ${index + 1}/${validResponses.length} from ${r.provider} model ${r.model}`);
      return {
        ...r,
        response: marked.parse(r.response),
        responseIndex: index + 1
      };
    });

    // Serve the combined results if HTTP is running
    if (await isHTTPRunning(context.registerOneTimeHandler, context.removeOneTimeHandler)) {
      const serveObj = {
        prompt,
        responses: formattedResponses,
        isMultipleModels: formattedResponses.length > 1,
        modelCount: formattedResponses.length
      };

      console.log(`HTML data object has ${serveObj.responses.length} responses`);
      // Only log a portion of each response to avoid flooding logs
      console.debug('HTML responses:', serveObj.responses.map(r => ({
        provider: r.provider,
        model: r.model,
        responseLength: r.response.length,
        responsePreview: r.response.substring(0, 50) + '...',
        responseIndex: r.responseIndex
      })));

      const page = await servePage(context, serveObj, 'ai');
      context.sendToBotChan(`This response is available at ${fqUrlFromPath(page)}`);
      if (context.options.ttl === -1) {
        context.sendToBotChan('Forever URL: ' + fqUrlFromPath(`static/${page}.html`));
      }
    } else {
      // Return a text version of the responses
      if (validResponses.length === 1) {
        console.log(`Returning single response from ${validResponses[0].provider} (${validResponses[0].model})`);
        return validResponses[0].response;
      } else {
        console.log(`Returning ${validResponses.length} responses as combined markdown`);
        const combinedResponse = validResponses.map(r =>
          `## ${r.provider.toUpperCase()} (${r.model}):\n${r.response}`
        ).join('\n\n');
        console.log(`Combined response length: ${combinedResponse.length}`);
        return combinedResponse;
      }
    }
  } catch (e) {
    console.log(e);
    const error = e.response?.data?.error?.message ?? e.error?.message ?? e.message;
    return 'ERROR: ' + error;
  }
}

f.__drcHelp = () => {
  // Get the configured command prefix character
  const config = require('config');
  const cmdPrefix = config.app.allowedSpeakersCommandPrefixCharacter || '!';

  return {
    title: 'A unified interface to multiple AI models (OpenAI\'s GPT, Anthropic\'s Claude, OpenRouter, etc.)',
    usage: '[prompt] <options>',
    options: [
      ['--openai', 'Use only OpenAI models'],
      ['--claude', 'Use only Anthropic models'],
      ['--openRouter', 'Use OpenRouter to access many different models (uses default models if none specified)'],
      ['--openaiModel', 'Specify OpenAI model', true],
      ['--anthropicModel', 'Specify Anthropic model', true],
      ['--model', 'Specify model for OpenRouter (can be used multiple times for multiple models)', true],
      ['--maxTokens', 'Set max tokens', true],
      ['--temperature', 'Set temperature', true],
      ['--system', 'Set system prompt for Claude', true],
      ['--template', 'Default template to use for AI rendering (e.g., "modern", "plain"). Can be overridden with ?template= query param', true],
      ['--listModels', 'List all available models'],
      ['--listOpenAIModels', 'List available OpenAI models'],
      ['--listAnthropicModels', 'List available Anthropic models'],
      ['--listOpenRouterModels', 'List available OpenRouter models']
    ],
    notes: `Run \`${cmdPrefix}config get openai\`, \`${cmdPrefix}config get anthropic\`, or \`${cmdPrefix}config get openrouter\` to see defaults. When using --openRouter, you can specify multiple models with multiple --model flags. If no models are specified with --openRouter, the default models configured in openrouter.defaultModels will be used.`
  };
};

module.exports = f;
