import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePlist } from "../src/plist.js";
import { IOS_SOCIAL_COMPANION_BUNDLE_IDS } from "../src/socialFeatureFilters.js";
import { recordValue } from "./test-helpers.mjs";

const dataRoot = await mkdtemp(join(tmpdir(), "vigil-manageengine-auto-export-"));
const stateDir = join(dataRoot, "state");
const manageEngineDir = join(dataRoot, "manageengine");
process.env.VIGIL_DATA_DIR = stateDir;
process.env.VIGIL_MANAGEENGINE_DIR = manageEngineDir;

const { startVigilServer, stopVigilServer } = await import("../src/server.js");

try {
  const handle = await startVigilServer({ host: "127.0.0.1", port: 0 });
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

  const profilePath = join(manageEngineDir, "vigil-manageengine-policy.mobileconfig");
  const summaryPath = join(manageEngineDir, "vigil-manageengine-policy.summary.json");
  const launcherProfilePath = join(manageEngineDir, "vigil-social-launchers.mobileconfig");
  const launcherSummaryPath = join(manageEngineDir, "vigil-social-launchers.summary.json");
  await waitForFile(profilePath);
  await waitForFile(summaryPath);
  await waitForFile(launcherProfilePath);
  await waitForFile(launcherSummaryPath);

  const profileText = await readFile(profilePath, "utf8");
  const profile = recordValue(parsePlist(profileText), "auto-exported ManageEngine profile");
  assert.equal(profile.PayloadIdentifier, "tech.caseline.vigil.ios-lock");
  assert.ok(Array.isArray(profile.PayloadContent));
  const webClips = profile.PayloadContent
    .map((item) => recordValue(item, "profile payload"))
    .filter((payload) => payload.PayloadType === "com.apple.webClip.managed");
  assert.equal(webClips.length, 0);
  const launcherProfile = recordValue(parsePlist(await readFile(launcherProfilePath, "utf8")), "auto-exported launcher profile");
  assert.ok(Array.isArray(launcherProfile.PayloadContent));
  const launcherWebClips = launcherProfile.PayloadContent
    .map((item) => recordValue(item, "launcher profile payload"))
    .filter((payload) => payload.PayloadType === "com.apple.webClip.managed");
  assert.deepEqual(launcherWebClips.map((payload) => String(payload.Label || "")).sort(), ["Instagram", "Snapchat", "YouTube"]);
  assert.equal(launcherWebClips.every((payload) => payload.PayloadDisplayName === payload.Label), true);
  assert.equal(launcherWebClips.every((payload) => payload.Precomposed === true), true);
  assert.deepEqual(
    launcherWebClips.map((payload) => payload.TargetApplicationBundleIdentifier).sort(),
    Object.values(IOS_SOCIAL_COMPANION_BUNDLE_IDS).sort()
  );

  const summary = recordValue(JSON.parse(await readFile(summaryPath, "utf8")), "auto-export summary");
  assert.equal(summary.mode, "managed-policy");
  assert.equal(summary.deliveryProvider, "manageengine");
  assert.equal(summary.enabled, true);
  assert.equal(summary.outputPath, profilePath);
  assert.equal(summary.appStoreAllowedByThisProfile, true);
  assert.equal(summary.artifactHash, createHash("sha256").update(profileText).digest("hex"));
  assert.equal(recordValue(summary.deployment, "auto-export deployment").status, "unverified");
  assert.equal(recordValue(summary.launcherProfile, "auto-export launcher summary").outputPath, launcherProfilePath);

  const state = await waitForStateEvent(join(stateDir, "state.json"), "ios_manageengine_policy_exported");
  const events = Array.isArray(state.events) ? state.events.map((event) => recordValue(event, "event")) : [];
  assert.equal(events.some((event) => event.type === "ios_manageengine_policy_exported"), true);
} finally {
  try {
    await stopVigilServer();
  } finally {
    await removeTemporaryData(dataRoot);
  }
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
