import assert from "node:assert/strict";
import { defaultState } from "../src/defaults.js";
import { evaluateExtensionCheck } from "../src/extensionPolicy.js";
import { Monitor } from "../src/monitor.js";
import { matchBlockedUrlPattern, profileById } from "../src/policy.js";

const state = defaultState();
const profile = profileById(state, "normal");
assert.ok(profile.blockedUrlPatterns.includes("nsfw"));
const monitor = new Monitor({ state, usage: {}, externalEffectsEnabled: false });
for (const host of ["www.reddit.com", "old.reddit.com", "reddit.com"]) {
  for (const path of ["/search", "/search/", "/r/cars/search.json"]) {
    for (const query of ["cars", "hi"]) {
      const url = `https://${host}${path}?q=${query}&include_over_18=off&nsfw=0`;
      assert.equal(matchBlockedUrlPattern(profile, url), null, url);
      assert.equal(monitor.browserBlockDecision({ app: "Safari", hostname: host, url }), null, url);
      assert.equal(evaluateExtensionCheck(structuredClone(state), {}, { url }).blocked, false, url);
    }
  }
}
for (const suffix of ["nsfw=0&nsfw=0", "n%73fw=0", "nsfw=%30"]) {
  assert.equal(matchBlockedUrlPattern(profile, `https://www.reddit.com/search?q=cars&${suffix}`), null);
}
for (const url of [
  "https://www.reddit.com/search?q=nsfw&nsfw=0",
  "https://www.reddit.com/search?q=cars&q=nsfw&nsfw=0",
  "https://www.reddit.com/search?q=%256e%2573%2566%2577&nsfw=0",
  "https://www.reddit.com/search?q=porn&nsfw=0",
  "https://www.reddit.com/search?q=cars&nsfw=1",
  "https://www.reddit.com/search?q=cars&nsfw=0&nsfw=1",
  "https://www.reddit.com/search?q=cars&nsfw=1&nsfw=0",
  "https://www.reddit.com/search?q=cars&nsfw=0#nsfw",
  "https://www.reddit.com/r/nsfw/search?q=cars&nsfw=0",
  "https://www.reddit.com/r/nsfw/?nsfw=0",
  "https://www.reddit.com/search?q=cars&other=nsfw&nsfw=0",
  "https://reddit.com.example.org/search?q=cars&nsfw=0"
]) {
  assert.ok(matchBlockedUrlPattern(profile, url), url);
  assert.ok(monitor.browserBlockDecision({ app: "Safari", hostname: new URL(url).hostname, url }), url);
  assert.equal(evaluateExtensionCheck(structuredClone(state), {}, { url }).blocked, true, url);
}
assert.ok(matchBlockedUrlPattern({ ...profile, blockedUrlPatterns: ["nsfw=0"] },
  "https://www.reddit.com/search?q=cars&nsfw=0"), "explicit custom URL rules must retain their meaning");
