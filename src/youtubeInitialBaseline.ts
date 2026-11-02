import { createHash } from "node:crypto";
import type { YouTubeDay } from "./youtubeLimits.js";

// Authorized first-use correction: this is the exact, unplayed November 2
// import of the existing Watch Later backlog. No request or editable setting
// can select another ledger for this migration.
export const INITIAL_YOUTUBE_BASELINE = Object.freeze({
  day: "2026-11-02",
  sha256: "c89811b07dd6f627a340774295af4c665964b3262d32c710a7de9a045499a8f5"
});

export function initializeYouTubeBaseline(
  ledger: YouTubeDay | undefined,
  expected: Readonly<{ day: string; sha256: string }> = INITIAL_YOUTUBE_BASELINE,
  now = new Date()
): boolean {
  if (!ledger || ledger.baselineInitializedAt || ledger.day !== expected.day
      || ledger.usedMs !== 0 || Object.keys(ledger.played).length !== 0 || ledger.lease
      || ledger.grace.status !== "unused" || ledger.grace.usedMs !== 0 || ledger.grace.videoId !== null
      || ledger.watchLater?.revision !== 1
      || ledger.slots.some(slot => slot && (slot.locked || slot.completed || slot.removed))) return false;
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: ledger.timezone, year: "numeric", month: "2-digit", day: "2-digit"
  }).format(now);
  if (today !== expected.day
      || createHash("sha256").update(JSON.stringify(ledger)).digest("hex") !== expected.sha256) return false;
  ledger.slots = [null, null, null, null];
  delete ledger.watchLaterOverflow;
  ledger.watchLater.revision++;
  ledger.baselineInitializedAt = now.toISOString();
  return true;
}
