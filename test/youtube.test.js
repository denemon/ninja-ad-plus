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
      querySelector() { return player; },
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
