'use strict';

// Registered in MAIN at document_start while enabled. This must run before the
// first player consumes its ad schedule, not after a skip button has appeared.
(() => {
  const YOUTUBE_DOMAINS = ['youtube.com', 'youtube-nocookie.com'];
  const isYouTubeHost = hostname => YOUTUBE_DOMAINS.some(domain =>
    hostname === domain || hostname.endsWith(`.${domain}`)
  );
  if (!isYouTubeHost(window.location.hostname)) return;

  function prunePlayerData(data, depth = 2) {
    if (!data || typeof data !== 'object' || depth < 0) return data;
    if (Array.isArray(data)) {
      for (const entry of data) prunePlayerData(entry, depth - 1);
      return data;
    }
    // Keep playback tracking, heartbeat data, media URLs and experiment flags.
    // Non-configurable properties fail open instead of breaking initialization.
    for (const key of ['adPlacements', 'adSlots']) Reflect.deleteProperty(data, key);
    if (data.playerResponse) prunePlayerData(data.playerResponse, depth - 1);
    return data;
  }

  const initialName = 'ytInitialPlayerResponse';
  const descriptor = Object.getOwnPropertyDescriptor(window, initialName);
  if (!descriptor || (descriptor.configurable && descriptor.writable !== false && !descriptor.get && !descriptor.set)) {
    let value = prunePlayerData(window[initialName]);
    Object.defineProperty(window, initialName, {
      configurable: true,
      enumerable: descriptor?.enumerable ?? true,
      get() { return prunePlayerData(value); },
      set(next) { value = prunePlayerData(next); },
    });
  } else {
    prunePlayerData(window[initialName]);
  }

  function isPlayerUrl(input) {
    try {
      const url = new URL(input?.url ?? input, window.location.href);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
      if (!isYouTubeHost(url.hostname) && url.hostname !== 'youtubei.googleapis.com') return false;
      return /^\/(?:youtubei\/v1\/(?:player|get_watch)|watch|get_watch|playlist)$/.test(url.pathname);
    } catch (_) {
      return false;
    }
  }

  function filterJsonText(text) {
    if (typeof text !== 'string' || !/"(?:adPlacements|adSlots)"\s*:/.test(text)) return text;
    const offset = text.startsWith(")]}'") ? text.indexOf('\n') + 1 : 0;
    try {
      // Validate JSON before editing keys. Preserve the original serialization,
      // including large integer text and the optional anti-XSSI prefix.
      JSON.parse(text.slice(offset));
    } catch (_) {
      return text;
    }
    return text.replace(/"(?:adPlacements|adSlots)"\s*:/g, '"no_ads":');
  }

  function withResponseMetadata(response, metadata) {
    const clone = Response.prototype.clone;
    Object.defineProperties(response, {
      url: { value: metadata.url },
      redirected: { value: metadata.redirected },
      type: { value: metadata.type },
      clone: {
        value() {
          const copy = Reflect.apply(clone, this, []);
          return withResponseMetadata(copy, { url: this.url, redirected: this.redirected, type: this.type });
        },
      },
    });
    return response;
  }

  async function filterResponse(response) {
    if (!response.ok || (response.url && !isPlayerUrl(response.url))) return response;
    try {
      // Work on a clone so malformed/unsupported payloads pass through with the
      // original body still unread. Only scoped player responses are buffered.
      const text = await response.clone().text();
      const filtered = filterJsonText(text);
      if (filtered === text) return response;
      const headers = new Headers(response.headers);
      headers.delete('content-length');
      headers.delete('content-encoding');
      const result = new Response(filtered, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
      return withResponseMetadata(result, {
        url: response.url, redirected: response.redirected, type: response.type,
      });
    } catch (_) {
      return response;
    }
  }

  if (typeof window.fetch === 'function') {
    window.fetch = new Proxy(window.fetch, {
      apply(target, receiver, args) {
        const result = Reflect.apply(target, receiver, args);
        return isPlayerUrl(args[0]) ? result.then(filterResponse) : result;
      },
    });
  }

  const xhr = window.XMLHttpRequest?.prototype;
  if (!xhr || typeof xhr.open !== 'function') return;
  const urls = new WeakMap();
  xhr.open = new Proxy(xhr.open, {
    apply(target, request, args) {
      const result = Reflect.apply(target, request, args);
      urls.set(request, args[1]);
      return result;
    },
  });
  for (const property of ['response', 'responseText']) {
    const original = Object.getOwnPropertyDescriptor(xhr, property);
    if (!original?.get || !original.configurable) continue;
    Object.defineProperty(xhr, property, {
      ...original,
      get() {
        // Read first to preserve native InvalidStateError/responseType behavior.
        const value = Reflect.apply(original.get, this, []);
        if (this.status < 200 || this.status >= 300) return value;
        if (!isPlayerUrl(urls.get(this)) || (this.responseURL && !isPlayerUrl(this.responseURL))) return value;
        if (typeof value === 'string') return filterJsonText(value);
        return this.responseType === 'json' ? prunePlayerData(value) : value;
      },
    });
  }
})();
