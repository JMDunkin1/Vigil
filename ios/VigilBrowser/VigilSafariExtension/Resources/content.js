(() => {
  "use strict";
  const nativeApplication = "tech.caseline.vigil.browser";
  const rulesSchemaVersion = 2;
  const normalizedHost = value => String(value || "").toLowerCase().replace(/\.+$/, "");
  const decodePercentRuns = value => String(value || "").replace(/(?:%[0-9a-f]{2})+/gi, run => {
    try { return decodeURIComponent(run); }
    catch {
      return run.replace(/%([0-9a-f]{2})/gi, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
    }
  });
  const decodedCandidates = value => {
    const candidates = [String(value || "").toLowerCase()];
    let decoded = candidates[0];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const next = decodePercentRuns(decoded);
      if (next === decoded) break;
      decoded = next.toLowerCase();
      candidates.push(decoded);
    }
    return [...new Set(candidates)];
  };
  const rulesCacheKey = `lastKnownRules:${normalizedHost(location.hostname)}`;
  const bootstrapRules = {
    schemaVersion: rulesSchemaVersion,
    blockedHosts: [],
    blockedURLFragments: [],
    blockedSearchTerms: [
      "porn", "porno", "xxx", "nsfw", "hentai", "rule34", "gonewild",
      "onlyfans", "fansly", "chaturbate", "stripchat", "cam4", "redtube",
      "youporn", "spankbang", "xvideos", "xnxx", "xhamster", "18+",
      "18%2b", "18plus", "18-plus"
    ],
    safeSearchEnabled: true,
    blockedDomain: "",
    filterUnavailable: false
  };
  let rules = null;
  let rulesSettled = false;
  let preflightHandled = false;
  let blockSurfaceActive = false;
  let blockGuard = null;
  let renderBlockSurface = null;
  const blankEscapeURL = "about:blank";
  const historyBridgeVersion = "main-v1";
  const historyBridgeNavigationEvent = "vigil-history-navigation";
  const historyBridgeReadyEvent = "vigil-history-bridge-ready";
  const NavigationConstructor = globalThis.Navigation;
  const navigationEvents = (
    typeof NavigationConstructor === "function"
    && globalThis.navigation instanceof NavigationConstructor
    && typeof globalThis.navigation.addEventListener === "function"
  ) ? globalThis.navigation : null;
  let historyBridgeReady = Boolean(navigationEvents);
  let restoringURL = "";
  let lastKnownAllowedURL = blankEscapeURL;
  let observedLocation = location.href;
  const protectedSearchKeys = new Set([
    "q", "query", "search_query", "search", "searchterm", "search_term",
    "keyword", "keywords", "term", "text", "p", "k", "s", "wd"
  ]);
  const searchRoutePattern = /(?:^|[/#])(?:advancedsearch(?:\.php)?|search(?:\.php)?|results?|find|browse)(?:[/?.#]|$)/i;
  const searchDescriptorPattern = /(?:^|[-_\s])(?:search|query|keyword)(?:$|[-_\s])/i;
  const personExposureMarkers = new Set(["leak", "leaks", "leaked", "nude", "nudes", "naked", "topless"]);
  const personIntimateContext = new Set([
    "explicit", "fansly", "intimate", "nsfw", "nude", "nudes", "naked",
    "onlyfans", "porn", "porno", "sex", "sextape", "topless", "xxx"
  ]);
  const nonPersonSearchContext = new Set([
    "air", "album", "api", "app", "apps", "classified", "code", "color", "court",
    "data", "database", "document", "documents", "email", "emails", "episode",
    "episodes", "fc", "film", "films", "game", "games", "gas", "government",
    "iphone", "javascript", "memory", "movie", "movies", "news", "oil",
    "palette", "papers", "password", "passwords", "phone", "pipeline", "pixel", "product",
    "products", "release", "releases", "report", "reports", "roof", "roster",
    "rumor", "rumors", "samsung", "security", "software", "source", "sources",
    "spec", "specs", "team", "transfer", "transfers", "tv", "water"
  ]);
  const personNameFillerWords = new Set([
    "a", "an", "and", "at", "for", "from", "in", "of", "on", "or", "the", "to", "with"
  ]);

  const hostMatches = (host, blocked) => {
    const normalizedBlocked = normalizedHost(blocked);
    return Boolean(normalizedBlocked && (host === normalizedBlocked || host.endsWith(`.${normalizedBlocked}`)));
  };
  const searchText = url => {
    const values = [...url.searchParams]
      .filter(([name]) => protectedSearchKeys.has(name.toLowerCase()))
      .map(([, value]) => value);
    const decodedPath = decodedCandidates(url.pathname).at(-1) || url.pathname;
    const decodedHash = decodedCandidates(url.hash.replace(/^#/, "")).at(-1) || url.hash;
    if (searchRoutePattern.test(decodedPath)) values.push(decodedPath);
    if (searchRoutePattern.test(decodedHash)) values.push(decodedHash);
    return values.flatMap(decodedCandidates).join(" ");
  };
  const explicitPersonSearchText = value => {
    const tokens = decodedCandidates(value).at(-1)?.replace(/\+/g, " ").normalize("NFKC")
      .match(/[\p{L}\p{M}][\p{L}\p{M}'’.-]*/gu)
      ?.map(token => token.replace(/^[^\p{L}\p{M}]+|[^\p{L}\p{M}]+$/gu, "").toLowerCase())
      .filter(Boolean) || [];
    if (tokens.length < 2) return false;
    const markerIndex = tokens.findIndex(token => personExposureMarkers.has(token));
    if (markerIndex < 0) return false;
    if (tokens.some((token, index) => index !== markerIndex && personIntimateContext.has(token))) return true;
    const nameSide = markerIndex === tokens.length - 1
      ? tokens.slice(0, markerIndex)
      : markerIndex === 0
        ? tokens.slice(1)
        : [];
    const structuralName = nameSide.filter(token => !personNameFillerWords.has(token));
    return structuralName.length >= 2 && structuralName.length <= 4
      && structuralName.every(token => token.length >= 2 && !nonPersonSearchContext.has(token));
  };
  const blockedSearchText = (value, activeRules = rules) => Boolean(activeRules
    && ((activeRules.blockedSearchTerms || []).some(term => (
      decodedCandidates(value).join(" ").includes(String(term).toLowerCase())
    )) || explicitPersonSearchText(value)));
  const decision = (raw, activeRules = rules) => {
    if (!activeRules) return { allowed: false, reason: "Vigil filter rules are unavailable" };
    if (activeRules.filterUnavailable) return { allowed: false, reason: "Vigil's content filter failed its integrity check" };
    let url;
    try { url = new URL(raw, location.href); } catch { return { allowed: false, reason: "Invalid address" }; }
    if (url.protocol !== "https:") return { allowed: false, reason: "Vigil requires HTTPS" };
    const host = normalizedHost(url.hostname);
    if (activeRules.blockedDomain && hostMatches(host, activeRules.blockedDomain)) return { allowed: false, reason: "Website blocked by Vigil" };
    if ((activeRules.blockedHosts || []).some(value => hostMatches(host, value))) return { allowed: false, reason: "Website blocked by Vigil" };
    const absoluteCandidates = decodedCandidates(url.href);
    if ((activeRules.blockedURLFragments || []).some(value => (
      absoluteCandidates.some(candidate => candidate.includes(String(value).toLowerCase()))
    ))) return { allowed: false, reason: "Page blocked by Vigil" };
    const terms = searchText(url);
    if ((activeRules.blockedSearchTerms || []).some(value => terms.includes(String(value).toLowerCase()))
        || explicitPersonSearchText(terms)) return { allowed: false, reason: "Search blocked by Vigil" };
    if (activeRules.safeSearchEnabled) {
      let key = null, value = null;
      if (host === "google.com" || host.endsWith(".google.com")) { key = "safe"; value = "active"; }
      else if (host === "bing.com" || host.endsWith(".bing.com")) { key = "adlt"; value = "strict"; }
      else if (host === "duckduckgo.com" || host.endsWith(".duckduckgo.com")) { key = "kp"; value = "1"; }
      const matchingSafeSearchEntries = key
        ? [...url.searchParams].filter(([name]) => name.toLowerCase() === key)
        : [];
      if (key && (
        matchingSafeSearchEntries.length !== 1
        || matchingSafeSearchEntries[0][0] !== key
        || matchingSafeSearchEntries[0][1] !== value
      )) {
        for (const name of new Set(matchingSafeSearchEntries.map(([entryName]) => entryName))) {
          url.searchParams.delete(name);
        }
        url.searchParams.append(key, value);
        return { allowed: true, redirect: url.href };
      }
    }
    return { allowed: true, redirect: null };
  };

  const allowedEscapeURL = raw => {
    const result = decision(raw);
    if (!result.allowed) return blankEscapeURL;
    return result.redirect || new URL(raw, location.href).href;
  };
  const currentAllowedEscapeURL = () => {
    const current = allowedEscapeURL(location.href);
    return current === blankEscapeURL ? lastKnownAllowedURL : current;
  };

  const restoreAllowedPage = raw => {
    let target;
    try { target = new URL(raw, location.href); }
    catch {
      restoringURL = blankEscapeURL;
      location.replace(blankEscapeURL);
      return;
    }
    restoringURL = target.href;
    try {
      const current = new URL(location.href);
      if (target.origin === current.origin && typeof location.reload === "function") {
        history.replaceState(history.state, "", target.href);
        location.reload();
        return;
      }
    } catch {}
    location.replace(target.href);
  };

  const ensureDocumentRoot = () => {
    if (document.documentElement) return document.documentElement;
    try {
      const replacement = document.createElement("html");
      if (typeof document.append === "function") document.append(replacement);
      if (document.documentElement !== replacement && typeof document.replaceChildren === "function") {
        document.replaceChildren(replacement);
      }
      return document.documentElement === replacement ? replacement : null;
    } catch {
      return null;
    }
  };

  const concealPendingPage = () => {
    const root = ensureDocumentRoot();
    root?.style?.setProperty?.("display", "none", "important");
  };

  const armBlockGuard = () => {
    blockGuard?.disconnect?.();
    blockGuard = null;
    const Observer = globalThis.MutationObserver;
    if ((rulesSettled && !blockSurfaceActive) || typeof Observer !== "function") return;
    blockGuard = new Observer(() => {
      blockGuard?.disconnect?.();
      blockGuard = null;
      try {
        if (blockSurfaceActive) renderBlockSurface?.();
        else if (!rulesSettled) concealPendingPage();
      } catch {
        document.documentElement?.style?.setProperty?.("display", "none", "important");
      } finally {
        if (!blockGuard && (!rulesSettled || blockSurfaceActive)) armBlockGuard();
      }
    });
    try {
      blockGuard.observe(document, {
        attributes: true,
        characterData: true,
        childList: true,
        subtree: true
      });
    } catch {
      blockGuard = null;
    }
  };

  const cover = (reason, escapeURL = blankEscapeURL) => {
    const escapeTarget = escapeURL === blankEscapeURL ? blankEscapeURL : allowedEscapeURL(escapeURL);
    document.documentElement?.style?.setProperty?.("display", "none", "important");
    renderBlockSurface = () => {
      blockSurfaceActive = true;
      const root = ensureDocumentRoot();
      if (!root) {
        armBlockGuard();
        return;
      }
      for (const attribute of Array.from(root.attributes || [])) root.removeAttribute?.(attribute.name);
      root.removeAttribute?.("style");
      root.hidden = false;
      root.inert = false;
      root.style?.removeProperty?.("visibility");
      root.style?.removeProperty?.("display");
      root.replaceChildren();
      root.dataset.vigilBlockPage = "1";
      const style = document.createElement("style");
      style.textContent = `
        :root{color-scheme:dark;--paper:#101111;--paper-2:#161717;--ink:#f0ece5;--muted:#aaa49c;--primary:#b77952;--primary-strong:#d5a16b;--focus:rgba(213,161,107,.24)}
        *{box-sizing:border-box}
        body{margin:0;min-height:100vh;display:grid;place-items:center;padding:32px;color:var(--ink);background:radial-gradient(circle at 78% -8%,rgba(183,121,82,.18),transparent 34rem),radial-gradient(circle at 28% 106%,rgba(157,124,88,.10),transparent 30rem),linear-gradient(180deg,var(--paper),var(--paper-2));font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,sans-serif}
        main{width:min(560px,100%)}
        .eyebrow{margin:0 0 12px;color:var(--primary-strong);font-size:.78rem;font-weight:800;letter-spacing:.16em;text-transform:uppercase}
        h1{max-width:12ch;margin:0;font:700 clamp(2.75rem,12vw,5rem)/.98 Georgia,"Times New Roman",serif;letter-spacing:-.04em}
        .reason{margin:22px 0 0;color:var(--muted);line-height:1.55}
        .escape-actions{margin-top:32px}
        button{min-height:48px;border:0;border-radius:7px;padding:0 22px;color:#16120f;background:var(--primary);font:700 17px ui-sans-serif,system-ui,-apple-system,sans-serif}
        button:active{background:var(--primary-strong);transform:translateY(1px)}
        button:focus-visible{outline:3px solid var(--focus);outline-offset:3px}
        @media(max-width:520px){body{place-items:start;padding:64px 24px}}
      `;
      const body = document.createElement("body");
      const main = document.createElement("main");
      const eyebrow = document.createElement("p"); eyebrow.className = "eyebrow"; eyebrow.textContent = "Vigil";
      const title = document.createElement("h1"); title.textContent = "This page is blocked.";
      const detail = document.createElement("p"); detail.className = "reason"; detail.textContent = reason;
      const actions = document.createElement("div"); actions.className = "escape-actions";
      const back = document.createElement("button"); back.type = "button"; back.textContent = "Go back";
      back.addEventListener("click", () => restoreAllowedPage(escapeTarget));
      actions.append(back); main.append(eyebrow, title, detail, actions); body.append(main);
      root.append(style, body);
      window.stop();
      armBlockGuard();
    };
    renderBlockSurface();
  };

  const installHistoryBridge = () => {
    if (navigationEvents) return Promise.resolve(true);
    if (document.readyState !== "loading" || typeof document.write !== "function") {
      return Promise.resolve(false);
    }
    let bridgeURL;
    try {
      bridgeURL = browser.runtime.getURL("history-bridge.js");
      if (!new URL(bridgeURL).protocol.endsWith("-extension:")) return Promise.resolve(false);
      if (document.documentElement?.dataset) delete document.documentElement.dataset.vigilHistoryBridge;
    } catch {
      return Promise.resolve(false);
    }
    return new Promise(resolve => {
      let settled = false;
      const finish = ready => {
        if (settled) return;
        settled = true;
        historyBridgeReady = ready;
        globalThis.removeEventListener?.(historyBridgeReadyEvent, onReady, true);
        globalThis.removeEventListener?.("error", onError, true);
        resolve(ready);
      };
      const onReady = () => finish(
        document.documentElement?.dataset?.vigilHistoryBridge === historyBridgeVersion
      );
      const onError = event => {
        if (event?.target?.src === bridgeURL) finish(false);
      };
      addEventListener(historyBridgeReadyEvent, onReady, true);
      addEventListener("error", onError, true);
      globalThis.setTimeout?.(() => finish(false), 1500);
      try {
        const escapedURL = bridgeURL.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
        document.write(`<script src="${escapedURL}" data-vigil-history-bridge-loader="1"></script>`);
      } catch {
        finish(false);
      }
    });
  };

  const checkCurrent = (escapeURL = blankEscapeURL) => {
    if (!rules) {
      if (!rulesSettled) return false;
      cover("Vigil could not load its filter rules.");
      return false;
    }
    if (!navigationEvents && !historyBridgeReady) {
      cover("Vigil could not secure this page's navigation.");
      return false;
    }
    const result = decision(location.href);
    if (!result.allowed) { cover(result.reason, escapeURL); return false; }
    const allowedURL = result.redirect || location.href;
    if (blockSurfaceActive) { restoreAllowedPage(allowedURL); return false; }
    if (result.redirect && result.redirect !== location.href) { location.replace(result.redirect); return false; }
    lastKnownAllowedURL = location.href;
    return true;
  };
  concealPendingPage();
  armBlockGuard();
  const preflight = decision(location.href, bootstrapRules);
  if (!preflight.allowed) {
    preflightHandled = true;
    cover(preflight.reason);
  } else if (preflight.redirect && preflight.redirect !== location.href) {
    preflightHandled = true;
    location.replace(preflight.redirect);
  }
  const historyBridgeRequest = preflight.allowed ? installHistoryBridge() : Promise.resolve(true);
  const rulesRequest = Promise.race([
    browser.runtime.sendNativeMessage(nativeApplication, { type: "rules", hostname: location.hostname }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("native-timeout")), 1500))
  ])
    .then(value => { if (value && value.schemaVersion === rulesSchemaVersion) rules = value; })
    .catch(() => browser.storage.local.get(rulesCacheKey).then(value => {
      const cached = value[rulesCacheKey];
      if (cached && cached.schemaVersion === rulesSchemaVersion) rules = cached;
    }));
  Promise.allSettled([rulesRequest, historyBridgeRequest])
    .finally(() => {
      rulesSettled = true;
      if (!blockSurfaceActive) {
        blockGuard?.disconnect?.();
        blockGuard = null;
      }
      if (rules) browser.storage.local.set({ [rulesCacheKey]: rules });
      if (preflightHandled) {
        if (!blockSurfaceActive && !navigationEvents && !historyBridgeReady) {
          cover("Vigil could not secure this page's navigation.");
        }
        return;
      }
      if (checkCurrent()) document.documentElement?.style?.removeProperty?.("display");
    });

  const checkLocationChange = () => {
    if (location.href === observedLocation) return;
    const escapeURL = lastKnownAllowedURL;
    observedLocation = location.href;
    if (!rulesSettled) return;
    checkCurrent(escapeURL);
  };
  addEventListener("popstate", checkLocationChange, true);
  addEventListener("hashchange", checkLocationChange, true);

  const inspectNavigation = (destination, cancel = () => {}) => {
    let canonical;
    try { canonical = new URL(destination, location.href).href; }
    catch { canonical = String(destination || ""); }
    if (restoringURL && canonical === restoringURL) return true;
    const result = decision(canonical);
    if (!result.allowed) {
      cancel();
      cover(result.reason, currentAllowedEscapeURL());
      return false;
    }
    const allowedDestination = result.redirect || canonical;
    if (blockSurfaceActive) {
      cancel();
      restoreAllowedPage(allowedDestination);
      return false;
    }
    if (result.redirect && result.redirect !== canonical) {
      cancel();
      location.assign(result.redirect);
      return false;
    }
    return true;
  };

  if (navigationEvents?.addEventListener) {
    navigationEvents.addEventListener("navigate", event => {
      const destination = event?.destination?.url;
      if (!destination) return;
      if (!rulesSettled || !rules) {
        if (event.cancelable) event.preventDefault();
        return;
      }
      inspectNavigation(destination, () => { if (event.cancelable) event.preventDefault(); });
    });
  } else {
    addEventListener(historyBridgeNavigationEvent, event => {
      const destination = String(event?.detail || "");
      if (!rulesSettled || !rules || !destination) {
        event.preventDefault();
        return;
      }
      inspectNavigation(destination, () => event.preventDefault());
    }, true);
    const frameGuard = () => {
      checkLocationChange();
      globalThis.requestAnimationFrame?.(frameGuard);
    };
    globalThis.requestAnimationFrame?.(frameGuard);
    globalThis.setInterval?.(checkLocationChange, 500);
  }

  addEventListener("click", event => {
    const anchor = event.target.closest?.("a[href]");
    if (!anchor) return;
    if (!rulesSettled || !rules) { event.preventDefault(); event.stopImmediatePropagation(); return; }
    const result = decision(anchor.href);
    if (!result.allowed) { event.preventDefault(); event.stopImmediatePropagation(); cover(result.reason, currentAllowedEscapeURL()); }
    else if (result.redirect && result.redirect !== anchor.href) { event.preventDefault(); location.assign(result.redirect); }
  }, true);
  addEventListener("submit", event => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (!rulesSettled || !rules) { event.preventDefault(); event.stopImmediatePropagation(); return; }
    const submitter = event.submitter;
    const target = new URL(submitter?.formAction || form.action || location.href, location.href);
    const method = (submitter?.formMethod || form.method || "get").toLowerCase();
    const fields = submitter ? new FormData(form, submitter) : new FormData(form);
    const formDescriptor = [form.getAttribute("role"), form.getAttribute("aria-label"), form.id, form.className, form.action]
      .filter(value => typeof value === "string").join(" ");
    const formIsSearch = searchDescriptorPattern.test(formDescriptor) || searchRoutePattern.test(form.action || "");
    const explicitFormSearch = [...fields].some(([name, value]) => (
      (formIsSearch || protectedSearchKeys.has(name.toLowerCase()))
      && blockedSearchText(typeof value === "string" ? value : value.name)
    )) || Array.from(form.elements || []).some(control => (
      isSearchControl(control) && blockedSearchText(searchControlValue(control))
    ));
    if (explicitFormSearch) {
      event.preventDefault(); event.stopImmediatePropagation();
      cover("Search blocked by Vigil", currentAllowedEscapeURL());
      return;
    }
    if (method === "get") {
      target.search = "";
      for (const [name, value] of fields) target.searchParams.append(name, typeof value === "string" ? value : value.name);
    }
    const result = decision(target.href);
    if (!result.allowed) { event.preventDefault(); event.stopImmediatePropagation(); cover(result.reason, currentAllowedEscapeURL()); }
    else if (result.redirect) { event.preventDefault(); location.assign(result.redirect); }
  }, true);

  const eventTargetElement = event => {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    return path.find(item => item instanceof Element)
      || (event.target instanceof Element ? event.target : null);
  };
  const isSearchControl = value => {
    if (!(value instanceof Element)) return false;
    const tag = String(value.tagName || "").toLowerCase();
    if (!value.isContentEditable && tag !== "input" && tag !== "textarea") return false;
    const descriptor = [
      value.getAttribute("name"), value.getAttribute("id"), value.getAttribute("aria-label"),
      value.getAttribute("placeholder"), value.getAttribute("data-testid")
    ].filter(Boolean).join(" ");
    return (value.getAttribute("type") || "").toLowerCase() === "search"
      || (value.getAttribute("role") || "").toLowerCase() === "searchbox"
      || protectedSearchKeys.has((value.getAttribute("name") || "").toLowerCase())
      || searchDescriptorPattern.test(descriptor)
      || Boolean(value.closest("[role='search'], form[action*='search' i], form[action*='find' i]"));
  };
  const searchControlValue = value => typeof value?.value === "string"
    ? value.value : String(value?.textContent || "");
  const guardSearchControl = event => {
    if (event.type === "keydown" && event.key !== "Enter") return;
    const control = eventTargetElement(event);
    if (!isSearchControl(control) || !blockedSearchText(searchControlValue(control))) return;
    if (event.cancelable) event.preventDefault();
    event.stopImmediatePropagation();
    cover("Search blocked by Vigil", currentAllowedEscapeURL());
  };
  addEventListener("input", guardSearchControl, true);
  addEventListener("change", guardSearchControl, true);
  addEventListener("keydown", guardSearchControl, true);
})();
