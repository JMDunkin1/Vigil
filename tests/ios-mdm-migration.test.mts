import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataRoot = await mkdtemp(join(tmpdir(), "sentinel-mdm-token-migration-"));
process.env.SENTINEL_DATA_DIR = join(dataRoot, "state");

const { defaultState } = await import("../src/defaults.js");
const { buildIosMdmEnrollmentProfile } = await import("../src/iosMdm.js");
const { toPlist } = await import("../src/plist.js");
const { DATA_DIR, saveState } = await import("../src/store.js");
const { startSentinelServer, stopSentinelServer } = await import("../src/server.js");

assert.equal(DATA_DIR, process.env.SENTINEL_DATA_DIR, "the migration server test must stay bound to its temporary data directory");

const now = new Date("2026-05-28T14:00:00-04:00");
const legacySecret = "server-legacy-enrollment-secret";
const legacyUdid = "server-legacy-iphone";
const state = defaultState();
state.deviceControls.ios.enabled = true;
state.deviceControls.ios.mdm = {
  ...state.deviceControls.ios.mdm,
  enabled: true,
  publicBaseUrl: "https://mdm.example.test",
  topic: "com.apple.mgmt.sentinel-migration-test",
  identityCertificateUuid: "11111111-2222-3333-4444-555555555555",
  identityCertificatePayloadBase64: pkcs12ShapeFixture(),
  pushCertificatePayloadBase64: pkcs12ShapeFixture(),
  enrollmentSecret: legacySecret,
  devices: [{
    id: "server-legacy-device",
    udid: legacyUdid,
    status: "enrolled",
    firstSeenAt: now.toISOString(),
    lastSeenAt: now.toISOString()
  }]
};
const enrollment = buildIosMdmEnrollmentProfile(state);
const oneTimeToken = enrollment.match(/token=([^<]+)/)?.[1] || "";
await saveState(state);

try {
  const handle = await startSentinelServer({ host: "127.0.0.1", port: 0 });
  const exchange = async (path: string, token: string, body: Record<string, unknown>) => {
    return await fetch(`${handle.url}${path}?token=${encodeURIComponent(token)}`, {
      method: "PUT",
      headers: { "content-type": "application/xml" },
      body: toPlist(body)
    });
  };

  const legacyCheckIn = await exchange("/mdm/checkin", legacySecret, {
    MessageType: "Authenticate",
    Topic: "com.apple.mgmt.sentinel-migration-test",
    UDID: legacyUdid
  });
  assert.equal(legacyCheckIn.status, 200, await legacyCheckIn.text());

  const legacyConnect = await exchange("/mdm/connect", legacySecret, {
    Status: "Idle",
    UDID: legacyUdid
  });
  assert.equal(legacyConnect.status, 200, await legacyConnect.text());

  const unknownLegacyCheckIn = await exchange("/mdm/checkin", legacySecret, {
    MessageType: "Authenticate",
    UDID: "unknown-server-iphone"
  });
  assert.equal(unknownLegacyCheckIn.status, 403, await unknownLegacyCheckIn.text());

  const newDeviceCheckIn = await exchange("/mdm/checkin", oneTimeToken, {
    MessageType: "Authenticate",
    Topic: "com.apple.mgmt.sentinel-migration-test",
    UDID: "new-server-iphone"
  });
  assert.equal(newDeviceCheckIn.status, 200, await newDeviceCheckIn.text());
} finally {
  await stopSentinelServer().catch(() => {});
  delete process.env.SENTINEL_DATA_DIR;
  await rm(dataRoot, { recursive: true, force: true });
}

function pkcs12ShapeFixture(): string {
  return Buffer.concat([Buffer.from([0x30, 0x82, 0x00, 0x80]), Buffer.alloc(128, 1)]).toString("base64");
}
