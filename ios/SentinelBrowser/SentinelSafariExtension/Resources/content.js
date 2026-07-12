(() => {
  "use strict";
  const nativeApplication = "tech.caseline.sentinel.browser";
  const rulesCacheKey = `lastKnownRules:${location.hostname.toLowerCase()}`;
  let rules = null;

  const hostMatches = (host, blocked) => host === blocked || host.endsWith(`.${blocked}`);
  const searchText = (url) => ["q", "query", "search_query", "text"].map(key => url.searchParams.get(key) || "").join(" ").toLowerCase();
  const decision = raw => {
    if (!rules) return { allowed: false, reason: "Sentinel filter rules are unavailable" };
    if (rules.filterUnavailable) return { allowed: false, reason: "Sentinel's content filter failed its integrity check" };
    let url;
    try { url = new URL(raw, location.href); } catch { return { allowed: false, reason: "Invalid address" }; }
    if (url.protocol !== "https:") return { allowed: false, reason: "Sentinel requires HTTPS" };
    const host = url.hostname.toLowerCase();
    if (rules.blockedDomain && hostMatches(host, String(rules.blockedDomain).toLowerCase())) return { allowed: false, reason: "Website blocked by Sentinel" };
    if ((rules.blockedHosts || []).some(value => hostMatches(host, String(value).toLowerCase()))) return { allowed: false, reason: "Website blocked by Sentinel" };
    const absolute = url.href.toLowerCase();
    if ((rules.blockedURLFragments || []).some(value => absolute.includes(String(value).toLowerCase()))) return { allowed: false, reason: "Page blocked by Sentinel" };
    const terms = searchText(url);
    if ((rules.blockedSearchTerms || []).some(value => terms.includes(String(value).toLowerCase()))) return { allowed: false, reason: "Search blocked by Sentinel" };
    if (rules.safeSearchEnabled) {
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
    if (!rules) { cover("Sentinel could not load its filter rules."); return; }
    const result = decision(location.href);
    if (!result.allowed) cover(result.reason);
    else if (result.redirect && result.redirect !== location.href) location.replace(result.redirect);
  };
  document.documentElement.style.setProperty("visibility", "hidden", "important");
  Promise.race([
    browser.runtime.sendNativeMessage(nativeApplication, { type: "rules", hostname: location.hostname }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("native-timeout")), 1500))
  ])
    .then(value => { if (value && value.schemaVersion === 1) rules = value; })
    .catch(() => browser.storage.local.get(rulesCacheKey).then(value => { if (value[rulesCacheKey]) rules = value[rulesCacheKey]; }))
    .finally(() => {
      if (rules) browser.storage.local.set({ [rulesCacheKey]: rules });
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
    const result = decision(new URL(form.action || location.href, location.href).href);
    if (!result.allowed) { event.preventDefault(); event.stopImmediatePropagation(); cover(result.reason); }
    else if (result.redirect) { event.preventDefault(); location.assign(result.redirect); }
  }, true);
})();
