(() => {
  'use strict';
  const allowedHosts = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com']);
  if (!allowedHosts.has(location.hostname) || window.__vigilYouTubeResponseGuard) return;
  window.__vigilYouTubeResponseGuard = true;
  const nativeParse = JSON.parse;
  const PLAYER_RESPONSE_PATHS = new Set([
    '/youtubei/v1/player', '/youtubei/v1/get_watch', '/youtubei/v1/next', '/get_watch', '/playlist'
  ]);
  const PLAYER_AD_KEYS = ['adPlacements', 'playerAds', 'adSlots'];
  const playerResponseURL = value => {
    let raw = value;
    if (typeof Request !== 'undefined' && value instanceof Request) raw = value.url;
    else if (value instanceof URL) raw = value.href;
    let url;
    try { url = new URL(String(raw || ''), location.href); } catch { return false; }
    return url.protocol === 'https:' && (!url.port || url.port === '443')
      && allowedHosts.has(url.hostname.toLowerCase())
      && PLAYER_RESPONSE_PATHS.has(url.pathname);
  };
  const plainRecord = value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null
      || (Object.getPrototypeOf(prototype) === null
        && Object.prototype.hasOwnProperty.call(prototype, 'constructor')
        && typeof prototype.constructor === 'function'
        && Function.prototype.toString.call(prototype.constructor) === Function.prototype.toString.call(Object));
  };
  const playablePlayerResponse = value => plainRecord(value)
    && plainRecord(value.videoDetails)
    && typeof value.videoDetails.videoId === 'string'
    && value.videoDetails.videoId.length > 0
    && (plainRecord(value.streamingData) || plainRecord(value.playabilityStatus));
  const collectPlayerAdFields = (value, targets, seen = new WeakSet()) => {
    if (!value || typeof value !== 'object' || seen.has(value)) return true;
    seen.add(value);
    if (Array.isArray(value)) return value.every(item => collectPlayerAdFields(item, targets, seen));
    if (!plainRecord(value)) return false;
    if (playablePlayerResponse(value)) {
      for (const key of PLAYER_AD_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.configurable || !Array.isArray(descriptor.value)) return false;
        targets.push([value, key]);
      }
    }
    // Mobile watch responses wrap the player beneath several renderer layers.
    // Remove only ad arrays belonging to a positively identified player.
    return Object.entries(value).every(([key, item]) => {
      // Older and mobile bootstrap data also carry the player as JSON inside
      // ytInitialData or ytplayer.config.args. Preserve the surrounding data.
      if (['playerResponse', 'player_response'].includes(key) && typeof item === 'string') {
        let player;
        try { player = nativeParse(item); } catch { return true; }
        if (!playablePlayerResponse(player)) return true;
        const nested = [];
        if (!collectPlayerAdFields(player, nested, seen)) return false;
        if (!nested.length) return true;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.writable) return false;
        for (const [target, field, replacement] of nested) {
          if (replacement === undefined) Reflect.deleteProperty(target, field);
          else Reflect.set(target, field, replacement);
        }
        targets.push([value, key, JSON.stringify(player)]);
        return true;
      }
      return !item || typeof item !== 'object' || collectPlayerAdFields(item, targets, seen);
    });
  };
  const prunePlayerResponse = value => {
    const targets = [];
    try {
      if (!collectPlayerAdFields(value, targets) || targets.length === 0) return false;
      return targets.every(([target, key, replacement]) => replacement === undefined
        ? Reflect.deleteProperty(target, key) : Reflect.set(target, key, replacement));
    } catch { return false; }
  };
  const clonedPrunedPlayerResponse = value => {
    try {
      // Bootstrap containers can also own player methods. A JSON round trip
      // drops those functions and changes unrelated values such as undefined.
      const seen = new WeakMap();
      const copy = item => {
        if (!item || typeof item !== 'object') return item;
        if (seen.has(item)) return seen.get(item);
        if (!Array.isArray(item) && !plainRecord(item)) throw new Error('Unknown player container');
        const clone = Array.isArray(item) ? [] : Object.create(Object.getPrototypeOf(item));
        seen.set(item, clone);
        for (const key of Reflect.ownKeys(item)) {
          const descriptor = Object.getOwnPropertyDescriptor(item, key);
          if (!descriptor || !('value' in descriptor)) throw new Error('Unknown player property');
          Object.defineProperty(clone, key, { ...descriptor, value: copy(descriptor.value) });
        }
        return clone;
      };
      const clone = copy(value);
      return prunePlayerResponse(clone) ? clone : null;
    } catch { return null; }
  };
  const rewrittenHeaders = response => {
    const headers = new Headers(response.headers);
    for (const name of [
      'content-encoding', 'content-length', 'content-md5', 'content-range',
      'digest', 'etag', 'transfer-encoding'
    ]) headers.delete(name);
    return headers;
  };
  const eligiblePlayerResponse = response => response instanceof Response
    && !response.bodyUsed && response.status === 200 && !response.redirected
    && ['basic', 'cors', 'default'].includes(response.type)
    && (!response.url || playerResponseURL(response.url))
    && /(?:^|[/+])json(?:\s*;|$)/i.test(response.headers.get('content-type') || '');
  const rewrittenPlayerResponse = responseBefore => {
    if (!eligiblePlayerResponse(responseBefore)) return Promise.resolve(responseBefore);
    return responseBefore.clone().json().then(payload => {
      if (!prunePlayerResponse(payload)) return responseBefore;
      const responseAfter = new Response(JSON.stringify(payload), {
        status: responseBefore.status,
        statusText: responseBefore.statusText,
        headers: rewrittenHeaders(responseBefore)
      });
      for (const property of ['ok', 'redirected', 'type', 'url']) {
        try { Object.defineProperty(responseAfter, property, { value: responseBefore[property] }); } catch {}
      }
      return responseAfter;
    }).catch(() => responseBefore);
  };
  const installFetchPlayerResponseGuard = () => {
    if (typeof window.fetch !== 'function') return;
    const nativeFetch = window.fetch;
    window.fetch = new Proxy(nativeFetch, {
      apply(target, thisArg, argumentsList) {
        const result = Reflect.apply(target, thisArg, argumentsList);
        return playerResponseURL(argumentsList[0])
          ? result.then(rewrittenPlayerResponse, () => result)
          : result;
      }
    });
  };
  const installXHRPlayerResponseGuard = () => {
    const NativeXHR = window.XMLHttpRequest;
    if (typeof NativeXHR !== 'function') return;
    const guarded = new WeakSet();
    window.XMLHttpRequest = class extends NativeXHR {
      open(method, url, ...rest) {
        guarded.delete(this);
        if (playerResponseURL(url)) guarded.add(this);
        return super.open(method, url, ...rest);
      }
      get response() {
        const raw = super.response;
        if (!guarded.has(this) || this.readyState !== 4 || Number(this.status) !== 200) return raw;
        const responseURL = String(this.responseURL || '');
        if (responseURL && !playerResponseURL(responseURL)) return raw;
        const contentType = String(this.getResponseHeader?.('content-type') || '');
        if (contentType && !/(?:^|[/+])json(?:\s*;|$)/i.test(contentType)) return raw;
        if (!['', 'text', 'json'].includes(String(this.responseType || ''))) return raw;
        try {
          const wasText = typeof raw === 'string';
          const payload = wasText ? nativeParse(raw) : clonedPrunedPlayerResponse(raw);
          if (!payload || (wasText && !prunePlayerResponse(payload))) return raw;
          return wasText ? JSON.stringify(payload) : payload;
        } catch { return raw; }
      }
      get responseText() {
        const value = this.response;
        return typeof value === 'string' ? value : super.responseText;
      }
    };
  };
  const cleanInitialValue = value => {
    if (typeof value !== 'string') return clonedPrunedPlayerResponse(value) || value;
    try {
      const payload = nativeParse(value);
      return prunePlayerResponse(payload) ? JSON.stringify(payload) : value;
    } catch { return value; }
  };
  const installInitialPlayerResponseGuard = key => {
    const descriptor = Object.getOwnPropertyDescriptor(window, key);
    if (descriptor && (!descriptor.configurable
        || ('value' in descriptor ? !descriptor.writable : !descriptor.get || !descriptor.set))) return;
    let current = descriptor?.value;
    try {
      if (descriptor?.get) current = descriptor.get.call(window);
      current = cleanInitialValue(current);
      if (descriptor?.set) descriptor.set.call(window, current);
      Object.defineProperty(window, key, {
        configurable: true,
        enumerable: descriptor?.enumerable ?? true,
        get: () => descriptor?.get ? descriptor.get.call(window) : current,
        set: value => {
          current = cleanInitialValue(value);
          if (descriptor?.set) descriptor.set.call(window, current);
        }
      });
    } catch {}
  };
  const installParsedPlayerResponseGuard = () => {
    // Some mobile startup and SPA responses bypass both globals and fetch by
    // parsing inline JSON. Only recognize complete player schemas with ads;
    // normal JSON and malformed/unknown schemas retain their original result.
    JSON.parse = new Proxy(nativeParse, {
      apply(target, thisArg, argumentsList) {
        const result = Reflect.apply(target, thisArg, argumentsList);
        const text = argumentsList[0];
        if (typeof text === 'string' && text.includes('"videoDetails"')
            && PLAYER_AD_KEYS.some(key => text.includes(`"${key}"`))) prunePlayerResponse(result);
        return result;
      }
    });
  };
  installFetchPlayerResponseGuard();
  installXHRPlayerResponseGuard();
  for (const key of ['ytInitialPlayerResponse', 'ytInitialData', 'ytplayer']) installInitialPlayerResponseGuard(key);
  installParsedPlayerResponseGuard();
  window.__vigilYouTubeResponseGuardReady = true;

})();
