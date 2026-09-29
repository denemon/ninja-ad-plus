'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'youtube.js'), 'utf8');

test('skips a playing YouTube ad and stops when the extension is disabled', async () => {
  let clicked = false;
  let removed = false;
  let disconnected = false;
  let storageListener;
  const video = { currentTime: 0, duration: 12, playbackRate: 1 };
  const player = {
    querySelector(selector) {
      return selector === 'video' ? video : { click() { clicked = true; } };
    },
  };

  const context = {
    requestAnimationFrame(callback) { callback(); },
    MutationObserver: class {
      observe() {}
      disconnect() { disconnected = true; }
    },
    document: {
      documentElement: {},
      addEventListener() {},
      querySelector(selector) {
        assert.equal(selector, '#movie_player.ad-showing, #movie_player.ad-interrupting');
        return player;
      },
      querySelectorAll() { return [{ remove() { removed = true; } }]; },
    },
    chrome: {
      storage: {
        local: { async get(defaults) { return defaults; } },
        onChanged: { addListener(listener) { storageListener = listener; } },
      },
    },
  };

  vm.runInNewContext(SOURCE, context, { filename: 'youtube.js' });
  await Promise.resolve();

  assert.equal(clicked, true);
  assert.equal(video.currentTime, 12);
  assert.equal(removed, true);

  storageListener({ isEnabled: { newValue: false } }, 'local');
  assert.equal(disconnected, true);
});

test('removes mobile and Shorts ad containers instead of leaving empty cards', async () => {
  let adSelector;
  let shortsRemoved = false;
  let mobileRemoved = false;
  const shortsContainer = { remove() { shortsRemoved = true; } };
  const mobileContainer = { remove() { mobileRemoved = true; } };

  const context = {
    requestAnimationFrame(callback) { callback(); },
    MutationObserver: class { observe() {} },
    document: {
      documentElement: {},
      addEventListener() {},
      querySelector() { return null; },
      querySelectorAll(selector) {
        adSelector = selector;
        return [
          {
            closest(containerSelector) {
              assert.ok(containerSelector.split(',').includes('.ytd-shorts'));
              return shortsContainer;
            },
          },
          {
            closest(containerSelector) {
              assert.ok(containerSelector.split(',').includes('ytm-rich-item-renderer'));
              return mobileContainer;
            },
          },
        ];
      },
    },
    chrome: {
      storage: {
        local: { async get(defaults) { return defaults; } },
        onChanged: { addListener() {} },
      },
    },
  };

  vm.runInNewContext(SOURCE, context, { filename: 'youtube.js' });
  await Promise.resolve();

  assert.ok(adSelector.split(',').includes('ad-slot-renderer'));
  assert.ok(adSelector.split(',').includes('ytm-companion-ad-renderer'));
  assert.equal(shortsRemoved, true);
  assert.equal(mobileRemoved, true);
});
