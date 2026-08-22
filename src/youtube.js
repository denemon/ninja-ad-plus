'use strict';

(() => {
  const STORAGE_KEY = 'isEnabled';
  const SKIP_BUTTONS = [
    '.ytp-ad-skip-button',
    '.ytp-ad-skip-button-modern',
    '.ytp-skip-ad-button',
    '.videoAdUiSkipButton',
  ].join(',');
  const AD_ELEMENTS = [
    '#masthead-ad',
    '.ytp-ad-overlay-container',
    'ytd-ad-slot-renderer',
    'ytd-display-ad-renderer',
    'ytd-in-feed-ad-layout-renderer',
    'ytd-promoted-sparkles-web-renderer',
    'ytd-promoted-video-renderer',
  ].join(',');

  let enabled = false;
  let observer;
  let scheduled = false;
  let acceleratedVideo;
  let originalPlaybackRate = 1;

  function restorePlaybackRate() {
    if (!acceleratedVideo) return;
    acceleratedVideo.playbackRate = originalPlaybackRate;
    acceleratedVideo = undefined;
  }

  function skipVideoAd() {
    const player = document.querySelector('#movie_player.ad-showing');
    if (!player) {
      restorePlaybackRate();
      return;
    }

    player.querySelector(SKIP_BUTTONS)?.click();

    const video = player.querySelector('video');
    if (!video) return;

    if (Number.isFinite(video.duration) && video.duration > 0) {
      video.currentTime = video.duration;
      return;
    }

    if (acceleratedVideo !== video) {
      restorePlaybackRate();
      acceleratedVideo = video;
      originalPlaybackRate = video.playbackRate;
      video.playbackRate = 16;
    }
  }

  function removeAdElements() {
    for (const element of document.querySelectorAll(AD_ELEMENTS)) {
      element.remove();
    }
  }

  function run() {
    if (!enabled) return;
    skipVideoAd();
    removeAdElements();
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
      attributeFilter: ['class'],
      childList: true,
      subtree: true,
    });
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
    restorePlaybackRate();
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes[STORAGE_KEY]) {
      setEnabled(Boolean(changes[STORAGE_KEY].newValue));
    }
  });

  chrome.storage.local.get({ [STORAGE_KEY]: true }).then((data) => {
    setEnabled(Boolean(data[STORAGE_KEY]));
  });
})();
