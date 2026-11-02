import assert from "node:assert/strict";
import { createECDH } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import vm from "node:vm";
import { test } from "node:test";
import { validateWebPushSubscription } from "../src/socialNotificationRelay.js";
import { createWebPushSender } from "../src/socialNotificationWebPush.js";
import webpush from "web-push";

async function receiverWorkerPath(): Promise<string> {
  for (const root of [process.cwd(), resolve(process.cwd(), "..", "..")]) {
    const path = join(root, "services", "notifications", "receiver", "worker.js");
    try { await access(path); return path; } catch { /* try the source checkout */ }
  }
  throw new Error("Could not locate the notification receiver worker in the source checkout.");
}

test("iPhone push subscriptions cannot become arbitrary outbound requests", () => {
  const ecdh = createECDH("prime256v1");
  const subscription = { endpoint: "https://web.push.apple.com/fixture-subscription", keys: {
    p256dh: ecdh.generateKeys().toString("base64url"), auth: Buffer.alloc(16, 1).toString("base64url") } };
  assert.equal(validateWebPushSubscription(subscription).endpoint, subscription.endpoint);
  for (const endpoint of ["http://web.push.apple.com/a", "https://127.0.0.1/a", "https://web.push.apple.com.attacker.test/a",
    "https://web.push.apple.com@attacker.test/a", "https://web.push.apple.com:8443/a", "https://web.push.apple.com/a?secret=1"]) {
    assert.throws(() => validateWebPushSubscription({ ...subscription, endpoint }));
  }
  assert.throws(() => validateWebPushSubscription({ ...subscription, keys: { ...subscription.keys, p256dh: "bad" } }));
});
test("Web Push requires an actual matching VAPID pair; no paid credentials are needed", () => {
  const keys = webpush.generateVAPIDKeys();
  assert.equal(typeof createWebPushSender(keys, "https://receiver.test"), "function");
  assert.throws(() => createWebPushSender({ ...keys, privateKey: webpush.generateVAPIDKeys().privateKey }, "https://receiver.test"));
  assert.throws(() => createWebPushSender(keys, "http://receiver.test"));
});
test("receiver displays generic text and opens only its own service-selection page", async () => {
  const handlers: Record<string, (event: unknown) => void> = {};
  const shown: unknown[] = [], opened: string[] = [];
  const context = vm.createContext({ URL, self: {
    location: { origin: "https://receiver.test" },
    registration: { showNotification: async (title: string, options: unknown) => { shown.push({ title, options }); } },
    clients: { openWindow: async (url: string) => { opened.push(url); } },
    addEventListener: (name: string, callback: (event: unknown) => void) => { handlers[name] = callback; }
  } });
  vm.runInContext(await readFile(await receiverWorkerPath(), "utf8"), context);
  let completion = Promise.resolve() as Promise<unknown>;
  handlers.push({ data: { json: () => ({ service: "snapchat", kind: "message", title: "Private sender", body: "Private content", url: "https://example.test" }) },
    waitUntil: (promise: Promise<unknown>) => { completion = promise; } });
  await completion;
  assert.deepEqual(JSON.parse(JSON.stringify(shown)), [{ title: "Snapchat", options: {
    body: "New message.", data: { service: "snapchat" }, tag: "vigil-snapchat-message"
  } }]);
  handlers.notificationclick({ notification: { data: { service: "snapchat", url: "https://example.test" }, close: () => {} },
    waitUntil: (promise: Promise<unknown>) => { completion = promise; } });
  await completion;
  assert.deepEqual(opened, ["https://receiver.test/notifications/?open=snapchat"]);
  handlers.push({ data: { json: () => { throw new Error("Malformed payload"); } },
    waitUntil: (promise: Promise<unknown>) => { completion = promise; } });
  await completion;
  assert.equal(shown.length, 2, "Received pushes cannot be invisible in Safari");
});
