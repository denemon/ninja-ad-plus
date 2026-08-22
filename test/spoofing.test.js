'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const SPOOFING_SOURCE = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'spoofing.js'), 'utf8');

function createStyle() {
  const calls = [];
  return {
    calls,
    setProperty(name, value, priority) {
      calls.push({ name, value, priority });
    },
  };
}

function createElement(overrides = {}) {
  return {
    nodeType: 1,
    className: '',
    id: '',
    textContent: '',
    dataset: {},
    style: createStyle(),
    attributes: {},
    classList: { remove() {} },
    appendChild() {},
    removeChild(node) { this.removedChild = node; },
    setAttribute(name, value) { this.attributes[name] = value; },
    getAttribute(name) {
      if (name === 'class') return this.className || '';
      return this.attributes[name] || '';
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { width: 0, height: 0 }; },
    _computedStyle: {
      display: 'block',
      visibility: 'visible',
      opacity: '1',
      position: 'static',
      zIndex: '0',
      overflow: 'visible',
    },
    ...overrides,
  };
}

function createTextNode(text, parentNode) {
  return {
    nodeType: 3,
    nodeValue: text,
    textContent: text,
    parentNode,
    parentElement: parentNode,
  };
}

function createSpoofingContext(candidates = []) {
  const timers = [];
  const listeners = {};
  const observers = [];
  const documentElement = createElement({
    _computedStyle: { overflow: 'hidden' },
  });
  const body = createElement({
    _computedStyle: { overflow: 'hidden' },
  });

  function HTMLElement() {}
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    get() { return this._offsetHeight || 0; },
    configurable: true,
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    get() { return this._offsetWidth || 0; },
    configurable: true,
  });

  const context = {
    console,
    HTMLElement,
    MutationObserver: class {
      constructor(callback) {
        this.callback = callback;
        observers.push(this);
      }
      observe() {}
    },
    setTimeout(callback) {
      timers.push(callback);
      return timers.length;
    },
    window: {
      innerWidth: 1000,
      innerHeight: 1000,
      getComputedStyle(element) {
        return element._computedStyle || {};
      },
      addEventListener(event, callback) {
        listeners[event] = callback;
      },
    },
    document: {
      documentElement,
      body,
      addEventListener(event, callback) {
        listeners[event] = callback;
      },
      createElement() {
        return createElement();
      },
      getElementById() {
        return null;
      },
      querySelectorAll() {
        return candidates;
      },
    },
  };

  context.window.document = context.document;
  context.window.HTMLElement = HTMLElement;

  return { context, timers, listeners, observers, documentElement, body };
}

function runSpoofing(context) {
  vm.runInNewContext(SPOOFING_SOURCE, context, { filename: 'spoofing.js' });
}

test('googletag command queue executes callbacks once', () => {
  const { context } = createSpoofingContext();

  runSpoofing(context);

  let count = 0;
  const queueLength = context.window.googletag.cmd.push(() => {
    count++;
  });

  assert.equal(queueLength, 1);
  assert.equal(count, 1);
});

test('pre-existing googletag command queue is flushed once and wrapped once', () => {
  const { context } = createSpoofingContext();
  let count = 0;
  context.window.googletag = {
    cmd: [
      () => { count++; },
    ],
  };

  runSpoofing(context);
  context.window.googletag.cmd.push(() => {
    count++;
  });

  assert.equal(count, 2);
});

function createOverlay() {
  return createElement({
    textContent: 'Please disable your ad blocker to continue',
    _computedStyle: { position: 'fixed', zIndex: '9999' },
    getBoundingClientRect() { return { width: 1000, height: 1000 }; },
  });
}

test('an overlay injected after the first pass is still removed', () => {
  const candidates = [];
  const { context, timers, listeners } = createSpoofingContext(candidates);

  runSpoofing(context);
  listeners.load();

  // First pass at 500ms: the page has nothing on it yet.
  timers.shift()();

  const overlay = createOverlay();
  candidates.push(overlay);

  // Second pass at 2500ms must still run, or a late overlay is missed forever.
  timers.shift()();

  assert.deepEqual(
    overlay.style.calls.filter(call => call.name === 'display'),
    [{ name: 'display', value: 'none', priority: 'important' }]
  );
});

test('hidden UI whose name merely starts with "ad" is left alone', () => {
  const { context, observers } = createSpoofingContext();
  runSpoofing(context);

  const hidden = { display: 'none', visibility: 'hidden', opacity: '0' };
  const untouched = ['address', 'admin-dialog', 'adaptive-layout', 'bannerman', 'sponsorship']
    .map(name => createElement({ className: name, _computedStyle: hidden }));
  const bait = ['ads', 'ad-banner', 'adBanner', 'ads_top', 'banner-left']
    .map(name => createElement({ className: name, _computedStyle: hidden }));

  for (const observer of observers) {
    observer.callback([{ type: 'childList', addedNodes: [...untouched, ...bait], target: context.document.body }]);
  }

  for (const el of untouched) {
    assert.deepEqual(el.style.calls, [], `${el.className} must not be force-shown`);
  }
  for (const el of bait) {
    assert.ok(
      el.style.calls.some(call => call.name === 'display' && call.value === 'block'),
      `${el.className} should still be protected as bait`
    );
  }
});

test('overlay cleanup does not unlock scrolling when no overlay is found', () => {
  const { context, timers, listeners, documentElement, body } = createSpoofingContext();

  runSpoofing(context);
  listeners.load();
  while (timers.length > 0) {
    timers.shift()();
  }

  assert.equal(documentElement.style.calls.some(call => call.name === 'overflow'), false);
  assert.equal(body.style.calls.some(call => call.name === 'overflow'), false);
});

test('hides raw sponsored placeholder templates added as text', () => {
  const { context, observers } = createSpoofingContext();
  const rawTemplate =
    '<a href="" rel="nofollow" class="article-link" aria-label="SPONSORED_HEADLINE">' +
    '<article aria-label="Search result: SPONSORED_HEADLINE" class="search-result">' +
    '<img src="SPONSORED_IMAGE_URL">SPONSORED_STRAPLINE</article></a>';
  const parent = createElement({ textContent: rawTemplate });
  const textNode = createTextNode(rawTemplate, parent);

  runSpoofing(context);
  observers[0].callback([{ type: 'childList', addedNodes: [textNode] }]);

  assert.equal(parent.removedChild, textNode);
  assert.equal(
    parent.style.calls.some(call => call.name === 'display' && call.value === 'none'),
    false
  );
});

test('hides parsed sponsored placeholder templates added as elements', () => {
  const { context, observers } = createSpoofingContext();
  const element = createElement({
    className: 'article-link',
    attributes: { 'aria-label': 'SPONSORED_HEADLINE' },
    textContent: 'SPONSORED_HEADLINE SPONSORED SPONSORED_STRAPLINE',
  });

  runSpoofing(context);
  observers[0].callback([{ type: 'childList', addedNodes: [element] }]);

  assert.equal(
    element.style.calls.some(call => call.name === 'display' && call.value === 'none'),
    true
  );
});

test('hides sponsored placeholder templates when text is updated in place', () => {
  const { context, observers } = createSpoofingContext();
  const text = 'SPONSORED_HEADLINE SPONSORED_IMAGE_URL SPONSORED_STRAPLINE';
  const parent = createElement({ textContent: text });
  const textNode = createTextNode(text, parent);

  runSpoofing(context);
  observers[0].callback([{ type: 'characterData', addedNodes: [], target: textNode }]);

  assert.equal(parent.removedChild, textNode);
  assert.equal(
    parent.style.calls.some(call => call.name === 'display' && call.value === 'none'),
    false
  );
});

test('does not hide a large parent that merely contains sponsored placeholders', () => {
  const { context, observers } = createSpoofingContext();
  const appRoot = createElement({
    className: 'app-root',
    textContent: 'Main content SPONSORED_HEADLINE SPONSORED_IMAGE_URL SPONSORED_STRAPLINE',
  });

  runSpoofing(context);
  observers[0].callback([{ type: 'childList', addedNodes: [appRoot] }]);

  assert.equal(
    appRoot.style.calls.some(call => call.name === 'display' && call.value === 'none'),
    false
  );
});

test('does not hide broad containers with similar class names', () => {
  const { context, observers } = createSpoofingContext();
  const appRoot = createElement({
    className: 'article-link-list',
    textContent: 'Main content SPONSORED_HEADLINE SPONSORED_IMAGE_URL SPONSORED_STRAPLINE',
  });

  runSpoofing(context);
  observers[0].callback([{ type: 'childList', addedNodes: [appRoot] }]);

  assert.equal(
    appRoot.style.calls.some(call => call.name === 'display' && call.value === 'none'),
    false
  );
});

test('does not hide ordinary sponsored labels without leaked placeholders', () => {
  const { context, observers } = createSpoofingContext();
  const element = createElement({
    textContent: 'SPONSORED',
  });

  runSpoofing(context);
  observers[0].callback([{ type: 'childList', addedNodes: [element] }]);

  assert.equal(
    element.style.calls.some(call => call.name === 'display' && call.value === 'none'),
    false
  );
});
