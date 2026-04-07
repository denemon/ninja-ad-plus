'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { convertLines, parseLine } = require('../convert');

test('converts EasyList regex rules to DNR regexFilter rules', () => {
  const result = convertLines([
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

  const result = convertLines(['/ads/$script']);
  assert.equal(result.rules.length, 1);
  assert.equal(result.rules[0].condition.urlFilter, '/ads/');
});

test('skips popup-only and regex popup rules', () => {
  const result = convertLines([
    '$popup,third-party,domain=example.com',
    '/^https?:\\/\\/popup\\.example\\.com\\//$popup,third-party',
  ]);

  assert.equal(result.rules.length, 0);
  assert.equal(result.skipped.mainframe, 2);
});

test('skips overly long urlFilter rules', () => {
  const result = convertLines(['a'.repeat(1025)]);

  assert.equal(result.rules.length, 0);
  assert.equal(result.skipped.invalid, 1);
});

test('skips whitelisted Google-family domains at build time', () => {
  const result = convertLines(['||google.com/pagead/$script']);

  assert.equal(result.rules.length, 0);
  assert.equal(result.skipped.whitelist, 1);
});
