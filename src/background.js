'use strict';

// The core ruleset stays inside Chrome's per-extension static rule guarantee,
// so enabling it can never be rejected for quota. The extended ruleset exceeds
// the guarantee and competes with other installed extensions for the shared
// global pool, so it is enabled on a best-effort basis: losing it costs
// blocking coverage, never the exceptions that keep sites working.
//
// Both are declared "enabled": false in the manifest and switched on from here.
// Chrome persists the enabled set across sessions but not across extension
// updates -- "the rule_resources manifest key will determine the set of enabled
// static rulesets on each extension update" -- so a ruleset marked enabled there
// comes back on after every update no matter what the user chose. Starting from
// off means an update can only ever under-block for the moment before this
// worker runs, never block behind a stored OFF.
const CORE_RULESET_ID = 'core';
const EXTENDED_RULESET_ID = 'extended';
const STORAGE_KEY = 'isEnabled';

// spoofing.js runs in the page's MAIN world, where chrome.* APIs are not
// exposed, so it cannot read the ON/OFF state by itself. Registering and
// unregistering it here puts it under the same switch as the network rules.
const SPOOFING_SCRIPT = Object.freeze({
  id: 'spoofing',
  js: ['spoofing.js'],
  matches: ['<all_urls>'],
  runAt: 'document_start',
  world: 'MAIN',
  persistAcrossSessions: true,
});

const BADGE = Object.freeze({
  on:  Object.freeze({ text: 'ON',  color: '#2ecc71' }),
  off: Object.freeze({ text: 'OFF', color: '#e74c3c' }),
});

// onStartup, onInstalled and toggle messages all drive the same state through
// several awaits. Run concurrently they interleave, and a sync that started
// earlier can finish last and re-apply the state the user just switched off.
// Serialising them means the update requested last is the one that lands.
let stateUpdates = Promise.resolve();

function enqueueStateUpdate(task) {
  // Same task on both settle paths: one failed update must not stall the queue.
  const result = stateUpdates.then(task, task);
  stateUpdates = result.catch(() => {});
  return result;
}

// Returning the promise keeps the sync awaitable in tests; onStartup and
// onInstalled ignore listener return values.
chrome.runtime.onStartup.addListener(() => enqueueStateUpdate(syncStateFromStorage).catch((error) => {
  console.error('Startup rule state sync failed:', error);
}));

chrome.runtime.onInstalled.addListener(() => enqueueStateUpdate(syncStateFromStorage).catch((error) => {
  console.error('Installed rule state sync failed:', error);
}));

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.action !== 'toggle') {
    return false;
  }

  const nextState = Boolean(message.value);
  enqueueStateUpdate(() => applyToggle(nextState))
    .then(() => {
      sendResponse({ status: 'success', value: nextState });
    })
    .catch((error) => {
      sendResponse({ status: 'error', message: getErrorMessage(error) });
    });
  return true;
});

async function applyToggle(nextState) {
  try {
    await applyRuleState(nextState);
    await chrome.storage.local.set({ [STORAGE_KEY]: nextState });
  } catch (error) {
    console.error('Toggle failed:', error);
    // A partial failure can leave the rulesets, the injected script and the
    // badge disagreeing with the value still in storage. Re-derive all of them
    // from that stored value, then report the failure rather than claiming a
    // switch that did not happen.
    try {
      await syncStateFromStorage();
    } catch (resyncError) {
      console.error('Resync after failed toggle also failed:', resyncError);
    }
    throw error;
  }
}

async function syncStateFromStorage() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  const stored = data[STORAGE_KEY];
  const shouldEnable = typeof stored === 'boolean' ? stored : true;

  // Apply before persisting the first-run default, so a failure here cannot
  // leave a stored value that no component is actually honouring.
  await applyRuleState(shouldEnable);

  if (typeof stored !== 'boolean') {
    await chrome.storage.local.set({ [STORAGE_KEY]: shouldEnable });
  }
}

async function applyRuleState(shouldEnable) {
  const badge = shouldEnable ? BADGE.on : BADGE.off;

  await updateRuleset(CORE_RULESET_ID, shouldEnable);
  await applyExtendedRuleset(shouldEnable);
  await applySpoofingState(shouldEnable);
  await chrome.action.setBadgeText({ text: badge.text });
  await chrome.action.setBadgeBackgroundColor({ color: badge.color });
}

async function applyExtendedRuleset(shouldEnable) {
  // Disabling never competes for the shared rule pool, so a rejection there is
  // a real failure: swallowing it would leave 28k rules live while the stored
  // state says OFF. Only quota pressure while *enabling* is tolerable, and it
  // costs blocking coverage rather than the OFF guarantee.
  if (!shouldEnable) {
    await updateRuleset(EXTENDED_RULESET_ID, false);
    return;
  }

  try {
    await updateRuleset(EXTENDED_RULESET_ID, true);
  } catch (error) {
    console.warn('Extended ruleset unavailable, running on core rules only:', error);
  }
}

function updateRuleset(rulesetId, shouldEnable) {
  return chrome.declarativeNetRequest.updateEnabledRulesets(
    shouldEnable ? { enableRulesetIds: [rulesetId] } : { disableRulesetIds: [rulesetId] }
  );
}

async function applySpoofingState(shouldEnable) {
  const registered = await chrome.scripting.getRegisteredContentScripts({
    ids: [SPOOFING_SCRIPT.id],
  });
  const isRegistered = registered.length > 0;

  if (shouldEnable === isRegistered) {
    return;
  }
  if (shouldEnable) {
    await chrome.scripting.registerContentScripts([SPOOFING_SCRIPT]);
    return;
  }
  await chrome.scripting.unregisterContentScripts({ ids: [SPOOFING_SCRIPT.id] });
}

function getErrorMessage(error) {
  if (error && typeof error.message === 'string') {
    return error.message;
  }
  return String(error);
}
