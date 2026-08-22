'use strict';

/**
 * Ad object spoofing script.
 * Injected at document_start in the MAIN world (page context).
 *
 * Strategies:
 * 1. Stub ad library globals (googletag, pbjs, adsbygoogle, google.ima)
 * 2. Fake-render ad slots (inject iframe into slot containers)
 * 3. Stub anti-adblock detection libraries (FuckAdBlock, BlockAdBlock)
 * 4. Spoof bait element dimensions (offsetHeight/offsetWidth)
 * 5. Hide broken sponsored templates that leak through as page content
 * 6. Detect and remove anti-adblock overlays
 */
(() => {
  const noopFn = () => {};
  const returnThis = function () { return this; };
  const returnNull = () => null;
  const returnEmpty = () => [];
  const returnTrue = () => true;
  const returnFalse = () => false;

  // =========================================================================
  // 1. Google Publisher Tag (googletag)
  // =========================================================================

  const registeredSlots = [];

  const createSlotStub = (adUnitPath, size, divId) => {
    const slot = {
      addService: returnThis,
      clearCategoryExclusions: returnThis,
      clearTargeting: returnThis,
      defineSizeMapping: returnThis,
      get: returnNull,
      getAdUnitPath: () => adUnitPath || '',
      getAttributeKeys: returnEmpty,
      getCategoryExclusions: returnEmpty,
      getDomId: () => divId || '',
      getResponseInformation: () => ({
        advertiserId: 1,
        campaignId: 1,
        creativeId: 1,
        labelIds: [1],
        lineItemId: 1,
        sourceAgnosticCreativeId: 1,
        sourceAgnosticLineItemId: 1,
        isBackfill: false,
      }),
      getSlotElementId: () => divId || '',
      getTargeting: returnEmpty,
      getTargetingKeys: returnEmpty,
      set: returnThis,
      setCategoryExclusion: returnThis,
      setClickUrl: returnThis,
      setCollapseEmptyDiv: returnThis,
      setForceSafeFrame: returnThis,
      setSafeFrameConfig: returnThis,
      setTargeting: returnThis,
      updateTargetingFromMap: returnThis,
      _size: size,
      _divId: divId,
    };
    registeredSlots.push(slot);
    return slot;
  };

  const renderSlotElement = (divId) => {
    if (!divId) return;
    const container = document.getElementById(divId);
    if (!container) return;
    if (container.querySelector('iframe')) return;

    const iframe = document.createElement('iframe');
    iframe.id = `google_ads_iframe_${divId}`;
    iframe.title = 'Advertisement';
    iframe.width = '1';
    iframe.height = '1';
    iframe.style.cssText =
      'border:0;vertical-align:bottom;position:absolute;opacity:0;pointer-events:none;';
    iframe.srcdoc = '<body></body>';
    iframe.setAttribute('sandbox', '');

    container.style.setProperty('min-height', '1px', 'important');
    container.style.setProperty('min-width', '1px', 'important');
    container.appendChild(iframe);
  };

  const companionAdsServiceStub = Object.freeze({
    addEventListener: returnThis,
    enableSyncLoading: noopFn,
    setRefreshUnfilledSlots: noopFn,
    getSlots: () => registeredSlots,
  });

  const pubadsServiceStub = Object.freeze({
    addEventListener: returnThis,
    clearCategoryExclusions: returnThis,
    clearTargeting: returnThis,
    collapseEmptyDivs: noopFn,
    disableInitialLoad: noopFn,
    display: noopFn,
    enableAsyncRendering: noopFn,
    enableLazyLoad: noopFn,
    enableSingleRequest: noopFn,
    enableVideoAds: noopFn,
    get: returnNull,
    getAttributeKeys: returnEmpty,
    getTargeting: returnEmpty,
    getTargetingKeys: returnEmpty,
    getSlots: () => registeredSlots,
    isInitialLoadDisabled: returnFalse,
    refresh: (slots) => {
      for (const slot of (slots || registeredSlots)) {
        renderSlotElement(slot._divId);
      }
    },
    set: returnThis,
    setCategoryExclusion: returnThis,
    setCentering: noopFn,
    setCookieOptions: returnThis,
    setForceSafeFrame: returnThis,
    setLocation: returnThis,
    setPrivacySettings: returnThis,
    setPublisherProvidedId: returnThis,
    setRequestNonPersonalizedAds: returnThis,
    setSafeFrameConfig: returnThis,
    setTargeting: returnThis,
    setVideoContent: returnThis,
    updateCorrelator: noopFn,
  });

  const runQueuedCommand = (fn) => {
    try { if (typeof fn === 'function') fn(); } catch (_) {}
  };
  const runAndQueueCommand = function (fn) {
    runQueuedCommand(fn);
    return Array.prototype.push.call(this, fn);
  };
  runAndQueueCommand.__spoofed = true;

  const commandQueue = [];
  commandQueue.push = runAndQueueCommand;

  const googletag = window.googletag || {};
  googletag.apiReady = true;
  if (!googletag.cmd) {
    googletag.cmd = commandQueue;
  } else {
    const originalPush = typeof googletag.cmd.push === 'function'
      ? googletag.cmd.push
      : Array.prototype.push;

    if (!originalPush.__spoofed) {
      if (Array.isArray(googletag.cmd)) {
        for (const fn of googletag.cmd) runQueuedCommand(fn);
      }
      googletag.cmd.push = function (fn) {
        runQueuedCommand(fn);
        return originalPush.call(this, fn);
      };
      googletag.cmd.push.__spoofed = true;
    }
  }
  googletag.companionAds = () => companionAdsServiceStub;
  googletag.content = () => companionAdsServiceStub;
  googletag.defineOutOfPageSlot = (adUnitPath, divId) =>
    createSlotStub(adUnitPath, null, typeof divId === 'string' ? divId : undefined);
  googletag.defineSlot = (adUnitPath, size, divId) =>
    createSlotStub(adUnitPath, size, divId);
  googletag.destroySlots = returnTrue;
  googletag.disablePublisherConsole = noopFn;
  googletag.display = (divOrSlot) => {
    const divId = typeof divOrSlot === 'string'
      ? divOrSlot
      : (divOrSlot && divOrSlot.getSlotElementId ? divOrSlot.getSlotElementId() : null);
    renderSlotElement(divId);
  };
  googletag.enableServices = () => {
    for (const slot of registeredSlots) {
      renderSlotElement(slot._divId);
    }
  };
  googletag.getVersion = () => '';
  googletag.pubads = () => pubadsServiceStub;
  googletag.pubadsReady = true;
  googletag.setAdIframeTitle = noopFn;
  googletag.sizeMapping = () => ({
    addSize: returnThis,
    build: returnNull,
  });
  window.googletag = googletag;

  // =========================================================================
  // 2. Google AdSense (adsbygoogle)
  // =========================================================================

  const adsbygoogle = window.adsbygoogle || [];
  adsbygoogle.loaded = true;
  adsbygoogle.push = function (obj) {
    if (obj && obj.element) {
      obj.element.dataset.adsbygoogleStatus = 'done';
    }
    return Array.prototype.push.call(this, obj);
  };
  window.adsbygoogle = adsbygoogle;

  // =========================================================================
  // 3. Prebid.js (pbjs)
  // =========================================================================

  const pbjs = window.pbjs || {};
  pbjs.que = pbjs.que || [];
  pbjs.que.push = function (fn) {
    try { if (typeof fn === 'function') fn(); } catch (_) {}
    return Array.prototype.push.call(this, fn);
  };
  pbjs.addAdUnits = noopFn;
  pbjs.requestBids = (opts) => {
    if (opts && typeof opts.bidsBackHandler === 'function') {
      try { opts.bidsBackHandler([]); } catch (_) {}
    }
  };
  pbjs.setConfig = noopFn;
  pbjs.getBidResponses = () => ({});
  pbjs.getAdserverTargeting = () => ({});
  pbjs.getAllWinningBids = returnEmpty;
  pbjs.libLoaded = true;
  window.pbjs = pbjs;

  // =========================================================================
  // 4. Google IMA SDK stub
  // =========================================================================

  if (!window.google) window.google = {};
  if (!window.google.ima) {
    window.google.ima = {
      AdDisplayContainer: class {
        initialize() {}
        destroy() {}
      },
      AdsLoader: class {
        constructor() { this._listeners = {}; }
        addEventListener(e, fn) { this._listeners[e] = fn; }
        requestAds() {}
        contentComplete() {}
        destroy() {}
        getSettings() {
          return {
            setCompanionBackfill: noopFn,
            setAutoPlayAdBreaks: noopFn,
            setPlayerType: noopFn,
            setPlayerVersion: noopFn,
            setVpaidMode: noopFn,
          };
        }
      },
      AdsManagerLoadedEvent: { Type: { ADS_MANAGER_LOADED: 'adsManagerLoaded' } },
      AdErrorEvent: { Type: { AD_ERROR: 'adError' } },
      AdEvent: { Type: {
        ALL_ADS_COMPLETED: 'allAdsCompleted',
        CLICK: 'click',
        COMPLETE: 'complete',
        CONTENT_PAUSE_REQUESTED: 'contentPauseRequested',
        CONTENT_RESUME_REQUESTED: 'contentResumeRequested',
        LOADED: 'loaded',
        STARTED: 'started',
      }},
      AdsRenderingSettings: class {},
      CompanionAdSelectionSettings: { CreativeType: {}, ResourceType: {}, SizeCriteria: {} },
      ImaSdkSettings: { CompanionBackfillMode: {}, VpaidMode: { ENABLED: 1 } },
      UiElements: { COUNTDOWN: 'countdown' },
      ViewMode: { NORMAL: 'normal', FULLSCREEN: 'fullscreen' },
      settings: new (class {
        setCompanionBackfill() {}
        setAutoPlayAdBreaks() {}
        setPlayerType() {}
        setPlayerVersion() {}
        setVpaidMode() {}
        getCompanionBackfill() {}
        getAutoPlayAdBreaks() { return true; }
        getPlayerType() { return ''; }
        getPlayerVersion() { return ''; }
        getVpaidMode() { return 1; }
      })(),
    };
  }

  // =========================================================================
  // 5. FuckAdBlock / BlockAdBlock / generic anti-adblock library stubs
  // =========================================================================
  // These libraries are loaded externally. If the script is blocked,
  // the global (window.fuckAdBlock / window.blockAdBlock) stays undefined.
  // Anti-adblock code then checks: if (!window.fuckAdBlock) → DETECTED.
  // We pre-create convincing stubs.

  class FakeAdBlockDetector {
    constructor() {
      this._callbacks = { detected: [], notDetected: [] };
    }
    _fireNotDetected() {
      for (const fn of this._callbacks.notDetected) {
        try { fn(); } catch (_) {}
      }
    }
    on(detected, fn) {
      if (typeof fn !== 'function') return this;
      if (detected === true || detected === 'detected') {
        this._callbacks.detected.push(fn);
      } else {
        this._callbacks.notDetected.push(fn);
        setTimeout(() => { try { fn(); } catch (_) {} }, 1);
      }
      return this;
    }
    onDetected(fn) { return this.on(true, fn); }
    onNotDetected(fn) { return this.on(false, fn); }
    check(loop) {
      this._fireNotDetected();
      return this;
    }
    emitEvent(detected) {
      if (!detected) this._fireNotDetected();
      return this;
    }
    setOption() { return this; }
  }

  window.fuckAdBlock = window.fuckAdBlock || new FakeAdBlockDetector();
  window.blockAdBlock = window.blockAdBlock || new FakeAdBlockDetector();
  window.sniffAdBlock = window.sniffAdBlock || new FakeAdBlockDetector();
  window.capolygon = window.capolygon || new FakeAdBlockDetector();

  // Some sites check these globals
  window.canRunAds = true;
  window.isAdBlockActive = false;

  // =========================================================================
  // 6. Bait element dimension spoofing (offsetHeight / offsetWidth)
  // =========================================================================

  // Matched against one class or id token at a time. The trailing boundary is
  // load-bearing: an open-ended /^ad[s_-]?/ also matches "address",
  // "admin-dialog" and "adaptive-layout", and protectBaitElement then
  // force-shows those with !important — breaking ordinary hidden UI on every
  // site this runs on. A name must be a bait word exactly, or a bait word
  // followed by a separator.
  const baitNamePattern =
    /^(ads?|adsbox|adunit|adbox|adslot|adbanner|adcontainer|adplacement|banner|sponsor|carbonads|textad)([_-].*)?$/i;

  const matchesBaitName = (value) => {
    if (typeof value !== 'string') return false;
    return value.split(/\s+/).some(token => token !== '' && baitNamePattern.test(token));
  };

  const isBaitElement = (el) => {
    if (!el || el.nodeType !== 1) return false;
    return matchesBaitName(el.className) || matchesBaitName(el.id);
  };

  const origOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
  const origOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');

  if (origOffsetHeight) {
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      get() {
        const value = origOffsetHeight.get.call(this);
        return (value === 0 && isBaitElement(this)) ? 1 : value;
      },
      configurable: true,
    });
  }
  if (origOffsetWidth) {
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      get() {
        const value = origOffsetWidth.get.call(this);
        return (value === 0 && isBaitElement(this)) ? 1 : value;
      },
      configurable: true,
    });
  }

  // =========================================================================
  // 7. MutationObserver — protect bait elements + hide broken ad templates
  // =========================================================================

  const protectBaitElement = (el) => {
    if (!isBaitElement(el)) return;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      el.style.setProperty('display', 'block', 'important');
      el.style.setProperty('visibility', 'visible', 'important');
      el.style.setProperty('opacity', '1', 'important');
      el.style.setProperty('height', '1px', 'important');
    }
  };

  const brokenSponsoredMarkers = Object.freeze([
    'SPONSORED_HEADLINE',
    'SPONSORED_IMAGE_URL',
    'SPONSORED_STRAPLINE',
  ]);
  const MAX_BROKEN_SPONSORED_TEXT_LENGTH = 12000;

  const hasBrokenSponsoredTemplateText = (text) => {
    if (typeof text !== 'string') return false;
    const sample = text.slice(0, MAX_BROKEN_SPONSORED_TEXT_LENGTH);
    const markerCount = brokenSponsoredMarkers.filter(marker => sample.includes(marker)).length;

    if (markerCount >= 2) return true;
    return (
      markerCount === 1 &&
      /<(?:a|article|img)\b/i.test(sample) &&
      /\b(?:article-link|search-result|category-link|lazy-image-van)\b/i.test(sample)
    );
  };

  const hideBrokenSponsoredElement = (el) => {
    el.style.setProperty('display', 'none', 'important');
    el.style.setProperty('visibility', 'hidden', 'important');
    el.style.setProperty('pointer-events', 'none', 'important');
    if (typeof el.setAttribute === 'function') {
      el.setAttribute('aria-hidden', 'true');
    }
  };

  const isRootElement = (el) => (
    el === document.documentElement || el === document.body
  );

  const removeTextNode = (node) => {
    if (node.parentNode && typeof node.parentNode.removeChild === 'function') {
      node.parentNode.removeChild(node);
      return;
    }
    node.nodeValue = '';
    node.textContent = '';
  };

  const getElementAttribute = (el, name) => {
    if (typeof el.getAttribute === 'function') {
      return el.getAttribute(name) || '';
    }
    if (name === 'class') return el.className || '';
    if (name === 'aria-label') return el.ariaLabel || '';
    if (name === 'src') return el.src || '';
    if (name === 'data-original') return (el.dataset && el.dataset.original) || '';
    return '';
  };

  const isSponsoredTemplateElement = (el) => {
    if (!el || el.nodeType !== 1 || isRootElement(el)) return false;

    const className = getElementAttribute(el, 'class');
    const ownSignal = [
      className,
      getElementAttribute(el, 'aria-label'),
      getElementAttribute(el, 'src'),
      getElementAttribute(el, 'data-original'),
    ].join(' ');
    const hasTemplateShape =
      /(?:^|\s)(?:article-link|search-result|category-link|lazy-image-van)(?:\s|$)/i.test(className) ||
      /SPONSORED_(?:HEADLINE|IMAGE_URL|STRAPLINE)/.test(ownSignal);

    if (!hasTemplateShape) {
      return false;
    }

    return hasBrokenSponsoredTemplateText(`${ownSignal} ${el.textContent || ''}`);
  };

  const hideBrokenSponsoredTemplate = (node) => {
    if (!node) return false;

    if (node.nodeType === 3) {
      if (!hasBrokenSponsoredTemplateText(node.nodeValue || node.textContent || '')) return false;

      removeTextNode(node);
      return true;
    }

    if (!isSponsoredTemplateElement(node)) return false;

    hideBrokenSponsoredElement(node);
    return true;
  };

  const scanBrokenSponsoredDescendants = (el) => {
    if (!el || typeof el.querySelectorAll !== 'function') return;
    try {
      const candidates = el.querySelectorAll(
        '[aria-label*="SPONSORED_HEADLINE"], [src*="SPONSORED_IMAGE_URL"], ' +
        '[data-original*="SPONSORED_IMAGE_URL"], .article-link, .search-result, .category-link'
      );
      for (const candidate of candidates) {
        hideBrokenSponsoredTemplate(candidate);
      }
    } catch (_) {}
  };

  const handleAddedNode = (node) => {
    if (node.nodeType === 1) {
      protectBaitElement(node);
      if (!hideBrokenSponsoredTemplate(node)) {
        scanBrokenSponsoredDescendants(node);
      }
      return;
    }
    if (node.nodeType === 3) {
      hideBrokenSponsoredTemplate(node);
    }
  };

  // Overlay removal is handled separately (one-shot, not continuous)

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of (mutation.addedNodes || [])) {
        handleAddedNode(node);
      }
      if (mutation.type === 'attributes' && mutation.target) {
        protectBaitElement(mutation.target);
      }
      if (mutation.type === 'characterData' && mutation.target) {
        hideBrokenSponsoredTemplate(mutation.target);
      }
    }
  });

  const startObserving = () => {
    const root = document.documentElement || document.body;
    if (!root) return;
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
      attributeFilter: ['class', 'style'],
    });
  };

  if (document.documentElement) {
    startObserving();
  } else {
    document.addEventListener('DOMContentLoaded', startObserving, { once: true });
  }

  // =========================================================================
  // 8. One-shot anti-adblock overlay removal (runs once after initial load)
  // =========================================================================
  // Separated from MutationObserver to avoid removing legitimate SPA content
  // during client-side navigation.

  const overlayTextPatterns = [
    /ad\s*block/i,
    /広告.*ブロック/i,
    /disable.*your.*ad/i,
    /turn\s+off.*ad\s*block/i,
    /deactivate.*ad\s*block/i,
    /ad\s*block.*detect/i,
  ];

  const isAntiAdblockOverlay = (el) => {
    if (!el || el.nodeType !== 1) return false;
    const style = window.getComputedStyle(el);
    const pos = style.position;
    if (pos !== 'fixed') return false;
    const z = parseInt(style.zIndex, 10);
    if (!(z > 1000)) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < window.innerWidth * 0.5 || rect.height < window.innerHeight * 0.5) return false;
    const text = (el.textContent || '').slice(0, 2000);
    return overlayTextPatterns.some(p => p.test(text));
  };

  const hideOverlay = (el) => {
    el.style.setProperty('display', 'none', 'important');
    el.style.setProperty('visibility', 'hidden', 'important');
    el.style.setProperty('pointer-events', 'none', 'important');
  };

  const restoreScrolling = () => {
    for (const target of [document.documentElement, document.body]) {
      if (!target) continue;
      const ov = window.getComputedStyle(target).overflow;
      if (ov === 'hidden') {
        target.style.setProperty('overflow', 'auto', 'important');
      }
      target.classList.remove('noscroll', 'modal-open', 'no-scroll');
    }
  };

  const scanAndRemoveOverlays = () => {
    let found = false;
    for (const el of document.querySelectorAll('body > *')) {
      if (isAntiAdblockOverlay(el)) {
        hideOverlay(el);
        found = true;
      }
    }
    if (found) restoreScrolling();
  };

  // Both passes run unconditionally: the overlay may be injected after the
  // first pass, or re-injected by the site after the first pass hides it.
  // Gating the second pass on the first one finding something would miss
  // exactly the late overlays it exists to catch.
  window.addEventListener('load', () => {
    setTimeout(scanAndRemoveOverlays, 500);
    setTimeout(scanAndRemoveOverlays, 2500);
  }, { once: true });
})();
