import assert from "node:assert/strict";
import { test } from "node:test";
import { createECDH } from "node:crypto";
import { createNotificationRelay, emptyNotificationRelayState, notificationPushPayload, NOTIFICATION_SERVICES, parseNotificationEvent, validateNotificationRelayState } from "../src/socialNotificationRelay.js";
import type { NotificationEvent, PushResult } from "../src/socialNotificationRelay.js";

const now = 1800000000000, pairing = "a".repeat(64), source = "b".repeat(64);
const token = "c".repeat(64);
const message: NotificationEvent = { id: "opaque-event-id-0001", service: "instagram", kind: "message", occurredAt: now };
function fixture(send: (token: string, event: NotificationEvent) => Promise<PushResult> = async () => ({ accepted: true })) {
  let disk = JSON.stringify(emptyNotificationRelayState());
  const delivered: NotificationEvent[] = [];
  const handle = createNotificationRelay({ pairingToken: pairing, sourceToken: source, now: () => now,
    load: async () => JSON.parse(disk), save: async state => { disk = JSON.stringify(state); },
    send: async (token, event) => { delivered.push(event); return send(token, event); } });
  const request = (path: string, credential: string, body?: unknown, method = "POST") => handle(new Request("https://relay.test/api/notifications/" + path, {
    method, headers: { Authorization: "Bearer " + credential, "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  }));
  const pair = async (services = ["instagram", "snapchat"]) => {
    const response = await request("devices", pairing, { token, services }); assert.equal(response.status, 201);
    return await response.json() as { deviceID: string; secret: string };
  };
  return { request, pair, delivered, disk: () => JSON.parse(disk) };
}
test("all services are addressable; only the two selected services receive alerts", async () => {
  const f = fixture(); await f.pair();
  for (const service of NOTIFICATION_SERVICES) {
    assert.equal((await f.request("events", source, { ...message, id: "event-for-service-" + service, service })).status, 200);
  }
  assert.deepEqual(f.delivered.map(event => event.service), ["instagram", "snapchat"]);
});
test("device and source credentials are separate; one device cannot change another", async () => {
  const f = fixture(); const device = await f.pair(); const other = await f.pair();
  assert.equal((await f.request("events", pairing, message)).status, 401);
  assert.equal((await f.request("devices", source, { token, services: [] })).status, 401);
  assert.equal((await f.request("devices/" + other.deviceID, device.secret, { token, services: [] }, "PUT")).status, 401);
  assert.equal((await f.request("devices/" + device.deviceID, device.secret, { token, services: [] }, "PUT")).status, 200);
  assert.equal(f.disk().devices[device.deviceID].secretHash.includes(device.secret), false);
});
test("unknown, stale, media/activity and private payloads fail closed for contact services", async () => {
  const f = fixture(); await f.pair();
  for (const invalid of [{ ...message, body: "Private message" }, { ...message, url: "https://example.com" },
    { ...message, kind: "snap" }, { ...message, kind: "activity" }, { ...message, service: "unknown" },
    { ...message, occurredAt: now - 60001 }, { ...message, kind: "call", occurredAt: now - 30001 }]) {
    assert.equal((await f.request("events", source, invalid)).status, 400);
  }
  assert.equal(f.delivered.length, 0);
  const payload = notificationPushPayload(message);
  assert.deepEqual(payload, { aps: { alert: { title: "Instagram", body: "New message." }, sound: "default" }, vigilService: "instagram", vigilKind: "message" });
  assert.throws(() => parseNotificationEvent({ ...message, occurredAt: now + 6000 }, now));
});
test("concurrent duplicates send once, token refresh works, and disable/unpair stop delivery", async () => {
  const f = fixture(); const device = await f.pair();
  const results = await Promise.all(Array.from({ length: 4 }, () => f.request("events", source, message)));
  assert.ok(results.every(result => result.status === 200)); assert.equal(f.delivered.length, 1);
  const path = "devices/" + device.deviceID;
  assert.equal((await f.request(path, device.secret, { token: "d".repeat(64), services: [] }, "PUT")).status, 200);
  await f.request("events", source, { ...message, id: "opaque-event-id-0002" }); assert.equal(f.delivered.length, 1);
  assert.equal((await f.request(path, device.secret, undefined, "DELETE")).status, 200);
  assert.equal(Object.keys(f.disk().devices).length, 0);
});
test("transient APNs failure retries; expired tokens are retired", async () => {
  let attempts = 0;
  const f = fixture(async () => ({ accepted: ++attempts > 1 })); await f.pair();
  assert.equal((await f.request("events", source, message)).status, 503);
  assert.equal((await f.request("events", source, message)).status, 200);
  assert.equal(attempts, 2);
  const expired = fixture(async () => ({ accepted: false, invalidToken: true })); await expired.pair();
  await expired.request("events", source, message); assert.equal(Object.keys(expired.disk().devices).length, 0);
});
test("corrupt durable state fails instead of silently losing registrations", async () => {
  assert.throws(() => validateNotificationRelayState({ schemaVersion: 1, devices: {}, delivered: { anything: 3 } }));
  const handle = createNotificationRelay({ pairingToken: pairing, sourceToken: source,
    load: async () => { throw new Error("Unreadable disk"); }, save: async () => assert.fail("Must not replace state"),
    send: async () => assert.fail("Must not send") });
  const result = await handle(new Request("https://relay.test/api/notifications/events", { method: "POST", headers: { Authorization: "Bearer " + source } }));
  assert.equal(result.status, 503);
});
test("free Web Push devices pair, filter services and use their own transport", async () => {
  let state = emptyNotificationRelayState(), webSends = 0;
  const handle = createNotificationRelay({ pairingToken: pairing, sourceToken: source, now: () => now,
    load: async () => structuredClone(state), save: async next => { state = structuredClone(next); },
    send: async () => assert.fail("A free receiver must not use native APNs"),
    sendWebPush: async () => { webSends++; return { accepted: true }; } });
  const ecdh = createECDH("prime256v1");
  const subscription = { endpoint: "https://web.push.apple.com/test-subscription", keys: {
    p256dh: ecdh.generateKeys().toString("base64url"), auth: Buffer.alloc(16, 2).toString("base64url") } };
  const request = (path: string, credential: string, body: unknown) => handle(new Request("https://receiver.test/api/notifications/" + path, {
    method: "POST", headers: { Authorization: "Bearer " + credential, "Content-Type": "application/json" }, body: JSON.stringify(body) }));
  assert.equal((await request("devices", pairing, { subscription, services: ["instagram", "snapchat"] })).status, 201);
  assert.equal((await request("events", source, message)).status, 200);
  assert.equal((await request("events", source, { ...message, id: "off-service-message-0001", service: "reddit" })).status, 200);
  assert.equal(webSends, 1);
});
