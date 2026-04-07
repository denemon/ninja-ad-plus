'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const BACKGROUND_SOURCE = fs.readFileSync(path.resolve(__dirname, '..', 'background.js'), 'utf8');

function createBackgroundContext() {
  const listeners = {};
  const storage = {};
  const updates = [];
  let dnrFailure = null;

  const chrome = {
    runtime: {
      onStartup: { addListener(callback) { listeners.startup = callback; } },
      onInstalled: { addListener(callback) { listeners.installed = callback; } },
      onMessage: { addListener(callback) { listeners.message = callback; } },
    },
    storage: {
      local: {
        async get(keys) {
          if (typeof keys === 'string') {
            return { [keys]: storage[keys] };
          }
          return { ...keys, ...storage };
        },
        async set(values) {
          Object.assign(storage, values);
        },
      },
    },
    declarativeNetRequest: {
      async updateEnabledRulesets(update) {
        if (dnrFailure) {
          throw dnrFailure;
        }
        updates.push(update);
      },
    },
    action: {
      async setBadgeText() {},
      async setBadgeBackgroundColor() {},
    },
  };

  const context = {
    chrome,
    console: { error() {} },
  };
  vm.runInNewContext(BACKGROUND_SOURCE, context, { filename: 'background.js' });

  return {
    listeners,
    storage,
    updates,
    failDnr(message) {
      dnrFailure = new Error(message);
    },
  };
}

function sendToggle(listeners, value) {
  return new Promise((resolve) => {
    const keepAlive = listeners.message({ action: 'toggle', value }, {}, resolve);
    assert.equal(keepAlive, true);
  });
}

test('toggle message applies ruleset before persisting state', async () => {
  const { listeners, storage, updates } = createBackgroundContext();

  const response = await sendToggle(listeners, false);

  assert.equal(response.status, 'success');
  assert.equal(response.value, false);
  assert.equal(storage.isEnabled, false);
  assert.equal(JSON.stringify(updates), JSON.stringify([
    { disableRulesetIds: ['ruleset_1'] },
  ]));
});

test('toggle message reports DNR failures without persisting the new state', async () => {
  const { listeners, storage, failDnr } = createBackgroundContext();
  storage.isEnabled = false;
  failDnr('quota unavailable');

  const response = await sendToggle(listeners, true);

  assert.equal(response.status, 'error');
  assert.equal(response.message, 'quota unavailable');
  assert.equal(storage.isEnabled, false);
});
