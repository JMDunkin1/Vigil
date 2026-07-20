(() => {
  "use strict";
  const nativeApplication = "tech.caseline.vigil.browser";
  const rulesSchemaVersion = 2;
  const rulesCacheKey = `lastKnownRules:${location.hostname.toLowerCase()}`;
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
  let preflightHandled = false;

  const hostMatches = (host, blocked) => host === blocked || host.endsWith(`.${blocked}`);
  const searchText = (url) => ["q", "query", "search_query", "text"].map(key => url.searchParams.get(key) || "").join(" ").toLowerCase();
  const decision = (raw, activeRules = rules) => {
    if (!activeRules) return { allowed: false, reason: "Vigil filter rules are unavailable" };
    if (activeRules.filterUnavailable) return { allowed: false, reason: "Vigil's content filter failed its integrity check" };
    let url;
    try { url = new URL(raw, location.href); } catch { return { allowed: false, reason: "Invalid address" }; }
    if (url.protocol !== "https:") return { allowed: false, reason: "Vigil requires HTTPS" };
    const host = url.hostname.toLowerCase();
    if (activeRules.blockedDomain && hostMatches(host, String(activeRules.blockedDomain).toLowerCase())) return { allowed: false, reason: "Website blocked by Vigil" };
    if ((activeRules.blockedHosts || []).some(value => hostMatches(host, String(value).toLowerCase()))) return { allowed: false, reason: "Website blocked by Vigil" };
    const absolute = url.href.toLowerCase();
    if ((activeRules.blockedURLFragments || []).some(value => absolute.includes(String(value).toLowerCase()))) return { allowed: false, reason: "Page blocked by Vigil" };
    const terms = searchText(url);
    if ((activeRules.blockedSearchTerms || []).some(value => terms.includes(String(value).toLowerCase()))) return { allowed: false, reason: "Search blocked by Vigil" };
    if (activeRules.safeSearchEnabled) {
      let key = null, value = null;
      if (host === "google.com" || host.endsWith(".google.com")) { key = "safe"; value = "active"; }
      else if (host === "bing.com" || host.endsWith(".bing.com")) { key = "adlt"; value = "strict"; }
      else if (host === "duckduckgo.com" || host.endsWith(".duckduckgo.com")) { key = "kp"; value = "1"; }
      if (key && url.searchParams.get(key) !== value) {
        url.searchParams.set(key, value);
        return { allowed: true, redirect: url.href };
      }
    }
    return { allowed: true, redirect: null };
  };

  const cover = reason => {
    document.documentElement.style.setProperty("display", "none", "important");
    const show = () => {
      document.documentElement.style.removeProperty("visibility");
      document.documentElement.style.removeProperty("display");
      document.documentElement.replaceChildren();
      const body = document.createElement("body");
      body.style.cssText = "margin:0;min-height:100vh;display:grid;place-items:center;background:#111;color:#fff;font:17px -apple-system;text-align:center";
      const main = document.createElement("main");
      const title = document.createElement("h1"); title.textContent = "Page blocked";
      const detail = document.createElement("p"); detail.textContent = reason;
      main.append(title, detail); body.append(main); document.documentElement.append(body);
      window.stop();
    };
    document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", show, { once: true }) : show();
  };

  const checkCurrent = () => {
    if (!rules) { cover("Vigil could not load its filter rules."); return; }
    const result = decision(location.href);
    if (!result.allowed) cover(result.reason);
    else if (result.redirect && result.redirect !== location.href) location.replace(result.redirect);
  };
  document.documentElement.style.setProperty("visibility", "hidden", "important");
  const preflight = decision(location.href, bootstrapRules);
  if (!preflight.allowed) {
    preflightHandled = true;
    cover(preflight.reason);
  } else if (preflight.redirect && preflight.redirect !== location.href) {
    preflightHandled = true;
    location.replace(preflight.redirect);
  }
  Promise.race([
    browser.runtime.sendNativeMessage(nativeApplication, { type: "rules", hostname: location.hostname }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("native-timeout")), 1500))
  ])
    .then(value => { if (value && value.schemaVersion === rulesSchemaVersion) rules = value; })
    .catch(() => browser.storage.local.get(rulesCacheKey).then(value => {
      const cached = value[rulesCacheKey];
      if (cached && cached.schemaVersion === rulesSchemaVersion) rules = cached;
    }))
    .finally(() => {
      if (rules) browser.storage.local.set({ [rulesCacheKey]: rules });
      if (preflightHandled) return;
      document.documentElement.style.removeProperty("visibility");
      checkCurrent();
    });

  addEventListener("click", event => {
    const anchor = event.target.closest?.("a[href]");
    if (!anchor) return;
    const result = decision(anchor.href);
    if (!result.allowed) { event.preventDefault(); event.stopImmediatePropagation(); cover(result.reason); }
    else if (result.redirect && result.redirect !== anchor.href) { event.preventDefault(); location.assign(result.redirect); }
  }, true);
  addEventListener("submit", event => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    const submitter = event.submitter;
    const target = new URL(submitter?.formAction || form.action || location.href, location.href);
    const method = (submitter?.formMethod || form.method || "get").toLowerCase();
    if (method === "get") {
      target.search = "";
      const fields = submitter ? new FormData(form, submitter) : new FormData(form);
      for (const [name, value] of fields) target.searchParams.append(name, typeof value === "string" ? value : value.name);
    }
    const result = decision(target.href);
    if (!result.allowed) { event.preventDefault(); event.stopImmediatePropagation(); cover(result.reason); }
    else if (result.redirect) { event.preventDefault(); location.assign(result.redirect); }
  }, true);
})();
