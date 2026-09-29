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
    '#player-ads',
    '#shopping-timely-shelf',
    '.ytp-ad-overlay-container',
    '.ytp-suggested-action-badge',
    'ad-slot-renderer',
    'ytd-ad-slot-renderer',
    'ytd-action-companion-ad-renderer',
    'ytd-companion-slot-renderer',
    'ytd-display-ad-renderer',
    'ytd-in-feed-ad-layout-renderer',
    'ytd-merch-shelf-renderer',
    'ytd-player-legacy-desktop-watch-ads-renderer',
    'ytd-promoted-sparkles-web-renderer',
    'ytd-promoted-video-renderer',
    'ytd-search-pyv-renderer',
    'ytm-companion-ad-renderer',
  ].join(',');
  const AD_CONTAINERS = [
    '.ytd-shorts',
    'ytd-rich-item-renderer',
    'ytm-companion-slot',
    'ytm-rich-item-renderer',
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
    const player = document.querySelector('#movie_player.ad-showing, #movie_player.ad-interrupting');
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
      (element.closest?.(AD_CONTAINERS) || element).remove();
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
