'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'youtube.js'), 'utf8');

function button(overrides = {}) {
  return {
    disabled: false,
    hidden: false,
    inert: false,
    parentElement: null,
    style: { display: 'block', visibility: 'visible', opacity: '1' },
    attributes: {},
    clicks: 0,
    getAttribute(name) { return this.attributes[name] ?? null; },
    getClientRects() { return this.hidden ? [] : [{ width: 100, height: 30 }]; },
    click() { this.clicks++; },
    ...overrides,
  };
}

async function load({ buttons = [button()], storageRead = Promise.resolve({ isEnabled: true }) } = {}) {
  const frames = [];
  const listeners = new Map();
  const observers = [];
  const video = { currentTime: 2, duration: 12, playbackRate: 1.25 };
  let storageListener;
  let adShowing = true;
  let removed = 0;
  const player = {
    querySelector(selector) { return selector === 'video' ? video : buttons[0]; },
    querySelectorAll() { return buttons; },
  };
  const context = {
    requestAnimationFrame(callback) { frames.push(callback); },
    getComputedStyle(element) { return element.style; },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe(_root, options) { this.options = options; this.connected = true; }
      disconnect() { this.connected = false; }
    },
    document: {
      documentElement: {},
      addEventListener(name, callback) { listeners.set(name, callback); },
      removeEventListener(name) { listeners.delete(name); },
      querySelector() { return adShowing ? player : null; },
      querySelectorAll() { return [{ remove() { removed++; } }]; },
    },
    chrome: {
      storage: {
        local: { get() { return storageRead; } },
        onChanged: { addListener(callback) { storageListener = callback; } },
      },
    },
  };
  vm.runInNewContext(SOURCE, context, { filename: 'youtube.js' });
  await Promise.resolve();

  return {
    buttons, video, observers,
    get removed() { return removed; },
    flush() { for (const callback of frames.splice(0)) callback(); },
    mutate(attribute = 'class') {
      const observer = observers.at(-1);
      if (observer?.connected && observer.options.attributeFilter.includes(attribute)) observer.callback();
    },
    timeupdate() { listeners.get('timeupdate')?.(); },
    setAdShowing(value) { adShowing = value; this.mutate(); },
    setEnabled(value) { storageListener({ isEnabled: { newValue: value } }, 'local'); },
  };
}

test('only clicks the native skip button, preserving media and ad elements', async () => {
  const page = await load();
  page.flush();

  assert.equal(page.buttons[0].clicks, 1);
  assert.deepEqual(page.video, { currentTime: 2, duration: 12, playbackRate: 1.25 });
  assert.equal(page.removed, 0);
});

test('a skip click that switches to the main video never seeks the main video', async () => {
  const page = await load();
  page.buttons[0].click = () => {
    page.video.currentTime = 0;
    page.video.duration = 600;
    page.setAdShowing(false);
  };
  page.flush();
  assert.equal(page.video.currentTime, 0);
  assert.equal(page.video.playbackRate, 1.25);
});

test('unskippable and unknown-duration ads keep their time and playback speed', async () => {
  for (const duration of [12, 0, NaN, Infinity]) {
    const page = await load({ buttons: [] });
    page.video.duration = duration;
    page.flush();
    assert.equal(page.video.currentTime, 2);
    assert.equal(page.video.playbackRate, 1.25);
    assert.equal(page.removed, 0);
  }
});

test('hidden or disabled skip controls are ignored, including hidden ancestors', async () => {
  const hiddenControls = [
    button({ disabled: true }),
    button({ hidden: true }),
    button({ inert: true }),
    button({ attributes: { 'aria-disabled': 'true' } }),
    button({ getClientRects: () => [] }),
    button({ style: { display: 'none', visibility: 'visible', opacity: '1' } }),
    button({ style: { display: 'block', visibility: 'hidden', opacity: '1' } }),
    button({ style: { display: 'block', visibility: 'visible', opacity: '0' } }),
    button({ parentElement: button({ hidden: true }) }),
    button({ parentElement: button({ style: { display: 'block', visibility: 'visible', opacity: '0' } }) }),
  ];
  const visible = button();
  const page = await load({ buttons: [...hiddenControls, visible] });
  page.flush();

  assert.deepEqual(hiddenControls.map(control => control.clicks), hiddenControls.map(() => 0));
  assert.equal(visible.clicks, 1);
});

test('waits for an enabled button and avoids repeated clicks until it is hidden and reused', async () => {
  const control = button({ disabled: true });
  const page = await load({ buttons: [control] });
  page.flush();
  assert.equal(control.clicks, 0);

  control.disabled = false;
  page.mutate('disabled');
  page.flush();
  assert.equal(control.clicks, 1);
  page.mutate();
  page.flush();
  assert.equal(control.clicks, 1);

  control.hidden = true;
  page.mutate('hidden');
  page.flush();
  control.hidden = false;
  page.mutate('hidden');
  page.flush();
  assert.equal(control.clicks, 2);
});

test('media events recheck controls revealed without a DOM mutation', async () => {
  const control = button({ style: { display: 'block', visibility: 'visible', opacity: '0' } });
  const page = await load({ buttons: [control] });
  page.flush();
  assert.equal(control.clicks, 0);
  control.style.opacity = '1';
  page.timeupdate();
  page.flush();
  assert.equal(control.clicks, 1);
});

test('OFF cancels pending work and ON resumes; a non-ad player is never clicked', async () => {
  const page = await load();
  page.setEnabled(false);
  page.flush();
  assert.equal(page.buttons[0].clicks, 0);
  assert.equal(page.observers[0].connected, false);

  page.setAdShowing(false);
  page.setEnabled(true);
  page.flush();
  assert.equal(page.buttons[0].clicks, 0);
  page.setAdShowing(true);
  page.flush();
  assert.equal(page.buttons[0].clicks, 1);
});

test('a stale initial storage read cannot undo a newer OFF event', async () => {
  let resolve;
  const storageRead = new Promise(done => { resolve = done; });
  const page = await load({ storageRead });
  page.setEnabled(false);
  resolve({ isEnabled: true });
  await Promise.resolve();
  page.flush();
  assert.equal(page.buttons[0].clicks, 0);
  assert.equal(page.observers.length, 0);
});
