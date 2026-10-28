import { youtubeAction, YOUTUBE_BASE_MS, YOUTUBE_GRACE_MS } from "./youtubeLimits.js";
import { validateYouTubeLedgerSeed } from "./youtubeSharedWorker.js";
import type { YouTubeDay, YouTubeSlot } from "./youtubeLimits.js";
import type { VigilState } from "./types.js";

export type YouTubeMigrationSources = Record<"mac" | "ios-app" | "ios-safari", { youtubeLimits: YouTubeDay }>;
export function mergeYouTubeLedgers(sources: YouTubeMigrationSources, now = new Date()) {
  const names = ["mac", "ios-app", "ios-safari"] as const;
  const timezone = sources.mac?.youtubeLimits?.timezone;
  if (!timezone) throw new Error("All three verified ledger exports are required.");
  const normalized = names.map(name => {
    const original = structuredClone(sources[name]);
    if (!original?.youtubeLimits) throw new Error(`Missing ${name} ledger. Do not create an empty replacement.`);
    // Spend any outstanding reservation before importing; never mint its tail.
    const lease = original.youtubeLimits.lease;
    if (lease) {
      const expiry = new Date(lease.expiresAt);
      if (expiry > now) throw new Error(`Pause ${name} playback and wait for its reservation to settle before migration.`);
      youtubeAction(original as VigilState, { action: "status" }, expiry);
    }
    validateYouTubeLedgerSeed(original);
    original.youtubeLimits.timezone = timezone;
    youtubeAction(original as VigilState, { action: "status" }, now);
    return original.youtubeLimits;
  });
  if (new Set(normalized.map(day => day.day)).size !== 1) throw new Error("Ledger clocks disagree. Do not reset them to activate sharing.");
  const day = structuredClone(normalized[0]);
  day.played = {}; day.external = []; day.feeds = {}; day.lease = null;
  const slots = new Map<string, YouTubeSlot>();
  let used = 0;
  for (const ledger of normalized) {
    used += ledger.usedMs + ledger.grace.usedMs;
    for (const [id, time] of Object.entries(ledger.played)) day.played[id] = (day.played[id] || 0) + time;
    for (const id of ledger.external) if (!day.external.includes(id)) day.external.push(id);
    for (const slot of ledger.slots) if (slot) {
      const existing = slots.get(slot.videoId);
      if (existing) { existing.locked ||= slot.locked; existing.removed &&= slot.removed; existing.completed ||= slot.completed; }
      else slots.set(slot.videoId, { ...slot });
    }
  }
  const overflow = slots.size > 4;
  const selected = [...slots.values()].sort((a,b) => Number(b.locked) - Number(a.locked)).slice(0,4);
  for (const slot of selected) slot.locked ||= overflow || day.played[slot.videoId] > 15_000;
  day.slots = Array.from({length:4}, (_,index) => selected[index] || null);
  day.usedMs = Math.min(YOUTUBE_BASE_MS, used);
  // There is no reliable single grace video when combining independent clocks.
  // Keep exhausted days exhausted; do not invent a new overtime allowance.
  day.grace = used >= YOUTUBE_BASE_MS || normalized.some(ledger => ledger.grace.status === "ended")
    ? {status:"ended",videoId:null,usedMs:Math.min(YOUTUBE_GRACE_MS,Math.max(0,used-YOUTUBE_BASE_MS))}
    : {status:"unused",videoId:null,usedMs:0};
  return { seed: validateYouTubeLedgerSeed({youtubeLimits:day}), overflow, originalSlotCount: slots.size };
}
