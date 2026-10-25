import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { BROWSER_BYPASS_BLOCKED_SITES, PUBLIC_SEARXNG_BLOCKED_SITES } from "../src/browserBypassDomains.js";
import { browserPermanentDomainRules } from "../src/browserStaticProtection.js";
import { defaultState, DEFAULT_FILTER_BYPASS_BLOCKED_SITES } from "../src/defaults.js";
import { evaluateExtensionCheck } from "../src/extensionPolicy.js";
import { buildHostsBlock } from "../src/hardening.js";
import { buildIosConfigurationProfile, iosPolicyTargets } from "../src/iosProfiles.js";
import { parsePlist } from "../src/plist.js";
import { shouldBlockSite } from "../src/policy.js";
import { safariFilterDenyUrls } from "../src/safariFilter.js";
import { sanitizeDefaultFocusProfile } from "../src/store.js";
import { generatedIosSafariGuard } from "../scripts/generate-ios-safari-guard.mjs";
import { now, recordValue, usageFixture } from "./test-helpers.mjs";

const state = defaultState();
state.settings.adultBlocklistEnabled = false;
state.deviceControls.ios.enabled = true;
const hosts = buildHostsBlock(state, now);
const safari = new Set(safariFilterDenyUrls(state, now));
const phone = iosPolicyTargets(state, now);
const delivered = new Set([...phone.deniedUrls, ...phone.supplementalDeniedUrls]);
const staticRules = browserPermanentDomainRules();
const contexts = [];
for (const source of [await readFile(new URL("../extension/google-safe-search.js", import.meta.url), "utf8"), await generatedIosSafariGuard()]) {
  const redirects: string[] = [];
  const location = { href: "https://example.org/", replace: (url: string) => redirects.push(url) };
  let tick = () => {};
  runInNewContext(source, { URL, URLSearchParams, location,
    chrome: { runtime: { getURL: (path: string) => `chrome-extension://fixture/${path}` } },
    browser: { runtime: { getURL: (path: string) => `extension-test://${path}` } }, addEventListener() {},
    setInterval: (callback: () => void) => { tick = callback; } });
  contexts.push({ location, redirects, tick: () => tick() });
}
const legacy = sanitizeDefaultFocusProfile({ ...state.profiles[0], blockedSites: ["retained.example"] });
assert.ok(legacy.blockedSites.includes("retained.example"));
assert.ok(PUBLIC_SEARXNG_BLOCKED_SITES.length >= 80, "retain the complete audited public registry");
assert.equal(new Set(BROWSER_BYPASS_BLOCKED_SITES).size, BROWSER_BYPASS_BLOCKED_SITES.length);
for (const domain of BROWSER_BYPASS_BLOCKED_SITES) {
  assert.ok(legacy.blockedSites.includes(domain), `existing focus profiles migrate: ${domain}`);
  assert.ok(hosts.includes(`0.0.0.0 ${domain}\n`), `machine network deny: ${domain}`);
  for (const scheme of ["http", "https"]) {
    assert.ok(safari.has(`${scheme}://${domain}/`), `Safari profile: ${scheme} ${domain}`);
    assert.ok(delivered.has(`${scheme}://${domain}/`), `supervised payload: ${scheme} ${domain}`);
    for (const host of [domain, `nested.${domain}`, `${domain}.`]) {
      for (const profile of state.profiles) assert.ok(shouldBlockSite(profile, host), `${profile.id}: ${host}`);
      const url = `${scheme}://${host}/ordinary?opaque=abc&safe=off`;
      for (const event of ["navigation", "embedded"] as const) {
        assert.equal(evaluateExtensionCheck(state, usageFixture({}), { url, event }, now).blocked, true, `${event}: ${url}`);
      }
      for (const context of contexts) {
        context.redirects.length = 0;
        context.location.href = url;
        context.tick();
        assert.ok(context.redirects.length > 0, `offline Chrome/Safari: ${url}`);
      }
    }
  }
  for (const rule of staticRules) assert.ok(rule.condition.requestDomains?.includes(domain), `pre-request static rule ${rule.id}: ${domain}`);
}
for (const type of ["sub_frame", "image", "media", "xmlhttprequest", "websocket"] as const) {
  assert.ok(staticRules[1].condition.resourceTypes?.includes(type), `opaque relay resources: ${type}`);
}
// Enlarging the inventory must never evict an older curated destination or
// silently exceed Apple's per-payload budget when custom rules consume slots.
for (const count of [0, 30, 500]) {
  state.deviceControls.ios.deniedUrls = Array.from({ length: count }, (_, index) => `https://custom-${index}.example/`);
  const targets = iosPolicyTargets(state, now);
  assert.ok(targets.deniedUrls.length <= 500);
  const all = new Set([...targets.deniedUrls, ...targets.supplementalDeniedUrls]);
  for (const domain of DEFAULT_FILTER_BYPASS_BLOCKED_SITES) assert.ok(all.has(`https://${domain}/`), `existing deny retained: ${domain}`);
  const profile = recordValue(parsePlist(buildIosConfigurationProfile(state, now)));
  assert.equal(profile.PayloadRemovalDisallowed, true);
  assert.ok(Array.isArray(profile.PayloadContent));
  const filters = profile.PayloadContent.map(value => recordValue(value)).filter(value => value.PayloadType === "com.apple.webcontent-filter");
  const actual = filters.flatMap(filter => {
    assert.equal(filter.FilterType, "BuiltIn");
    assert.equal(filter.AutoFilterEnabled, true);
    assert.ok(Array.isArray(filter.DenyListURLs) && filter.DenyListURLs.length <= 500);
    return filter.DenyListURLs as string[];
  });
  assert.equal(new Set(filters.map(filter => filter.PayloadUUID)).size, filters.length);
  assert.deepEqual([...new Set(actual)].sort(), [...all].sort(), "overflow must reach the actual signed-profile inputs without losing any deny");
  if (count === 500) assert.ok(filters.length > 2, "large policy must exercise additive overflow payloads");
}
for (const domain of ["google.com", "bing.com", "duckduckgo.com", "brave.com", "mail.yahoo.com", "suma-ev.de", "example.org",
  "startpage.com.example.org", "notstartpage.com", "search.rhscz.eu.example.org", "rhscz.eu"]) {
  assert.equal(shouldBlockSite(state.profiles.find(profile => profile.id === "normal")!, domain), false, `exact service boundary: ${domain}`);
}
console.log(`Browser bypass coverage passed: ${BROWSER_BYPASS_BLOCKED_SITES.length} services, top-level/embedded/offline guards, both schemes, migration and preserved supervised policy.`);
