#!/usr/bin/env node
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import webpush from "web-push";
import { createApnsSender, createNotificationRelay, emptyNotificationRelayState, validateNotificationRelayState } from "../src/socialNotificationRelay.js";
import { createWebPushSender } from "../src/socialNotificationWebPush.js";

// Separate optional service: never starts, stops or changes Vigil enforcement.
const statePath = resolve(required("VIGIL_NOTIFICATION_STATE_FILE"));
if (process.argv.includes("--generate-web-push-keys")) {
  const path = resolve(required("VIGIL_WEB_PUSH_KEYS_FILE"));
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(webpush.generateVAPIDKeys()), { flag: "wx", mode: 0o600 });
  console.log("Web Push keys generated in the configured private file. No service was started.");
} else if (process.argv.includes("--initialize")) {
  await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
  await writeFile(statePath, JSON.stringify(emptyNotificationRelayState()), { flag: "wx", mode: 0o600 });
  console.log("Notification relay storage initialized. No service was started.");
} else {
  // Missing/corrupt state is a hard error. Never discard existing registrations.
  const load = async () => validateNotificationRelayState(JSON.parse(await readFile(statePath, "utf8")));
  await load();
  const environment = process.env.VIGIL_APNS_ENVIRONMENT;
  if (environment && environment !== "development" && environment !== "production") throw new Error("Choose a real APNs environment");
  const origin = required("VIGIL_NOTIFICATION_ORIGIN");
  const actualOrigin = new URL(origin);
  if (actualOrigin.protocol !== "https:" || actualOrigin.origin !== origin || actualOrigin.username || actualOrigin.password) throw new Error("Use the actual HTTPS origin without a path");
  const keys = process.env.VIGIL_WEB_PUSH_KEYS_FILE
    ? JSON.parse(await readFile(process.env.VIGIL_WEB_PUSH_KEYS_FILE, "utf8")) as { publicKey: string; privateKey: string } : null;
  if (!environment && !keys) throw new Error("Configure Web Push (free), native APNs, or both");
  const relay = createNotificationRelay({
    nativePushEnabled: Boolean(environment),
    pairingToken: required("VIGIL_NOTIFICATION_PAIRING_TOKEN"), sourceToken: required("VIGIL_NOTIFICATION_SOURCE_TOKEN"), load,
    save: async state => {
      const temporary = statePath + "." + randomBytes(8).toString("hex") + ".tmp";
      await writeFile(temporary, JSON.stringify(state), { mode: 0o600, flag: "wx" });
      await rename(temporary, statePath);
      await chmod(statePath, 0o600);
    },
    send: environment === "development" || environment === "production" ? createApnsSender({ environment, teamID: required("VIGIL_APNS_TEAM_ID"), keyID: required("VIGIL_APNS_KEY_ID"),
      privateKey: await readFile(required("VIGIL_APNS_KEY_FILE"), "utf8") }) : async () => ({ accepted: false }),
    ...(keys ? { sendWebPush: createWebPushSender(keys, origin) } : {})
  });
  const server = createServer(async (incoming, outgoing) => {
    outgoing.setHeader("Cache-Control", "no-store");
    try {
      if (incoming.headers.origin && incoming.headers.origin !== origin) { outgoing.writeHead(403).end(); return; }
      const path = new URL(incoming.url ?? "/", "http://127.0.0.1").pathname;
      const assets: Record<string, [string, string]> = {
        "/notifications/": ["index.html", "text/html"],
        "/notifications/receiver.js": ["receiver.js", "text/javascript"],
        "/notifications/receiver.css": ["receiver.css", "text/css"],
        "/notifications/worker.js": ["worker.js", "text/javascript"],
        "/notifications/manifest.webmanifest": ["manifest.webmanifest", "application/manifest+json"]
      };
      if (incoming.method === "GET" && (assets[path] || path === "/notifications/config")) {
        outgoing.setHeader("X-Content-Type-Options", "nosniff");
        outgoing.setHeader("Referrer-Policy", "no-referrer");
        outgoing.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; manifest-src 'self'; img-src 'self'; worker-src 'self'; base-uri 'none'; frame-ancestors 'none'");
        if (path === "/notifications/config") {
          outgoing.setHeader("Content-Type", "application/json");
          outgoing.end(JSON.stringify({ publicKey: keys?.publicKey ?? null })); return;
        }
        const [file, type] = assets[path];
        outgoing.setHeader("Content-Type", type + "; charset=utf-8");
        outgoing.end(await readFile(resolve("services/notifications/receiver", file))); return;
      }
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of incoming) {
        size += Buffer.byteLength(chunk);
        if (size > 4096) { outgoing.writeHead(413).end(); incoming.destroy(); return; }
        chunks.push(Buffer.from(chunk));
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (typeof value === "string") headers.set(name, value);
      }
      const method = incoming.method ?? "GET";
      const response = await relay(new Request("http://127.0.0.1" + (incoming.url ?? "/"), {
        method, headers, ...(!["GET", "HEAD"].includes(method) ? { body: Buffer.concat(chunks) } : {})
      }));
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch { outgoing.writeHead(503).end(); }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.setTimeout(15_000, socket => socket.destroy());
  server.listen(8789, "127.0.0.1", () => console.log("Optional notification relay listening on loopback port 8789. Requires an authenticated HTTPS reverse proxy and a verified event source."));
}
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error("Missing " + name);
  return value;
}
