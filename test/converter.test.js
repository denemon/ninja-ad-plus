'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { convertLines, parseLine, assertFitsGuarantee } = require('../convert');

// Every ruleset leads with the whitelist guard rule. These tests are about the
// rules converted from the input lines, so drop it — while asserting it is
// there, since it is the only thing protecting the whitelisted hosts.
function convert(lines) {
  const result = convertLines(lines);
  const [guard, ...rules] = result.rules;

  assert.deepEqual(guard.action, { type: 'allow' });
  assert.ok(guard.condition.requestDomains.includes('google.com'));
  assert.ok(guard.priority > 2, 'the guard must outrank exceptions and blocks');

  return { ...result, rules };
}

test('a generic filter cannot reach a whitelisted host', () => {
  // This filter never mentions Google, so the build-time scan cannot catch it,
  // yet it matches https://www.google.com/pagead/conversion.js.
  const result = convert(['/pagead/conversion.js$script']);

  assert.equal(result.rules.length, 1);
  assert.equal(result.rules[0].condition.urlFilter, '/pagead/conversion.js');

  const guard = convertLines([]).rules[0];
  assert.deepEqual(guard.condition.requestDomains, [
    'google.com', 'google.co.jp', 'gstatic.com', 'googleapis.com',
    'youtube.com', 'ggpht.com', 'accounts.google.com',
    'gemini.google.com', 'bard.google.com',
  ]);
});

test('every resource type gets a noop it can load', () => {
  // A filter with no $type option covers many resource types, and a rule carries
  // one action, so it has to be split: one byte of JavaScript fails to decode as
  // an image and fires the error event anti-adblock scripts listen for, and a
  // stylesheet served as text/javascript is refused outright.
  const result = convert(['||example.com/ad-frame^']);

  const byTarget = new Map(
    result.rules.map(rule => [rule.action.redirect.extensionPath, rule.condition.resourceTypes])
  );

  assert.deepEqual(byTarget.get('/noop.gif'), ['image']);
  assert.deepEqual(byTarget.get('/noop.html'), ['sub_frame']);
  assert.deepEqual(
    byTarget.get('/noop.js'),
    ['script', 'xmlhttprequest', 'ping', 'other', 'object']
  );

  // Nothing can stand in for a font or a video, Chrome does not support
  // redirecting a WebSocket at all, and a generic filter is not worth an extra
  // rule on every one of 57,000 filters for ad CSS that EasyList itself marks on
  // 17 of them. Unmatched means the request proceeds untouched -- less blocking,
  // nothing for a page to detect.
  assert.equal(byTarget.has('/noop.css'), false);
  const covered = result.rules.flatMap(rule => rule.condition.resourceTypes);
  assert.deepEqual(
    covered.filter(type => ['font', 'media', 'websocket', 'stylesheet'].includes(type)),
    []
  );
});

test('a generic exception lifts a type-specific block on the same URL', () => {
  const result = convert([
    '||example.com/ad.css^$stylesheet',
    '@@||example.com/ad.css^',
  ]);

  const allow = result.rules.find(rule => rule.action.type === 'allow');
  const redirect = result.rules.find(rule => rule.action.type === 'redirect');

  assert.ok(allow.priority > redirect.priority);
  assert.ok(
    allow.condition.resourceTypes.includes('stylesheet'),
    'an exception narrower than the block it opposes does not except anything'
  );
  assert.equal(redirect.action.redirect.extensionPath, '/noop.css');
});

test('an exception never claims a type no rule can block', () => {
  const [allow] = convert(['@@||example.com/keep^']).rules;

  for (const type of ['font', 'media', 'websocket']) {
    assert.equal(allow.condition.resourceTypes.includes(type), false, `${type} is never blocked`);
  }
});

test('an explicit $stylesheet filter still reaches the stylesheet noop', () => {
  const result = convert(['||example.com/ads.css^$stylesheet']);

  assert.equal(result.rules.length, 1);
  assert.deepEqual(result.rules[0].condition.resourceTypes, ['stylesheet']);
  assert.equal(result.rules[0].action.redirect.extensionPath, '/noop.css');
});

test('a filter for a type no noop can serve is dropped, not redirected elsewhere', () => {
  const result = convert([
    '||example.com/ad.woff2^$font',        // nothing left to serve: drop the line
    '||example.com/preroll.mp4^$media',
    '||example.com/ad^$media,script',      // narrows to script rather than dropping
  ]);

  assert.equal(result.skipped.invalid, 2);
  assert.equal(result.rules.length, 1);
  assert.deepEqual(result.rules[0].condition.resourceTypes, ['script']);
  assert.equal(result.rules[0].action.redirect.extensionPath, '/noop.js');
});

test('rules are emitted noop group by noop group, not filter by filter', () => {
  // The order decides what a ruleset that overflowed the guarantee would drop
  // first. Grouping by target puts one rule per filter in front, rather than
  // every variant of the first quarter of the filters.
  const result = convert(['||a.example/ad^', '||b.example/ad^']);

  assert.deepEqual(
    result.rules.map(rule => rule.action.redirect.extensionPath),
    ['/noop.js', '/noop.js', '/noop.gif', '/noop.gif', '/noop.html', '/noop.html']
  );
});

test('drops rules carrying options with no declarativeNetRequest equivalent', () => {
  const result = convert([
    '@@||example.com^$generichide',       // cosmetic-only: must not become a network allow
    '||example.com/ads^$csp=script-src',  // header injection: must not become a redirect
    '||example.com/x.js^$rewrite=abp-resource:blank-js',
    '||example.com/keep.js^$script',      // supported, stays
  ]);

  assert.equal(result.skipped.unsupported, 3);
  assert.equal(result.rules.length, 1);
  assert.equal(result.rules[0].condition.urlFilter, '||example.com/keep.js^');
});

test('an unsupported option does not survive alongside a supported one', () => {
  const result = convert(['@@||example.com^$xmlhttprequest,generichide']);

  assert.equal(result.rules.length, 0);
  assert.equal(result.skipped.unsupported, 1);
});

test('whitelisting matches whole hosts, not substrings', () => {
  const result = convert([
    '||ggpht.com/ad.js^$script',          // the whitelisted host itself
    '||cdn.ggpht.com/ad.js^$script',      // a subdomain of it
    '||gggpht.com/ad.js^$script',         // unrelated host that merely contains it
    '||ggpht.com.evil.net/ad.js^$script', // whitelisted label used as a prefix
  ]);

  assert.equal(result.skipped.whitelist, 2);
  assert.deepEqual(
    result.rules.map(rule => rule.condition.urlFilter),
    ['||gggpht.com/ad.js^', '||ggpht.com.evil.net/ad.js^']
  );
});

test('assertFitsGuarantee refuses a ruleset that would need the shared pool', () => {
  const oversized = Array.from({ length: 30001 }, (_, index) => ({ id: index + 1 }));

  assert.throws(() => assertFitsGuarantee(oversized), /30001 rules exceed/);
  assert.doesNotThrow(() => assertFitsGuarantee(oversized.slice(0, 30000)));
});

// Whole-host filters are what the bundled lists are almost entirely made of, so
// this merge is the difference between ~12,000 rules and ~178,000. At the old
// count everything past Chrome's guarantee competed for the shared global pool,
// and the networks that fell past the cut -- g.doubleclick.net among them --
// were blocked only if that gamble paid off.
test('whole-host filters merge into one requestDomains rule per noop target', () => {
  const result = convert(['||a.example^', '||b.example^', '||c.example^']);
  const merged = result.rules.filter(rule => rule.condition.requestDomains);

  assert.deepEqual(
    merged.map(rule => rule.action.redirect.extensionPath),
    ['/noop.js', '/noop.gif', '/noop.html']
  );
  for (const rule of merged) {
    assert.deepEqual(rule.condition.requestDomains, ['a.example', 'b.example', 'c.example']);
    assert.equal(rule.condition.urlFilter, undefined);
  }
});

test('merging keeps filters apart when their conditions differ', () => {
  const result = convert([
    '||a.example^',
    '||b.example^$third-party',        // domainType cannot vary within one rule
    '||c.example^$script',             // narrower resourceTypes must not widen
    '||d.example^$domain=publisher.example', // initiatorDomains is per-filter
  ]);

  const byDomains = result.rules
    .filter(rule => rule.condition.requestDomains)
    .filter(rule => rule.action.redirect.extensionPath === '/noop.js')
    .map(rule => [rule.condition.requestDomains, rule.condition.domainType, rule.condition.resourceTypes]);

  assert.deepEqual(byDomains, [
    [['a.example'], undefined, ['script', 'xmlhttprequest', 'ping', 'other', 'object']],
    [['b.example'], 'thirdParty', ['script', 'xmlhttprequest', 'ping', 'other', 'object']],
    [['c.example'], undefined, ['script']],
  ]);
  assert.ok(
    result.rules.some(rule => rule.condition.urlFilter === '||d.example^'),
    'a $domain= filter must keep its own rule so its initiatorDomains stay its own'
  );
});

// ||ad.example without a trailing ^ also matches ad.example.evil.net, which
// requestDomains would not: merging it would silently narrow the filter.
test('only a bare host with a trailing separator is safe to merge', () => {
  const result = convert(['||ad.example', '||ad.example:8080^', '||ads.*.example^']);

  assert.deepEqual(result.rules.filter(rule => rule.condition.requestDomains), []);
  assert.deepEqual(
    [...new Set(result.rules.map(rule => rule.condition.urlFilter))],
    ['||ad.example', '||ad.example:8080^', '||ads.*.example^']
  );
});

test('converts EasyList regex rules to DNR regexFilter rules', () => {
  const result = convert([
    '/^https?:\\/\\/ads\\.example\\.com\\/path\\/.*$/$script,third-party,domain=example.org',
  ]);

  assert.equal(result.rules.length, 1);
  assert.equal(result.skipped.invalid, 0);

  const [rule] = result.rules;
  assert.equal(rule.condition.regexFilter, '^https?:\\/\\/ads\\.example\\.com\\/path\\/.*$');
  assert.equal(rule.condition.urlFilter, undefined);
  assert.deepEqual(rule.condition.resourceTypes, ['script']);
  assert.equal(rule.condition.domainType, 'thirdParty');
  assert.deepEqual(rule.condition.initiatorDomains, ['example.org']);
  assert.equal(rule.action.redirect.extensionPath, '/noop.js');
});

test('keeps slash-wrapped path filters as urlFilter rules', () => {
  const parsed = parseLine('/ads/$script');
  assert.equal(parsed.filterKey, 'urlFilter');
  assert.equal(parsed.filterValue, '/ads/');

  const result = convert(['/ads/$script']);
  assert.equal(result.rules.length, 1);
  assert.equal(result.rules[0].condition.urlFilter, '/ads/');
});

test('skips regex rules whose compiled form exceeds the RE2 2KB limit', () => {
  // 33 written characters, but RE2 expands .{100,} at compile time and blows
  // Chrome's 2KB program-memory cap — the rule would load as an error and be
  // skipped by Chrome anyway.
  const result = convert(['/(https?:\\/\\/)104\\.154\\..{100,}/$script,third-party']);

  assert.equal(result.rules.length, 0);
  assert.equal(result.skipped.invalid, 1);
});

test('skips popup-only and regex popup rules', () => {
  const result = convert([
    '$popup,third-party,domain=example.com',
    '/^https?:\\/\\/popup\\.example\\.com\\//$popup,third-party',
  ]);

  assert.equal(result.rules.length, 0);
  assert.equal(result.skipped.mainframe, 2);
});

test('skips overly long urlFilter rules', () => {
  const result = convert(['a'.repeat(1025)]);

  assert.equal(result.rules.length, 0);
  assert.equal(result.skipped.invalid, 1);
});

test('skips whitelisted Google-family domains at build time', () => {
  const result = convert(['||google.com/pagead/$script']);

  assert.equal(result.rules.length, 0);
  assert.equal(result.skipped.whitelist, 1);
});
