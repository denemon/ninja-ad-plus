'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..', 'src');
const ASCII_PRINTABLE = /^[ -~]+$/;
const URL_FILTER_REGEX_LEFTOVER = /^\/.+\/[a-z]*$/i;
const GUARANTEED_STATIC_RULES = 30000;
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

function readJson(fileName) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, fileName), 'utf8'));
}

// Local files the popup document pulls in itself; the manifest never lists them.
function popupAssets(popupFile) {
  const html = fs.readFileSync(path.join(ROOT, popupFile), 'utf8');
  return [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map(match => match[1])
    .filter(ref => !/^(https?:)?\/\//.test(ref));
}

test('manifest references existing extension resources', () => {
  const manifest = readJson('manifest.json');
  const resources = [
    manifest.background.service_worker,
    manifest.action.default_popup,
    ...Object.values(manifest.action.default_icon),
    ...Object.values(manifest.icons),
    ...manifest.content_scripts.flatMap(script => script.js),
    ...manifest.declarative_net_request.rule_resources.map(ruleset => ruleset.path),
  ];

  for (const resource of resources) {
    assert.ok(fs.existsSync(path.join(ROOT, resource)), `${resource} should exist`);
  }
});

test('src/ holds only files the packaged extension needs', () => {
  const manifest = readJson('manifest.json');
  const declared = new Set([
    'manifest.json',
    manifest.background.service_worker,
    manifest.action.default_popup,
    ...Object.values(manifest.action.default_icon),
    ...Object.values(manifest.icons),
    ...manifest.content_scripts.flatMap(script => script.js),
    ...manifest.declarative_net_request.rule_resources.map(ruleset => ruleset.path),
    ...manifest.web_accessible_resources.flatMap(entry => entry.resources),
    ...popupAssets(manifest.action.default_popup),
    'spoofing.js', // registered at runtime by background.js, not in the manifest
  ]);

  const unexpected = fs.readdirSync(ROOT)
    .filter(name => name !== '_metadata' && !name.startsWith('.'))
    .filter(name => !declared.has(name));

  assert.deepEqual(unexpected, [], `src/ should not ship unreferenced files: ${unexpected}`);
});

test('spoofing.js is registered dynamically so the toggle can disable it', () => {
  const manifest = readJson('manifest.json');
  const manifestScripts = manifest.content_scripts.flatMap(script => script.js);

  assert.equal(
    manifestScripts.includes('spoofing.js'),
    false,
    'a manifest-declared spoofing.js would run even when the extension is off'
  );
  assert.ok(manifest.permissions.includes('scripting'), 'dynamic registration needs "scripting"');
  assert.ok(fs.existsSync(path.join(ROOT, 'spoofing.js')));
});

test('every static rule fits inside Chrome\'s guarantee', () => {
  const manifest = readJson('manifest.json');
  const rulesets = manifest.declarative_net_request.rule_resources;
  const total = rulesets.reduce((count, ruleset) => count + readJson(ruleset.path).length, 0);

  // Anything past the guarantee comes from a pool shared with every other
  // installed extension, and updateEnabledRulesets() is atomic: one rejection
  // costs all blocking at once, for a reason that depends on what else the user
  // happens to have installed. Staying under it makes that outcome impossible.
  assert.ok(
    total <= GUARANTEED_STATIC_RULES,
    `${total} rules exceed the ${GUARANTEED_STATIC_RULES} Chrome guarantees per extension`
  );
});

test('no ruleset is enabled from the manifest, so an update cannot revive a stored OFF', () => {
  const manifest = readJson('manifest.json');

  // Chrome persists the enabled ruleset set across sessions but not across
  // extension updates: rule_resources decides it again on every update. A
  // ruleset marked enabled here would therefore switch itself back on after an
  // update even when the user has the extension off, and would keep blocking
  // until the service worker got around to disabling it again.
  for (const ruleset of manifest.declarative_net_request.rule_resources) {
    assert.equal(
      ruleset.enabled,
      false,
      `${ruleset.id} must start off and be enabled from the stored state instead`
    );
  }
});

test('the whitelist guard outranks every other rule and leads the core ruleset', () => {
  const manifest = readJson('manifest.json');
  const [core] = manifest.declarative_net_request.rule_resources;
  const rules = readJson(core.path);
  const [guard] = rules;

  assert.ok(guard.condition.requestDomains.length > 0, 'the guard matches by requested host');
  assert.equal(guard.action.type, 'allow');
  assert.ok(
    rules.slice(1).every(rule => rule.priority < guard.priority),
    'nothing may outrank the guard, or a whitelisted host could still be redirected'
  );
});

// Chrome types the response from the noop file's extension, so a redirect is
// only invisible when the target suits the requested type: a stylesheet served
// as text/javascript is refused in standards mode and an image fails to decode,
// and both fire the error event anti-adblock scripts watch for. Spelled out here
// rather than imported from convert.js, so the converter cannot define its own
// correctness -- an earlier version of this test only checked image and script
// and passed while 57,000 rules sent stylesheets, fonts and video to /noop.js.
const EXPECTED_NOOP = Object.freeze({
  script: '/noop.js',
  xmlhttprequest: '/noop.js',
  ping: '/noop.js',
  other: '/noop.js',
  object: '/noop.js',
  image: '/noop.gif',
  sub_frame: '/noop.html',
  stylesheet: '/noop.css',
});

test('every redirect serves a noop the requested type can actually load', () => {
  const manifest = readJson('manifest.json');
  const seen = new Set();

  for (const ruleset of manifest.declarative_net_request.rule_resources) {
    for (const rule of readJson(ruleset.path)) {
      if (rule.action.type !== 'redirect') {
        continue;
      }
      const target = rule.action.redirect.extensionPath;

      for (const type of rule.condition.resourceTypes) {
        seen.add(type);
        assert.equal(
          target,
          EXPECTED_NOOP[type],
          `rule ${rule.id} sends ${type} to ${target}`
        );
      }
    }
  }

  // font, media and websocket are absent from the table on purpose: nothing can
  // stand in for a font or a video, and "redirects are not supported for
  // WebSocket requests" -- a WebSocket needs an HTTP 101 upgrade handshake that
  // no static file can answer. All three have to go unmatched rather than be
  // redirected to something the caller will reject. Any type outside the table
  // fails the assertion above against undefined; this catches the reverse, a
  // type that quietly stopped being covered at all.
  assert.deepEqual([...seen].sort(), Object.keys(EXPECTED_NOOP).sort());
});

test('an exception rule can lift every block rule that could apply', () => {
  const manifest = readJson('manifest.json');
  const blockable = new Set();
  const allowed = new Set();

  for (const ruleset of manifest.declarative_net_request.rule_resources) {
    for (const rule of readJson(ruleset.path)) {
      // The whitelist guard is a different mechanism: it covers hosts outright
      // rather than opposing a URL pattern. Merged block rules also match by
      // host, but they still have to be liftable by an exception.
      if (rule.condition.requestDomains && rule.action.type === 'allow') {
        continue;
      }
      const target = rule.action.type === 'allow' ? allowed : blockable;
      for (const type of rule.condition.resourceTypes) {
        target.add(type);
      }
    }
  }

  // A block rule costs one rule per resource type group, so block rules carry a
  // deliberately narrow type set. Exceptions are never split, so breadth is free
  // there -- and an exception narrower than the blocks it opposes silently fails
  // to except: @@||x/ad.css^ would leave ||x/ad.css^$stylesheet redirecting the
  // file the exception exists to permit.
  const uncovered = [...blockable].filter(type => !allowed.has(type));
  assert.deepEqual(uncovered, [], `no exception rule covers ${uncovered}`);
});

test('exceptions lead the ruleset, ahead of every block rule', () => {
  const manifest = readJson('manifest.json');
  const [core] = manifest.declarative_net_request.rule_resources;
  const rules = readJson(core.path).slice(1); // the whitelist guard leads

  const lastAllow = rules.findLastIndex(rule => rule.action.type === 'allow');
  const firstRedirect = rules.findIndex(rule => rule.action.type === 'redirect');

  assert.ok(lastAllow >= 0, 'expected exception rules');
  assert.ok(
    lastAllow < firstRedirect,
    'a block rule ahead of the exceptions would be the one to survive a truncation, ' +
    'leaving it to fire unopposed'
  );
});

test('minimum_chrome_version covers the APIs the extension relies on', () => {
  const manifest = readJson('manifest.json');

  // RegisteredContentScript.world is Chrome 102+, and DNR initiatorDomains is
  // Chrome 101+. Below 102 the extension installs but the spoofing kill switch
  // silently never registers.
  assert.ok(Number(manifest.minimum_chrome_version) >= 102);
});

test('generated rulesets are a valid DNR shape for bundled resources', () => {
  const manifest = readJson('manifest.json');
  const webAccessible = new Set(
    manifest.web_accessible_resources.flatMap(entry => entry.resources)
  );

  for (const ruleset of manifest.declarative_net_request.rule_resources) {
    assertValidRuleset(readJson(ruleset.path), ruleset.path, webAccessible);
  }
});

function assertValidRuleset(rules, label, webAccessible) {
  const ids = new Set();

  assert.ok(rules.length > 0, `${label} should not be empty`);
  assert.ok(rules.length <= 280000, `${label} should stay under converter cap`);

  for (const rule of rules) {
    assert.equal(ids.has(rule.id), false, `duplicate rule id ${rule.id}`);
    ids.add(rule.id);
    assert.ok(Number.isInteger(rule.id) && rule.id > 0, `invalid id ${rule.id}`);
    assert.ok(['allow', 'redirect'].includes(rule.action.type), `invalid action ${rule.id}`);

    const condition = rule.condition;
    assert.ok(condition, `missing condition ${rule.id}`);

    // The whitelist guard and the merged domain blocks both match by requested
    // host rather than by URL pattern, so they carry neither filter. Chrome
    // takes a bare lowercase domain here and rejects the whole ruleset over one
    // malformed entry, which would cost all blocking at once.
    if (condition.requestDomains) {
      assert.equal(condition.urlFilter, undefined, `rule ${rule.id} mixes host and URL matching`);
      assert.equal(condition.regexFilter, undefined, `rule ${rule.id} mixes host and URL matching`);
      for (const domain of condition.requestDomains) {
        assert.match(domain, HOSTNAME, `rule ${rule.id} has an unusable requestDomain ${domain}`);
      }
    } else {
      assert.equal(
        Boolean(condition.urlFilter) && Boolean(condition.regexFilter),
        false,
        `rule ${rule.id} must not set both urlFilter and regexFilter`
      );
      assert.ok(
        condition.urlFilter || condition.regexFilter,
        `rule ${rule.id} needs urlFilter or regexFilter`
      );
    }

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
}
