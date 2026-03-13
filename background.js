'use strict';

const RULESET_ID = 'ruleset_1';
const STORAGE_KEY = 'isEnabled';

const BADGE = Object.freeze({
  on:  Object.freeze({ text: 'ON',  color: '#2ecc71' }),
  off: Object.freeze({ text: 'OFF', color: '#e74c3c' }),
});

chrome.runtime.onStartup.addListener(async () => {
  const data = await chrome.storage.local.get({ [STORAGE_KEY]: true });
  await applyRuleState(data[STORAGE_KEY]);
});

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.local.set({ [STORAGE_KEY]: true });
  await applyRuleState(true);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action !== 'toggle') {
    return false;
  }
  applyRuleState(message.value).then(() => {
    sendResponse({ status: 'success' });
  });
  return true;
});

async function applyRuleState(shouldEnable) {
  const rulesetUpdate = shouldEnable
    ? { enableRulesetIds: [RULESET_ID] }
    : { disableRulesetIds: [RULESET_ID] };
  const badge = shouldEnable ? BADGE.on : BADGE.off;

  try {
    await chrome.declarativeNetRequest.updateEnabledRulesets(rulesetUpdate);
    await chrome.action.setBadgeText({ text: badge.text });
    await chrome.action.setBadgeBackgroundColor({ color: badge.color });
  } catch (error) {
    console.error('Rule state update failed:', error);
  }
}
