'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_INPUT_FILES = ['filters/easylist.txt', 'filters/antiadblockfilters.txt'];
const CORE_OUTPUT_FILE = 'src/rules-core.json';
const EXTENDED_OUTPUT_FILE = 'src/rules-extended.json';
const MAX_RULES = 280000;

// Chrome guarantees this many static rules per extension. Rules past it are
// drawn from a pool shared with every other installed extension.
const GUARANTEED_STATIC_RULES = 30000;
const MIN_URL_FILTER_LENGTH = 4;
const MAX_URL_FILTER_LENGTH = 1024;
const ASCII_PRINTABLE = /^[ -~]+$/;

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
// Group order is load-bearing twice over: convertLines emits group by group and
// both the core/extended boundary and the MAX_RULES cut fall wherever that
// sequence reaches. Most valuable first, so the cheapest thing to lose is last.
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

  const { core, extended } = splitRules(result.rules);
  fs.writeFileSync(path.join(__dirname, CORE_OUTPUT_FILE), JSON.stringify(core));
  fs.writeFileSync(path.join(__dirname, EXTENDED_OUTPUT_FILE), JSON.stringify(extended));
  printSummary(result, core, extended);
}

// updateEnabledRulesets() is atomic: if enabling a ruleset would push the
// count past what the shared global pool can spare, the whole call is rejected
// and nothing is enabled. A single oversized ruleset therefore risks losing all
// blocking at once. Keeping the core ruleset inside the per-extension guarantee
// makes it immune to that rejection, so the extended ruleset can fail on its
// own and cost only blocking coverage.
function splitRules(rules) {
  const exceptions = rules.filter(rule => rule.action.type === 'allow').length;
  if (exceptions > GUARANTEED_STATIC_RULES) {
    throw new Error(
      `${exceptions} exception rules exceed the ${GUARANTEED_STATIC_RULES}-rule guarantee; ` +
      'they cannot all fit in the core ruleset.'
    );
  }

  return {
    core: rules.slice(0, GUARANTEED_STATIC_RULES),
    extended: rules.slice(GUARANTEED_STATIC_RULES),
  };
}

function printSummary(result, core, extended) {
  const allowCount = result.rules.filter(r => r.action.type === 'allow').length;
  const redirectCount = result.rules.length - allowCount;

  console.log(`Done: ${result.rules.length} rules generated`);
  console.log(`  allow: ${allowCount} / redirect: ${redirectCount}`);
  console.log(`  ${CORE_OUTPUT_FILE}: ${core.length} rules (always enabled, all exceptions)`);
  console.log(`  ${EXTENDED_OUTPUT_FILE}: ${extended.length} rules (best-effort, shared global pool)`);
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

  for (const line of lines) {
    if (candidates.length >= MAX_RULES) {
      break;
    }

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

// Exceptions come first so they take the lowest ids and land in the core
// ruleset, where they can oppose the block rules Chrome always has enabled.
// They are never split by noop target: an allow rule carries no response.
//
// Block rules are then emitted group by group rather than filter by filter.
// Both orders produce the same rules; only the core/extended boundary moves.
// Filter-major would give core 30,000 rules covering a quarter as many filters,
// each with all four of its type variants. Group-major spends core on the
// /noop.js variant of as many filters as fit and leaves the image, stylesheet
// and frame variants to the extended ruleset. If extended cannot be enabled
// those requests simply match nothing and proceed untouched: less blocking, but
// no wrong-MIME failure for a page to notice — the safe direction to fail.
function buildRules(candidates) {
  const emitted = candidates
    .filter(candidate => candidate.parsed.isException)
    .map(candidate => ({ candidate, resourceTypes: candidate.resourceTypes, noopPath: null }));

  for (const group of NOOP_GROUPS) {
    for (const candidate of candidates) {
      if (candidate.parsed.isException) {
        continue;
      }
      const resourceTypes = candidate.resourceTypes.filter(type => group.types.includes(type));
      if (resourceTypes.length > 0) {
        emitted.push({ candidate, resourceTypes, noopPath: group.path });
      }
    }
  }

  const rules = [buildWhitelistGuardRule(1)];
  for (const { candidate, resourceTypes, noopPath } of emitted.slice(0, MAX_RULES - rules.length)) {
    rules.push(buildRule(rules.length + 1, candidate.parsed, candidate.options, resourceTypes, noopPath));
  }

  return rules;
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

function isValidRegexFilter(regexFilter) {
  if (
    typeof regexFilter !== 'string' ||
    !ASCII_PRINTABLE.test(regexFilter) ||
    regexFilter.length === 0
  ) {
    return false;
  }

  try {
    new RegExp(regexFilter);
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
  splitRules,
  parseLine,
  parseOptions,
  resolveResourceTypes,
  buildRule,
  isValidRequestFilter,
});
