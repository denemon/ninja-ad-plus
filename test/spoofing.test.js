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

test('forces YouTube off the raw Network Machine response path', () => {
  const { context } = createSpoofingContext();
  context.window.location = { hostname: 'www.youtube.com', href: 'https://www.youtube.com/' };
  context.window.URL = URL;

  runSpoofing(context);

  context.window.ytcfg = {};
  context.window.ytcfg.data_ = {};
  context.window.ytcfg.data_.EXPERIMENT_FLAGS = {
    all_web_enable_network_machine: true,
    all_web_network_machine_raw_request: true,
    unrelated_experiment: true,
  };
  const flags = context.window.ytcfg.data_.EXPERIMENT_FLAGS;

  assert.equal(flags.all_web_enable_network_machine, false);
  assert.equal(flags.all_web_network_machine_raw_request, false);
  assert.equal(flags.unrelated_experiment, true);

  flags.all_web_enable_network_machine = true;
  flags.all_web_network_machine_raw_request = true;
  assert.equal(flags.all_web_enable_network_machine, false);
  assert.equal(flags.all_web_network_machine_raw_request, false);

  context.window.ytcfg = {
    data_: {
      EXPERIMENT_FLAGS: {
        all_web_enable_network_machine: true,
        all_web_network_machine_raw_request: true,
      },
    },
  };
  const replacedFlags = context.window.ytcfg.data_.EXPERIMENT_FLAGS;
  assert.equal(replacedFlags.all_web_enable_network_machine, false);
  assert.equal(replacedFlags.all_web_network_machine_raw_request, false);
});

test('removes ad metadata from YouTube initial, fetch and XHR player responses', async () => {
  class FakeResponse {
    constructor(url, body) {
      this.url = url;
      this.body = body;
    }
    async json() { return this.body; }
    async text() { return JSON.stringify(this.body); }
  }

  class FakeXMLHttpRequest {
    constructor(body, responseType = '') {
      this.body = body;
      this.responseType = responseType;
    }
    open(_method, url) { this.url = url; }
  }
  Object.defineProperties(FakeXMLHttpRequest.prototype, {
    response: {
      configurable: true,
      get() { return this.responseType === 'json' ? this.body : JSON.stringify(this.body); },
    },
    responseText: {
      configurable: true,
      get() { return JSON.stringify(this.body); },
    },
  });

  const playerData = () => ({
    adPlacements: [{ id: 'pre-roll' }],
    playerAds: [{ id: 'companion' }],
    playerResponse: { adSlots: [{ id: 'mid-roll' }], videoDetails: { videoId: 'abc' } },
    entries: [
      { command: { reelWatchEndpoint: { adClientParams: { isAd: true } } } },
      { command: { reelWatchEndpoint: { videoId: 'short' } } },
    ],
  });
  const { context } = createSpoofingContext();
  context.window.location = { hostname: 'www.youtube.com', href: 'https://www.youtube.com/watch?v=abc' };
  context.window.URL = URL;
  context.window.Response = FakeResponse;
  context.window.XMLHttpRequest = FakeXMLHttpRequest;

  runSpoofing(context);

  context.window.ytInitialPlayerResponse = playerData();
  assert.equal(context.window.ytInitialPlayerResponse.adPlacements, undefined);
  assert.equal(context.window.ytInitialPlayerResponse.playerAds, undefined);
  assert.equal(context.window.ytInitialPlayerResponse.playerResponse.adSlots, undefined);
  assert.equal(context.window.ytInitialPlayerResponse.entries.length, 1);

  const response = new FakeResponse(
    'https://www.youtube.com/youtubei/v1/player?prettyPrint=false',
    playerData()
  );
  const fetched = await response.json();
  assert.equal(fetched.adPlacements, undefined);
  assert.equal(fetched.playerResponse.adSlots, undefined);

  // Feed, search and guide responses carry ad slots too.
  const feedResponse = new FakeResponse(
    'https://www.youtube.com/youtubei/v1/browse',
    playerData()
  );
  assert.equal((await feedResponse.json()).adPlacements, undefined);

  // The API host serves the same InnerTube payloads as the site host.
  const apiResponse = new FakeResponse(
    'https://youtubei.googleapis.com/youtubei/v1/player',
    playerData()
  );
  assert.equal((await apiResponse.json()).playerResponse.adSlots, undefined);

  // Shorts entries carry adClientParams and no other ad key, so the text
  // pre-check has to let them through for the reel prune to run at all.
  const reelResponse = new FakeResponse(
    'https://www.youtube.com/youtubei/v1/reel/reel_item_watch',
    { entries: playerData().entries }
  );
  assert.equal(JSON.parse(await reelResponse.text()).entries.length, 1);

  const unrelatedResponse = new FakeResponse(
    'https://www.youtube.com/youtubei/v1/log_event',
    playerData()
  );
  assert.equal((await unrelatedResponse.json()).adPlacements.length, 1);

  // A feed entry whose renderer is an ad is dropped whole: deleting just the
  // renderer key would leave the wrappers behind as an empty card.
  const feedContents = [
    { richItemRenderer: { content: { videoRenderer: { videoId: 'real' } } } },
    { richItemRenderer: { content: { adSlotRenderer: { adSlotMetadata: {} } } } },
    { richSectionRenderer: { content: { inFeedAdLayoutRenderer: {} } } },
    // A section mixing real results with an ad must keep the results.
    {
      itemSectionRenderer: {
        contents: [
          { videoRenderer: { videoId: 'kept' } },
          { searchPyvRenderer: {} },
          { videoRenderer: { videoId: 'also-kept' } },
        ],
      },
    },
  ];
  const feedEntries = new FakeResponse(
    'https://www.youtube.com/youtubei/v1/search',
    { contents: feedContents, adBreakHeartbeatParams: 'x' }
  );
  const feed = await feedEntries.json();
  assert.equal(feed.adBreakHeartbeatParams, undefined);
  assert.deepEqual(
    feed.contents.map((entry) => Object.keys(entry)[0]),
    ['richItemRenderer', 'itemSectionRenderer']
  );
  assert.deepEqual(
    feed.contents[1].itemSectionRenderer.contents.map((item) => item.videoRenderer.videoId),
    ['kept', 'also-kept']
  );

  // The text pre-check has to let renderer-only payloads through too.
  const rendererOnly = new FakeResponse(
    'https://www.youtube.com/youtubei/v1/browse',
    { contents: [{ richItemRenderer: { content: { displayAdRenderer: {} } } }] }
  );
  assert.equal(JSON.parse(await rendererOnly.text()).contents.length, 0);

  const xhr = new FakeXMLHttpRequest(playerData());
  xhr.open('POST', '/youtubei/v1/player');
  const xhrData = JSON.parse(xhr.responseText);
  assert.equal(xhrData.adPlacements, undefined);
  assert.equal(xhrData.playerResponse.adSlots, undefined);
});

test('seeks a server-side YouTube ad using the page player API', () => {
  let clicked = false;
  let seekedTo;
  const player = {
    getStatsForNerds() { return { debug_info: 'SSAP, AD, pre-roll' }; },
    getProgressState() { return { current: 2, duration: 15 }; },
    querySelector() { return { click() { clicked = true; } }; },
    seekTo(value) { seekedTo = value; },
  };
  const { context } = createSpoofingContext();
  context.window.location = { hostname: 'www.youtube.com', href: 'https://www.youtube.com/watch?v=abc' };
  context.window.URL = URL;
  context.window.requestAnimationFrame = callback => callback();
  context.document.getElementById = id => id === 'movie_player' ? player : null;

  runSpoofing(context);

  assert.equal(clicked, true);
  assert.equal(seekedTo, 15);
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

test('hidden UI that is not empty bait is left alone', () => {
  const { context, observers } = createSpoofingContext();
  runSpoofing(context);

  const hidden = { display: 'none', visibility: 'hidden', opacity: '0' };
  const untouched = ['address', 'admin-dialog', 'adaptive-layout', 'bannerman', 'sponsorship']
    .map(name => createElement({ className: name, _computedStyle: hidden }));
  // GitHub/Primer calls its message box "Banner-message": a bait name on real,
  // text-bearing UI. Force-showing it leaks every hidden upload error at once.
  untouched.push(createElement({
    className: 'Banner-message',
    textContent: 'Attaching documents requires write permission to this repository.',
    _computedStyle: hidden,
  }));
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
