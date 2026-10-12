'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const BACKGROUND_SOURCE = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'background.js'), 'utf8');

function createBackgroundContext({ spoofingRegistered = false, youtubePlayerRegistered = false } = {}) {
  const listeners = {};
  const storage = {};
  const updates = [];
  const registeredScripts = new Map();
  const scriptUpdates = [];
  const rulesetFailures = new Map();
  const enabledRulesets = new Set();
  const badge = {};
  let dnrFailure = null;
  let scriptingFailure = null;
  let scriptingFailureId;
  let scriptQueryGate = null;

  if (spoofingRegistered) {
    registeredScripts.set('spoofing', { id: 'spoofing' });
  }
  if (youtubePlayerRegistered) {
    registeredScripts.set('youtube-player', { id: 'youtube-player' });
  }

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
        const ids = [...(update.enableRulesetIds || []), ...(update.disableRulesetIds || [])];
        if (ids.some(id => rulesetFailures.has(id))) {
          throw rulesetFailures.get(ids.find(id => rulesetFailures.has(id)));
        }
        updates.push(update);
        for (const id of update.enableRulesetIds || []) {
          enabledRulesets.add(id);
        }
        for (const id of update.disableRulesetIds || []) {
          enabledRulesets.delete(id);
        }
      },
    },
    scripting: {
      async getRegisteredContentScripts({ ids }) {
        if (scriptQueryGate) {
          const gate = scriptQueryGate;
          scriptQueryGate = null;
          await gate;
        }
        return ids.filter(id => registeredScripts.has(id)).map(id => registeredScripts.get(id));
      },
      async registerContentScripts(scripts) {
        if (scriptingFailure && (!scriptingFailureId || scripts.some(script => script.id === scriptingFailureId))) {
          throw scriptingFailure;
        }
        for (const script of scripts) {
          assert.equal(registeredScripts.has(script.id), false, `duplicate registration ${script.id}`);
          registeredScripts.set(script.id, script);
        }
      },
      async updateContentScripts(scripts) {
        if (scriptingFailure && (!scriptingFailureId || scripts.some(script => script.id === scriptingFailureId))) throw scriptingFailure;
        for (const script of scripts) {
          assert.ok(registeredScripts.has(script.id));
          scriptUpdates.push(script);
          registeredScripts.set(script.id, { ...registeredScripts.get(script.id), ...script });
        }
      },
      async unregisterContentScripts({ ids }) {
        for (const id of ids) {
          assert.ok(registeredScripts.delete(id), `unregistering unknown script ${id}`);
        }
      },
    },
    action: {
      async setBadgeText({ text }) {
        badge.text = text;
      },
      async setBadgeBackgroundColor() {},
    },
  };

  const context = {
    chrome,
    console: { error() {}, warn() {} },
  };
  vm.runInNewContext(BACKGROUND_SOURCE, context, { filename: 'background.js' });

  return {
    listeners,
    storage,
    updates,
    registeredScripts,
    scriptUpdates,
    enabledRulesets,
    badge,
    // Blocks the next getRegisteredContentScripts() call until release() is
    // called, so a slow in-flight state update can be raced against a toggle.
    gateScriptQuery() {
      let release;
      scriptQueryGate = new Promise((resolve) => { release = resolve; });
      return release;
    },
    failDnr(message) {
      dnrFailure = new Error(message);
    },
    failRuleset(rulesetId, message) {
      rulesetFailures.set(rulesetId, new Error(message));
    },
    failScripting(message, scriptId) {
      scriptingFailure = new Error(message);
      scriptingFailureId = scriptId;
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
    { disableRulesetIds: ['core'] },
  ]));
});

test('a slow startup sync cannot re-enable anything after a later OFF toggle', async () => {
  const context = createBackgroundContext({ spoofingRegistered: true });
  const { listeners, storage, registeredScripts, enabledRulesets, badge } = context;
  storage.isEnabled = true;

  // Startup begins first and stalls mid-flight, then the user switches off.
  const release = context.gateScriptQuery();
  const startup = listeners.startup();
  const toggle = sendToggle(listeners, false);
  release();

  const response = await toggle;
  await startup;

  assert.equal(response.status, 'success');
  assert.equal(storage.isEnabled, false);
  assert.equal(registeredScripts.has('spoofing'), false, 'spoofing must not come back');
  assert.equal(registeredScripts.size, 0, 'the player filter must not come back either');
  assert.deepEqual([...enabledRulesets], [], 'no ruleset may survive the OFF toggle');
  assert.equal(badge.text, 'OFF');
});

test('a failed core ruleset update leaves nothing enabled and is reported', async () => {
  const { listeners, storage, failRuleset } = createBackgroundContext();
  failRuleset('core', 'rule count limit exceeded');

  const response = await sendToggle(listeners, true);

  assert.equal(response.status, 'error');
  assert.equal(response.message, 'rule count limit exceeded');
  assert.equal(storage.isEnabled, undefined, 'a failed toggle must not be persisted');
});

test('a partial failure re-derives every component from the stored state', async () => {
  const { listeners, storage, updates, registeredScripts, failScripting } = createBackgroundContext();
  storage.isEnabled = false;
  failScripting('cannot register content script');

  const response = await sendToggle(listeners, true);

  assert.equal(response.status, 'error');
  assert.equal(storage.isEnabled, false, 'storage keeps the old value');
  assert.equal(
    registeredScripts.has('spoofing'),
    false,
    'spoofing must match the stored OFF state, not the attempted ON state'
  );
  assert.deepEqual(
    Object.keys(updates.at(-1)),
    ['disableRulesetIds'],
    'the rulesets must be put back to match the stored OFF state'
  );
});

test('turning the extension off unregisters both page-context scripts', async () => {
  const { listeners, registeredScripts } = createBackgroundContext({ spoofingRegistered: true, youtubePlayerRegistered: true });

  await sendToggle(listeners, false);

  assert.equal(registeredScripts.size, 0);
});

test('turning the extension on registers spoofing in the MAIN world at document_start', async () => {
  const { listeners, registeredScripts } = createBackgroundContext();

  await sendToggle(listeners, true);

  // The script object is built inside the vm realm, so copy the arrays out
  // before comparing: deepEqual is prototype-sensitive across realms.
  const script = registeredScripts.get('spoofing');
  assert.deepEqual(Array.from(script.js), ['spoofing.js']);
  assert.deepEqual(Array.from(script.matches), ['<all_urls>']);
  assert.deepEqual(Array.from(script.excludeMatches), ['*://*.youtube.com/*', '*://*.youtube-nocookie.com/*']);
  assert.equal(script.world, 'MAIN');
  assert.equal(script.runAt, 'document_start');
  assert.equal(script.persistAcrossSessions, true);
});

test('installation sync migrates a persisted spoofing registration to exclude YouTube', async () => {
  const { listeners, registeredScripts, scriptUpdates } = createBackgroundContext({ spoofingRegistered: true });

  await listeners.installed();

  assert.equal(registeredScripts.size, 2);
  assert.equal(scriptUpdates.length, 1);
  assert.deepEqual(Array.from(registeredScripts.get('spoofing').excludeMatches), [
    '*://*.youtube.com/*', '*://*.youtube-nocookie.com/*',
  ]);
});

test('startup sync registers spoofing for a first-run install', async () => {
  const { listeners, storage, registeredScripts } = createBackgroundContext();

  await listeners.installed();

  assert.equal(storage.isEnabled, true);
  assert.ok(registeredScripts.has('spoofing'));
  assert.ok(registeredScripts.has('youtube-player'));
});

test('the player filter is registered before page scripts on YouTube and embedded players', async () => {
  const { listeners, registeredScripts } = createBackgroundContext();
  await sendToggle(listeners, true);
  const script = registeredScripts.get('youtube-player');
  assert.ok(script);
  assert.deepEqual(Array.from(script.js), ['youtube-player.js']);
  assert.deepEqual(Array.from(script.matches), ['*://*.youtube.com/*', '*://*.youtube-nocookie.com/*']);
  assert.equal(script.world, 'MAIN');
  assert.equal(script.runAt, 'document_start');
  assert.equal(script.allFrames, true);
  assert.equal(script.persistAcrossSessions, true);
});

test('a failed player-filter registration rolls back the already registered generic script', async () => {
  const { listeners, storage, registeredScripts, enabledRulesets, failScripting } = createBackgroundContext();
  storage.isEnabled = false;
  failScripting('player filter registration failed', 'youtube-player');
  const result = await sendToggle(listeners, true);
  assert.equal(result.status, 'error');
  assert.equal(storage.isEnabled, false);
  assert.equal(registeredScripts.size, 0);
  assert.equal(enabledRulesets.size, 0);
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
