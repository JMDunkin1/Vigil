import assert from "node:assert/strict";
import { IOS_UNGUARDED_BROWSER_BUNDLE_IDS, defaultState } from "../src/defaults.js";
import { buildIosConfigurationProfile, normalizeIosSettings } from "../src/iosProfiles.js";
import { parsePlist } from "../src/plist.js";
import { recordValue } from "./test-helpers.mjs";

const safari = "com.apple.mobilesafari";
const companion = "tech.caseline.vigil.instagram";
const customBlock = "example.previously.blocked";
const settings = normalizeIosSettings({
  enabled: true,
  blockedAppBundleIds: [customBlock],
  allowedAppBundleIds: [safari, companion, ...IOS_UNGUARDED_BROWSER_BUNDLE_IDS.map(id => id.toUpperCase())]
});
assert.ok(settings.blockedAppBundleIds.includes(customBlock), "existing custom restrictions must survive migration");
for (const id of IOS_UNGUARDED_BROWSER_BUNDLE_IDS) {
  assert.ok(settings.blockedAppBundleIds.includes(id), `${id} must be blocked even when omitted from saved settings`);
  assert.ok(!settings.allowedAppBundleIds.some(value => value.toLowerCase() === id.toLowerCase()), `${id} cannot be restored through an allowlist`);
}
assert.deepEqual(settings.allowedAppBundleIds, [safari, companion].sort());
assert.ok(normalizeIosSettings({ blockedAppBundleIds: [] }, settings).blockedAppBundleIds.includes("com.google.chrome.ios"), "settings edits cannot clear the permanent browser block");

for (const mode of ["denylist", "allowlist"] as const) {
  const state = defaultState();
  state.deviceControls.ios = {
    ...state.deviceControls.ios,
    enabled: true,
    mode,
    blockedAppBundleIds: [customBlock],
    allowedAppBundleIds: [safari, companion, ...IOS_UNGUARDED_BROWSER_BUNDLE_IDS]
  };
  state.profiles[0]!.mode = mode === "allowlist" ? "allowlist" : "blocklist";
  state.activeSessions.phone = {
    id: `browser-guards-${mode}`, title: "Browser guard regression", profileId: state.profiles[0]!.id, mode: "timed",
    startedAt: "2026-10-01T12:00:00.000Z", endsAt: "2026-10-01T14:00:00.000Z",
    lockLevel: "deep", canEndEarly: false, commitmentLock: true, emergencyUnlocksAllowed: false, source: "manual"
  };
  const parsed = recordValue(parsePlist(buildIosConfigurationProfile(state, new Date("2026-10-01T13:00:00.000Z"))), "browser policy");
  assert.equal(parsed.PayloadRemovalDisallowed, true);
  const payloads = (parsed.PayloadContent as unknown[]).map(value => recordValue(value, "browser policy payload"));
  const restrictions = payloads.find(value => value.PayloadType === "com.apple.applicationaccess")!;
  const appList = (mode === "allowlist" ? restrictions.allowListedAppBundleIDs : restrictions.blockedAppBundleIDs) as string[];
  assert.ok(Array.isArray(appList));
  for (const id of IOS_UNGUARDED_BROWSER_BUNDLE_IDS) {
    assert.equal(appList.includes(id), mode === "denylist", `${mode} must make ${id} unavailable`);
  }
  assert.equal(appList.includes(safari), mode === "allowlist", "guarded Safari must remain available");
  assert.equal(appList.includes(companion), mode === "allowlist", "guarded Vigil companion must remain available");
  assert.ok(payloads.some(value => value.PayloadType === "com.apple.webcontent-filter" && value.FilterType === "BuiltIn" && value.AutoFilterEnabled === true), "blocking browsers must preserve supervised web filtering");
}

console.log("Unguarded iPhone browsers stay blocked across saved settings and both policy modes.");
