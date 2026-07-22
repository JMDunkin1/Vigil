import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { parsePlist } from "../src/plist.js";
import { IOS_SOCIAL_COMPANION_APPS, IOS_SOCIAL_COMPANION_BUNDLE_IDS } from "../src/socialFeatureFilters.js";
import type { VigilState } from "../src/types.js";
import { recordValue } from "./test-helpers.mjs";

const dataRoot = await mkdtemp(join(tmpdir(), "vigil-manageengine-auto-export-"));
const stateDir = join(dataRoot, "state");
const manageEngineDir = join(dataRoot, "manageengine");
process.env.VIGIL_DATA_DIR = stateDir;
process.env.VIGIL_MANAGEENGINE_DIR = manageEngineDir;

const { startVigilServer, stopVigilServer } = await import("../src/server.js");

try {
  const handle = await startVigilServer({ host: "127.0.0.1", port: 0 });
  const initialStateResponse = await fetch(`${handle.url}/api/state`);
  assert.equal(initialStateResponse.status, 200);
  const initialStatePayload = recordValue(await initialStateResponse.json(), "initial state payload");
  assert.equal(manageEngineSummary(initialStatePayload).currentGeneration, false);
  const requestExport = () => fetch(`${handle.url}/api/devices/ios/usb-profile-apply`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-vigil-intent": "vigil-app"
    },
    body: "{}"
  });
  const responses = await Promise.all([requestExport(), requestExport()]);
  for (const response of responses) assert.equal(response.status, 200, await response.text());

  const refreshedStateResponse = await fetch(`${handle.url}/api/state`);
  assert.equal(refreshedStateResponse.status, 200);
  const refreshedStatePayload = recordValue(await refreshedStateResponse.json(), "refreshed state payload");
  assert.equal(
    manageEngineSummary(refreshedStatePayload).currentGeneration,
    true,
    "persisted generation evidence must invalidate the earlier diagnostic snapshot and verify the published artifacts"
  );

  const profilePath = join(manageEngineDir, "vigil-manageengine-policy.mobileconfig");
  const summaryPath = join(manageEngineDir, "vigil-manageengine-policy.summary.json");
  const launcherProfilePath = join(manageEngineDir, "vigil-social-launchers.mobileconfig");
  const launcherSummaryPath = join(manageEngineDir, "vigil-social-launchers.summary.json");
  await waitForFile(profilePath);
  await waitForFile(summaryPath);

  const profileText = await readFile(profilePath, "utf8");
  const profile = recordValue(parsePlist(profileText), "auto-exported ManageEngine profile");
  assert.equal(profile.PayloadIdentifier, "tech.caseline.vigil.ios-lock");
  assert.ok(Array.isArray(profile.PayloadContent));
  const webClips = profile.PayloadContent
    .map((item) => recordValue(item, "profile payload"))
    .filter((payload) => payload.PayloadType === "com.apple.webClip.managed");
  assert.equal(webClips.length, 0);
  assert.equal(await fileExists(launcherProfilePath), false);
  assert.equal(await fileExists(launcherSummaryPath), false);

  const summary = recordValue(JSON.parse(await readFile(summaryPath, "utf8")), "auto-export summary");
  assert.equal(summary.mode, "managed-policy");
  assert.equal(summary.deliveryProvider, "manageengine");
  assert.equal(summary.enabled, true);
  assert.equal(summary.outputPath, profilePath);
  assert.equal(summary.appStoreAllowedByThisProfile, true);
  assert.equal(summary.artifactHash, createHash("sha256").update(profileText).digest("hex"));
  assert.equal(recordValue(summary.deployment, "auto-export deployment").status, "unverified");
  const companionApps = recordValue(summary.companionApps, "auto-export companion summary");
  assert.equal(companionApps.appCount, 2);
  assert.deepEqual(companionApps.bundleIds, Object.values(IOS_SOCIAL_COMPANION_BUNDLE_IDS));
  assert.deepEqual(companionApps.apps, IOS_SOCIAL_COMPANION_APPS.map((app) => ({ ...app })));
  assert.equal(recordValue(summary.launcherProfile, "auto-export retired launcher summary").webClipCount, 0);

  const state = await waitForStateEvent(join(stateDir, "state.json"), "ios_manageengine_policy_exported");
  const events = Array.isArray(state.events) ? state.events.map((event) => recordValue(event, "event")) : [];
  assert.equal(events.some((event) => event.type === "ios_manageengine_policy_exported"), true);
  const ios = recordValue(recordValue(state.deviceControls, "device controls").ios, "iOS settings");
  const generation = recordValue(ios.manageEngineGeneration, "persisted ManageEngine generation");
  assert.equal(generation.profileHash, summary.artifactHash);
  assert.equal(generation.generation, basename(await realpath(join(manageEngineDir, "current"))));
  assert.match(String(generation.generatedAt || ""), /^\d{4}-\d{2}-\d{2}T/u);

  const { iosProfileSummary } = await import("../src/iosProfiles.js");
  const durableSummary = iosProfileSummary(state as unknown as VigilState);
  assert.equal(durableSummary.manageEngine.currentGeneration, true);
  assert.equal(durableSummary.manageEngine.generation, generation.generation);
  assert.equal(durableSummary.manageEngine.generatedAt, generation.generatedAt);
  assert.equal(durableSummary.manageEngine.profileHash, generation.profileHash);

  const { deviceSummary } = await import("../src/devices.js");
  const verifiedDevices = await deviceSummary(state as unknown as VigilState, {
    manageEngineOutputDirectory: manageEngineDir
  });
  assert.equal(verifiedDevices.ios.manageEngine.currentGeneration, true);

  const generationPath = await realpath(join(manageEngineDir, "current"));
  await writeFile(join(generationPath, "main", basename(profilePath)), "corrupted profile bytes", { mode: 0o600 });
  assert.equal(
    iosProfileSummary(state as unknown as VigilState).manageEngine.currentGeneration,
    true,
    "the pure profile summary should continue to describe protected state evidence"
  );
  const corruptedDevices = await deviceSummary(state as unknown as VigilState, {
    manageEngineOutputDirectory: manageEngineDir
  });
  assert.equal(
    corruptedDevices.ios.manageEngine.currentGeneration,
    false,
    "setup readiness must fail closed when the pinned current generation no longer verifies"
  );
} finally {
  try {
    await stopVigilServer();
  } finally {
    await removeTemporaryData(dataRoot);
  }
}

function manageEngineSummary(payload: Record<string, unknown>): Record<string, unknown> {
  const devices = recordValue(payload.devices, "device summary");
  const ios = recordValue(devices.ios, "iOS device summary");
  return recordValue(ios.manageEngine, "ManageEngine device summary");
}

async function removeTemporaryData(path: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : "";
      if (code !== "ENOTEMPTY" || attempt === 19) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const file = await stat(path).catch(() => null);
    if (file?.isFile() && file.size > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`Timed out waiting for ${path}`);
}

async function fileExists(path: string): Promise<boolean> {
  return Boolean(await stat(path).catch(() => null));
}

async function waitForStateEvent(path: string, type: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const state = await readStateFile(path);
    const events = Array.isArray(state?.events) ? state.events : [];
    if (events.some((event) => recordValue(event, "event").type === type)) return recordValue(state, "saved state");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`Timed out waiting for state event ${type}`);
}

async function readStateFile(path: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch (error) {
    if (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT") return null;
    throw error;
  }
}
