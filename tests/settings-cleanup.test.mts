import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultState } from "../src/defaults.js";
import { legacyState } from "./fixtures/legacy-settings.mjs";
import { retiredFeaturePath } from "../src/retiredFeatures.js";
import { activeAppLockPolicy } from "../src/appLocks.js";
import { activeLimitPolicy } from "../src/limits.js";
import { dateKey } from "../src/time.js";
import { youtubeAction } from "../src/youtubeLimits.js";
import type { UnknownRecord, UsageState, VigilState } from "../src/types.js";

const directory = await mkdtemp(join(tmpdir(), "vigil-settings-cleanup-"));
process.env.VIGIL_DATA_DIR = directory;
const store = await import("../src/store.js");
const { policyForSample } = await import("../src/monitor/policy.js");
const { updateSettings } = await import("../src/server/settingsRoutes.js");
const { previewManualSession } = await import("../src/server/sessionRoutes.js");

const fresh = defaultState();
assert.deepEqual(fresh.limitRules, []);
assert.deepEqual(fresh.appLocks, []);
assert.deepEqual(fresh.intentionalUse.behaviors, []);
assert.equal(fresh.settings.intentionalUseEnabled, false);
assert.equal(fresh.settings.protectedBrowsersOnly, true);
assert.ok(policyForSample(fresh, {}, { app: "Firefox", url: "", hostname: "" }));
assert.equal(Object.keys(fresh.settings).some(key => key.startsWith("focusSound")), false);
for (const key of ["focusSoundVolume", "hostsBlockingEnabled", "intentionalUseEnabled", "focusShortcutEnabled"]) {
  assert.throws(() => updateSettings(fresh.settings, { [key]: true }), (error: unknown) => (error as { status: number }).status === 410);
}
assert.throws(() => updateSettings(fresh.settings, { protectedBrowsersOnly: false }), /cannot be disabled/);
updateSettings(fresh.settings, { appQuitEnabled: false, protectedEditsEnabled: false, systemNetworkBlockingEnabled: false });
assert.equal(fresh.settings.appQuitEnabled, true);
assert.equal(fresh.settings.protectedEditsEnabled, true);
assert.equal(fresh.settings.systemNetworkBlockingEnabled, true);
assert.equal(fresh.settings.protectedBrowsersOnly, true);
assert.throws(() => updateSettings(fresh.settings, { baselineProfileId: "soft-block" }), (error: unknown) => (error as { status: number }).status === 410);
for (const body of [{ cycleEnabled: true }, { cycle: {} }, { mode: "soft-block" }, { profileId: "soft-block" }]) {
  assert.throws(() => previewManualSession(fresh, body), (error: unknown) => (error as { status: number }).status === 410);
}

try {
  const firstLaunch = await store.loadState();
  assert.equal(firstLaunch.settings.protectedBrowsersOnly, true, "fresh persistence must enable required browser protection");
  assert.ok(policyForSample(firstLaunch, {}, { app: "Firefox", url: "", hostname: "" }));
  const legacy = legacyState();
  delete legacy.settingsCleanupVersion;
  legacy.settings.protectedBrowsersOnly = false;
  (legacy.settings as unknown as UnknownRecord).focusSoundVolume = 80;
  legacy.intentionalUse.journalEntries = [{ id: "saved-note", title: "Saved", body: "private note preserved in ciphertext", mood: "", energy: null, tags: [], behaviorIds: [], ruleIds: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), entryDate: new Date().toISOString() }];
  legacy.appLocks = [{ id: "permanent-webtoonguide-com", name: "Permanent site block", enabled: true, lockLevel: "deep", days: [0,1,2,3,4,5,6], apps: [], sites: ["webtoonguide.com"], unlocksAllowed: 0, unlockMinutes: 1, delaySeconds: 30 }, { id: "permanent-chrome-safari-parity", name: "Permanent Chrome block", enabled: true, lockLevel: "deep", days: [0,1,2,3,4,5,6], apps: ["Google Chrome"], sites: [], unlocksAllowed: 0, unlockMinutes: 1, delaySeconds: 0 }];
  const customLimit = { ...structuredClone(legacy.limitRules[0]!), id: "custom-time-limit", name: "Custom time limit", apps: ["Custom limited app"], sites: [], limitMinutes: 1, blockMinutes: 0 };
  const customizedTemplate = { ...structuredClone(legacy.limitRules[0]!), apps: ["Customized template app"], sites: [], limitMinutes: 1 };
  legacy.limitRules.push(customLimit, customizedTemplate);
  const customLock = { id: "custom-app-lock", name: "Custom app lock", enabled: true, lockLevel: "deep" as const, days: [0,1,2,3,4,5,6], apps: ["Custom locked app"], sites: [], unlocksAllowed: 2, unlockMinutes: 10, delaySeconds: 30 };
  const unusedTemplateLock = { ...structuredClone(customLock), id: "social-app-lock-template", name: "Locked socials", enabled: false, apps: [], sites: ["youtube.com", "x.com", "twitter.com", "instagram.com", "tiktok.com", "facebook.com", "threads.net", "snapchat.com", "pinterest.com", "discord.com"] };
  legacy.appLocks.push(customLock, { ...customLock, id: "disabled-custom-lock", enabled: false }, unusedTemplateLock, { ...unusedTemplateLock, enabled: true });
  const now = new Date();
  const usage: UsageState = { [dateKey(now)]: { totalSeconds: 120, apps: { "Custom limited app": 60, "Customized template app": 60 }, sites: {}, opens: { apps: {}, sites: {} }, devices: {} } };
  const verifyCustomRestrictions = (state: VigilState): void => {
    const snapshot = structuredClone(state);
    assert.equal(activeLimitPolicy(snapshot, usage, { app: "Custom limited app" }, now)?.limitBlock?.ruleId, customLimit.id);
    assert.equal(activeLimitPolicy(snapshot, usage, { app: "Customized template app" }, now)?.limitBlock?.ruleId, customizedTemplate.id);
    assert.equal(activeAppLockPolicy(snapshot, { app: "Custom locked app" }, now)?.appLock?.id, customLock.id);
  };
  verifyCustomRestrictions(legacy);
  legacy.limitBlocks = [{ id: "already-running", ruleId: "instagram-20-20-template", ruleName: "Existing block", type: "time", lockLevel: "deep", apps: ["Instagram"], sites: ["instagram.com"], createdAt: new Date().toISOString(), until: new Date(Date.now() + 60_000).toISOString() }];
  youtubeAction(legacy, { action: "save", videoId: "abcdefghijk", title: "Saved video" });
  legacy.youtubeLimits!.usedMs = 25_000;
  legacy.youtubeLimits!.slots[0]!.locked = true;
  const youtubeBefore = structuredClone(legacy.youtubeLimits);
  const retainedLocks = structuredClone(legacy.appLocks.filter(lock => lock !== unusedTemplateLock));
  const retainedLimits = structuredClone([customLimit, customizedTemplate]);
  const blockBefore = structuredClone(legacy.limitBlocks);
  await store.saveState(legacy);
  const original = await readFile(store.STATE_PATH, "utf8");
  assert.equal(original.includes("private note preserved in ciphertext"), false);
  const migrated = await store.loadState();
  assert.equal(migrated.settingsCleanupVersion, 1);
  assert.equal(migrated.settings.protectedBrowsersOnly, true);
  assert.deepEqual(migrated.limitRules, retainedLimits);
  assert.deepEqual(migrated.appLocks, retainedLocks);
  verifyCustomRestrictions(migrated);
  assert.deepEqual(migrated.limitBlocks, blockBefore);
  assert.deepEqual(migrated.youtubeLimits, youtubeBefore);
  assert.deepEqual(migrated.intentionalUse.journalEntries, []);
  assert.equal(migrated.integrity.stateSeal.tamperDetectedAt, null);
  const archives = await readdir(join(directory, "retired-features"));
  assert.equal(archives.length, 1);
  assert.equal(await readFile(join(directory, "retired-features", archives[0]), "utf8"), original);
  assert.equal((await stat(join(directory, "retired-features"))).mode & 0o777, 0o700);
  assert.equal((await stat(join(directory, "retired-features", archives[0]))).mode & 0o777, 0o600);
  await store.saveState(migrated);
  const reopened = await store.loadState();
  assert.deepEqual(reopened.limitRules, retainedLimits, "loading must retain custom limits without recreating retired templates");
  assert.deepEqual(reopened.appLocks, retainedLocks);
  verifyCustomRestrictions(reopened);
  assert.equal((await readdir(join(directory, "retired-features"))).length, 1);
  const { startVigilRuntime } = await import("../src/server.js");
  const runtime = await startVigilRuntime({ port: 0, systemEffects: "isolated" });
  try {
    for (const path of ["/api/limit", "/api/app-lock", "/api/profile", "/api/intentional-use/journal", "/api/grayscale/schedule", "/api/devices/ios/app-removal", "/api/devices/ios/mdm/settings", "/api/extension/pause/continue", "/mdm/checkin"]) {
      assert.equal(retiredFeaturePath(path), true);
      const response = await runtime.request({ method: "POST", path, body: "{}" });
      assert.equal(response.status, 410, path);
    }
    const response = await runtime.request({ path: "/api/state" });
    const payload = JSON.parse(Buffer.from(response.body).toString("utf8")) as UnknownRecord;
    assert.equal(Object.hasOwn(payload, "report"), false);
    assert.equal(Object.hasOwn(payload, "intentionalUse"), false);
  } finally { await runtime.stop(); }
} finally { await rm(directory, { recursive: true, force: true }); }
