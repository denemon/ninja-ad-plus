'use strict';

const fs = require('fs');

const DEFAULT_INPUT_FILES = ['easylist.txt', 'antiadblockfilters.txt'];
const OUTPUT_FILE = 'rules.json';
const MAX_RULES = 280000;
const MIN_URL_FILTER_LENGTH = 4;
const MAX_URL_FILTER_LENGTH = 1024;
const ASCII_PRINTABLE = /^[ -~]+$/;

const WHITELIST_DOMAINS = Object.freeze([
  'google.com', 'google.co.jp', 'gstatic.com', 'googleapis.com',
  'youtube.com', 'ggpht.com', 'accounts.google.com',
  'gemini.google.com', 'bard.google.com',
]);

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

const DEFAULT_RESOURCE_TYPES = Object.freeze([
  'script', 'image', 'xmlhttprequest', 'sub_frame', 'media', 'ping',
  'font', 'stylesheet', 'websocket', 'other', 'object',
]);

const NOOP_PATH = Object.freeze({
  script: '/noop.js',
  image: '/noop.gif',
  stylesheet: '/noop.css',
  sub_frame: '/noop.html',
  default: '/noop.txt',
});

const URL_EXTENSION_MAP = Object.freeze([
  { pattern: /\.js\^?$/, path: NOOP_PATH.script },
  { pattern: /\.css\^?$/, path: NOOP_PATH.stylesheet },
  { pattern: /\.(gif|png|jpe?g|webp|svg|ico)\^?$/, path: NOOP_PATH.image },
  { pattern: /\.html?\^?$/, path: NOOP_PATH.sub_frame },
]);

const PRIORITY_BLOCK = 1;
const PRIORITY_EXCEPTION = 2;

// --- Main ---

if (require.main === module) {
  run();
}

function run() {
  const inputFiles = process.argv.length > 2
    ? process.argv.slice(2)
    : DEFAULT_INPUT_FILES;

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

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(result.rules));
  printSummary(result);
}

function printSummary(result) {
  const allowCount = result.rules.filter(r => r.action.type === 'allow').length;
  const redirectCount = result.rules.length - allowCount;

  console.log(`Done: ${result.rules.length} rules generated`);
  console.log(`  allow: ${allowCount} / redirect: ${redirectCount}`);
  console.log(
    `Skipped: comment=${result.skipped.comment}, cosmetic=${result.skipped.cosmetic}, ` +
    `invalid=${result.skipped.invalid}, whitelist=${result.skipped.whitelist}, ` +
    `mainframe=${result.skipped.mainframe}`
  );
}

// --- Line Processing ---

function convertLines(lines) {
  const rules = [];
  const skipped = { comment: 0, cosmetic: 0, invalid: 0, whitelist: 0, mainframe: 0 };
  let idCounter = 1;

  for (const line of lines) {
    if (idCounter > MAX_RULES) {
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

    if (!isValidRequestFilter(parsed)) {
      skipped.invalid++;
      continue;
    }
    if (matchesWhitelistDomain(parsed.filterValue)) {
      skipped.whitelist++;
      continue;
    }

    const resourceTypes = resolveResourceTypes(options);

    if (resourceTypes.length === 0) {
      skipped.invalid++;
      continue;
    }

    const rule = buildRule(idCounter, parsed, options, resourceTypes);
    rules.push(rule);
    idCounter++;
  }

  return { rules, skipped };
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
  return WHITELIST_DOMAINS.some(domain => urlFilter.includes(domain));
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
    }
    return;
  }
  const mapped = RESOURCE_TYPE_MAP[option];
  if (mapped) {
    result.resourceTypes.push(mapped);
  }
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

function resolveResourceTypes(options) {
  if (options.resourceTypes.length > 0) {
    return options.resourceTypes;
  }
  if (options.excludedResourceTypes.length > 0) {
    return DEFAULT_RESOURCE_TYPES.filter(t => !options.excludedResourceTypes.includes(t));
  }
  return [...DEFAULT_RESOURCE_TYPES];
}

// --- Rule Building ---

function buildRule(id, parsed, options, resourceTypes) {
  const condition = buildCondition(parsed, options, resourceTypes);
  const action = parsed.isException
    ? { type: 'allow' }
    : decideRedirectAction(parsed.filterValue, resourceTypes);

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

// --- Redirect Decision ---

function decideRedirectAction(urlFilter, resourceTypes) {
  if (resourceTypes.length === 1) {
    const singleTypePath = NOOP_PATH[resourceTypes[0]];
    if (singleTypePath) {
      return createRedirectAction(singleTypePath);
    }
  }

  const extensionPath = matchUrlExtension(urlFilter);
  if (extensionPath) {
    return createRedirectAction(extensionPath);
  }

  // Rules with mixed resourceTypes including script must use noop.js.
  // Module scripts enforce strict MIME type checking and reject text/plain.
  if (resourceTypes.includes('script')) {
    return createRedirectAction(NOOP_PATH.script);
  }

  return createRedirectAction(NOOP_PATH.default);
}

function matchUrlExtension(urlFilter) {
  for (const entry of URL_EXTENSION_MAP) {
    if (entry.pattern.test(urlFilter)) {
      return entry.path;
    }
  }
  return null;
}

function createRedirectAction(extensionPath) {
  return {
    type: 'redirect',
    redirect: { extensionPath },
  };
}

module.exports = Object.freeze({
  convertLines,
  parseLine,
  parseOptions,
  resolveResourceTypes,
  buildRule,
  isValidRequestFilter,
  decideRedirectAction,
});
