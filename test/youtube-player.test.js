'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'youtube-player.js'), 'utf8');
const PLAYER_URL = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';
const payload = () => ({
  adPlacements: [{ ad: 'pre-roll' }],
  adSlots: [{ slot: 'pre-roll' }],
  adBreakHeartbeatParams: 'keep-heartbeat',
  playbackTracking: { videostatsPlaybackUrl: { baseUrl: '/api/stats/playback' } },
  streamingData: { formats: [{ url: 'https://media.example/video' }] },
  videoDetails: { videoId: 'main-video' },
});

function response(body, url = PLAYER_URL, options = {}) {
  const result = new Response(body, {
    headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) },
    ...options,
  });
  Object.defineProperties(result, { url: { value: url }, redirected: { value: true }, type: { value: 'basic' } });
  return result;
}

function load({ hostname = 'www.youtube.com', initial, fetchImpl = async () => response(JSON.stringify(payload())) } = {}) {
  class XMLHttpRequest {
    status = 200;
    open(method, url) { this.method = method; this.url = url; this.responseURL = ''; }
    get responseText() {
      if (this.responseType === 'json') throw new TypeError('InvalidStateError');
      return this.body;
    }
    get response() { return this.body; }
  }
  const context = {
    location: { hostname, href: `https://${hostname}/watch?v=main-video` },
    URL, Request, Response, Headers, XMLHttpRequest,
    fetch: fetchImpl,
    ytcfg: { data_: { EXPERIMENT_FLAGS: { all_web_enable_network_machine: true } } },
  };
  if (initial !== undefined) context.ytInitialPlayerResponse = initial;
  context.window = context;
  vm.runInNewContext(SOURCE, context, { filename: 'youtube-player.js' });
  return context;
}

function assertPlayerData(data) {
  assert.equal(data.adPlacements, undefined);
  assert.equal(data.adSlots, undefined);
  assert.equal(data.adBreakHeartbeatParams, 'keep-heartbeat');
  assert.equal(data.streamingData.formats[0].url, 'https://media.example/video');
  assert.equal(data.playbackTracking.videostatsPlaybackUrl.baseUrl, '/api/stats/playback');
  assert.equal(data.videoDetails.videoId, 'main-video');
}

test('initial player assignments are filtered synchronously before first player consumption', () => {
  const context = load();
  for (let i = 0; i < 2; i++) {
    const data = payload();
    context.ytInitialPlayerResponse = data;
    assert.equal(context.ytInitialPlayerResponse, data, 'keep initial object identity');
    assertPlayerData(context.ytInitialPlayerResponse);
  }
  assert.equal(context.ytcfg.data_.EXPERIMENT_FLAGS.all_web_enable_network_machine, true);
});

test('already present player data is filtered, and null or frozen data does not break initialization', () => {
  const context = load({ initial: payload() });
  assertPlayerData(context.ytInitialPlayerResponse);
  for (const data of [null, undefined, 0, Object.freeze(payload())]) {
    assert.doesNotThrow(() => { context.ytInitialPlayerResponse = data; });
    assert.equal(context.ytInitialPlayerResponse, data);
  }
});

test('player fetch bodies are filtered for json, text, arrayBuffer, streams and clones', async () => {
  for (const method of ['json', 'text', 'arrayBuffer', 'stream', 'clone']) {
    const context = load();
    const result = await context.fetch(new Request(PLAYER_URL));
    assert.equal(result.url, PLAYER_URL);
    assert.equal(result.redirected, true);
    assert.equal(result.type, 'basic');
    assert.equal(result.status, 200);
    assert.equal(result.bodyUsed, false);
    assert.equal(result.headers.get('content-length'), null);
    let data;
    if (method === 'json') data = await result.json();
    if (method === 'text') data = JSON.parse(await result.text());
    if (method === 'arrayBuffer') data = JSON.parse(new TextDecoder().decode(await result.arrayBuffer()));
    if (method === 'stream') data = await new Response(result.body).json();
    if (method === 'clone') {
      const clone = result.clone().clone();
      assert.equal(clone.url, PLAYER_URL);
      assert.equal(clone.redirected, true);
      assert.equal(clone.type, 'basic');
      data = await clone.json();
      assert.equal(result.bodyUsed, false);
      await result.text();
    }
    assertPlayerData(data);
    assert.equal(result.bodyUsed, true);
    await assert.rejects(result.text(), TypeError);
  }
});

test('filters API-host, relative and wrapped player responses without changing JSON number text', async () => {
  const body = `)]}'\n[{"playerResponse":${JSON.stringify(payload())},"requestId":9007199254740993}]`;
  for (const url of [PLAYER_URL, '/youtubei/v1/player', 'https://youtubei.googleapis.com/youtubei/v1/player', '/youtubei/v1/get_watch', '/watch?v=main-video&pbj=1']) {
    const context = load({ fetchImpl: async () => response(body, new URL(url, PLAYER_URL).href) });
    const result = await context.fetch(url);
    const text = await result.text();
    assert.ok(text.startsWith(")]}'\n"));
    assert.ok(text.includes('9007199254740993'), 'do not round-trip numbers through JSON.stringify');
    assertPlayerData(JSON.parse(text.slice(text.indexOf('\n') + 1))[0].playerResponse);
  }
});

test('non-player requests and redirected responses keep their original body and response identity', async () => {
  for (const url of [
    'https://www.youtube.com/youtubei/v1/log_event',
    'https://www.youtube.com/youtubei/v1/browse',
    'https://www.youtube.com/youtubei/v1/player/extra',
    'https://youtube.com.example.org/youtubei/v1/player',
    'https://example.org/youtubei/v1/player',
  ]) {
    const original = response(JSON.stringify(payload()), url);
    const context = load({ fetchImpl: async () => original });
    const result = await context.fetch(url);
    assert.equal(result, original);
    assert.equal(result.bodyUsed, false);
    assert.equal((await result.json()).adSlots.length, 1);
  }
  const external = response(JSON.stringify(payload()), 'https://example.org/youtubei/v1/player');
  const context = load({ fetchImpl: async () => external });
  assert.equal(await context.fetch(PLAYER_URL), external);
});

test('malformed, HTML, ad-free and error responses pass through unconsumed; fetch failures propagate', async () => {
  for (const body of ['{"adSlots":', '<html>"adSlots":[]</html>', '{"videoDetails":{"videoId":"main-video"}}']) {
    const original = response(body);
    const context = load({ fetchImpl: async () => original });
    assert.equal(await context.fetch(PLAYER_URL), original);
    assert.equal(original.bodyUsed, false);
    assert.equal(await original.text(), body);
  }
  const failed = response(JSON.stringify(payload()), PLAYER_URL, { status: 403 });
  const context = load({ fetchImpl: async () => failed });
  assert.equal(await context.fetch(PLAYER_URL), failed);
  const error = new TypeError('network failure');
  const rejecting = load({ fetchImpl: async () => { throw error; } });
  await assert.rejects(rejecting.fetch(PLAYER_URL), value => value === error);
});

test('XHR filters player JSON/text, preserves getter errors and resets scope on reuse', () => {
  const context = load();
  const xhr = new context.XMLHttpRequest();
  xhr.open('POST', '/youtubei/v1/player');
  xhr.body = JSON.stringify(payload());
  assertPlayerData(JSON.parse(xhr.responseText));
  assertPlayerData(JSON.parse(xhr.response));
  xhr.responseType = 'json';
  xhr.body = { playerResponse: payload() };
  assertPlayerData(xhr.response.playerResponse);
  assert.throws(() => xhr.responseText, /InvalidStateError/);
  xhr.open('POST', '/youtubei/v1/log_event');
  xhr.responseType = '';
  xhr.body = JSON.stringify(payload());
  assert.equal(xhr.responseText, xhr.body);
});

test('XHR error responses and redirects outside YouTube pass through unchanged', () => {
  const context = load();
  const xhr = new context.XMLHttpRequest();
  xhr.open('POST', '/youtubei/v1/player');
  xhr.body = JSON.stringify(payload());
  for (const status of [0, 199, 300, 403, 500]) {
    xhr.status = status;
    assert.equal(xhr.responseText, xhr.body, `HTTP ${status}`);
  }
  xhr.status = 200;
  xhr.responseURL = 'https://example.org/youtubei/v1/player';
  assert.equal(xhr.responseText, xhr.body);
});

test('only YouTube documents install the player filter', () => {
  const fetchImpl = async () => response('{}');
  for (const hostname of ['example.org', 'youtube.com.example.org', 'notyoutube.com']) {
    const context = load({ hostname, fetchImpl });
    assert.equal(context.fetch, fetchImpl);
    assert.equal(Object.hasOwn(context, 'ytInitialPlayerResponse'), false);
  }
  const embed = load({ hostname: 'www.youtube-nocookie.com' });
  embed.ytInitialPlayerResponse = payload();
  assertPlayerData(embed.ytInitialPlayerResponse);
});
