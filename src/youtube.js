'use strict';

(() => {
  const STORAGE_KEY = 'isEnabled';
  const SKIP_BUTTONS = [
    '.ytp-ad-skip-button',
    '.ytp-ad-skip-button-modern',
    '.ytp-skip-ad-button',
    '.videoAdUiSkipButton',
  ].join(',');

  // Fallback for ads that reach the player: use the native skip control once
  // available. Initial player-response filtering runs in youtube-player.js.
  let enabled = false;
  let storageChanged = false;
  let observer;
  let scheduled = false;
  let clickedButton;

  function isClickable(button) {
    if (button.getClientRects().length === 0) return false;
    for (let element = button; element; element = element.parentElement) {
      if (element.disabled || element.hidden || element.inert ||
          element.getAttribute('aria-disabled') === 'true') return false;
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility !== 'visible' || style.opacity === '0') return false;
    }
    return true;
  }

  function run() {
    if (!enabled) return;
    const player = document.querySelector('#movie_player.ad-showing, #movie_player.ad-interrupting');
    const button = Array.from(player?.querySelectorAll(SKIP_BUTTONS) || []).find(isClickable);
    if (!button) {
      clickedButton = undefined;
      return;
    }
    if (button === clickedButton) return;
    clickedButton = button;
    button.click();
  }

  function schedule() {
    if (scheduled || !enabled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      run();
    });
  }

  function startObserver() {
    if (!enabled || observer || !document.documentElement) return;
    observer = new MutationObserver(schedule);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'disabled', 'aria-disabled', 'inert'],
      childList: true,
      subtree: true,
    });
    // CSS transitions can reveal a control without a new DOM mutation.
    document.addEventListener('timeupdate', schedule, true);
    schedule();
  }

  function setEnabled(nextEnabled) {
    enabled = nextEnabled;
    if (enabled) {
      startObserver();
      if (!observer) {
        document.addEventListener('DOMContentLoaded', startObserver, { once: true });
      }
      return;
    }

    observer?.disconnect();
    observer = undefined;
    clickedButton = undefined;
    document.removeEventListener('DOMContentLoaded', startObserver);
    document.removeEventListener('timeupdate', schedule, true);
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes[STORAGE_KEY]) {
      storageChanged = true;
      setEnabled(Boolean(changes[STORAGE_KEY].newValue));
    }
  });

  chrome.storage.local.get({ [STORAGE_KEY]: true }).then((data) => {
    // A newer storage event wins over an in-flight initial read.
    if (!storageChanged) setEnabled(Boolean(data[STORAGE_KEY]));
  }).catch((error) => {
    console.warn('YouTube state read failed:', error);
  });
})();
