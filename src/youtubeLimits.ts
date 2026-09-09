import { randomUUID } from "node:crypto";
import type { VigilState } from "./types.js";

export const YOUTUBE_BASE_MS = 7_200_000;
export const YOUTUBE_GRACE_MS = 1_200_000;
export const YOUTUBE_SEGMENT_MS = 2_000;
const LEASE_LIFETIME_MS = 5_000;
export const YOUTUBE_FULL = "Watch Later is full. Replace an unwatched video to save this one.";
export const YOUTUBE_USED = "You’ve used all four Watch Later slots today.";
export const YOUTUBE_TIME = "You’ve reached today’s watch time.";
export interface YouTubeSlot { videoId: string; title: string; locked: boolean; removed: boolean }
export interface YouTubeCard { videoId: string; title: string; channel?: string; duration?: string }
interface Lease { id: string; client: string; videoId: string; milliseconds: number; settledMs: number; expiresAt: number }
export interface YouTubeDay {
  day: string;
  timezone: string;
  slots: (YouTubeSlot | null)[];
  played: Record<string, number>;
  usedMs: number;
  grace: { status: "unused" | "active" | "ended"; videoId: string | null; usedMs: number };
  feedMode?: "native";
  feeds: Partial<Record<"home" | "subscriptions", YouTubeCard[]>>;
  external: string[];
  lease: Lease | null;
}
export interface YouTubeRequest {
  action?: unknown; client?: unknown; videoId?: unknown; title?: unknown;
  replace?: unknown; mode?: unknown; feed?: unknown; cards?: unknown; leaseId?: unknown;
  playedMs?: unknown; ended?: unknown;
}
function videoId(value: unknown): string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{11}$/.test(value) ? value : "";
}
function localDay(now: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
function charge(day: YouTubeDay, id: string, milliseconds: number): void {
  day.played[id] = (day.played[id] || 0) + milliseconds;
  for (const slot of day.slots) if (slot?.videoId === id && day.played[id] > 15_000) slot.locked = true;
  const base = Math.min(milliseconds, Math.max(0, YOUTUBE_BASE_MS - day.usedMs));
  day.usedMs += base;
  if (day.usedMs >= YOUTUBE_BASE_MS && day.grace.status === "unused") {
    day.grace = { status: "active", videoId: id, usedMs: 0 };
  }
  day.grace.usedMs = Math.min(YOUTUBE_GRACE_MS, day.grace.usedMs + milliseconds - base);
  if (day.grace.usedMs >= YOUTUBE_GRACE_MS) day.grace.status = "ended";
}
export function youtubeAction(state: VigilState, input: YouTubeRequest, now = new Date()) {
  const timezone = state.youtubeLimits?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const key = localDay(now, timezone);
  // A backwards wall-clock jump must never reopen a prior day.
  if (!state.youtubeLimits || key > state.youtubeLimits.day) {
    state.youtubeLimits = { day: key, timezone, slots: [null, null, null, null], played: {}, usedMs: 0,
      grace: { status: "unused", videoId: null, usedMs: 0 }, feeds: {}, external: [], lease: null };
  }
  const day = state.youtubeLimits;
  if (day.lease && now.getTime() >= day.lease.expiresAt) {
    // Unsettled credit stays spent after a crash. Never mint replacement time.
    charge(day, day.lease.videoId, day.lease.milliseconds - day.lease.settledMs);
    day.lease = null;
  }
  const result = (ok = true, message = "", lease: Lease | null = null) => ({
    ok, message, day: day.day, slots: structuredClone(day.slots), usedMs: day.usedMs,
    grace: { ...day.grace }, feeds: structuredClone(day.feeds), lease,
    serverTime: now.getTime()
  });
  const id = videoId(input.videoId);
  const client = typeof input.client === "string" ? input.client.slice(0, 180) : "";
  const slot = day.slots.find((item) => item?.videoId === id);
  switch (input.action) {
    case "status": return result();
    case "switch":
      if (id && day.grace.status === "active" && day.grace.videoId !== id) day.grace.status = "ended";
      return result();
    case "external":
      if (!id) return result(false, "Invalid video.");
      if (!day.external.includes(id)) day.external.push(id);
      return result();
    case "save": {
      if (!id) return result(false, "Invalid video.");
      if (slot) { slot.removed = false; return result(); }
      let index = day.slots.indexOf(null);
      if (typeof input.replace === "string") {
        index = day.slots.findIndex((item) => item !== null && item.videoId === input.replace && !item.locked);
        if (index < 0) return result(false, "That slot is now used. Choose another replaceable video.");
        if (day.lease?.videoId === input.replace) return result(false, "Pause that video before replacing it.");
      }
      if (index < 0) return result(false, day.slots.every((item) => item?.locked) ? YOUTUBE_USED : YOUTUBE_FULL);
      day.slots[index] = { videoId: id, title: String(input.title || id).slice(0, 200),
        locked: (day.played[id] || 0) > 15_000, removed: false };
      return result();
    }
    case "remove": {
      if (!slot) return result();
      if (day.lease?.videoId === id) return result(false, "Pause that video before removing it.");
      if (slot.locked) slot.removed = true;
      else day.slots[day.slots.indexOf(slot)] = null;
      return result();
    }
    case "feed": {
      if (input.feed !== "home" && input.feed !== "subscriptions") return result(false, "Invalid feed.");
      // One-time migration away from the discarded custom-card feed. Playback
      // time and the four-slot ledger are never reset by this UI migration.
      if (input.mode === "native" && day.feedMode !== "native") { day.feeds = {}; day.feedMode = "native"; }
      if (Array.isArray(input.cards)) {
        const cards = day.feeds[input.feed] ||= [];
        for (const item of input.cards.slice(0, 100)) {
          if (!item || typeof item !== "object") continue;
          const id = videoId(item.videoId);
          const title = String(item.title || "").trim().slice(0, 200);
          if (!id || !title || /^(?:\d+:)+\d+$/.test(title) || title === id) continue;
          const existing = cards.find(card => card.videoId === id);
          const metadata = { title, channel: String(item.channel || "").slice(0, 150), duration: String(item.duration || "").slice(0, 30) };
          // Repair metadata without changing the persistent daily IDs or order.
          if (existing) Object.assign(existing, metadata);
          else if (cards.length < 20) cards.push({ videoId: id, ...metadata });
          for (const saved of day.slots) if (saved?.videoId === id) saved.title = title;
        }
      }
      return result();
    }
    case "renew":
    case "settle": {
      const lease = day.lease;
      if (!lease || lease.id !== input.leaseId || lease.client !== client) return result(false, "Playback authorization expired.");
      const elapsed = input.playedMs;
      if (typeof elapsed !== "number" || !Number.isFinite(elapsed) || elapsed < lease.settledMs || elapsed > lease.milliseconds) return result(false, "Invalid playback time.");
      charge(day, lease.videoId, elapsed - lease.settledMs);
      lease.settledMs = elapsed;
      if (input.action === "renew" && day.grace.status !== "ended") {
        const remaining = day.usedMs < YOUTUBE_BASE_MS ? YOUTUBE_BASE_MS - day.usedMs : YOUTUBE_GRACE_MS - day.grace.usedMs;
        // Retain ownership and the same authorization identity during renewal.
        // The client can use its already reserved tail while this is in flight.
        let lifetime = LEASE_LIFETIME_MS;
        while (lifetime > 0 && localDay(new Date(now.getTime() + lifetime), timezone) > day.day) lifetime -= 100;
        lease.milliseconds = Math.max(lease.milliseconds, elapsed + Math.min(YOUTUBE_SEGMENT_MS, remaining, lifetime));
        lease.expiresAt = now.getTime() + lifetime;
        return result(true, "", { ...lease });
      }
      day.lease = null;
      if (input.ended === true && day.grace.videoId === lease.videoId) day.grace.status = "ended";
      return result();
    }
    case "start": {
      if (!id || !client) return result(false, "Invalid playback request.");
      if (day.grace.status === "active" && day.grace.videoId !== id) day.grace.status = "ended";
      if (day.grace.status === "ended") return result(false, YOUTUBE_TIME);
      if ((!slot || slot.removed) && !day.external.includes(id)) return result(false, "Save this video to Watch Later before playing.");
      if (day.lease) return result(false, "Pause playback in the other tab or device first.");
      const remaining = day.usedMs < YOUTUBE_BASE_MS ? YOUTUBE_BASE_MS - day.usedMs : YOUTUBE_GRACE_MS - day.grace.usedMs;
      if (remaining <= 0) return result(false, YOUTUBE_TIME);
      // Bound authorization at midnight, including DST transitions.
      let untilMidnight = LEASE_LIFETIME_MS;
      while (untilMidnight > 0 && localDay(new Date(now.getTime() + untilMidnight), timezone) > day.day) untilMidnight -= 100;
      if (untilMidnight <= 0) return result(false, "A new day is starting. Save for today to continue.");
      const lease = { id: randomUUID(), client, videoId: id, milliseconds: Math.min(YOUTUBE_SEGMENT_MS, remaining, untilMidnight), settledMs: 0, expiresAt: now.getTime() + untilMidnight };
      day.lease = lease;
      return result(true, "", { ...lease });
    }
    default: return result(false, "Unknown YouTube action.");
  }
}
