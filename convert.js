'use strict';

const fs = require('fs');

const INPUT_FILE = 'easylist.txt';
const OUTPUT_FILE = 'rules.json';
const MAX_RULES = 280000;
const MIN_URL_FILTER_LENGTH = 4;
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
  'font', 'stylesheet', 'websocket', 'other',
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

run();

function run() {
  if (!fs.existsSync(INPUT_FILE)) {
    console.error(`Error: ${INPUT_FILE} not found.`);
    process.exit(1);
  }

  console.log('EasyList -> declarativeNetRequest conversion started...');

  const data = fs.readFileSync(INPUT_FILE, 'utf8');
  const lines = data.split('\n');
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

    if (!isValidUrlFilter(parsed.urlFilter)) {
      skipped.invalid++;
      continue;
    }
    if (matchesWhitelistDomain(parsed.urlFilter)) {
      skipped.whitelist++;
      continue;
    }

    const options = parseOptions(parsed.optionsStr);

    if (options.hasDocumentType || options.hasPopupType) {
      skipped.mainframe++;
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
  const lastDollar = rawRule.lastIndexOf('$');

  if (lastDollar <= 0) {
    return { urlFilter: rawRule, optionsStr: '', isException };
  }
  return {
    urlFilter: rawRule.substring(0, lastDollar),
    optionsStr: rawRule.substring(lastDollar + 1),
    isException,
  };
}

function isValidUrlFilter(urlFilter) {
  return ASCII_PRINTABLE.test(urlFilter) && urlFilter.length >= MIN_URL_FILTER_LENGTH;
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
  const condition = buildCondition(parsed.urlFilter, options, resourceTypes);
  const action = parsed.isException
    ? { type: 'allow' }
    : decideRedirectAction(parsed.urlFilter, resourceTypes);

  return {
    id,
    priority: parsed.isException ? PRIORITY_EXCEPTION : PRIORITY_BLOCK,
    action,
    condition,
  };
}

function buildCondition(urlFilter, options, resourceTypes) {
  const condition = { urlFilter, resourceTypes };

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
