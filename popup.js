'use strict';

const STORAGE_KEY = 'isEnabled';

const UI_STATE = Object.freeze({
  on:  Object.freeze({ text: '現在: ON (監視中)', color: '#27ae60' }),
  off: Object.freeze({ text: '現在: OFF', color: '#c0392b' }),
});

document.addEventListener('DOMContentLoaded', async () => {
  const toggleSwitch = document.getElementById('toggle-switch');
  const statusText = document.getElementById('status-text');

  const data = await chrome.storage.local.get({ [STORAGE_KEY]: true });
  renderState(data[STORAGE_KEY]);

  toggleSwitch.addEventListener('change', async () => {
    const newState = toggleSwitch.checked;
    await chrome.storage.local.set({ [STORAGE_KEY]: newState });
    renderState(newState);
    sendToggleMessage(newState);
  });

  function renderState(isEnabled) {
    const config = isEnabled ? UI_STATE.on : UI_STATE.off;
    toggleSwitch.checked = isEnabled;
    statusText.textContent = config.text;
    statusText.style.color = config.color;
  }
});

function sendToggleMessage(value) {
  chrome.runtime.sendMessage({ action: 'toggle', value }, () => {
    if (!chrome.runtime.lastError) {
      return;
    }
    console.warn('Toggle message failed:', chrome.runtime.lastError.message);
  });
}
