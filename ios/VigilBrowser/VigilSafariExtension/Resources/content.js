(() => {
  "use strict";
// BEGIN GENERATED BLOCK DIAGNOSTICS
const BLOCK_REFERENCE_KINDS = {
    "adult-blocklist": "ADULT", allowlist: "ALLOW", "app-lock": "APP",
    baseline: "BASE", "browser-control": "BROWSER", "browser-protection": "CONNECTION",
    "content-filter": "FILTER", "explicit-content": "CONTENT", integrity: "INTEGRITY",
    limit: "LIMIT", "url-pattern": "URL", focus: "FOCUS", lock: "LOCK",
    "search-break": "BREAK", https: "HTTPS", "filter-unavailable": "UNAVAILABLE"
};
// A readable screenshot reference, never an authorization token. Full context
// remains in the page's diagnostic metadata rather than its visible message.
function blockPageDiagnostic(input) {
    const source = input.source.toUpperCase().replace(/[^A-Z0-9]/gu, "").slice(0, 12) || "UNKNOWN";
    const kind = input.kind.toLowerCase().trim().slice(0, 80) || "rule";
    const diagnostic = {
        schema: 1,
        source,
        kind,
        target: String(input.target || "").slice(0, 2048),
        policyId: String(input.policyId || "").slice(0, 240),
        until: String(input.until || "").slice(0, 80),
        detail: String(input.detail || "").slice(0, 2048)
    };
    const identity = JSON.stringify([source, kind, diagnostic.target, diagnostic.policyId, diagnostic.until]);
    let hash = 0x811c9dc5;
    for (let index = 0; index < identity.length; index++) {
        hash = Math.imul(hash ^ identity.charCodeAt(index), 0x01000193) >>> 0;
    }
    return {
        ...diagnostic,
        reference: `V1-${source}-${BLOCK_REFERENCE_KINDS[kind] || "RULE"}-${hash.toString(16).padStart(8, "0").toUpperCase()}`
    };
}
// END GENERATED BLOCK DIAGNOSTICS
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
      "porn", "porno", "prno", "p0rn", "xxx", "nsfw", "hentai", "rule34", "gonewild",
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
  const personExposureMarkers = new Set([
    "leak", "leaks", "leaked", "leakd", "lek", "leks",
    "nud", "nuds", "nude", "nudes", "nued", "naked", "topless"
  ]);
  const personIntimateContext = new Set([
    "explicit", "fansly", "intimate", "nsfw", "nude", "nudes", "naked",
    "onlyfans", "porn", "porno", "sex", "sextape", "topless", "xxx"
  ]);
  const personLeakContext = new Set([
    "air", "api", "app", "apps", "classified", "code", "command", "court",
    "data", "database", "document", "documents", "email", "emails", "episode",
    "episodes", "fc", "film", "films", "game", "games", "gas", "government",
    "guide", "iphone", "javascript", "memory", "movie", "movies", "news", "oil",
    "papers", "password", "passwords", "phone", "pipeline", "pixel", "product",
    "products", "release", "releases", "report", "reports", "roof", "roster",
    "rumor", "rumors", "samsung", "security", "software", "source", "sources",
    "spec", "specs", "team", "transfer", "transfers", "tutorial", "tv", "water"
  ]);
  const personNudeContext = new Set([
    "anatomy", "animal", "animals", "art", "arts", "artwork", "artworks", "beach", "beaches",
    "beige", "color", "colors", "colour", "colours", "drawing", "drawings", "fabric", "fashion",
    "figure", "figures", "lipstick", "makeup", "medical", "mice", "model", "models", "mole",
    "mouse", "museum", "museums", "painting", "paintings", "palette", "photography", "rat", "rats",
    "reference", "references", "sculpture", "sculptures", "shade", "shades", "statue", "statues",
    "studies", "study"
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
    const marker = tokens[markerIndex];
    const ordinaryContext = ["leak", "leaks", "leaked", "leakd", "lek", "leks"].includes(marker)
      ? personLeakContext
      : personNudeContext;
    if (tokens.some((token, index) => index !== markerIndex && personIntimateContext.has(token))) return true;
    if (tokens.some(token => ordinaryContext.has(token))) return false;
    const structuralName = tokens.filter((token, index) => (
      index !== markerIndex && !personNameFillerWords.has(token)
    ));
    return structuralName.length >= 2 && structuralName.length <= 4
      && structuralName.every(token => token.length >= 2);
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
    const diagnostic = blockPageDiagnostic({
      source: "IOS", kind: /HTTPS/u.test(reason) ? "https"
        : /unavailable|integrity/u.test(reason) ? "filter-unavailable"
        : /Search/u.test(reason) ? "explicit-content" : "content-filter",
      target: location.href, detail: reason
    });
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
/* BEGIN GENERATED PROTECTION APPEARANCE */

/* Vigil's protection palette matches the main app's dark appearance. */
:root, :host {
  color-scheme: dark;
  --paper: #181a1c;
  --paper-2: #141618;
  --surface: #202225;
  --surface-strong: #292b2e;
  --ink: #e7e8ea;
  --muted: #9c9fa5;
  --line: #303236;
  --line-strong: #484b51;
  --primary: #365b41;
  --primary-strong: #2c4d35;
  --accent: #8db39a;
  --accent-soft: rgba(141, 179, 154, .12);
  --focus: rgba(141, 179, 154, .28);
  --font-body: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
  --font-display: var(--font-body);
  -webkit-text-size-adjust: 100%;
  background: var(--paper);
  color: var(--ink);
  font-family: var(--font-body);
}

* { box-sizing: border-box; }
[hidden] { display: none !important; }
body {
  margin: 0;
  min-height: 100vh;
  min-height: 100svh;
  display: grid;
  place-items: center;
  padding: max(40px, env(safe-area-inset-top)) max(24px, env(safe-area-inset-right)) max(40px, env(safe-area-inset-bottom)) max(24px, env(safe-area-inset-left));
  background:
    radial-gradient(circle at 78% -8%, rgba(141, 179, 154, .06), transparent 34rem),
    linear-gradient(180deg, var(--paper), var(--paper-2));
}
main { width: min(560px, 100%); }
.brand-lockup { display: flex; align-items: center; gap: 12px; margin-bottom: 36px; }
.brand-mark { display: block; width: 44px; height: 44px; flex: 0 0 auto; background: url("icons/icon-128.png") center / contain no-repeat; }
.eyebrow { margin: 0; color: var(--accent); font-size: .72rem; font-weight: 750; letter-spacing: .13em; text-transform: uppercase; }
h1 {
  max-width: 16ch;
  margin: 0;
  font-family: var(--font-display);
  font-size: clamp(2.5rem, 5vw, 3.75rem);
  font-weight: 500;
  line-height: 1.12;
  letter-spacing: -.025em;
  overflow-wrap: anywhere;
  text-wrap: balance;
}
.message, .reason {
  max-width: 46ch;
  margin: 22px 0 0;
  color: var(--muted);
  font-size: 1rem;
  line-height: 1.65;
  overflow-wrap: anywhere;
}
.escape-actions { margin-top: 32px; padding-top: 24px; border-top: 1px solid var(--line); }
.escape-actions a, .escape-actions button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 24px;
  min-height: 48px;
  padding: 12px 20px;
  border: 1px solid transparent;
  border-radius: 9px;
  background: var(--primary);
  color: #ffffff;
  font-family: var(--font-body);
  cursor: pointer;
  font-size: .94rem;
  font-weight: 700;
  line-height: 1.4;
  text-decoration: none;
  transition: background .15s ease, transform .15s ease;
}
.escape-actions a:hover, .escape-actions button:hover { background: var(--primary-strong); }
.escape-actions a:active, .escape-actions button:active { transform: translateY(1px); }
.escape-actions a:focus-visible, .escape-actions button:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; }
strong { color: var(--ink); }
@media (max-width: 520px) {
  .brand-lockup { margin-bottom: 28px; }
  .escape-actions a, .escape-actions button { width: 100%; justify-content: space-between; }
}
@media (prefers-reduced-motion: reduce) {
  .escape-actions a, .escape-actions button { transition: none; }
}

/* Quiet rejection pages. The diagnostic reference stays readable in screenshots. */
body[data-vigil-block-page="1"] {
  background: var(--paper);
  text-align: center;
}
body[data-vigil-block-page="1"] main { width: min(400px, 100%); }
body[data-vigil-block-page="1"] h1 {
  max-width: none;
  color: #c1c4c8;
  font-size: clamp(1.5rem, 3vw, 2rem);
  font-weight: 400;
  line-height: 1.25;
  letter-spacing: -.025em;
}
body[data-vigil-block-page="1"] .escape-actions { margin-top: 8px; padding: 0; border: 0; }
body[data-vigil-block-page="1"] .escape-actions :is(a, button) {
  min-width: 44px;
  min-height: 44px;
  width: auto;
  padding: 8px 12px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--accent);
  font-size: .75rem;
  font-weight: 400;
  line-height: 1.4;
  justify-content: center;
}
body[data-vigil-block-page="1"] .escape-actions :is(a, button):hover { background: transparent; text-decoration: underline; }
body[data-vigil-block-page="1"] .message { margin: 16px auto 0; font-size: .75rem; line-height: 1.5; }
.block-reference {
  position: fixed;
  right: max(16px, env(safe-area-inset-right));
  bottom: max(12px, env(safe-area-inset-bottom));
  max-width: calc(100vw - 32px);
  margin: 0;
  color: #737980;
  font: 10px/1.4 "SFMono-Regular", Menlo, monospace;
  letter-spacing: .02em;
  overflow-wrap: anywhere;
  text-align: right;
}

.brand-mark { background-image: url("data:image/png;base64,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"); }
/* END GENERATED PROTECTION APPEARANCE */
      `;
      const body = document.createElement("body");
      body.dataset.vigilBlockPage = "1";
      const main = document.createElement("main");
      const title = document.createElement("h1"); title.textContent = "Blocked";
      const detail = document.createElement("p"); detail.className = "reason"; detail.textContent = reason; detail.hidden = true;
      const reference = document.createElement("p"); reference.id = "vigilBlockDiagnostic"; reference.className = "block-reference"; reference.textContent = diagnostic.reference; reference.title = reason;
      const details = document.createElement("script"); details.id = "vigilBlockDetails"; details.type = "application/json"; details.textContent = JSON.stringify(diagnostic);
      const actions = document.createElement("div"); actions.className = "escape-actions";
      const back = document.createElement("button"); back.type = "button"; back.textContent = "Back";
      back.addEventListener("click", () => restoreAllowedPage(escapeTarget));
      actions.append(back); main.append(title, detail, actions); body.append(main, reference, details);
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
