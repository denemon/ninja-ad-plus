'use strict';

const fs = require('fs');
const path = require('path');
const { RE2 } = require('@adguard/re2-wasm');

// EasyList is international and carries almost no Japanese ad networks, so a
// regional list is what covers hosts like caprofitx.com and flux-cdn.com.
const DEFAULT_INPUT_FILES = [
  'filters/easylist.txt',
  'filters/antiadblockfilters.txt',
  'filters/adguard-japanese.txt',
];
const CORE_OUTPUT_FILE = 'src/rules-core.json';

// Chrome guarantees this many static rules per extension; anything past it is
// drawn from a pool shared with every other installed extension, so enabling
// can be rejected for reasons the user has no way to see. Merging the ||host^
// filters brings the whole ruleset to roughly a third of the guarantee, so the
// build now treats the guarantee as a hard cap and fails rather than quietly
// shipping a ruleset that competes for the shared pool.
const GUARANTEED_STATIC_RULES = 30000;
const MIN_URL_FILTER_LENGTH = 4;
const MAX_URL_FILTER_LENGTH = 1024;
const ASCII_PRINTABLE = /^[ -~]+$/;

// Chrome compiles each regexFilter with RE2 capped at 2KB of program memory
// and skips any rule over the cap at install time, leaving a load error on
// chrome://extensions. Counted repetitions expand at compile time, so a
// 40-character pattern like (https?:\/\/)\w{30,}\.me\/\w{30,}\. still blows
// the cap. The written length says nothing about the compiled size, so the
// only reliable check is compiling with the same engine and limit.
const DNR_REGEX_MAX_MEM = 2048;

const WHITELIST_DOMAINS = Object.freeze([
  'google.com', 'google.co.jp', 'gstatic.com', 'googleapis.com',
  'youtube.com', 'ggpht.com', 'accounts.google.com',
  'gemini.google.com', 'bard.google.com',
]);

// Match a whitelisted domain only as a whole host: it must start at a host
// boundary (pattern start, "|", "/", or a subdomain dot) and end at a host
// terminator. A plain includes() would read gggpht.com as ggpht.com and drop a
// legitimate rule, and would read google.com.evil.net as Google.
const WHITELIST_PATTERNS = Object.freeze(WHITELIST_DOMAINS.map(domain => new RegExp(
  `(^|[|/.])${domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\w.-]|$)`
)));

// font, media and websocket stay mapped so that $font / $media / $websocket
// parse as recognised options rather than unsupported ones: a filter like
// ||x^$media,script must narrow to script, not be dropped whole.
// resolveResourceTypes then drops the types themselves, because no redirect can
// answer any of the three convincingly.
const RESOURCE_TYPE_MAP = Object.freeze({
  script: 'script',
  image: 'image',
  stylesheet: 'stylesheet',
  font: 'font',
  xmlhttprequest: 'xmlhttprequest',
  subdocument: 'sub_frame',
  media: 'media',
  ping: 'ping',
  websocket: 'websocket',
  other: 'other',
  object: 'object',
});

// Chrome derives the response MIME type from the noop file's extension, so a
// redirect only stays invisible when the target suits the requested type. A
// stylesheet served as text/javascript is refused in standards mode, an image
// fails to decode, and both fire the error event anti-adblock scripts listen
// for. Types are grouped by the noop that can honestly answer them; since a
// rule carries a single action, a filter spanning several groups needs one rule
// per group.
//
// Group order decides what an overflowing ruleset would drop first, so the most
// valuable noop leads and the cheapest thing to lose is last.
const NOOP_GROUPS = Object.freeze([
  // Scripts need parseable JavaScript. The rest have no content requirement and
  // no load-failure event to observe, so text/javascript is undetectable there.
  Object.freeze({
    path: '/noop.js',
    types: Object.freeze(['script', 'xmlhttprequest', 'ping', 'other', 'object']),
  }),
  Object.freeze({ path: '/noop.gif', types: Object.freeze(['image']) }),
  Object.freeze({ path: '/noop.html', types: Object.freeze(['sub_frame']) }),
  Object.freeze({ path: '/noop.css', types: Object.freeze(['stylesheet']) }),
]);

const SERVEABLE_RESOURCE_TYPES = Object.freeze(NOOP_GROUPS.flatMap(group => [...group.types]));

// What a filter carrying no $type option covers. Deliberately narrower than
// SERVEABLE_RESOURCE_TYPES, because every type added here costs one extra rule
// on ~57,000 filters and the extended ruleset already competes for Chrome's
// shared 330,000-rule pool:
//
//   stylesheet — EasyList marks 17 filters $stylesheet out of 58,000, so ad CSS
//     is close to nonexistent. Explicit $stylesheet filters still reach
//     /noop.css; generic filters no longer claim the type.
//   font, media — no bundled noop can stand in for either. A wrong-format font
//     rejects the document.fonts promise and a wrong-format video fires error on
//     the element, and blocking outright is detectable the same way.
//   websocket — absent from NOOP_GROUPS entirely, so no rule can claim it.
//     "Redirects are not supported for WebSocket requests": Chrome drops the
//     redirect, and it could not work anyway, since a WebSocket needs an HTTP 101
//     upgrade handshake and a static file answers 200. The outcome is either the
//     original request proceeding or a failed connection firing error on the
//     WebSocket — a detection signal, which is the opposite of the point.
//
// An unmatched type is not a silent failure: the request proceeds untouched, so
// the page sees exactly what it would without the extension. Less blocking, but
// nothing for an anti-adblock script to notice.
const DEFAULT_RESOURCE_TYPES = Object.freeze(
  SERVEABLE_RESOURCE_TYPES.filter(type => type !== 'stylesheet')
);

const PRIORITY_BLOCK = 1;
const PRIORITY_EXCEPTION = 2;
const PRIORITY_WHITELIST = 3;

// A filter that is nothing but ||host^ says exactly what requestDomains says,
// and a single rule can carry a whole list of hosts. The bundled lists are ~93%
// such filters, so merging them collapses ~55,000 rules into a handful. That is
// what lets every rule fit inside Chrome's per-extension guarantee: emitted one
// by one they overflowed it four times over, and whichever networks fell past
// the cut -- adingo.jp and g.doubleclick.net among them -- were blocked only on
// a best-effort basis, in list order rather than by any measure of importance.
//
// Only a bare lowercase domain qualifies. Ports, wildcards, paths and
// underscores are excluded because requestDomains cannot express them, and a
// missing trailing ^ is excluded because ||ad.com without one also matches
// ad.comcast.net, which requestDomains would not.
const PURE_DOMAIN_FILTER = /^\|\|([a-z0-9.-]+)\^$/i;

// Chrome documents no cap on requestDomains, and the merged lists stay well
// under any plausible one, but a rejected ruleset costs all blocking at once.
// ponytail: fixed chunk size, revisit only if Chrome documents a real limit.
const MAX_MERGED_DOMAINS = 10000;

// --- Main ---

function run() {
  const inputFiles = process.argv.length > 2
    ? process.argv.slice(2)
    : DEFAULT_INPUT_FILES.map(file => path.join(__dirname, file));

  const existing = inputFiles.filter(f => fs.existsSync(f));
  if (existing.length === 0) {
    console.error(`Error: no input files found (tried: ${inputFiles.join(', ')})`);
    process.exit(1);
  }

  console.log(`Input files: ${existing.join(', ')}`);
  console.log('EasyList -> declarativeNetRequest conversion started...');

  const lines = [];
  for (const file of existing) {
    const data = fs.readFileSync(file, 'utf8');
    lines.push(...data.split('\n'));
  }

  const result = convertLines(lines);

  assertFitsGuarantee(result.rules);
  fs.writeFileSync(path.join(__dirname, CORE_OUTPUT_FILE), JSON.stringify(result.rules));
  printSummary(result);
}

// updateEnabledRulesets() is atomic: if enabling a ruleset would push the count
// past what the shared global pool can spare, the whole call is rejected and
// nothing is enabled -- all blocking lost at once, for a reason that depends on
// what else the user has installed. Staying inside the per-extension guarantee
// makes that rejection impossible. Failing the build is the point: silently
// truncating would ship a ruleset whose coverage nobody chose.
function assertFitsGuarantee(rules) {
  if (rules.length > GUARANTEED_STATIC_RULES) {
    throw new Error(
      `${rules.length} rules exceed the ${GUARANTEED_STATIC_RULES}-rule per-extension ` +
      'guarantee, so enabling them would compete for the shared global pool.'
    );
  }
}

function printSummary(result) {
  const allowCount = result.rules.filter(r => r.action.type === 'allow').length;
  const merged = result.rules.filter(r => r.condition.requestDomains && r.action.type === 'redirect');
  const mergedDomains = merged.reduce((total, rule) => total + rule.condition.requestDomains.length, 0);

  console.log(`Done: ${result.rules.length} rules generated`);
  console.log(`  allow: ${allowCount} / redirect: ${result.rules.length - allowCount}`);
  console.log(`  ${mergedDomains} domain blocks merged into ${merged.length} rules`);
  console.log(`  ${CORE_OUTPUT_FILE}: ${result.rules.length} / ${GUARANTEED_STATIC_RULES} guaranteed rules`);
  console.log(
    `Skipped: comment=${result.skipped.comment}, cosmetic=${result.skipped.cosmetic}, ` +
    `invalid=${result.skipped.invalid}, whitelist=${result.skipped.whitelist}, ` +
    `mainframe=${result.skipped.mainframe}, unsupported=${result.skipped.unsupported}`
  );
}

// --- Line Processing ---

function convertLines(lines) {
  const candidates = [];
  const skipped = { comment: 0, cosmetic: 0, invalid: 0, whitelist: 0, mainframe: 0, unsupported: 0 };

  // Every line is read. A candidate is not a rule any more -- tens of thousands
  // of them merge into one -- so capping candidates would throw away filters
  // that cost nothing to keep.
  for (const line of lines) {
    const trimmed = line.trim();
    const classification = classifyLine(trimmed);

    if (classification === 'skip_comment') {
      skipped.comment++;
      continue;
    }
    if (classification === 'skip_cosmetic') {
      skipped.cosmetic++;
      continue;
    }

    const parsed = parseLine(trimmed);
    const options = parseOptions(parsed.optionsStr);

    if (options.hasDocumentType || options.hasPopupType) {
      skipped.mainframe++;
      continue;
    }

    if (options.unsupported.length > 0) {
      skipped.unsupported++;
      continue;
    }

    if (!isValidRequestFilter(parsed)) {
      skipped.invalid++;
      continue;
    }
    if (matchesWhitelistDomain(parsed.filterValue)) {
      skipped.whitelist++;
      continue;
    }

    const resourceTypes = resolveResourceTypes(options, parsed.isException);

    if (resourceTypes.length === 0) {
      skipped.invalid++;
      continue;
    }

    candidates.push({ parsed, options, resourceTypes });
  }

  return { rules: buildRules(candidates), skipped };
}

// Ordered by how much each rule covers, so if the ruleset ever overflows again
// the cheapest thing to lose is last. Exceptions first: a block rule left
// standing without the exception opposing it breaks sites, and an allow rule is
// never split by noop target because it carries no response. Then the merged
// whole-network blocks — a few dozen rules covering the overwhelming majority
// of ad traffic. Per-filter rules last: thousands of them, each covering one
// path on one host.
function buildRules(candidates) {
  const { merged, perFilter } = groupBlocks(candidates);
  const rules = [buildWhitelistGuardRule(1)];

  for (const candidate of candidates) {
    if (candidate.parsed.isException) {
      rules.push(buildRule(
        rules.length + 1, candidate.parsed, candidate.options, candidate.resourceTypes, null
      ));
    }
  }
  for (const bucket of merged) {
    for (const domains of chunk([...bucket.domains], MAX_MERGED_DOMAINS)) {
      rules.push(buildDomainRule(rules.length + 1, domains, bucket));
    }
  }
  for (const { candidate, resourceTypes, noopPath } of perFilter) {
    rules.push(buildRule(rules.length + 1, candidate.parsed, candidate.options, resourceTypes, noopPath));
  }

  return rules;
}

// Blocks are walked group by group rather than filter by filter, so a filter
// spanning several noop targets contributes to each group's bucket separately.
// Buckets key on everything a merged rule cannot vary per domain: the noop it
// redirects to, the first/third-party constraint, and the resource types.
function groupBlocks(candidates) {
  const merged = new Map();
  const perFilter = [];

  for (const group of NOOP_GROUPS) {
    for (const candidate of candidates) {
      if (candidate.parsed.isException) {
        continue;
      }
      const resourceTypes = candidate.resourceTypes.filter(type => group.types.includes(type));
      if (resourceTypes.length === 0) {
        continue;
      }

      const domain = mergeableDomain(candidate);
      if (domain === null) {
        perFilter.push({ candidate, resourceTypes, noopPath: group.path });
        continue;
      }

      const key = `${group.path} ${candidate.options.thirdParty} ${resourceTypes.join(',')}`;
      const bucket = merged.get(key);
      if (bucket) {
        bucket.domains.add(domain);
        continue;
      }
      merged.set(key, {
        domains: new Set([domain]),
        thirdParty: candidate.options.thirdParty,
        resourceTypes,
        noopPath: group.path,
      });
    }
  }

  return { merged: [...merged.values()], perFilter };
}

// $domain= filters stay per-filter: initiatorDomains constrains the calling
// page, so sharing a rule would apply one filter's page restriction to every
// other domain in it.
function mergeableDomain(candidate) {
  const { parsed, options } = candidate;

  if (parsed.filterKey !== 'urlFilter') {
    return null;
  }
  if (options.includeDomains.length > 0 || options.excludeDomains.length > 0) {
    return null;
  }

  const match = PURE_DOMAIN_FILTER.exec(parsed.filterValue);
  return match ? match[1].toLowerCase() : null;
}

function chunk(values, size) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

// The build-time domain scan only catches filters that spell a whitelisted
// domain out. A generic filter such as /pagead/conversion.js still matches
// https://www.google.com/pagead/conversion.js, so this single highest-priority
// rule is what actually protects those hosts. requestDomains matches the host
// being requested and its subdomains, which is the condition that matters here;
// initiatorDomains would constrain the calling page instead.
function buildWhitelistGuardRule(id) {
  return {
    id,
    priority: PRIORITY_WHITELIST,
    action: { type: 'allow' },
    condition: {
      requestDomains: [...WHITELIST_DOMAINS],
      // Every type the converter can emit a redirect for, not just the default
      // set: an explicit $stylesheet filter must not outlive the guard either.
      resourceTypes: [...SERVEABLE_RESOURCE_TYPES],
    },
  };
}

function classifyLine(trimmed) {
  if (!trimmed || trimmed.startsWith('!') || trimmed.startsWith('[')) {
    return 'skip_comment';
  }
  if (trimmed.includes('##') || trimmed.includes('#@#') || trimmed.includes('#?#')) {
    return 'skip_cosmetic';
  }
  return 'rule';
}

function parseLine(trimmed) {
  const isException = trimmed.startsWith('@@');
  const rawRule = isException ? trimmed.slice(2) : trimmed;
  const regexRule = parseRegexRule(rawRule);

  if (regexRule) {
    return { ...regexRule, isException };
  }

  const lastDollar = rawRule.lastIndexOf('$');

  if (lastDollar === 0) {
    return createParsedFilter('', rawRule.slice(1), isException, 'urlFilter');
  }
  if (lastDollar <= 0) {
    return createParsedFilter(rawRule, '', isException, 'urlFilter');
  }
  return createParsedFilter(
    rawRule.substring(0, lastDollar),
    rawRule.substring(lastDollar + 1),
    isException,
    'urlFilter'
  );
}

function parseRegexRule(rawRule) {
  if (!rawRule.startsWith('/')) {
    return null;
  }

  const regexEnd = findRegexRuleEnd(rawRule);
  if (regexEnd <= 0) {
    return null;
  }

  const regexFilter = rawRule.slice(1, regexEnd);
  const trailing = rawRule.slice(regexEnd + 1);

  // Path-like EasyList filters can also be wrapped in slashes. Treat only
  // escaped-slash regex bodies as regexFilter rules to avoid misclassifying
  // common patterns such as /ads/$script.
  if (!regexFilter.includes('\\')) {
    return null;
  }
  if (trailing && !trailing.startsWith('$')) {
    return null;
  }

  return createParsedFilter(regexFilter, trailing.slice(1), false, 'regexFilter');
}

function findRegexRuleEnd(rawRule) {
  for (let index = rawRule.length - 1; index > 0; index--) {
    if (rawRule[index] === '/' && !isEscaped(rawRule, index)) {
      return index;
    }
  }
  return -1;
}

function isEscaped(value, index) {
  let backslashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor--) {
    backslashCount++;
  }
  return backslashCount % 2 === 1;
}

function createParsedFilter(filterValue, optionsStr, isException, filterKey) {
  return {
    filterKey,
    filterValue,
    urlFilter: filterKey === 'urlFilter' ? filterValue : undefined,
    regexFilter: filterKey === 'regexFilter' ? filterValue : undefined,
    optionsStr,
    isException,
  };
}

function isValidRequestFilter(parsed) {
  if (parsed.filterKey === 'regexFilter') {
    return isValidRegexFilter(parsed.filterValue);
  }
  return isValidUrlFilter(parsed.filterValue);
}

function isValidUrlFilter(urlFilter) {
  return (
    typeof urlFilter === 'string' &&
    ASCII_PRINTABLE.test(urlFilter) &&
    urlFilter.length >= MIN_URL_FILTER_LENGTH &&
    urlFilter.length <= MAX_URL_FILTER_LENGTH &&
    !urlFilter.startsWith('||*')
  );
}

// Mirrors Chrome's own compile of a regexFilter: RE2 (which also rejects the
// lookaheads and backreferences declarativeNetRequest cannot use), the 2KB
// program-memory cap, case-insensitive (the isUrlFilterCaseSensitive default),
// and capture groups neutralised the way Chrome's never_capture option does.
// Validated against chrome.declarativeNetRequest.isRegexSupported() on every
// regex the bundled filter lists produce: no over-limit pattern gets through,
// at the cost of rejecting two borderline patterns Chrome would accept.
function isValidRegexFilter(regexFilter) {
  if (
    typeof regexFilter !== 'string' ||
    !ASCII_PRINTABLE.test(regexFilter) ||
    regexFilter.length === 0
  ) {
    return false;
  }

  try {
    const noCapture = regexFilter.replace(/(\\.)|\((?!\?)/g, (match, escaped) => escaped || '(?:');
    new RE2(noCapture, 'iu', DNR_REGEX_MAX_MEM);
    return true;
  } catch (_) {
    return false;
  }
}

function matchesWhitelistDomain(urlFilter) {
  // Regex-syntax filters escape their dots; normalise so the same host check
  // applies to them instead of silently never matching.
  const candidate = urlFilter.replace(/\\\./g, '.');
  return WHITELIST_PATTERNS.some(pattern => pattern.test(candidate));
}

// --- Option Parsing ---

function parseOptions(optionsStr) {
  const result = {
    resourceTypes: [],
    excludedResourceTypes: [],
    thirdParty: null,
    includeDomains: [],
    excludeDomains: [],
    hasDocumentType: false,
    hasPopupType: false,
    unsupported: [],
  };

  if (!optionsStr) {
    return result;
  }

  const parts = optionsStr.split(',');
  for (const part of parts) {
    applyOption(result, part.trim().toLowerCase());
  }
  return result;
}

function applyOption(result, option) {
  if (option === 'third-party' || option === '3p') {
    result.thirdParty = true;
    return;
  }
  if (option === '~third-party' || option === '~3p' || option === 'first-party' || option === '1p') {
    result.thirdParty = false;
    return;
  }
  if (option.startsWith('domain=')) {
    parseDomainOption(result, option.slice(7));
    return;
  }
  if (option === 'document') {
    result.hasDocumentType = true;
    return;
  }
  if (option === 'popup') {
    result.hasPopupType = true;
    return;
  }
  if (option.startsWith('~')) {
    const mapped = RESOURCE_TYPE_MAP[option.slice(1)];
    if (mapped) {
      result.excludedResourceTypes.push(mapped);
      return;
    }
    result.unsupported.push(option);
    return;
  }
  const mapped = RESOURCE_TYPE_MAP[option];
  if (mapped) {
    result.resourceTypes.push(mapped);
    return;
  }

  // Options with no DNR equivalent must not fall through: an ignored option
  // silently changes what the rule means. $generichide (a cosmetic-filtering
  // directive) would become a blanket network `allow` that switches blocking
  // off for the whole domain, and $csp / $rewrite would become redirects that
  // cover every resource type. Record it so the caller drops the line.
  result.unsupported.push(option);
}

function parseDomainOption(result, domainStr) {
  const domains = domainStr.split('|');
  for (const domain of domains) {
    if (domain.startsWith('~')) {
      result.excludeDomains.push(domain.slice(1));
      continue;
    }
    result.includeDomains.push(domain);
  }
}

// --- Resource Type Resolution ---

// An exception has to be able to lift every block rule that could apply to the
// same URL, so it resolves against the full serveable set rather than the
// narrower default one. The default set exists to hold the rule count down, and
// a block rule is the only thing that costs a rule per type; an exception is
// never split, so breadth is free there. Sharing the narrow set would let
// ||x/ad.css^$stylesheet redirect the very file @@||x/ad.css^ exists to permit,
// because the priority-2 allow would not cover the type the priority-1 redirect
// claims.
function resolveResourceTypes(options, isException) {
  const base = isException ? SERVEABLE_RESOURCE_TYPES : DEFAULT_RESOURCE_TYPES;

  if (options.resourceTypes.length > 0) {
    // Explicit types still have to be serveable: $font alone leaves nothing, and
    // the caller counts that line as one it cannot translate. Checked against
    // the serveable set rather than the default one, so $stylesheet is honoured
    // where a generic filter would not claim the type.
    return options.resourceTypes.filter(type => SERVEABLE_RESOURCE_TYPES.includes(type));
  }
  if (options.excludedResourceTypes.length > 0) {
    return base.filter(type => !options.excludedResourceTypes.includes(type));
  }
  return [...base];
}

// --- Rule Building ---

function buildRule(id, parsed, options, resourceTypes, noopPath) {
  const condition = buildCondition(parsed, options, resourceTypes);
  const action = parsed.isException
    ? { type: 'allow' }
    : { type: 'redirect', redirect: { extensionPath: noopPath } };

  return {
    id,
    priority: parsed.isException ? PRIORITY_EXCEPTION : PRIORITY_BLOCK,
    action,
    condition,
  };
}

// The merged counterpart of buildRule: same action and priority, but the hosts
// live in requestDomains instead of one ||host^ urlFilter per rule.
function buildDomainRule(id, domains, bucket) {
  const condition = { requestDomains: domains, resourceTypes: bucket.resourceTypes };

  if (bucket.thirdParty === true) {
    condition.domainType = 'thirdParty';
  }
  if (bucket.thirdParty === false) {
    condition.domainType = 'firstParty';
  }

  return {
    id,
    priority: PRIORITY_BLOCK,
    action: { type: 'redirect', redirect: { extensionPath: bucket.noopPath } },
    condition,
  };
}

function buildCondition(parsed, options, resourceTypes) {
  const condition = {
    [parsed.filterKey]: parsed.filterValue,
    resourceTypes,
  };

  if (options.thirdParty === true) {
    condition.domainType = 'thirdParty';
  }
  if (options.thirdParty === false) {
    condition.domainType = 'firstParty';
  }
  if (options.includeDomains.length > 0) {
    condition.initiatorDomains = options.includeDomains;
  }
  if (options.excludeDomains.length > 0) {
    condition.excludedInitiatorDomains = options.excludeDomains;
  }

  return condition;
}

// Entry point stays last: run() reads module-level constants, and calling it
// from higher up the file would hit any const declared below it in its
// temporal dead zone — a crash the unit tests cannot see, because requiring
// the module never runs this branch.
if (require.main === module) {
  run();
}

module.exports = Object.freeze({
  convertLines,
  assertFitsGuarantee,
  parseLine,
  parseOptions,
  resolveResourceTypes,
  buildRule,
  isValidRequestFilter,
});
