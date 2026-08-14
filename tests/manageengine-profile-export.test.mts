import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultState } from "../src/defaults.js";
import { parsePlist } from "../src/plist.js";
import { detectManageEngineDeploymentState, exportManageEngineIosProfile, pinManageEngineCurrentGeneration, resolveManageEngineCurrentGeneration } from "../src/manageEngineExport.js";
import { IOS_SOCIAL_COMPANION_APPS, IOS_SOCIAL_COMPANION_BUNDLE_IDS } from "../src/socialFeatureFilters.js";
import type { VigilState } from "../src/types.js";
import { DATA_DIR } from "../src/store.js";
import { recordValue } from "./test-helpers.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const runtimeParent = dirname(root);
const projectRoot = basename(root) === "runtime" && ["dist", "dist.nosync"].includes(basename(runtimeParent))
  ? dirname(runtimeParent)
  : root;
const dataDir = await mkdtemp(join(tmpdir(), "vigil-manageengine-export-"));
await chmod(dataDir, 0o755);

try {
  await writeTestUrlFilterService(dataDir);
  await writeTestUrlFilterService(DATA_DIR);
  const usbApplySource = await readFile(join(projectRoot, "scripts", "apply-ios-usb-profile.mjs"), "utf8");
  assert.match(usbApplySource, /await pairSupervised\(udid, supervisorKeybagPath\);\s*await runPymobiledevice3\(\[\s*"profile",\s*"remove",\s*"--udid",\s*udid,\s*IOS_PROFILE_IDENTIFIER/s);
  assert.doesNotMatch(usbApplySource, /"profile",\s*"remove"[^\]]*"--keybag"/s);

  const profilePath = join(dataDir, "vigil-manageengine-policy.mobileconfig");
  const summaryPath = join(dataDir, "vigil-manageengine-policy.summary.json");
  const launcherProfilePath = join(dataDir, "vigil-social-launchers.mobileconfig");
  const launcherSummaryPath = join(dataDir, "vigil-social-launchers.summary.json");
  await writeFile(launcherProfilePath, "retired launcher profile");
  await writeFile(launcherSummaryPath, "retired launcher summary");
  const result = await runExporter(["--out", profilePath, "--summary", summaryPath], dataDir);

  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /State saved: yes/);
  assert.equal((await stat(dataDir)).mode & 0o777, 0o700);
  for (const path of [
    join(dataDir, "state.json"),
    profilePath,
    summaryPath
  ]) {
    assert.equal((await stat(path)).mode & 0o777, 0o600, `${path} should be private`);
  }

  const savedState = JSON.parse(await readFile(join(dataDir, "state.json"), "utf8")) as VigilState;
  const savedPassword = savedState.deviceControls.ios.removalPassword;
  assert.equal(typeof savedPassword, "string");
  const removalPassword = savedPassword as string;
  assert.ok(removalPassword.length >= 16);

  const profile = recordValue(parsePlist(await readFile(profilePath, "utf8")), "ManageEngine profile");
  assert.equal(profile.PayloadRemovalDisallowed, true);
  assert.ok(Array.isArray(profile.PayloadContent), "profile payload content should be an array");
  const removalPayload = profile.PayloadContent
    .map((item) => recordValue(item, "profile payload"))
    .find((payload) => payload.PayloadType === "com.apple.profileRemovalPassword");
  assert.equal(removalPayload?.RemovalPassword, removalPassword, "always-on protection must carry the saved removal password");
  const restrictionsPayload = profile.PayloadContent
    .map((item) => recordValue(item, "profile payload"))
    .find((payload) => payload.PayloadType === "com.apple.applicationaccess");
  assert.equal(restrictionsPayload?.allowAppInstallation, true);
  assert.equal(restrictionsPayload?.allowAppRemoval, true);
  assert.equal(restrictionsPayload?.allowUIAppInstallation, true);
  assert.ok(Array.isArray(restrictionsPayload?.blockedAppBundleIDs));
  assert.equal((restrictionsPayload?.blockedAppBundleIDs as unknown[]).includes("com.google.chrome.ios"), false);
  assert.equal(restrictionsPayload?.allowListedAppBundleIDs, undefined);
  const baselineWebFilter = profile.PayloadContent
    .map((item) => recordValue(item, "profile payload"))
    .find((payload) => payload.PayloadType === "com.apple.webcontent-filter" && payload.FilterType === "BuiltIn");
  assert.ok(Array.isArray(baselineWebFilter?.DenyListURLs));
  assert.equal((baselineWebFilter?.DenyListURLs as unknown[]).includes("https://youtube.com/shorts"), true);
  const webClips = profile.PayloadContent
    .map((item) => recordValue(item, "profile payload"))
    .filter((payload) => payload.PayloadType === "com.apple.webClip.managed");
  assert.equal(webClips.length, 0, "dynamic policy profile must not own launcher icons");
  assert.equal(await fileExists(launcherProfilePath), false, "export must retire the stale launcher profile artifact");
  assert.equal(await fileExists(launcherSummaryPath), false, "export must retire the stale launcher summary artifact");

  const summaryText = await readFile(summaryPath, "utf8");
  const summary = recordValue(JSON.parse(summaryText), "ManageEngine export summary");
  assert.equal(summary.stateSaved, true);
  assert.equal(summary.deliveryProvider, "manageengine");
  assert.equal(summary.normalFreeDeliveryPath, true);
  assert.equal(summary.appBundleCount, 10);
  assert.ok(Number(summary.deniedUrlCount) > 0);
  assert.equal(summary.enforcementActive, false);
  assert.equal(summary.focusedSocialEnforcementActive, false);
  assert.deepEqual(summary.managedHelperAppBundleIds, []);
  assert.equal(summary.hardenRemoval, true);
  assert.equal(summary.removalPasswordStoredInVigilState, true);
  assert.equal(summary.allowSafariHistoryClearing, true);
  assert.equal(summary.appStoreAllowedByThisProfile, true);
  assert.equal(summary.appStoreRestrictionKeysEmitted, false);
  assert.match(String(summary.artifactHash || ""), /^[a-f0-9]{64}$/);
  const deployment = recordValue(summary.deployment, "ManageEngine deployment summary");
  assert.equal(deployment.status, "unverified");
  assert.equal(deployment.artifactOnly, true);
  assert.equal(deployment.requiresManageEngineUploadAndAssignment, true);
  const companionApps = recordValue(summary.companionApps, "companion app summary");
  assert.equal(companionApps.appCount, 2);
  assert.deepEqual(companionApps.labels, ["Instagram", "YouTube"]);
  assert.deepEqual(companionApps.bundleIds, Object.values(IOS_SOCIAL_COMPANION_BUNDLE_IDS));
  assert.deepEqual(companionApps.apps, IOS_SOCIAL_COMPANION_APPS.map((app) => ({ ...app })));
  const retiredLauncher = recordValue(summary.launcherProfile, "retired launcher summary");
  assert.equal(retiredLauncher.retired, true);
  assert.equal(retiredLauncher.webClipCount, 0);
  assert.equal(retiredLauncher.outputPath, null);
  assert.equal(retiredLauncher.uploadToManageEngineAsSeparateCustomConfigurationProfile, false);
  assert.equal(summaryText.includes(removalPassword), false);

  const observationPath = join(dataDir, "deployment-observation.json");
  const observedProfilePath = join(dataDir, "observed-policy.mobileconfig");
  const observedSummaryPath = join(dataDir, "observed-policy.summary.json");
  await writeFile(observationPath, JSON.stringify({
    observedAt: "2026-07-10T12:00:00.000Z",
    installedProfileIdentifier: "tech.caseline.vigil.ios-lock",
    installedProfileHash: summary.artifactHash,
    effectiveProhibitAppInstall: false,
    effectiveProhibitAppDelete: false
  }));
  const observedResult = await runExporter([
    "--out", observedProfilePath,
    "--summary", observedSummaryPath,
    "--deployment-observation", observationPath
  ], dataDir);
  assert.equal(observedResult.code, 0, observedResult.stderr || observedResult.stdout);
  const observedSummary = recordValue(JSON.parse(await readFile(observedSummaryPath, "utf8")), "observed deployment summary");
  assert.equal(recordValue(observedSummary.deployment, "observed deployment").status, "current");

  const retiredOptionResult = await runExporter(["--launcher-deployment-observation", observationPath], dataDir);
  assert.notEqual(retiredOptionResult.code, 0);
  assert.match(retiredOptionResult.stderr, /Unknown option: --launcher-deployment-observation/);

  const typoProfilePath = join(dataDir, "typo-should-not-write.mobileconfig");
  const typoSummaryPath = join(dataDir, "typo-should-not-write.summary.json");
  const typoResult = await runExporter(["--out", typoProfilePath, "--summary", typoSummaryPath, "--enrolment-window"], dataDir);

  assert.notEqual(typoResult.code, 0, typoResult.stdout);
  assert.match(typoResult.stderr, /Unknown option: --enrolment-window/);
  assert.equal(await fileExists(typoProfilePath), false);
  assert.equal(await fileExists(typoSummaryPath), false);

  const inlineEqualsProfilePath = join(dataDir, "policy=name.mobileconfig");
  const inlineEqualsSummaryPath = join(dataDir, "policy=name.summary.json");
  const inlineEqualsResult = await runExporter([
    `--out=${inlineEqualsProfilePath}`,
    `--summary=${inlineEqualsSummaryPath}`,
    "--enrollment-window"
  ], dataDir);

  assert.equal(inlineEqualsResult.code, 0, inlineEqualsResult.stderr || inlineEqualsResult.stdout);
  assert.match(inlineEqualsResult.stdout, new RegExp(`Wrote ManageEngine iOS profile: ${escapeRegExp(inlineEqualsProfilePath)}`));
  assert.match(await readFile(inlineEqualsProfilePath, "utf8"), /^\s*<\?xml/);
  const inlineEqualsSummary = recordValue(JSON.parse(await readFile(inlineEqualsSummaryPath, "utf8")), "inline-equals summary");
  assert.equal(inlineEqualsSummary.mode, "enrollment-window");
  assert.equal(inlineEqualsSummary.deliveryProvider, "manageengine");
  assert.equal(inlineEqualsSummary.outputPath, inlineEqualsProfilePath);
  assert.equal(inlineEqualsSummary.hardenRemoval, false);
  assert.equal(inlineEqualsSummary.restrictInstallAndErase, false);

  const noSuffixProfilePath = join(dataDir, "vigil-manageengine-policy-no-suffix");
  const noSuffixSummaryPath = `${noSuffixProfilePath}.summary.json`;
  const noSuffixResult = await runExporter(["--out", noSuffixProfilePath], dataDir);

  assert.equal(noSuffixResult.code, 0, noSuffixResult.stderr || noSuffixResult.stdout);
  assert.match(noSuffixResult.stdout, new RegExp(`Wrote ManageEngine iOS profile: ${escapeRegExp(noSuffixProfilePath)}`));
  assert.match(noSuffixResult.stdout, new RegExp(`Summary: ${escapeRegExp(noSuffixSummaryPath)}`));
  assert.match(await readFile(noSuffixProfilePath, "utf8"), /^\s*<\?xml/);
  assert.equal(recordValue(JSON.parse(await readFile(noSuffixSummaryPath, "utf8")), "no-suffix summary").outputPath, noSuffixProfilePath);

  const failureRoot = join(dataDir, "atomic-failure");
  const failureProfilePath = join(failureRoot, "blocked.mobileconfig");
  await mkdir(failureProfilePath, { recursive: true, mode: 0o700 });
  const failureState = defaultState();
  failureState.deviceControls.ios.hardenRemoval = false;
  await assert.rejects(exportManageEngineIosProfile(failureState, {
    currentState: true,
    outPath: failureProfilePath,
    summaryPath: join(failureRoot, "blocked.summary.json")
  }));
  assert.equal((await stat(failureRoot)).mode & 0o777, 0o700);
  assert.equal((await readdir(failureRoot)).some((name) => name.startsWith(".blocked.mobileconfig.") && name.endsWith(".tmp")), false);
} finally {
  await rm(dataDir, { recursive: true, force: true });
}

async function writeTestUrlFilterService(dataDirectory: string): Promise<void> {
  const directory = join(dataDirectory, "ios-url-filter");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "service.json"), JSON.stringify({
    schemaVersion: 1,
    pirServerURL: "https://pir.example.test/",
    privacyPassIssuerURL: "https://issuer.example.test/",
    deploymentManifestURL: "https://pir.example.test/deployment.json",
    authenticationToken: "test-authentication-token-0001",
    hostBundleIdentifier: "tech.caseline.vigil.url-filter",
    controlProviderBundleIdentifier: "tech.caseline.vigil.url-filter.control",
    usecaseName: "tech.caseline.vigil.url-filter.url.filtering",
    prefilterFetchIntervalSeconds: 2700,
    prefilterTag: "test-prefilter",
    pirDatabaseRevision: "test-pir",
    pirDatabaseSha256: "a".repeat(64),
    exactIndexSnapshotHash: "b".repeat(64)
  }));
}

{
  const artifact = {
    artifactHash: "a".repeat(64),
    profileIdentifier: "tech.caseline.vigil.ios-lock",
    appStoreAllowedByThisProfile: true
  };
  const stale = detectManageEngineDeploymentState(artifact, {
    observedAt: "2026-07-10T12:00:00.000Z",
    installedProfileIdentifier: artifact.profileIdentifier,
    installedProfileHash: "b".repeat(64),
    effectiveProhibitAppInstall: true,
    effectiveProhibitAppDelete: true
  });
  assert.equal(stale.status, "stale");
  assert.equal(stale.requiresManageEngineUploadAndAssignment, true);
  assert.equal(stale.reasons.length, 2);

  const current = detectManageEngineDeploymentState(artifact, {
    installedProfileIdentifier: artifact.profileIdentifier,
    installedProfileHash: artifact.artifactHash,
    effectiveProhibitAppInstall: false,
    effectiveProhibitAppDelete: false
  });
  assert.equal(current.status, "current");
  assert.equal(current.requiresManageEngineUploadAndAssignment, false);

  const currentWithConflict = detectManageEngineDeploymentState(artifact, {
    installedProfileIdentifier: artifact.profileIdentifier,
    installedProfileHash: artifact.artifactHash,
    effectiveProhibitAppInstall: true,
    effectiveProhibitAppDelete: false
  });
  assert.equal(currentWithConflict.status, "current-with-conflict");
  assert.equal(currentWithConflict.artifactCurrent, true);
  assert.equal(currentWithConflict.effectivePolicyConflict, true);
  assert.equal(currentWithConflict.requiresManageEngineUploadAndAssignment, false);
  assert.equal(currentWithConflict.requiresRestrictionReconciliation, true);

  const unverifiedWithConflict = detectManageEngineDeploymentState(artifact, {
    installedProfileIdentifier: artifact.profileIdentifier,
    effectiveProhibitAppInstall: true
  });
  assert.equal(unverifiedWithConflict.status, "unverified-with-conflict");
  assert.equal(unverifiedWithConflict.artifactCurrent, null);
  assert.equal(unverifiedWithConflict.requiresRestrictionReconciliation, true);
}

{
  const splitRoot = await mkdtemp(join(tmpdir(), "vigil-manageengine-split-paths-"));
  try {
    const paths = {
      outPath: join(splitRoot, "profile", "policy.mobileconfig"),
      summaryPath: join(splitRoot, "summary", "policy.summary.json"),
      launcherOutPath: join(splitRoot, "launcher", "social.mobileconfig"),
      launcherSummaryPath: join(splitRoot, "launcher-summary", "social.summary.json")
    };
    const splitState = defaultState();
    const splitResult = await exportManageEngineIosProfile(splitState, {
      currentState: true,
      ...paths,
      saveState: async () => {}
    });
    assert.ok((await readFile(splitResult.outPath, "utf8")).length > 0);
    assert.equal(recordValue(JSON.parse(await readFile(splitResult.summaryPath, "utf8")), "split summary").outputPath, paths.outPath);
    assert.equal(splitResult.launcherOutPath, null);
    assert.equal(splitResult.launcherSummaryPath, null);
    assert.equal(await fileExists(paths.launcherOutPath), false);
    assert.equal(await fileExists(paths.launcherSummaryPath), false);
  } finally {
    await rm(splitRoot, { recursive: true, force: true });
  }
}

{
  const canonicalRoot = await mkdtemp(join(tmpdir(), "vigil-manageengine-canonical-root-"));
  const aliasedRoot = `${canonicalRoot}-alias`;
  try {
    await symlink(canonicalRoot, aliasedRoot, process.platform === "win32" ? "junction" : "dir");
    const outPath = join(aliasedRoot, "policy.mobileconfig");
    const summaryPath = join(aliasedRoot, "policy.summary.json");
    await exportManageEngineIosProfile(defaultState(), {
      currentState: true,
      outPath,
      summaryPath,
      saveState: async () => {}
    });
    const firstGeneration = await resolveManageEngineCurrentGeneration(aliasedRoot);
    assert.equal(dirname(firstGeneration), await realpath(join(aliasedRoot, ".generations")), "a canonical generation must remain valid when its publication root is reached through a path alias");
    await assert.rejects(exportManageEngineIosProfile(defaultState(), {
      currentState: true,
      outPath,
      summaryPath,
      saveState: async () => {},
      afterPublicationBoundary(boundary) {
        if (boundary === "current-published") throw new Error("crash after aliased current publication");
      }
    }), /crash after aliased current publication/u);
    assert.notEqual(await resolveManageEngineCurrentGeneration(aliasedRoot), firstGeneration, "crash cleanup must retain a generation published through a path alias");

    const oldGenerationPin = await pinManageEngineCurrentGeneration(aliasedRoot);
    const oldGeneration = oldGenerationPin.generationPath;
    for (let index = 0; index < 4; index += 1) {
      await exportManageEngineIosProfile(defaultState(), {
        currentState: true,
        outPath,
        summaryPath,
        saveState: async () => {}
      });
    }
    await oldGenerationPin.release();
    await rm(join(aliasedRoot, "current"), { force: true });
    await symlink(join(".generations", basename(oldGeneration)), join(aliasedRoot, "current"));
    await assert.rejects(exportManageEngineIosProfile(defaultState(), {
      currentState: true,
      outPath,
      summaryPath,
      saveState: async () => {},
      afterPublicationBoundary(boundary) {
        if (boundary === "generation-fsynced") throw new Error("stop after aliased sweep");
      }
    }), /stop after aliased sweep/u);
    await stat(oldGeneration);
    assert.equal(
      await resolveManageEngineCurrentGeneration(aliasedRoot),
      oldGeneration,
      "an aliased publication root must retain an older generation while current points to it"
    );
  } finally {
    await rm(aliasedRoot, { force: true });
    await rm(canonicalRoot, { recursive: true, force: true });
  }
}

{
  const overlapDir = await mkdtemp(join(tmpdir(), "vigil-manageengine-overlap-"));
  try {
    const outPath = join(overlapDir, "vigil-manageengine-policy.mobileconfig");
    const summaryPath = join(overlapDir, "vigil-manageengine-policy.summary.json");
    const firstState = defaultState();
    firstState.deviceControls.ios.enabled = true;
    firstState.deviceControls.ios.hardenRemoval = false;
    firstState.activeSessions.phone = {
      id: "overlap-soft",
      title: "Overlap Soft",
      mode: "focus",
      profileId: "soft-block",
      lockLevel: "light",
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      endsAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      canEndEarly: true,
      source: "manual",
      deviceTargets: ["phone"]
    };
    const secondState = defaultState();
    secondState.deviceControls.ios.enabled = true;
    secondState.deviceControls.ios.hardenRemoval = false;

    await Promise.all([
      exportManageEngineIosProfile(firstState, { currentState: true, outPath, summaryPath }),
      exportManageEngineIosProfile(secondState, { currentState: true, outPath, summaryPath })
    ]);

    const initialPin = await pinManageEngineCurrentGeneration(overlapDir);
    const pinnedMainProfile = initialPin.paths[join("main", basename(outPath))];
    const pinnedMainSummary = initialPin.paths[join("main", basename(summaryPath))];
    assert.ok(pinnedMainProfile && pinnedMainSummary);
    const profileText = await readFile(pinnedMainProfile.path, "utf8");
    const summary = recordValue(JSON.parse(await readFile(pinnedMainSummary.path, "utf8")), "overlap summary");
    assert.equal(summary.artifactHash, createHash("sha256").update(profileText).digest("hex"));
    assert.equal(summary.enforcementActive, false, "the second queued Level 1 export should win as a complete artifact set");
    const profile = recordValue(parsePlist(profileText), "overlap profile");
    assert.ok(Array.isArray(profile.PayloadContent));
    assert.equal(profile.PayloadContent.length, 3, "Personal edition should contain restrictions, Apple's BuiltIn web filter, and SafeSearch DNS");
    const payloads = profile.PayloadContent.map((value) => recordValue(value, "overlap payload"));
    assert.equal(payloads.some((payload) => payload.FilterType === "Plugin"), false);
    const releasePayload = payloads.find((payload) => payload.PayloadType === "com.apple.applicationaccess")!;
    assert.equal(releasePayload.PayloadType, "com.apple.applicationaccess");
    assert.equal(releasePayload.allowAppInstallation, true);
    assert.equal(releasePayload.allowAppRemoval, true);
    assert.ok(Array.isArray(releasePayload.blockedAppBundleIDs));
    const baselineFilter = payloads.find((payload) => payload.PayloadType === "com.apple.webcontent-filter" && payload.FilterType === "BuiltIn")!;
    assert.equal(baselineFilter.PayloadType, "com.apple.webcontent-filter");
    assert.ok(Array.isArray(baselineFilter.DenyListURLs));
    const safeSearchDns = payloads.find((payload) => payload.PayloadType === "com.apple.dnsSettings.managed")!;
    assert.equal(safeSearchDns.PayloadType, "com.apple.dnsSettings.managed");
    assert.equal(recordValue(safeSearchDns.DNSSettings, "SafeSearch DNS settings").DNSProtocol, "HTTPS");
    assert.equal(Object.keys(initialPin.paths).some((path) => path.includes("social-launchers")), false);
    assert.equal(pinnedMainProfile.sha256, createHash("sha256").update(profileText).digest("hex"));
    await initialPin.release();

    const firstGeneration = await resolveManageEngineCurrentGeneration(overlapDir);
    await assert.rejects(exportManageEngineIosProfile(firstState, {
      currentState: true,
      outPath,
      summaryPath,
      afterPublicationBoundary(boundary) {
        if (boundary === "generation-fsynced") throw new Error("crash before current publication");
      }
    }), /crash before current publication/u);
    assert.equal(await resolveManageEngineCurrentGeneration(overlapDir), firstGeneration, "a pre-publication crash must leave current unchanged");

    await assert.rejects(exportManageEngineIosProfile(firstState, {
      currentState: true,
      outPath,
      summaryPath,
      afterPublicationBoundary(boundary) {
        if (boundary === "current-published") throw new Error("crash after current publication");
      }
    }), /crash after current publication/u);
    const publishedGeneration = await resolveManageEngineCurrentGeneration(overlapDir);
    assert.notEqual(publishedGeneration, firstGeneration, "the atomic current switch is the publication commit point");
    const pinnedProfile = await readFile(join(publishedGeneration, "main", basename(outPath)), "utf8");
    const pinnedSummary = recordValue(JSON.parse(await readFile(join(publishedGeneration, "main", basename(summaryPath)), "utf8")), "pinned summary");
    assert.equal(pinnedSummary.artifactHash, createHash("sha256").update(pinnedProfile).digest("hex"), "a pinned generation must never mix artifacts");

    const corruptManifestPath = join(publishedGeneration, "manifest.json");
    const corruptManifest = JSON.parse(await readFile(corruptManifestPath, "utf8")) as {
      artifacts: Array<{ path: string; sha256: string; bytes: number }>;
    };
    const corruptArtifactPath = join(publishedGeneration, corruptManifest.artifacts[0]?.path || "missing");
    const corruptArtifact = await readFile(corruptArtifactPath);
    corruptArtifact[0] = (corruptArtifact[0] || 0) ^ 0xff;
    await writeFile(corruptArtifactPath, corruptArtifact);
    await assert.rejects(pinManageEngineCurrentGeneration(overlapDir), /SHA-256 mismatch/u, "pinning must hash the artifact bytes");

    await exportManageEngineIosProfile(secondState, { currentState: true, outPath, summaryPath });
    const symlinkGeneration = await resolveManageEngineCurrentGeneration(overlapDir);
    const symlinkManifest = JSON.parse(await readFile(join(symlinkGeneration, "manifest.json"), "utf8")) as {
      artifacts: Array<{ path: string; sha256: string; bytes: number }>;
    };
    const symlinkArtifact = join(symlinkGeneration, symlinkManifest.artifacts[0]?.path || "missing");
    await rm(symlinkArtifact);
    await symlink(join(symlinkGeneration, symlinkManifest.artifacts[1]?.path || "manifest.json"), symlinkArtifact);
    await assert.rejects(pinManageEngineCurrentGeneration(overlapDir), /regular non-symlink/u, "pinning must reject symlink artifacts");

    for (const invalid of [
      { name: "duplicate", mutate: (manifest: typeof symlinkManifest) => manifest.artifacts.push({ ...manifest.artifacts[0]! }), pattern: /Duplicate/u },
      { name: "traversal", mutate: (manifest: typeof symlinkManifest) => { manifest.artifacts[0]!.path = "../outside"; }, pattern: /manifest path/u },
      { name: "oversize", mutate: (manifest: typeof symlinkManifest) => { manifest.artifacts[0]!.bytes = 17 * 1024 * 1024; }, pattern: /size limit/u }
    ]) {
      await exportManageEngineIosProfile(secondState, { currentState: true, outPath, summaryPath });
      const invalidGeneration = await resolveManageEngineCurrentGeneration(overlapDir);
      const invalidManifestPath = join(invalidGeneration, "manifest.json");
      const invalidManifest = JSON.parse(await readFile(invalidManifestPath, "utf8")) as typeof symlinkManifest;
      invalid.mutate(invalidManifest);
      await writeFile(invalidManifestPath, `${JSON.stringify(invalidManifest)}\n`);
      await assert.rejects(pinManageEngineCurrentGeneration(overlapDir), invalid.pattern, `${invalid.name} manifest entries must fail closed`);
    }

    await exportManageEngineIosProfile(secondState, { currentState: true, outPath, summaryPath });

    const durablePin = await pinManageEngineCurrentGeneration(overlapDir);
    for (let index = 0; index < 6; index += 1) {
      await mkdir(join(overlapDir, ".generations", `unreachable-${index}`), { recursive: true });
    }
    for (let index = 0; index < 5; index += 1) {
      await exportManageEngineIosProfile(index % 2 ? firstState : secondState, { currentState: true, outPath, summaryPath });
    }
    await stat(durablePin.generationPath);
    const retainedWithPin = (await readdir(join(overlapDir, ".generations"), { withFileTypes: true })).filter((entry) => entry.isDirectory());
    assert.ok(retainedWithPin.length <= 4, "orphan sweep must retain only bounded history plus an active pin");
    await durablePin.release();
    await exportManageEngineIosProfile(secondState, { currentState: true, outPath, summaryPath });
    const retainedAfterRelease = (await readdir(join(overlapDir, ".generations"), { withFileTypes: true })).filter((entry) => entry.isDirectory());
    assert.ok(retainedAfterRelease.length <= 3, "released pins must become eligible for bounded-history cleanup");

    const failedRenewalPin = await pinManageEngineCurrentGeneration(overlapDir);
    const failedRenewalPath = await pinFileForGeneration(overlapDir, basename(failedRenewalPin.generationPath));
    const failedRenewalLease = JSON.parse(await readFile(failedRenewalPath, "utf8")) as { token: string };
    failedRenewalLease.token = "deterministically-replaced-token";
    await writeFile(failedRenewalPath, `${JSON.stringify(failedRenewalLease)}\n`);
    await assert.rejects(failedRenewalPin.assertValid(), /ownership changed/u, "pin renewal failure must surface before callers continue using returned paths");
    await assert.rejects(failedRenewalPin.release(), /ownership changed/u, "the first pin renewal failure must remain visible through release");
    await rm(failedRenewalPath, { force: true });

    const childPin = await startPinChild(overlapDir);
    const childDataDirs = await Promise.all([
      mkdtemp(join(tmpdir(), "vigil-manageengine-child-a-")),
      mkdtemp(join(tmpdir(), "vigil-manageengine-child-b-"))
    ]);
    await Promise.all(childDataDirs.map(writeTestUrlFilterService));
    try {
      const childPinPath = await pinFileForGeneration(overlapDir, basename(childPin.generationPath));
      const expiredChildLease = JSON.parse(await readFile(childPinPath, "utf8")) as { expiresAt: string };
      expiredChildLease.expiresAt = new Date(0).toISOString();
      await writeFile(childPinPath, `${JSON.stringify(expiredChildLease)}\n`);
      for (let index = 0; index < 5; index += 1) {
        await exportManageEngineIosProfile(index % 2 ? firstState : secondState, { currentState: true, outPath, summaryPath });
      }
      await stat(childPin.generationPath);
      const childResults = await Promise.all(childDataDirs.map((childDataDir) => runExporter([
        "--out", outPath,
        "--summary", summaryPath,
        "--current-state"
      ], childDataDir)));
      for (const childResult of childResults) assert.equal(childResult.code, 0, childResult.stderr || childResult.stdout);
      await stat(childPin.generationPath);
    } finally {
      await childPin.release();
      await Promise.all(childDataDirs.map(async (path) => await rm(path, { recursive: true, force: true })));
    }
  } finally {
    await rm(overlapDir, { recursive: true, force: true });
  }
}

function runExporter(args: string[], vigilDataDir: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(root, "scripts", "export-manageengine-ios-profile.mjs"), ...args], {
      cwd: root,
      env: {
        ...process.env,
        VIGIL_DATA_DIR: vigilDataDir
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    };
    const timeout = setTimeout(() => {
      stderr += "Exporter child timed out.";
      child.kill("SIGKILL");
      finish(1);
    }, 15_000);
    child.once("error", (error) => {
      stderr += error.message;
      finish(1);
    });
    child.once("close", (code, signal) => {
      finish(signal || code === null ? 1 : code);
    });
  });
}

async function startPinChild(outputDirectory: string): Promise<{ generationPath: string; release(): Promise<void> }> {
  const moduleUrl = new URL("../src/manageEngineExport.js", import.meta.url).href;
  const source = `
    const { pinManageEngineCurrentGeneration } = await import(${JSON.stringify(moduleUrl)});
    const pin = await pinManageEngineCurrentGeneration(${JSON.stringify(outputDirectory)});
    process.stdout.write(JSON.stringify({ generationPath: pin.generationPath }) + "\\n");
    const timeout = setTimeout(async () => { await pin.release(); process.exit(2); }, 30000);
    process.stdin.once("data", async () => { clearTimeout(timeout); await pin.release(); process.exit(0); });
    process.stdin.resume();
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
    stdio: ["pipe", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const generationPath = await new Promise<string>((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      rejectReady(new Error(`Pin child timed out: ${stderr}`));
    }, 5_000);
    const inspect = () => {
      const newline = stdout.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timeout);
      try {
        const ready = JSON.parse(stdout.slice(0, newline)) as { generationPath?: unknown };
        if (typeof ready.generationPath !== "string") throw new Error("Pin child returned no generation path.");
        resolveReady(ready.generationPath);
      } catch (error) {
        child.kill("SIGKILL");
        rejectReady(error);
      }
    };
    child.stdout.on("data", inspect);
    child.once("exit", (code) => {
      if (!stdout.includes("\n")) {
        clearTimeout(timeout);
        rejectReady(new Error(`Pin child exited before ready (${code}): ${stderr}`));
      }
    });
  });
  let released = false;
  return {
    generationPath,
    async release() {
      if (released) return;
      released = true;
      const closed = new Promise<void>((resolveClosed, rejectClosed) => {
        const timeout = setTimeout(() => {
          child.kill("SIGKILL");
          rejectClosed(new Error(`Pin child did not stop: ${stderr}`));
        }, 5_000);
        child.once("close", (code) => {
          clearTimeout(timeout);
          if (code === 0) resolveClosed();
          else rejectClosed(new Error(`Pin child failed (${code}): ${stderr}`));
        });
      });
      child.stdin.end("release\n");
      await closed;
    }
  };
}

async function pinFileForGeneration(outputDirectory: string, generation: string): Promise<string> {
  const pinsRoot = join(outputDirectory, ".pins");
  for (const entry of await readdir(pinsRoot)) {
    const path = join(pinsRoot, entry);
    const lease = JSON.parse(await readFile(path, "utf8")) as { generation?: unknown };
    if (lease.generation === generation) return path;
  }
  throw new Error(`No pin found for ManageEngine generation ${generation}.`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT") return false;
    throw error;
  }
}
