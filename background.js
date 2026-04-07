'use strict';

const RULESET_ID = 'ruleset_1';
const STORAGE_KEY = 'isEnabled';

const BADGE = Object.freeze({
  on:  Object.freeze({ text: 'ON',  color: '#2ecc71' }),
  off: Object.freeze({ text: 'OFF', color: '#e74c3c' }),
});

chrome.runtime.onStartup.addListener(() => {
  syncStateFromStorage().catch((error) => {
    console.error('Startup rule state sync failed:', error);
  });
});

chrome.runtime.onInstalled.addListener(() => {
  syncStateFromStorage().catch((error) => {
    console.error('Installed rule state sync failed:', error);
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.action !== 'toggle') {
    return false;
  }

  const nextState = Boolean(message.value);
  applyRuleState(nextState)
    .then(() => chrome.storage.local.set({ [STORAGE_KEY]: nextState }))
    .then(() => {
      sendResponse({ status: 'success', value: nextState });
    })
    .catch((error) => {
      console.error('Toggle failed:', error);
      sendResponse({ status: 'error', message: getErrorMessage(error) });
    });
  return true;
});

async function syncStateFromStorage() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  const shouldEnable = typeof data[STORAGE_KEY] === 'boolean'
    ? data[STORAGE_KEY]
    : true;

  if (typeof data[STORAGE_KEY] !== 'boolean') {
    await chrome.storage.local.set({ [STORAGE_KEY]: shouldEnable });
  }
  await applyRuleState(shouldEnable);
}

async function applyRuleState(shouldEnable) {
  const rulesetUpdate = shouldEnable
    ? { enableRulesetIds: [RULESET_ID] }
    : { disableRulesetIds: [RULESET_ID] };
  const badge = shouldEnable ? BADGE.on : BADGE.off;

  await chrome.declarativeNetRequest.updateEnabledRulesets(rulesetUpdate);
  await chrome.action.setBadgeText({ text: badge.text });
  await chrome.action.setBadgeBackgroundColor({ color: badge.color });
}

function getErrorMessage(error) {
  if (error && typeof error.message === 'string') {
    return error.message;
  }
  return String(error);
}
