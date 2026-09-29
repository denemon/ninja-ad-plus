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

  // YouTube serves ads in the same first-party player responses and media
  // streams as the requested video. Blocking those URLs also blocks playback,
  // so remove only the ad metadata before the player consumes the response.
  const isYouTube = (() => {
    const hostname = window.location && window.location.hostname;
    return hostname === 'youtube.com' || (hostname || '').endsWith('.youtube.com');
  })();

  // YouTube's raw Network Machine path consumes binary/streamed responses and
  // bypasses the JSON response hooks below. Trap the config assignments made by
  // the boot scripts and keep that path disabled even if an experiment update
  // tries to turn it back on later.
  const watchProperty = (target, property, onValue) => {
    if (!target || typeof target !== 'object') return;
    const descriptor = Object.getOwnPropertyDescriptor(target, property);
    if (descriptor && !descriptor.configurable) {
      onValue(target[property]);
      return;
    }

    let value = target[property];
    Object.defineProperty(target, property, {
      configurable: true,
      enumerable: descriptor?.enumerable ?? true,
      get() { return value; },
      set(nextValue) {
        value = nextValue;
        onValue(nextValue);
      },
    });
    onValue(value);
  };

  const forceYouTubeJsonNetworking = (flags) => {
    if (!flags || typeof flags !== 'object') return;
    for (const property of [
      'all_web_enable_network_machine',
      'all_web_network_machine_raw_request',
    ]) {
      const descriptor = Object.getOwnPropertyDescriptor(flags, property);
      if (descriptor && !descriptor.configurable) {
        try { flags[property] = false; } catch (_) {}
        continue;
      }
      Object.defineProperty(flags, property, {
        configurable: true,
        enumerable: descriptor?.enumerable ?? true,
        get: returnFalse,
        set: noopFn,
      });
    }
  };

  if (isYouTube) {
    watchProperty(window, 'ytcfg', (config) => {
      watchProperty(config, 'data_', (data) => {
        watchProperty(data, 'EXPERIMENT_FLAGS', forceYouTubeJsonNetworking);
      });
    });
  }

  // Carriers of ad metadata that sit alongside real content under the same
  // parent, so the key can simply be dropped.
  const AD_KEYS = ['adPlacements', 'adSlots', 'playerAds', 'adBreakHeartbeatParams'];

  // A Polymer element name maps 1:1 from its renderer key -- adSlotRenderer
  // becomes <ytd-ad-slot-renderer> -- so this list is the JSON-side twin of the
  // selectors in youtube.js. The DOM pass stays as a backstop for what never
  // reaches this code: player chrome (.ytp-*) is built by the player itself and
  // has no renderer key, and a response read as a stream or an ArrayBuffer is
  // not pruned at all.
  const AD_RENDERER_KEYS = new Set([
    'actionCompanionAdRenderer',
    'adSlotRenderer',
    'bannerPromoRenderer',
    'compactPromotedVideoRenderer',
    'companionAdRenderer',
    'companionSlotRenderer',
    'displayAdRenderer',
    'inFeedAdLayoutRenderer',
    'merchandiseShelfRenderer',
    'playerLegacyDesktopWatchAdsRenderer',
    'promotedSparklesTextRenderer',
    'promotedSparklesWebRenderer',
    'promotedVideoRenderer',
    'searchPyvRenderer',
    'statementBannerRenderer',
  ]);

  // Deleting the renderer key on its own leaves the wrappers around it, which
  // render as an empty card, so the whole entry carrying one is dropped. The
  // renderer sits a couple of wrappers down at most
  // (richItemRenderer.content.adSlotRenderer), and the depth bound doubles as
  // the cycle guard.
  //
  // Only a single-key chain is followed. A search section holds real videos and
  // a searchPyvRenderer in one contents array, so "contains an ad somewhere
  // below" would splice the whole section and take the results with it. An
  // entry that holds anything besides the ad is a container, and the ads inside
  // it get spliced from their own array by the walk below.
  const isYouTubeAdEntry = (entry, depth = 4) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || depth < 0) return false;
    if (entry.command?.reelWatchEndpoint?.adClientParams?.isAd) return true;

    const keys = Object.keys(entry);
    if (keys.some((key) => AD_RENDERER_KEYS.has(key))) return true;
    return keys.length === 1 && isYouTubeAdEntry(entry[keys[0]], depth - 1);
  };

  const pruneYouTubeAdData = (value, seen = new WeakSet()) => {
    if (!value || typeof value !== 'object' || seen.has(value)) return value;
    seen.add(value);

    for (const key of AD_KEYS) {
      delete value[key];
    }

    if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index--) {
        if (isYouTubeAdEntry(value[index])) {
          value.splice(index, 1);
          continue;
        }
        pruneYouTubeAdData(value[index], seen);
      }
      return value;
    }

    for (const child of Object.values(value)) {
      pruneYouTubeAdData(child, seen);
    }
    return value;
  };

  // Some clients fetch the same InnerTube responses from the API host instead
  // of the site host, and those arrive unpruned if only *.youtube.com counts.
  const YOUTUBE_API_HOST = 'youtubei.googleapis.com';

  // Ad payloads ride along with the feed, search, related-video, guide and
  // Shorts responses, not just the player response. Matching only the player
  // paths leaves every other surface to be cleaned out of the DOM after it has
  // already rendered -- which is the flash of ad content the DOM pass chases.
  const AD_BEARING_PATH =
    /^\/(?:watch|playlist|get_watch)$|^\/youtubei\/v1\/(?:player|get_watch|next|browse|search|guide|reel)(?:$|\/)/;

  const isYouTubePlayerResponse = (url) => {
    if (!isYouTube || !url || !window.URL) return false;
    try {
      const parsed = new window.URL(String(url), window.location.href);
      const hostname = parsed.hostname;
      if (
        hostname !== 'youtube.com' &&
        !hostname.endsWith('.youtube.com') &&
        hostname !== YOUTUBE_API_HOST
      ) return false;
      return AD_BEARING_PATH.test(parsed.pathname);
    } catch (_) {
      return false;
    }
  };

  // Cheap pre-check so ordinary responses skip the parse/stringify round trip.
  // Built from the lists above rather than hand-written, so a key added there
  // cannot be missed here and silently stop reaching the walk. adClientParams
  // is the Shorts marker -- those entries carry no other ad key.
  // ponytail: parse+stringify walks the whole response; only reached when an
  // ad key is actually present. Move to a streaming prune if feeds get slow.
  const AD_TEXT_MARKER = new RegExp(
    `"(?:${[...AD_KEYS, 'adClientParams', ...AD_RENDERER_KEYS].join('|')})"`
  );

  const pruneYouTubeJsonText = (text) => {
    if (typeof text !== 'string' || !AD_TEXT_MARKER.test(text)) {
      return text;
    }

    const newline = text.indexOf('\n');
    const hasXssiPrefix = text.startsWith(")]}'") && newline >= 0;
    const prefix = hasXssiPrefix ? text.slice(0, newline + 1) : '';
    try {
      return prefix + JSON.stringify(pruneYouTubeAdData(JSON.parse(text.slice(prefix.length))));
    } catch (_) {
      return text;
    }
  };

  const installYouTubePlayerGuards = () => {
    if (!isYouTube) return;

    for (const name of ['ytInitialPlayerResponse', 'ytInitialData']) {
      if (Object.prototype.hasOwnProperty.call(window, name)) {
        pruneYouTubeAdData(window[name]);
        continue;
      }

      let value;
      Object.defineProperty(window, name, {
        configurable: true,
        enumerable: true,
        get() { return value; },
        set(nextValue) { value = pruneYouTubeAdData(nextValue); },
      });
    }

    const responsePrototype = window.Response && window.Response.prototype;
    for (const [method, prune] of [
      ['json', pruneYouTubeAdData],
      ['text', pruneYouTubeJsonText],
    ]) {
      const original = responsePrototype && responsePrototype[method];
      if (typeof original !== 'function') continue;
      responsePrototype[method] = new Proxy(original, {
        apply(target, response, args) {
          const result = Reflect.apply(target, response, args);
          return isYouTubePlayerResponse(response.url)
            ? Promise.resolve(result).then(prune)
            : result;
        },
      });
    }

    const xhrPrototype = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
    if (!xhrPrototype || typeof xhrPrototype.open !== 'function') return;

    const requestUrls = new WeakMap();
    const originalOpen = xhrPrototype.open;
    xhrPrototype.open = new Proxy(originalOpen, {
      apply(target, request, args) {
        requestUrls.set(request, args[1]);
        return Reflect.apply(target, request, args);
      },
    });

    for (const property of ['response', 'responseText']) {
      const descriptor = Object.getOwnPropertyDescriptor(xhrPrototype, property);
      if (!descriptor?.get || !descriptor.configurable) continue;
      Object.defineProperty(xhrPrototype, property, {
        ...descriptor,
        get() {
          const value = descriptor.get.call(this);
          if (!isYouTubePlayerResponse(requestUrls.get(this))) return value;
          if (typeof value === 'string') return pruneYouTubeJsonText(value);
          return this.responseType === 'json' ? pruneYouTubeAdData(value) : value;
        },
      });
    }
  };

  installYouTubePlayerGuards();

  let youtubeAdCheckScheduled = false;
  const checkYouTubeServerSideAd = () => {
    youtubeAdCheckScheduled = false;
    if (!isYouTube) return;

    const player = document.getElementById('movie_player');
    try {
      const debugInfo = player?.getStatsForNerds?.()?.debug_info;
      if (typeof debugInfo !== 'string' || !debugInfo.startsWith('SSAP, AD')) return;

      player.querySelector(
        '.ytp-ad-skip-button,.ytp-ad-skip-button-modern,.ytp-skip-ad-button'
      )?.click();
      const duration = player.getProgressState?.()?.duration;
      if (Number.isFinite(duration) && duration > 0) {
        player.seekTo?.(duration);
      }
    } catch (_) {}
  };

  const scheduleYouTubeAdCheck = () => {
    if (!isYouTube || youtubeAdCheckScheduled) return;
    youtubeAdCheckScheduled = true;
    const schedule = window.requestAnimationFrame || ((callback) => setTimeout(callback, 0));
    schedule(checkYouTubeServerSideAd);
  };

  if (isYouTube) {
    document.addEventListener('timeupdate', scheduleYouTubeAdCheck, true);
    document.addEventListener('yt-navigate-finish', scheduleYouTubeAdCheck);
  }

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

  // Detection bait is an empty placeholder the site measures. Real UI that
  // happens to carry a bait word -- GitHub/Primer names its message box
  // "Banner-message" -- holds text, and force-showing it with !important leaks
  // every message the site deliberately hides. Only unhide what is empty.
  const protectBaitElement = (el) => {
    if (!isBaitElement(el)) return;
    if ((el.textContent || '').trim() !== '') return;
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
    scheduleYouTubeAdCheck();
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
  scheduleYouTubeAdCheck();

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
