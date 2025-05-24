'use strict';

const fs = require('fs');
const path = require('path');
const mustache = require('mustache');
const { NAME, VERSION } = require('../util');

require('../logger')('http-common');

let templates = null;
function templatesLoad (force = false) {
  if (!force && templates) {
    return;
  }

  const templatePath = path.join(__dirname, 'templates');
  templates = Object.freeze(fs.readdirSync(templatePath).reduce((a, tmplPath) => {
    const { name } = path.parse(tmplPath);
    return {
      [name]: () => fs.readFileSync(path.join(templatePath, tmplPath)).toString('utf8'),
      ...a
    };
  }, {}));

  console.log(`Loaded templates: ${Object.keys(templates).join(', ')}`);
}

// `renderType` can be the name (no extension) of any of the defined templates
// `body` should be an object of shape: { network, elements: [] }
function renderTemplate (renderType, body, expiry) {
  templatesLoad();

  if (!templates[renderType]) {
    throw new Error(`Invalid render type "${renderType}"`);
  }

  // Add detailed debugging for AI template
  if (renderType === 'ai' && body.responses) {
    console.log(`renderTemplate for AI: ${body.responses.length} responses`);
    console.log(`Model list: ${JSON.stringify(body.responses.map(r => r.model))}`);

    // Log each response details
    body.responses.forEach((response, idx) => {
      console.log(`Response #${idx + 1} - Provider: ${response.provider}, Model: ${response.model}, Response length: ${response.response?.length || 0}`);
    });

    // Add index to each response if not already present
    body.responses = body.responses.map((r, idx) => ({
      ...r,
      responseIndex: r.responseIndex || idx + 1
    }));
  }

  if (body.elements) {
    // this shouldn't be here! probably...
    body.elements.forEach((ele) => {
      if (ele.timestamp) {
        ele.timestampString = new Date(ele.timestamp).toDRCString();
      }
    });
  }

  // Add special fields for liveLogs template
  if (renderType === 'liveLogs' && body.daemon) {
    // Add a boolean flag for all daemons view - now supporting both 'all' and 'combined' daemon names
    body.daemon_all = body.daemon === 'all' || body.daemon === 'combined';

    // Add the daemons list to the template if it's provided
    if (Array.isArray(body.daemons) && body.daemons.length > 0) {
      body.daemon_list = body.daemons.join(', ');
    }
  }

  const renderObj = {
    NAME,
    VERSION,
    captureTimestamp: new Date().toDRCString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    ...body
  };

  if (expiry) {
    renderObj.documentExpiresAt = (new Date(expiry)).toDRCString();
    renderObj.documentExpiresAtUnix = Math.floor(Number(new Date(expiry)) / 1000);
  }

  return {
    body: mustache.render(templates[renderType](), renderObj),
    renderType,
    renderObj
  };
}

module.exports = {
  getTemplates () { return templates; },
  renderTemplate,
  templatesLoad
};
