import { createHash, createPrivateKey, randomBytes, sign, timingSafeEqual } from "node:crypto";
import { connect } from "node:http2";

export const NOTIFICATION_SERVICES = ["instagram", "youtube", "snapchat", "linkedin", "facebook", "x", "tiktok", "reddit"] as const;
export type NotificationService = typeof NOTIFICATION_SERVICES[number];
export type NotificationKind = "message" | "call" | "activity";
const names = { instagram: "Instagram", youtube: "YouTube", snapchat: "Snapchat", linkedin: "LinkedIn", facebook: "Facebook", x: "X", tiktok: "TikTok", reddit: "Reddit" };
export interface WebPushSubscription { endpoint: string; keys: { p256dh: string; auth: string } }
type Device = { secretHash: string; token: string; subscription?: WebPushSubscription; services: NotificationService[]; updatedAt: number };
export interface NotificationRelayState { schemaVersion: 1; devices: Record<string, Device>; delivered: Record<string, number> }
export const emptyNotificationRelayState = (): NotificationRelayState => ({ schemaVersion: 1, devices: {}, delivered: {} });
export interface NotificationEvent { id: string; service: NotificationService; kind: NotificationKind; occurredAt: number }
export interface PushResult { accepted: boolean; invalidToken?: boolean }
export interface NotificationRelayOptions {
  pairingToken: string;
  sourceToken: string;
  load: () => Promise<NotificationRelayState>;
  save: (state: NotificationRelayState) => Promise<void>;
  send: (token: string, event: NotificationEvent) => Promise<PushResult>;
  nativePushEnabled?: boolean;
  sendWebPush?: (subscription: WebPushSubscription, event: NotificationEvent) => Promise<PushResult>;
  now?: () => number;
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function equal(a: string, b: string): boolean {
  const left = Buffer.from(hash(a), "hex"), right = Buffer.from(hash(b), "hex");
  return timingSafeEqual(left, right);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid request");
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).some(key => !keys.includes(key))) throw new Error("Unexpected fields");
}
function services(value: unknown): NotificationService[] {
  if (!Array.isArray(value) || value.length > NOTIFICATION_SERVICES.length
      || value.some(item => !NOTIFICATION_SERVICES.includes(item as NotificationService))) throw new Error("Invalid services");
  return [...new Set(value)] as NotificationService[];
}
export function validateWebPushSubscription(value: unknown): WebPushSubscription {
  const subscription = object(value);
  fields(subscription, ["endpoint", "keys", "expirationTime"]);
  if (typeof subscription.endpoint !== "string" || subscription.endpoint.length > 2048) throw new Error("Invalid push endpoint");
  const url = new URL(subscription.endpoint), keys = object(subscription.keys);
  fields(keys, ["p256dh", "auth"]);
  // Only real iOS Web Push subscriptions, never a client-selected HTTP target.
  if (url.protocol !== "https:" || !url.hostname.endsWith(".push.apple.com") || url.port || url.username || url.password || url.hash
      || !/^\/[A-Za-z0-9/_-]+$/.test(url.pathname) || url.search
      || typeof keys.p256dh !== "string" || !/^[A-Za-z0-9_-]{87}$/.test(keys.p256dh)
      || Buffer.from(keys.p256dh, "base64url")[0] !== 4
      || typeof keys.auth !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(keys.auth)) throw new Error("Invalid iOS push subscription");
  return { endpoint: url.href, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}
function deviceBody(value: Record<string, unknown>): Pick<Device, "token" | "subscription" | "services"> {
  fields(value, ["token", "services", "subscription"]);
  if (value.subscription !== undefined) {
    if (value.token !== undefined && value.token !== "") throw new Error("Ambiguous transport");
    return { token: "", subscription: validateWebPushSubscription(value.subscription), services: services(value.services) };
  }
  if (typeof value.token !== "string" || !/^[a-f0-9]{64,512}$/.test(value.token) || value.token.length % 2) throw new Error("Invalid token");
  return { token: value.token, services: services(value.services) };
}
export function parseNotificationEvent(value: unknown, now: number): NotificationEvent {
  const body = object(value);
  fields(body, ["id", "service", "kind", "occurredAt"]);
  if (typeof body.id !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(body.id)
      || !NOTIFICATION_SERVICES.includes(body.service as NotificationService)
      || !["message", "call", "activity"].includes(String(body.kind))
      || typeof body.occurredAt !== "number" || !Number.isSafeInteger(body.occurredAt)
      || body.occurredAt > now + 5000 || body.occurredAt < now - (body.kind === "call" ? 30_000 : 60_000)
      || (["instagram", "snapchat"].includes(String(body.service)) && body.kind === "activity")) throw new Error("Invalid contact event");
  return body as unknown as NotificationEvent;
}
export function validateNotificationRelayState(value: unknown): NotificationRelayState {
  const state = object(value);
  fields(state, ["schemaVersion", "devices", "delivered"]);
  if (state.schemaVersion !== 1) throw new Error("Invalid relay state");
  const devices = object(state.devices), delivered = object(state.delivered);
  if (Object.keys(devices).length > 16 || Object.keys(delivered).length > 10000) throw new Error("Relay state limit");
  for (const [id, candidate] of Object.entries(devices)) {
    const device = object(candidate);
    fields(device, ["secretHash", "token", "subscription", "services", "updatedAt"]);
    if (!/^[a-f0-9]{32}$/.test(id) || !/^[a-f0-9]{64}$/.test(String(device.secretHash))
        || !Number.isSafeInteger(device.updatedAt)) throw new Error("Invalid device state");
    deviceBody({ token: device.token, services: device.services, ...(device.subscription ? { subscription: device.subscription } : {}) });
  }
  for (const [id, time] of Object.entries(delivered)) {
    if (!/^[a-f0-9]{64}$/.test(id) || !Number.isSafeInteger(time)) throw new Error("Invalid delivery state");
  }
  return value as NotificationRelayState;
}

// One owner, separately authenticated device registration and trusted event
// ingestion. No route reads social accounts or accepts notification text/URLs.
// A source adapter must establish message/call classification BEFORE ingestion.
export function createNotificationRelay(options: NotificationRelayOptions): (request: Request) => Promise<Response> {
  for (const token of [options.pairingToken, options.sourceToken]) {
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Relay credentials must be 256-bit hex secrets");
  }
  if (equal(options.pairingToken, options.sourceToken)) throw new Error("Use separate pairing and source credentials");
  let queue = Promise.resolve() as Promise<unknown>;
  const reply = (status: number, body: unknown) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
  const handle = async (request: Request) => {
      const path = new URL(request.url).pathname;
      const credential = request.headers.get("Authorization")?.replace(/^Bearer /, "") ?? "";
      const deviceID = path.match(/^\/api\/notifications\/devices\/([a-f0-9]{32})$/)?.[1];
      const pair = path === "/api/notifications/devices" && request.method === "POST";
      const eventRoute = path === "/api/notifications/events" && request.method === "POST";
      if (!pair && !eventRoute && !(deviceID && ["PUT", "DELETE"].includes(request.method))) return reply(404, { error: "Not found" });
      if ((pair && !equal(credential, options.pairingToken)) || (eventRoute && !equal(credential, options.sourceToken))) return reply(401, { error: "Unauthorized" });
      let state: NotificationRelayState;
      try { state = validateNotificationRelayState(await options.load()); }
      catch { return reply(503, { error: "Relay storage unavailable" }); }
      if (deviceID && (!state.devices[deviceID] || !equal(hash(credential), state.devices[deviceID].secretHash))) return reply(401, { error: "Unauthorized" });
      if (deviceID && request.method === "DELETE") {
        delete state.devices[deviceID];
        await options.save(state);
        return reply(200, { ok: true });
      }
      let body: Record<string, unknown>;
      try {
        if (!request.headers.get("Content-Type")?.startsWith("application/json")) return reply(415, { error: "JSON required" });
        const reader = request.body?.getReader();
        if (!reader) throw new Error("Missing body");
        const chunks: Uint8Array[] = []; let length = 0;
        while (true) {
          const result = await reader.read();
          if (result.done) break;
          length += result.value.byteLength;
          if (length > 4096) { await reader.cancel(); return reply(413, { error: "Request too large" }); }
          chunks.push(result.value);
        }
        body = object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch { return reply(400, { error: "Invalid request" }); }
      const now = (options.now ?? Date.now)();
      if (pair || deviceID) {
        let settings: Pick<Device, "token" | "services">;
        try { settings = deviceBody(body); } catch { return reply(400, { error: "Invalid device settings" }); }
        if ("subscription" in settings && !options.sendWebPush) return reply(503, { error: "Web Push is not configured" });
        if (!("subscription" in settings) && options.nativePushEnabled === false) return reply(503, { error: "Native push is not configured" });
        if (pair) {
          if (Object.keys(state.devices).length >= 16) return reply(409, { error: "Device limit" });
          const id = randomBytes(16).toString("hex"), secret = randomBytes(32).toString("hex");
          state.devices[id] = { ...settings, secretHash: hash(secret), updatedAt: now };
          await options.save(state);
          return reply(201, { deviceID: id, secret });
        }
        state.devices[deviceID!] = { secretHash: state.devices[deviceID!].secretHash, ...settings, updatedAt: now };
        await options.save(state);
        return reply(200, { ok: true });
      }
      let event: NotificationEvent;
      try { event = parseNotificationEvent(body, now); } catch { return reply(400, { error: "Invalid contact event" }); }
      state.delivered = Object.fromEntries(Object.entries(state.delivered).filter(([, time]) => time > now - 86400_000));
      if (Object.keys(state.delivered).length > 9900) return reply(503, { error: "Delivery capacity reached" });
      let accepted = 0, failed = 0;
      for (const [id, device] of Object.entries(state.devices)) {
        const key = hash(id + ":" + event.service + ":" + event.id);
        if (!device.services.includes(event.service) || state.delivered[key]) continue;
        // Persist a reservation BEFORE sending. A crash cannot cause repeated
        // call/message alerts; failed attempts are released for bounded retries.
        state.delivered[key] = now;
        await options.save(state);
        let result: PushResult;
        try {
          result = device.subscription
            ? await options.sendWebPush!(device.subscription, event) : await options.send(device.token, event);
        } catch { result = { accepted: false }; }
        if (result.accepted) accepted++;
        else {
          delete state.delivered[key];
          if (result.invalidToken) delete state.devices[id];
          else failed++;
        }
        await options.save(state);
      }
      return reply(failed ? 503 : 200, { accepted, failed });
  };
  return (request: Request) => {
    const operation = queue.then(() => handle(request));
    const response = operation.catch(() => reply(503, { error: "Relay unavailable" }));
    queue = response;
    return response;
  };
}

export function notificationPushPayload(event: NotificationEvent): Record<string, unknown> {
  return {
    aps: { alert: { title: names[event.service], body: event.kind === "call" ? "Incoming call." : event.kind === "message" ? "New message." : "New activity." }, sound: "default" },
    vigilService: event.service, vigilKind: event.kind
  };
}
export function createApnsSender(configuration: { teamID: string; keyID: string; privateKey: string; environment: "development" | "production" }): NotificationRelayOptions["send"] {
  if (!/^[A-Z0-9]{10}$/.test(configuration.teamID) || !/^[A-Z0-9]{10}$/.test(configuration.keyID)
      || !["development", "production"].includes(configuration.environment)) throw new Error("Invalid APNs configuration");
  const key = createPrivateKey(configuration.privateKey);
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Error("APNs requires a P-256 signing key");
  let authorization = "", generatedAt = 0;
  return async (token, event) => {
    const now = Math.floor(Date.now() / 1000);
    if (!authorization || now - generatedAt >= 3000) {
      const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: configuration.keyID })).toString("base64url");
      const claims = Buffer.from(JSON.stringify({ iss: configuration.teamID, iat: now })).toString("base64url");
      const input = header + "." + claims;
      authorization = input + "." + sign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" }).toString("base64url");
      generatedAt = now;
    }
    const host = configuration.environment === "development" ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com";
    return new Promise<PushResult>((resolveSend, rejectSend) => {
      const session = connect(host);
      const deadline = setTimeout(() => { session.destroy(); rejectSend(new Error("APNs timeout")); }, 8000);
      const finish = (result: PushResult) => { clearTimeout(deadline); session.close(); resolveSend(result); };
      session.once("error", () => { clearTimeout(deadline); session.destroy(); rejectSend(new Error("APNs unavailable")); });
      const request = session.request({
        ":method": "POST", ":path": "/3/device/" + token, authorization: "bearer " + authorization,
        "apns-topic": "tech.caseline.vigil.instagram", "apns-push-type": "alert", "apns-priority": "10",
        "apns-expiration": String(Math.floor(event.occurredAt / 1000) + (event.kind === "call" ? 30 : 60)),
        "content-type": "application/json"
      });
      request.once("response", headers => {
        const status = Number(headers[":status"]);
        finish({ accepted: status === 200, invalidToken: status === 410 });
        request.close();
      });
      request.once("error", () => { clearTimeout(deadline); session.destroy(); rejectSend(new Error("APNs request failed")); });
      request.end(JSON.stringify(notificationPushPayload(event)));
    });
  };
}
