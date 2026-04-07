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
    const previousState = !newState;
    toggleSwitch.disabled = true;
    try {
      const response = await sendToggleMessage(newState);
      renderState(response.value);
    } catch (error) {
      console.warn('Toggle failed:', error);
      renderState(previousState);
    } finally {
      toggleSwitch.disabled = false;
    }
  });

  function renderState(isEnabled) {
    const config = isEnabled ? UI_STATE.on : UI_STATE.off;
    toggleSwitch.checked = isEnabled;
    statusText.textContent = config.text;
    statusText.style.color = config.color;
  }
});

function sendToggleMessage(value) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action: 'toggle', value }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response || response.status !== 'success') {
        reject(new Error(response?.message || 'Toggle failed'));
        return;
      }
      resolve(response);
    });
  });
}
