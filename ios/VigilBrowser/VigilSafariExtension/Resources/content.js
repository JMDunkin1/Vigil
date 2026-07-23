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
  const protectedSearchKeys = new Set(["q", "query", "search_query", "text"]);

  const hostMatches = (host, blocked) => {
    const normalizedBlocked = normalizedHost(blocked);
    return Boolean(normalizedBlocked && (host === normalizedBlocked || host.endsWith(`.${normalizedBlocked}`)));
  };
  const searchText = url => [...url.searchParams]
    .filter(([name]) => protectedSearchKeys.has(name.toLowerCase()))
    .flatMap(([, value]) => decodedCandidates(value))
    .join(" ");
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
    if ((activeRules.blockedSearchTerms || []).some(value => terms.includes(String(value).toLowerCase()))) return { allowed: false, reason: "Search blocked by Vigil" };
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
    if (method === "get") {
      target.search = "";
      const fields = submitter ? new FormData(form, submitter) : new FormData(form);
      for (const [name, value] of fields) target.searchParams.append(name, typeof value === "string" ? value : value.name);
    }
    const result = decision(target.href);
    if (!result.allowed) { event.preventDefault(); event.stopImmediatePropagation(); cover(result.reason, currentAllowedEscapeURL()); }
    else if (result.redirect) { event.preventDefault(); location.assign(result.redirect); }
  }, true);
})();
