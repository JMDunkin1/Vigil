import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultState } from "../../src/defaults.js";
import { resolveDefaultDataDir } from "../../src/store.js";
import { stateDigest, verifyStateTextSeal, writeStateTextSeal } from "../../src/seal.js";
import { sourceManifestText, sourceSealStatus, writeSourceSeal } from "../../src/sourceSeal.js";

const now = new Date("2026-05-28T14:00:00-04:00");
const TEST_DAYS = [0, 1, 2, 3, 4, 5, 6];

assert.equal(resolveDefaultDataDir(join("/tmp", "sentinel", "dist", "runtime")), join("/tmp", "sentinel", "data"));
assert.equal(
  resolveDefaultDataDir("/Applications/Sentinel.app/Contents/Resources/app.asar/dist/runtime"),
  "/Applications/Sentinel.app/Contents/Resources/app.asar/dist/runtime/data"
);

{
  const dir = await mkdtemp(join(tmpdir(), "sentinel-source-seal-"));
  try {
    await mkdir(join(dir, "src"), { recursive: true });
    await mkdir(join(dir, "scripts"), { recursive: true });
    await writeFile(join(dir, "package.json"), "{\"type\":\"module\"}\n");
    await writeFile(join(dir, "src", "server.js"), "console.log('ok');\n");
    await writeFile(join(dir, "scripts", "tool.mjs"), "console.log('tool');\n");
    const keyPath = join(dir, "state-seal.key");
    const sealPath = join(dir, "source.seal.json");
    const initial = await sourceSealStatus({ root: dir, keyPath, sealPath });
    assert.equal(initial.ok, false);
    assert.equal(initial.status, "missing");
    const written = await writeSourceSeal({ root: dir, keyPath, sealPath, sealedAt: now.toISOString() });
    assert.equal(written.ok, true);
    const sealed = await sourceSealStatus({ root: dir, keyPath, sealPath });
    assert.equal(sealed.ok, true);
    const manifest = JSON.parse(await sourceManifestText({ root: dir })) as { files: Array<{ path: string }> };
    assert.deepEqual(manifest.files.map((file) => file.path), ["package.json", "scripts/tool.mjs", "src/server.js"]);
    await writeFile(join(dir, "src", "server.js"), "console.log('changed');\n");
    const changed = await sourceSealStatus({ root: dir, keyPath, sealPath });
    assert.equal(changed.status, "mismatch");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

{
  const dir = await mkdtemp(join(tmpdir(), "sentinel-seal-"));
  try {
    const keyPath = join(dir, "state-seal.key");
    const sealPath = join(dir, "state.seal.json");
    const text = "{\"settings\":{\"strictByDefault\":true}}\n";
    const seal = await writeStateTextSeal(text, { keyPath, sealPath }, now.toISOString());
    const key = (await readFile(keyPath, "utf8")).trim();

    assert.equal(seal.digest, stateDigest(text, key));
    assert.equal((await verifyStateTextSeal(text, { keyPath, sealPath })).status, "sealed");
    assert.equal((await verifyStateTextSeal(text.replace("true", "false"), { keyPath, sealPath })).status, "mismatch");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

{
  const dir = await mkdtemp(join(tmpdir(), "sentinel-protected-seal-"));
  try {
    const keyPath = join(dir, "state-seal.key");
    const sealPath = join(dir, "state.seal.json");
    const state = defaultState();
    const text = `${JSON.stringify(state, null, 2)}\n`;
    await writeStateTextSeal(text, { keyPath, sealPath, scope: "state" }, now.toISOString());

    const bookkeepingChange = structuredClone(state);
    bookkeepingChange.events.unshift({ id: "event", type: "note", detail: {}, at: now.toISOString() });
    bookkeepingChange.integrity.runtime.lastHeartbeatAt = new Date(now.getTime() + 1000).toISOString();
    const bookkeepingText = `${JSON.stringify(bookkeepingChange, null, 2)}\n`;
    const bookkeepingVerification = await verifyStateTextSeal(bookkeepingText, { keyPath, sealPath });
    assert.equal(bookkeepingVerification.ok, true);
    assert.equal(bookkeepingVerification.status, "bookkeeping-mismatch");

    const bypassChange = structuredClone(state);
    bypassChange.settings.siteRedirectEnabled = false;
    const bypassText = `${JSON.stringify(bypassChange, null, 2)}\n`;
    assert.equal((await verifyStateTextSeal(bypassText, { keyPath, sealPath })).status, "mismatch");

    const runtimeThresholdChange = structuredClone(state);
    runtimeThresholdChange.settings.runtimeGapLockdownSeconds = 999999;
    const runtimeThresholdText = `${JSON.stringify(runtimeThresholdChange, null, 2)}\n`;
    assert.equal((await verifyStateTextSeal(runtimeThresholdText, { keyPath, sealPath })).status, "mismatch");

    const clockThresholdChange = structuredClone(state);
    clockThresholdChange.settings.clockTamperLockdownSeconds = 999999;
    const clockThresholdText = `${JSON.stringify(clockThresholdChange, null, 2)}\n`;
    assert.equal((await verifyStateTextSeal(clockThresholdText, { keyPath, sealPath })).status, "mismatch");

    const phoneSessionChange = structuredClone(state);
    phoneSessionChange.activeSessions.phone = {
      id: "phone-session-tamper",
      title: "Phone session tamper",
      mode: "focus",
      profileId: "default",
      lockLevel: "deep",
      startedAt: now.toISOString(),
      endsAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
      canEndEarly: false,
      source: "manual",
      deviceTargets: ["phone"]
    };
    const phoneSessionText = `${JSON.stringify(phoneSessionChange, null, 2)}\n`;
    assert.equal((await verifyStateTextSeal(phoneSessionText, { keyPath, sealPath })).status, "mismatch");

    const focusedSocialChange = structuredClone(state);
    focusedSocialChange.deviceControls.ios.focusedSocial.enabled = false;
    const focusedSocialText = `${JSON.stringify(focusedSocialChange, null, 2)}\n`;
    assert.equal((await verifyStateTextSeal(focusedSocialText, { keyPath, sealPath })).status, "mismatch");

    const grayscaleChange = structuredClone(state);
    grayscaleChange.grayscale.softBlockEnabled = true;
    grayscaleChange.grayscale.schedules = [{
      id: "night",
      name: "Night grayscale",
      enabled: true,
      days: TEST_DAYS,
      start: "22:00",
      end: "07:00",
      deviceTargets: ["computer", "phone"]
    }];
    const grayscaleText = `${JSON.stringify(grayscaleChange, null, 2)}\n`;
    assert.equal((await verifyStateTextSeal(grayscaleText, { keyPath, sealPath })).status, "mismatch");

    const legacyBrandingState = structuredClone(state);
    legacyBrandingState.settings.focusShortcutOnName = "Local Screen Time Focus On";
    legacyBrandingState.settings.focusShortcutOffName = "Local Screen Time Focus Off";
    const legacyBrandingText = `${JSON.stringify(legacyBrandingState, null, 2)}\n`;
    await writeStateTextSeal(legacyBrandingText, { keyPath, sealPath, scope: "state" }, now.toISOString());
    const sentinelBrandingState = structuredClone(legacyBrandingState);
    sentinelBrandingState.settings.focusShortcutOnName = "Sentinel Focus On";
    sentinelBrandingState.settings.focusShortcutOffName = "Sentinel Focus Off";
    const sentinelBrandingVerification = await verifyStateTextSeal(`${JSON.stringify(sentinelBrandingState, null, 2)}\n`, { keyPath, sealPath });
    assert.equal(sentinelBrandingVerification.ok, true);
    assert.equal(sentinelBrandingVerification.status, "trusted-migration");

    const preIntentionalUseState = structuredClone(state);
    delete (preIntentionalUseState as Partial<typeof preIntentionalUseState>).intentionalUse;
    delete (preIntentionalUseState.settings as Partial<typeof preIntentionalUseState.settings>).intentionalUseEnabled;
    await writeStateTextSeal(`${JSON.stringify(preIntentionalUseState, null, 2)}\n`, { keyPath, sealPath, scope: "state" }, now.toISOString());
    const intentionalUseMigrationVerification = await verifyStateTextSeal(text, { keyPath, sealPath });
    assert.equal(intentionalUseMigrationVerification.ok, true);
    assert.equal(intentionalUseMigrationVerification.status, "trusted-migration");

    const preGrayscaleState = structuredClone(state);
    delete (preGrayscaleState as Partial<typeof preGrayscaleState>).grayscale;
    await writeStateTextSeal(`${JSON.stringify(preGrayscaleState, null, 2)}\n`, { keyPath, sealPath, scope: "state" }, now.toISOString());
    const grayscaleMigrationVerification = await verifyStateTextSeal(text, { keyPath, sealPath });
    assert.equal(grayscaleMigrationVerification.ok, true);
    assert.equal(grayscaleMigrationVerification.status, "trusted-migration");

    const preActiveSessionsState = structuredClone(state);
    delete (preActiveSessionsState as Partial<typeof preActiveSessionsState>).activeSessions;
    await writeStateTextSeal(`${JSON.stringify(preActiveSessionsState, null, 2)}\n`, { keyPath, sealPath, scope: "state" }, now.toISOString());
    const activeSessionsMigrationVerification = await verifyStateTextSeal(text, { keyPath, sealPath });
    assert.equal(activeSessionsMigrationVerification.ok, true);
    assert.equal(activeSessionsMigrationVerification.status, "bookkeeping-mismatch");
    assert.equal((await verifyStateTextSeal(phoneSessionText, { keyPath, sealPath })).status, "mismatch");

    const legacyActiveSessionState = structuredClone(state);
    legacyActiveSessionState.activeSession = {
      id: "legacy-active-session",
      title: "Legacy active session",
      mode: "focus",
      profileId: "default",
      lockLevel: "deep",
      startedAt: now.toISOString(),
      endsAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
      canEndEarly: false,
      source: "manual"
    };
    delete (legacyActiveSessionState as Partial<typeof legacyActiveSessionState>).activeSessions;
    await writeStateTextSeal(`${JSON.stringify(legacyActiveSessionState, null, 2)}\n`, { keyPath, sealPath, scope: "state" }, now.toISOString());
    const migratedLegacyActiveSessionState = structuredClone(legacyActiveSessionState);
    migratedLegacyActiveSessionState.activeSessions = {
      computer: legacyActiveSessionState.activeSession,
      phone: legacyActiveSessionState.activeSession
    };
    const migratedLegacyActiveSessionVerification = await verifyStateTextSeal(`${JSON.stringify(migratedLegacyActiveSessionState, null, 2)}\n`, { keyPath, sealPath });
    assert.equal(migratedLegacyActiveSessionVerification.ok, true);
    assert.equal(migratedLegacyActiveSessionVerification.status, "trusted-migration");

    const mdmQueueState = structuredClone(state);
    mdmQueueState.deviceControls.ios.mdm.enabled = true;
    mdmQueueState.deviceControls.ios.mdm.devices = [{ udid: "iphone-udid-1", status: "enrolled" }];
    mdmQueueState.deviceControls.ios.mdm.commands = [{
      udid: "iphone-udid-1",
      requestType: "InstallProfile",
      status: "queued",
      policyHash: "policy-hash"
    }];
    mdmQueueState.deviceControls.ios.mdm.lastPolicyHash = "policy-hash";
    const mdmQueueText = `${JSON.stringify(mdmQueueState, null, 2)}\n`;
    await writeStateTextSeal(mdmQueueText, { keyPath, sealPath, scope: "state" }, now.toISOString());
    mdmQueueState.deviceControls.ios.mdm.commands = [];
    assert.equal((await verifyStateTextSeal(`${JSON.stringify(mdmQueueState, null, 2)}\n`, { keyPath, sealPath })).status, "mismatch");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
