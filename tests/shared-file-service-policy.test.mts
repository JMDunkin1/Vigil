import assert from "node:assert/strict";
import { defaultState } from "../src/defaults.js";
import { browserPermanentBlockedDomains } from "../src/browserStaticProtection.js";
import { iosPolicyTargets, buildIosConfigurationProfile } from "../src/iosProfiles.js";
import { shouldBlockSite } from "../src/policy.js";

const state = defaultState();
state.deviceControls.ios.enabled = true;
const targets = iosPolicyTargets(state);
const denied = [...targets.deniedUrls, ...targets.supplementalDeniedUrls];
const profile = buildIosConfigurationProfile(state);
for (const domain of ["balbums.st", "bunkr-albums.io"]) {
  assert.ok(browserPermanentBlockedDomains().includes(domain), "browser static network protection: " + domain);
  assert.ok(state.profiles.every(profile => shouldBlockSite(profile, domain)), "every default profile denies the reviewed index: " + domain);
  assert.ok(denied.some(value => new URL(value).hostname === domain), "supervised iPhone filter denies the index: " + domain);
  assert.ok(profile.includes(`<string>https://${domain}</string>`) || profile.includes(`<string>https://${domain}/</string>`), "the generated profile carries the deny: " + domain);
}
assert.match(profile, /<key>PayloadRemovalDisallowed<\/key>\s*<true\/>/u);
assert.match(profile, /<string>BuiltIn<\/string>/u);
assert.ok(targets.deniedUrls.length <= 500, "the primary Apple deny-list budget is preserved");
console.log("Reviewed album indexes are denied in default policy, browser network rules, and the non-removable supervised phone profile.");
