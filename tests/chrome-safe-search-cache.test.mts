import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHROME_PREFERENCE_DOMAINS,
  CHROME_SAFE_SEARCH_PAYLOAD_ID,
  CHROME_SAFE_SEARCH_PAYLOAD_UUID,
  CHROME_SAFE_SEARCH_PROFILE_ID,
  CHROME_SAFE_SEARCH_PROFILE_INVENTORY_CACHE_MS,
  CHROME_SAFE_SEARCH_PROFILE_INVENTORY_MISSING_CACHE_MS,
  CHROME_SAFE_SEARCH_PROFILE_UUID,
  CHROME_SAFE_SEARCH_SIGNATURE,
  ChromeSafeSearchProfileInventoryCache,
  chromeManagedPreferencePath,
  chromeManagedPreferencePaths,
  chromeSafeSearchStatus,
  parseInstalledChromeSafeSearchProfileInventory
} from "../src/chromeSafeSearch.js";
import type { InstalledProfileResult } from "../src/chromeSafeSearch.js";

assert.ok(
  CHROME_SAFE_SEARCH_PROFILE_INVENTORY_CACHE_MS >= 5 * 60 * 1000,
  "installed profile inventory should be cached substantially longer than dashboard diagnostics"
);
assert.ok(
  CHROME_SAFE_SEARCH_PROFILE_INVENTORY_MISSING_CACHE_MS < CHROME_SAFE_SEARCH_PROFILE_INVENTORY_CACHE_MS,
  "a missing profile should be refreshed sooner while the user may be approving it"
);

const [statePayloadSource, monitorSource] = await Promise.all([
  readFile(new URL("../src/server/statePayload.js", import.meta.url), "utf8"),
  readFile(new URL("../src/monitor.js", import.meta.url), "utf8")
]);
const applyScriptSource = await readFile(new URL("../scripts/apply-chrome-safe-search.mjs", import.meta.url), "utf8");
assert.doesNotMatch(applyScriptSource, /\/usr\/bin\/open/u,
  "exporting the Chrome profile must never open macOS's removable manual-install flow");
assert.match(applyScriptSource, /Deploy this profile through device management/u);
assert.match(
  statePayloadSource,
  /collectStrictPreflightEvidence[\s\S]*?attestChromeSafeSearchStatus\(\)/u,
  "strict-lock evidence collection must bypass the routine Chrome profile inventory cache"
);
assert.doesNotMatch(
  statePayloadSource.match(/strictPreflightStatus[\s\S]*?function publicPolicy/u)?.[0] || "",
  /attestChromeSafeSearchStatus\(\)/u,
  "the serialized strict-lock state check must consume precollected evidence without fresh external measurement"
);
assert.match(
  monitorSource,
  /refreshHardeningDrift\(now\)[\s\S]*?attestChromeSafeSearchStatus\(\)/u,
  "protected-lock drift sampling must use a fresh Chrome profile attestation"
);

assert.equal(chromeManagedPreferencePath(), "/Library/Managed Preferences/com.google.Chrome.plist");
assert.equal(chromeManagedPreferencePath("alice"), "/Library/Managed Preferences/alice/com.google.Chrome.plist");
assert.deepEqual(chromeManagedPreferencePaths("com.google.Chrome.canary", "alice"), [
  "/Library/Managed Preferences/alice/com.google.Chrome.canary.plist",
  "/Library/Managed Preferences/com.google.Chrome.canary.plist"
]);

{
  const preferenceRoot = await mkdtemp(join(tmpdir(), "vigil-chrome-preference-fallback-"));
  const plist = (entry: string) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>${entry}</dict></plist>`;
  try {
    const managedPreferencePaths = Object.fromEntries(CHROME_PREFERENCE_DOMAINS.map((domain, index) => {
      const userPath = join(preferenceRoot, `${index}-user.plist`);
      const systemPath = join(preferenceRoot, `${index}-system.plist`);
      return [domain, [userPath, systemPath]];
    }));
    const stablePaths = managedPreferencePaths[CHROME_PREFERENCE_DOMAINS[0]]!;
    await writeFile(stablePaths[0]!, plist("<key>HomepageLocation</key><string>https://example.com</string>"));
    await writeFile(stablePaths[1]!, plist("<key>ForceGoogleSafeSearch</key><true/>"));
    for (const domain of CHROME_PREFERENCE_DOMAINS.slice(1)) {
      await writeFile(managedPreferencePaths[domain]![1]!, plist("<key>ForceGoogleSafeSearch</key><true/>"));
    }

    const options = {
      profilePath: join(preferenceRoot, "missing.mobileconfig"),
      managedPreferencePaths
    };
    const fallback = await chromeSafeSearchStatus(options);
    assert.equal(fallback.forced, true,
      "a per-user plist without the key must fall through to a forced machine-wide value");
    assert.equal(fallback.managedPreferencePaths[CHROME_PREFERENCE_DOMAINS[0]].path, stablePaths[1]);

    await writeFile(stablePaths[0]!, plist("<key>ForceGoogleSafeSearch</key><false/>"));
    const shadowed = await chromeSafeSearchStatus(options);
    assert.equal(shadowed.forced, false,
      "an explicit per-user false must shadow a forced machine-wide value");
    assert.equal(shadowed.managedPreferencePaths[CHROME_PREFERENCE_DOMAINS[0]].path, stablePaths[0]);

    await writeFile(stablePaths[0]!, plist("<key>ForceGoogleSafeSearch</key><true/>"));
    await writeFile(stablePaths[1]!, plist("<key>ForceGoogleSafeSearch</key><false/>"));
    const userForced = await chromeSafeSearchStatus(options);
    assert.equal(userForced.forced, true,
      "an explicit per-user true must shadow a machine-wide false");
    assert.equal(userForced.managedPreferencePaths[CHROME_PREFERENCE_DOMAINS[0]].path, stablePaths[0]);

    await writeFile(stablePaths[0]!, "not a property list");
    await writeFile(stablePaths[1]!, plist("<key>ForceGoogleSafeSearch</key><true/>"));
    const malformed = await chromeSafeSearchStatus(options);
    assert.equal(malformed.forced, false,
      "a malformed per-user plist must fail closed instead of accepting a lower-priority machine-wide value");
    assert.equal(malformed.managedPreferencePaths[CHROME_PREFERENCE_DOMAINS[0]].path, stablePaths[0]);
    assert.ok(malformed.unforcedDomains.includes(CHROME_PREFERENCE_DOMAINS[0]));
    assert.match(malformed.error || "", new RegExp(stablePaths[0]!.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));

    await rm(stablePaths[0]!);
    const missing = await chromeSafeSearchStatus(options);
    assert.equal(missing.forced, true,
      "a confirmed-missing per-user plist must still fall through to the machine-wide value");
    assert.equal(missing.managedPreferencePaths[CHROME_PREFERENCE_DOMAINS[0]].path, stablePaths[1]);
  } finally {
    await rm(preferenceRoot, { recursive: true, force: true });
  }
}

function managedPayloadData(domains: readonly string[] = CHROME_PREFERENCE_DOMAINS): string {
  return `{ PayloadContent = { ${domains.map((domain) => (
    `"${domain}" = { Forced = ( { "mcx_preference_settings" = { ForceGoogleSafeSearch = 1; }; } ); };`
  )).join(" ")} }; }`;
}

function installedProfile(options: {
  source?: string;
  removalDisallowed?: string;
  signature?: string;
  payloadDomains?: readonly string[];
  payloadData?: string;
} = {}) {
  return {
    _name: "Vigil Chrome SafeSearch Filter",
    spconfigprofile_description: `Vigil Chrome SafeSearch Filter. VigilPolicySignature:${options.signature ?? CHROME_SAFE_SEARCH_SIGNATURE}`,
    spconfigprofile_install_source: options.source ?? "MDM",
    spconfigprofile_organization: "Vigil",
    spconfigprofile_profile_identifier: CHROME_SAFE_SEARCH_PROFILE_ID,
    spconfigprofile_profile_uuid: CHROME_SAFE_SEARCH_PROFILE_UUID,
    spconfigprofile_RemovalDisallowed: options.removalDisallowed ?? "yes",
    spconfigprofile_version: 1,
    _items: [{
      _name: "com.apple.ManagedClient.preferences",
      spconfigprofile_payload_data: options.payloadData ?? managedPayloadData(options.payloadDomains),
      spconfigprofile_payload_display_name: "Vigil Chrome SafeSearch Filter",
      spconfigprofile_payload_identifier: CHROME_SAFE_SEARCH_PAYLOAD_ID,
      spconfigprofile_payload_uuid: CHROME_SAFE_SEARCH_PAYLOAD_UUID,
      spconfigprofile_payload_version: 1
    }]
  };
}

function inventory(section: string, profiles: readonly unknown[]) {
  return { SPConfigurationProfileDataType: [{ _name: section, _items: profiles }] };
}

{
  const parsed = parseInstalledChromeSafeSearchProfileInventory(inventory(
    "spconfigprofile_section_deviceconfigprofiles",
    [installedProfile()]
  ));
  assert.equal(parsed.installed, true);
  assert.equal(parsed.locked, true);
  assert.equal(parsed.deviceScoped, true);
  assert.equal(parsed.removalDisallowed, true);
  assert.equal(parsed.managedInstall, true);
  assert.equal(parsed.payloadCurrent, true);
  assert.deepEqual(parsed.validationErrors, []);
}

{
  const decoy = {
    ...installedProfile(),
    spconfigprofile_profile_identifier: "example.lookalike",
    spconfigprofile_description: `Vigil Chrome SafeSearch Filter. VigilPolicySignature:${CHROME_SAFE_SEARCH_SIGNATURE}`
  };
  const parsed = parseInstalledChromeSafeSearchProfileInventory(inventory(
    "spconfigprofile_section_deviceconfigprofiles",
    [decoy, installedProfile({ signature: "0".repeat(64) })]
  ));
  assert.equal(parsed.installed, true);
  assert.equal(parsed.locked, false, "a signature on another profile record must not validate the matching identifier");
  assert.equal(parsed.signature, "0".repeat(64));
  assert.ok(parsed.validationErrors?.includes("profile-signature-mismatch"));
}

{
  const manual = parseInstalledChromeSafeSearchProfileInventory(inventory(
    "spconfigprofile_section_deviceconfigprofiles",
    [installedProfile({ source: "Manual" })]
  ));
  assert.equal(manual.locked, false, "a manually installed profile remains removable by a local administrator");
  assert.ok(manual.validationErrors?.includes("profile-manually-installed"));

  const userScoped = parseInstalledChromeSafeSearchProfileInventory(inventory(
    "User (501) Configuration Profiles",
    [installedProfile({ removalDisallowed: "no" })]
  ));
  assert.equal(userScoped.locked, false);
  assert.ok(userScoped.validationErrors?.includes("profile-not-device-scoped"));
  assert.ok(userScoped.validationErrors?.includes("profile-removal-allowed"));

  const incompletePayload = parseInstalledChromeSafeSearchProfileInventory(inventory(
    "spconfigprofile_section_deviceconfigprofiles",
    [installedProfile({ payloadDomains: CHROME_PREFERENCE_DOMAINS.slice(0, -1) })]
  ));
  assert.equal(incompletePayload.locked, false, "every supported Chrome channel must be present in the matching payload");
  assert.ok(incompletePayload.validationErrors?.includes("managed-preferences-payload-mismatch"));

  const [stable, ...otherDomains] = CHROME_PREFERENCE_DOMAINS;
  const interveningPreferencePayload = `{ PayloadContent = {
    "${stable}" = { HomepageLocation = "https://example.com"; };
    "com.example.InterveningPreferences" = { Forced = ( { "mcx_preference_settings" = { ForceGoogleSafeSearch = 1; }; } ); };
    ${otherDomains.map((domain) => (
      `"${domain}" = { Forced = ( { "mcx_preference_settings" = { ForceGoogleSafeSearch = 1; }; } ); };`
    )).join("\n")}
  }; }`;
  const interveningPreference = parseInstalledChromeSafeSearchProfileInventory(inventory(
    "spconfigprofile_section_deviceconfigprofiles",
    [installedProfile({ payloadData: interveningPreferencePayload })]
  ));
  assert.equal(interveningPreference.locked, false,
    "a neighboring preference domain must not lend its SafeSearch setting to the exact Chrome domain dictionary");
  assert.ok(interveningPreference.validationErrors?.includes("managed-preferences-payload-mismatch"));
}

{
  let now = 0;
  let calls = 0;
  let release = (_value: InstalledProfileResult) => {};
  const pending = new Promise<InstalledProfileResult>((resolve) => { release = resolve; });
  const cache = new ChromeSafeSearchProfileInventoryCache(async () => {
    calls += 1;
    return await pending;
  }, { now: () => now, cacheMs: 100 });

  const first = cache.get();
  const concurrent = cache.get();
  assert.equal(calls, 1, "concurrent callers must share one system profile inventory read");
  release({ installed: true, signature: "ABCDEF" });
  assert.deepEqual(await first, { installed: true, signature: "abcdef" });
  assert.deepEqual(await concurrent, { installed: true, signature: "abcdef" });

  now = 99;
  assert.deepEqual(await cache.get(), { installed: true, signature: "abcdef" });
  assert.equal(calls, 1, "an installed profile should remain cached for the full inventory TTL");
}

{
  let calls = 0;
  let releaseFresh = (_value: InstalledProfileResult) => {};
  const freshRead = new Promise<InstalledProfileResult>((resolve) => { releaseFresh = resolve; });
  const cache = new ChromeSafeSearchProfileInventoryCache(async () => {
    calls += 1;
    return calls === 1
      ? { installed: true, signature: "cached", locked: true }
      : await freshRead;
  }, { cacheMs: 5 * 60 * 1000 });

  assert.equal((await cache.get()).signature, "cached");
  assert.equal((await cache.get()).signature, "cached");
  assert.equal(calls, 1, "ordinary status reads must keep using the long-lived inventory cache");

  const attestation = cache.getFresh();
  const concurrentAttestation = cache.getFresh();
  assert.equal(calls, 2, "fresh attestation must bypass a completed cached inventory exactly once");
  releaseFresh({ installed: true, signature: "fresh", locked: true });
  assert.equal((await attestation).signature, "fresh");
  assert.equal((await concurrentAttestation).signature, "fresh");
  assert.equal((await cache.get()).signature, "fresh",
    "a fresh attestation should become the cache used by subsequent ordinary diagnostics");
  assert.equal(calls, 2);
}

{
  let now = 0;
  let calls = 0;
  const cache = new ChromeSafeSearchProfileInventoryCache(async () => {
    calls += 1;
    return { installed: true, signature: String(calls) };
  }, { now: () => now, cacheMs: 100 });

  assert.equal((await cache.get()).signature, "1");
  now = 100;
  assert.equal((await cache.get()).signature, "2");
  cache.invalidate();
  assert.equal((await cache.get()).signature, "3", "targeted invalidation must force the next inventory read");
}

{
  let now = 0;
  let calls = 0;
  const cache = new ChromeSafeSearchProfileInventoryCache(async () => {
    calls += 1;
    return { installed: false, signature: "" };
  }, { now: () => now, cacheMs: 1_000, missingCacheMs: 20 });

  await cache.get();
  now = 19;
  await cache.get();
  assert.equal(calls, 1);
  now = 20;
  await cache.get();
  assert.equal(calls, 2, "missing inventory must use the shorter deployment-aware TTL");
}

{
  let now = 0;
  let calls = 0;
  const cache = new ChromeSafeSearchProfileInventoryCache(async () => {
    calls += 1;
    return { installed: true, signature: CHROME_SAFE_SEARCH_SIGNATURE, locked: false };
  }, { now: () => now, cacheMs: 1_000, missingCacheMs: 20 });

  await cache.get();
  now = 20;
  await cache.get();
  assert.equal(calls, 2, "an unprotected installation must refresh on the shorter deployment-aware TTL");
}

{
  let now = 0;
  let calls = 0;
  const cache = new ChromeSafeSearchProfileInventoryCache(async () => {
    calls += 1;
    if (calls === 1) throw new Error("profiler unavailable");
    return { installed: true, signature: "recovered" };
  }, { now: () => now, failureCacheMs: 5 });

  assert.deepEqual(await cache.get(), { installed: false, signature: "" });
  now = 4;
  assert.deepEqual(await cache.get(), { installed: false, signature: "" });
  assert.equal(calls, 1);
  now = 5;
  assert.deepEqual(await cache.get(), { installed: true, signature: "recovered" });
  assert.equal(calls, 2, "a profiler failure must retry sooner than a successful inventory");
}

{
  let calls = 0;
  let releaseOld = (_value: InstalledProfileResult) => {};
  let releaseFresh = (_value: InstalledProfileResult) => {};
  const old = new Promise<InstalledProfileResult>((resolve) => { releaseOld = resolve; });
  const fresh = new Promise<InstalledProfileResult>((resolve) => { releaseFresh = resolve; });
  const cache = new ChromeSafeSearchProfileInventoryCache(async () => {
    calls += 1;
    return await (calls === 1 ? old : fresh);
  });

  const obsoleteRead = cache.get();
  cache.invalidate();
  const freshRead = cache.get();
  assert.equal(calls, 2);
  releaseFresh({ installed: true, signature: "fresh" });
  assert.deepEqual(await freshRead, { installed: true, signature: "fresh" });
  releaseOld({ installed: true, signature: "old" });
  assert.deepEqual(await obsoleteRead, { installed: true, signature: "old" });
  assert.deepEqual(await cache.get(), { installed: true, signature: "fresh" },
    "an invalidated in-flight read must not replace the newer cached inventory");
}
