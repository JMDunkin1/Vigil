import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultState } from "../src/defaults.js";
import { parsePlist } from "../src/plist.js";
import { detectManageEngineDeploymentState, exportManageEngineIosProfile } from "../src/manageEngineExport.js";
import { IOS_SOCIAL_COMPANION_BUNDLE_IDS } from "../src/socialFeatureFilters.js";
import type { VigilState } from "../src/types.js";
import { recordValue } from "./test-helpers.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const runtimeParent = dirname(root);
const projectRoot = basename(root) === "runtime" && ["dist", "dist.nosync"].includes(basename(runtimeParent))
  ? dirname(runtimeParent)
  : root;
const dataDir = await mkdtemp(join(tmpdir(), "vigil-manageengine-export-"));
await chmod(dataDir, 0o755);

try {
  const usbApplySource = await readFile(join(projectRoot, "scripts", "apply-ios-usb-profile.mjs"), "utf8");
  assert.match(usbApplySource, /await pairSupervised\(udid, supervisorKeybagPath\);\s*await runPymobiledevice3\(\[\s*"profile",\s*"remove",\s*"--udid",\s*udid,\s*IOS_PROFILE_IDENTIFIER/s);
  assert.doesNotMatch(usbApplySource, /"profile",\s*"remove"[^\]]*"--keybag"/s);

  const profilePath = join(dataDir, "vigil-manageengine-policy.mobileconfig");
  const summaryPath = join(dataDir, "vigil-manageengine-policy.summary.json");
  const launcherProfilePath = join(dataDir, "vigil-social-launchers.mobileconfig");
  const launcherSummaryPath = join(dataDir, "vigil-social-launchers.summary.json");
  const result = await runExporter(["--out", profilePath, "--summary", summaryPath], dataDir);

  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /State saved: yes/);
  assert.equal((await stat(dataDir)).mode & 0o777, 0o700);
  for (const path of [
    join(dataDir, "state.json"),
    profilePath,
    summaryPath,
    launcherProfilePath,
    launcherSummaryPath
  ]) {
    assert.equal((await stat(path)).mode & 0o777, 0o600, `${path} should be private`);
  }

  const savedState = JSON.parse(await readFile(join(dataDir, "state.json"), "utf8")) as VigilState;
  const savedPassword = savedState.deviceControls.ios.removalPassword;
  assert.equal(typeof savedPassword, "string");
  const removalPassword = savedPassword as string;
  assert.ok(removalPassword.length >= 16);

  const profile = recordValue(parsePlist(await readFile(profilePath, "utf8")), "ManageEngine profile");
  assert.equal(profile.PayloadRemovalDisallowed, false);
  assert.ok(Array.isArray(profile.PayloadContent), "profile payload content should be an array");
  const removalPayload = profile.PayloadContent
    .map((item) => recordValue(item, "profile payload"))
    .find((payload) => payload.PayloadType === "com.apple.profileRemovalPassword");
  assert.equal(removalPayload, undefined, "Level 1 must not emit removal hardening");
  const restrictionsPayload = profile.PayloadContent
    .map((item) => recordValue(item, "profile payload"))
    .find((payload) => payload.PayloadType === "com.apple.applicationaccess");
  assert.equal(restrictionsPayload?.allowAppInstallation, true);
  assert.equal(restrictionsPayload?.allowAppRemoval, true);
  assert.equal(restrictionsPayload?.allowUIAppInstallation, true);
  assert.equal(restrictionsPayload?.blockedAppBundleIDs, undefined);
  assert.equal(restrictionsPayload?.allowListedAppBundleIDs, undefined);
  const webClips = profile.PayloadContent
    .map((item) => recordValue(item, "profile payload"))
    .filter((payload) => payload.PayloadType === "com.apple.webClip.managed");
  assert.equal(webClips.length, 0, "dynamic policy profile must not own launcher icons");
  const launcherProfile = recordValue(parsePlist(await readFile(launcherProfilePath, "utf8")), "ManageEngine launcher profile");
  assert.equal(launcherProfile.DurationUntilRemoval, undefined);
  assert.ok(Array.isArray(launcherProfile.PayloadContent));
  const launcherWebClips = launcherProfile.PayloadContent
    .map((item) => recordValue(item, "launcher profile payload"))
    .filter((payload) => payload.PayloadType === "com.apple.webClip.managed");
  assert.deepEqual(launcherWebClips.map((payload) => String(payload.Label || "")).sort(), ["Instagram", "Snapchat", "YouTube"]);
  for (const payload of launcherWebClips) {
    assert.equal(payload.PayloadDisplayName, payload.Label);
    assert.equal(payload.Precomposed, true);
    const service = String(payload.Label || "").toLowerCase() as keyof typeof IOS_SOCIAL_COMPANION_BUNDLE_IDS;
    assert.equal(payload.TargetApplicationBundleIdentifier, IOS_SOCIAL_COMPANION_BUNDLE_IDS[service]);
    const icon = recordValue(payload.Icon, "web clip icon data");
    assert.equal(typeof icon.__plistData, "string");
    assert.ok(String(icon.__plistData).length > 500, "web clip should include embedded PNG icon data");
  }

  const summaryText = await readFile(summaryPath, "utf8");
  const summary = recordValue(JSON.parse(summaryText), "ManageEngine export summary");
  assert.equal(summary.stateSaved, true);
  assert.equal(summary.deliveryProvider, "manageengine");
  assert.equal(summary.normalFreeDeliveryPath, true);
  assert.equal(summary.appBundleCount, 0);
  assert.equal(summary.deniedUrlCount, 0);
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
  const launcherArtifact = recordValue(summary.launcherProfile, "launcher artifact summary");
  assert.equal(launcherArtifact.outputPath, launcherProfilePath);
  assert.equal(launcherArtifact.summaryPath, launcherSummaryPath);
  assert.equal(launcherArtifact.webClipCount, 3);
  assert.equal(launcherArtifact.durationUntilRemoval, false);
  const launcherSummary = recordValue(JSON.parse(await readFile(launcherSummaryPath, "utf8")), "launcher sidecar summary");
  assert.equal(launcherSummary.mode, "static-social-launchers");
  assert.equal(launcherSummary.stablePayloadIdentities, true);
  assert.equal(recordValue(launcherSummary.deployment, "launcher deployment summary").status, "unverified");
  assert.equal(summaryText.includes(removalPassword), false);

  const observationPath = join(dataDir, "deployment-observation.json");
  const launcherObservationPath = join(dataDir, "launcher-deployment-observation.json");
  const observedProfilePath = join(dataDir, "observed-policy.mobileconfig");
  const observedSummaryPath = join(dataDir, "observed-policy.summary.json");
  await writeFile(observationPath, JSON.stringify({
    observedAt: "2026-07-10T12:00:00.000Z",
    installedProfileIdentifier: "tech.caseline.vigil.ios-lock",
    installedProfileHash: summary.artifactHash,
    effectiveProhibitAppInstall: false,
    effectiveProhibitAppDelete: false
  }));
  await writeFile(launcherObservationPath, JSON.stringify({
    observedAt: "2026-07-10T12:00:00.000Z",
    installedProfileIdentifier: "tech.caseline.vigil.ios-social-launchers",
    installedProfileHash: launcherSummary.artifactHash,
    effectiveProhibitAppInstall: false,
    effectiveProhibitAppDelete: false
  }));
  const observedResult = await runExporter([
    "--out", observedProfilePath,
    "--summary", observedSummaryPath,
    "--deployment-observation", observationPath,
    "--launcher-deployment-observation", launcherObservationPath
  ], dataDir);
  assert.equal(observedResult.code, 0, observedResult.stderr || observedResult.stdout);
  const observedSummary = recordValue(JSON.parse(await readFile(observedSummaryPath, "utf8")), "observed deployment summary");
  assert.equal(recordValue(observedSummary.deployment, "observed deployment").status, "current");
  assert.equal(recordValue(recordValue(observedSummary.launcherProfile, "observed launcher artifact").deployment, "observed launcher deployment").status, "current");
  const observedLauncherSummary = recordValue(JSON.parse(await readFile(launcherSummaryPath, "utf8")), "observed launcher sidecar");
  assert.equal(recordValue(observedLauncherSummary.deployment, "observed launcher sidecar deployment").status, "current");

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
    summaryPath: join(failureRoot, "blocked.summary.json"),
    launcherOutPath: join(failureRoot, "blocked-launcher.mobileconfig"),
    launcherSummaryPath: join(failureRoot, "blocked-launcher.summary.json")
  }));
  assert.equal((await stat(failureRoot)).mode & 0o777, 0o700);
  assert.equal((await readdir(failureRoot)).some((name) => name.startsWith(".blocked.mobileconfig.") && name.endsWith(".tmp")), false);
} finally {
  await rm(dataDir, { recursive: true, force: true });
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

    const profileText = await readFile(outPath, "utf8");
    const summary = recordValue(JSON.parse(await readFile(summaryPath, "utf8")), "overlap summary");
    assert.equal(summary.artifactHash, createHash("sha256").update(profileText).digest("hex"));
    assert.equal(summary.enforcementActive, false, "the second queued Level 1 export should win as a complete artifact set");
    const profile = recordValue(parsePlist(profileText), "overlap profile");
    assert.ok(Array.isArray(profile.PayloadContent));
    assert.equal(profile.PayloadContent.length, 1);
    const releasePayload = recordValue(profile.PayloadContent[0], "overlap Level 1 release payload");
    assert.equal(releasePayload.PayloadType, "com.apple.applicationaccess");
    assert.equal(releasePayload.allowAppInstallation, true);
    assert.equal(releasePayload.allowAppRemoval, true);
    const launcherPath = join(overlapDir, "vigil-social-launchers.mobileconfig");
    const launcherText = await readFile(launcherPath, "utf8");
    assert.equal(recordValue(summary.launcherProfile, "overlap launcher summary").artifactHash, createHash("sha256").update(launcherText).digest("hex"));
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
      resolve({ code, stdout, stderr });
    };
    child.once("error", (error) => {
      stderr += error.message;
      finish(1);
    });
    child.once("close", (code, signal) => {
      finish(signal || code === null ? 1 : code);
    });
  });
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
