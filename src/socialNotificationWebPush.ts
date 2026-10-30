import webpush from "web-push";
import { createECDH } from "node:crypto";
import { notificationPushPayload, validateWebPushSubscription } from "./socialNotificationRelay.js";
import type { NotificationRelayOptions } from "./socialNotificationRelay.js";

// Standards-based transport for a Home Screen receiver, requiring neither a
// native push entitlement nor paid Apple membership. Filtering happens BEFORE
// sending: Safari requires every received push to display a notification.
export function createWebPushSender(keys: { publicKey: string; privateKey: string }, origin: string): NonNullable<NotificationRelayOptions["sendWebPush"]> {
  const url = new URL(origin);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Configure the actual HTTPS receiver origin");
  // Validate the pair using the library without sending anything.
  webpush.getVapidHeaders(url.origin, url.origin, keys.publicKey, keys.privateKey, "aes128gcm");
  const verificationKey = createECDH("prime256v1");
  verificationKey.setPrivateKey(Buffer.from(keys.privateKey, "base64url"));
  if (verificationKey.getPublicKey().toString("base64url") !== keys.publicKey) throw new Error("Web Push key pair does not match");
  return async (subscription, event) => {
    const verified = validateWebPushSubscription(subscription);
    const native = notificationPushPayload(event) as { aps: { alert: { title: string; body: string } } };
    try {
      const response = await webpush.sendNotification(verified, JSON.stringify({
        title: native.aps.alert.title, body: native.aps.alert.body, service: event.service, kind: event.kind
      }), { vapidDetails: { subject: url.origin, ...keys }, contentEncoding: "aes128gcm", timeout: 8000,
        TTL: Math.max(0, Math.floor((event.occurredAt + (event.kind === "call" ? 30000 : 60000) - Date.now()) / 1000)), urgency: "high" });
      return { accepted: response.statusCode === 201 || response.statusCode === 200 };
    } catch (error) {
      const status = error && typeof error === "object" && "statusCode" in error ? error.statusCode : null;
      return { accepted: false, invalidToken: status === 404 || status === 410 };
    }
  };
}
