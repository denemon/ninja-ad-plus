'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const ASCII_PRINTABLE = /^[ -~]+$/;
const URL_FILTER_REGEX_LEFTOVER = /^\/.+\/[a-z]*$/i;

function readJson(fileName) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, fileName), 'utf8'));
}

test('manifest references existing extension resources', () => {
  const manifest = readJson('manifest.json');
  const resources = [
    manifest.background.service_worker,
    manifest.action.default_popup,
    manifest.action.default_icon,
    ...manifest.content_scripts.flatMap(script => script.js),
    ...manifest.declarative_net_request.rule_resources.map(ruleset => ruleset.path),
  ];

  for (const resource of resources) {
    assert.ok(fs.existsSync(path.join(ROOT, resource)), `${resource} should exist`);
  }
});

test('rules.json is a valid DNR ruleset shape for bundled resources', () => {
  const manifest = readJson('manifest.json');
  const rules = readJson('rules.json');
  const webAccessible = new Set(
    manifest.web_accessible_resources.flatMap(entry => entry.resources)
  );
  const ids = new Set();

  assert.ok(rules.length > 0, 'rules should not be empty');
  assert.ok(rules.length <= 280000, 'rules should stay under converter cap');

  for (const rule of rules) {
    assert.equal(ids.has(rule.id), false, `duplicate rule id ${rule.id}`);
    ids.add(rule.id);
    assert.ok(Number.isInteger(rule.id) && rule.id > 0, `invalid id ${rule.id}`);
    assert.ok(['allow', 'redirect'].includes(rule.action.type), `invalid action ${rule.id}`);

    const condition = rule.condition;
    assert.ok(condition, `missing condition ${rule.id}`);
    assert.equal(
      Boolean(condition.urlFilter) && Boolean(condition.regexFilter),
      false,
      `rule ${rule.id} must not set both urlFilter and regexFilter`
    );
    assert.ok(
      condition.urlFilter || condition.regexFilter,
      `rule ${rule.id} needs urlFilter or regexFilter`
    );
    assert.equal(
      condition.resourceTypes.includes('main_frame'),
      false,
      `rule ${rule.id} must not target main_frame`
    );

    if (condition.urlFilter) {
      assert.match(condition.urlFilter, ASCII_PRINTABLE, `non-ASCII urlFilter ${rule.id}`);
      assert.ok(condition.urlFilter.length <= 1024, `urlFilter too long ${rule.id}`);
      assert.equal(
        URL_FILTER_REGEX_LEFTOVER.test(condition.urlFilter) && condition.urlFilter.includes('\\'),
        false,
        `regex-like urlFilter leftover ${rule.id}`
      );
    }
    if (condition.regexFilter) {
      assert.match(condition.regexFilter, ASCII_PRINTABLE, `non-ASCII regexFilter ${rule.id}`);
      assert.doesNotThrow(() => new RegExp(condition.regexFilter), `bad regexFilter ${rule.id}`);
    }

    if (rule.action.type === 'redirect') {
      const extensionPath = rule.action.redirect && rule.action.redirect.extensionPath;
      assert.ok(extensionPath && extensionPath.startsWith('/'), `bad redirect path ${rule.id}`);
      const resource = extensionPath.slice(1);
      assert.ok(webAccessible.has(resource), `${extensionPath} must be web accessible`);
      assert.ok(fs.existsSync(path.join(ROOT, resource)), `${extensionPath} should exist`);
    }
  }
});
