import { timingSafeEqual } from "node:crypto";
import { youtubeAction, YOUTUBE_BASE_MS, YOUTUBE_GRACE_MS } from "./youtubeLimits.js";
import type { YouTubeDay, YouTubeRequest } from "./youtubeLimits.js";
import type { VigilState } from "./types.js";

interface Transaction {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}
interface DurableContext { storage: { transaction<T>(operation: (transaction: Transaction) => Promise<T>): Promise<T> } }
interface LedgerEnvironment {
  LEDGER_TOKEN: string;
  LEDGER_SEED_JSON: string;
  LEDGERS: { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } };
}
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
function authorized(request: Request, env: LedgerEnvironment) {
  const actual = request.headers.get("authorization") || "";
  const expected = `Bearer ${env.LEDGER_TOKEN}`;
  return /^[a-f0-9]{64}$/.test(env.LEDGER_TOKEN || "") && /^Bearer [a-f0-9]{64}$/.test(actual)
    && timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}
export function validateYouTubeLedgerSeed(value: unknown): { youtubeLimits: YouTubeDay } {
  const day = (value as { youtubeLimits?: YouTubeDay })?.youtubeLimits;
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day.day) || !day.timezone
      || !Array.isArray(day.slots) || day.slots.length !== 4 || day.lease !== null
      || !Number.isFinite(day.usedMs) || day.usedMs < 0 || day.usedMs > YOUTUBE_BASE_MS
      || !day.played || !day.feeds || !Array.isArray(day.external) || !day.grace
      || !["unused", "active", "ended"].includes(day.grace.status)
      || !Number.isFinite(day.grace.usedMs) || day.grace.usedMs < 0 || day.grace.usedMs > YOUTUBE_GRACE_MS
      || day.slots.some(slot => slot !== null && (!/^[\w-]{11}$/.test(slot.videoId) || typeof slot.title !== "string"
        || typeof slot.locked !== "boolean" || typeof slot.removed !== "boolean"
        || slot.completed !== undefined && typeof slot.completed !== "boolean"))) throw new Error("A verified, settled migration seed is required.");
  if (new Set(day.slots.filter(slot => slot !== null).map(slot => slot.videoId)).size !== day.slots.filter(Boolean).length
      || day.external.some(id => !/^[\w-]{11}$/.test(id))
      || Object.entries(day.played).some(([id, time]) => !/^[\w-]{11}$/.test(id) || !Number.isFinite(time) || time < 0)
      || (day.grace.status === "active" && (day.usedMs !== YOUTUBE_BASE_MS || !/^[\w-]{11}$/.test(day.grace.videoId || "")))) {
    throw new Error("Invalid migration ledger.");
  }
  new Intl.DateTimeFormat("en-CA", { timeZone: day.timezone });
  return structuredClone({ youtubeLimits: day });
}

// One named SQLite-backed Durable Object owns all three surfaces. Its storage
// transaction includes both the decision and durable write, before any grant.
export class YouTubeSharedLedger {
  constructor(private readonly context: DurableContext, private readonly env: LedgerEnvironment) {}
  async fetch(request: Request): Promise<Response> {
    if (!authorized(request, this.env)) return json({ ok: false }, 403);
    if (request.method !== "POST" || new URL(request.url).pathname !== "/api/youtube") return json({ ok: false }, 404);
    try {
      if (Number(request.headers.get("content-length") || 0) > 16_384) return json({ ok: false }, 413);
      // Bound chunked requests as well as callers supplying Content-Length.
      const reader = request.body?.getReader();
      if (!reader) return json({ ok: false }, 400);
      const chunks: Uint8Array[] = []; let length = 0;
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        length += value.byteLength;
        if (length > 16_384) { await reader.cancel(); return json({ ok: false }, 413); }
        chunks.push(value);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as YouTubeRequest;
      if (!body || typeof body !== "object" || Array.isArray(body)) return json({ ok: false }, 400);
      const result = await this.context.storage.transaction(async transaction => {
        let state = await transaction.get<VigilState>("state");
        const existing = state !== undefined;
        if (!state) state = validateYouTubeLedgerSeed(JSON.parse(this.env.LEDGER_SEED_JSON)) as VigilState;
        const before = JSON.stringify(state);
        const reply = youtubeAction(state, body);
        if (!existing || JSON.stringify(state) !== before) await transaction.put("state", state);
        return reply;
      });
      return json(result);
    } catch { return json({ ok: false, message: "Shared YouTube limits could not be verified or saved. Playback remains paused." }, 503); }
  }
}
export default {
  async fetch(request: Request, env: LedgerEnvironment): Promise<Response> {
    if (!authorized(request, env)) return json({ ok: false }, 403);
    if (request.method !== "POST" || new URL(request.url).pathname !== "/api/youtube") return json({ ok: false }, 404);
    try { return await env.LEDGERS.get(env.LEDGERS.idFromName("vigil-owner-youtube")).fetch(request); }
    catch { return json({ ok: false, message: "The shared YouTube allowance is unavailable." }, 503); }
  }
};
