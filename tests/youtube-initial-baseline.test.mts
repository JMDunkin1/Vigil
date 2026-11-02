import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { defaultState } from "../src/defaults.js";
import { youtubeAction } from "../src/youtubeLimits.js";
import { initializeYouTubeBaseline } from "../src/youtubeInitialBaseline.js";

const now = new Date("2026-11-02T18:00:00Z");
const ids = Array.from({ length: 6 }, (_, i) => `video${String(i).padStart(6, "0")}`);
function fixture() {
  const state = defaultState();
  youtubeAction(state, { action: "status" }, now);
  const ledger = state.youtubeLimits!;
  ledger.timezone = "America/New_York";
  youtubeAction(state, { action: "watch-later-sync", day: ledger.day, revision: 0,
    accountKey: "a".repeat(64), videoIds: ids.slice(0, 5), cards: [], complete: true }, now);
  const expected = { day: ledger.day, sha256: createHash("sha256").update(JSON.stringify(ledger)).digest("hex") };
  return { state, ledger, expected };
}

test("an exact unplayed initial import becomes a baseline once and later saves still consume four slots", () => {
  const { state, ledger, expected } = fixture();
  const checkpoint = structuredClone(ledger.watchLater);
  checkpoint!.revision++;
  assert.equal(initializeYouTubeBaseline(ledger, expected, now), true);
  assert.deepEqual(ledger.slots, [null, null, null, null]);
  assert.deepEqual(ledger.watchLater, checkpoint);
  assert.equal(ledger.usedMs, 0);
  assert.equal(ledger.watchLaterOverflow, undefined);
  assert.equal(initializeYouTubeBaseline(ledger, expected, now), false);
  for (let i = 0; i < 4; i++) assert.equal(youtubeAction(state, {
    action: "save", videoId: `newvideo${String(i).padStart(3, "0")}`
  }, now).ok, true);
  assert.equal(youtubeAction(state, { action: "save", videoId: ids[5] }, now).ok, false);
  youtubeAction(state, { action: "status" }, new Date("2026-11-03T18:00:00Z"));
  assert.equal(state.youtubeLimits!.baselineInitializedAt, now.toISOString());
  assert.deepEqual(state.youtubeLimits!.watchLater, checkpoint);
});

test("changed snapshots, playback, account changes and a later day cannot receive the first-use correction", () => {
  for (const modify of [
    (f: ReturnType<typeof fixture>) => { f.ledger.usedMs = 1; },
    (f: ReturnType<typeof fixture>) => { f.ledger.played[ids[0]] = 1; },
    (f: ReturnType<typeof fixture>) => { f.ledger.slots[0]!.locked = true; },
    (f: ReturnType<typeof fixture>) => { f.ledger.watchLater!.revision++; },
    (f: ReturnType<typeof fixture>) => { f.ledger.watchLater!.accountKey = "b".repeat(64); },
    (f: ReturnType<typeof fixture>) => { f.ledger.watchLater!.videoIds.pop(); }
  ]) {
    const f = fixture(); modify(f);
    const before = structuredClone(f.ledger);
    assert.equal(initializeYouTubeBaseline(f.ledger, f.expected, now), false);
    assert.deepEqual(f.ledger, before);
  }
  const f = fixture();
  assert.equal(initializeYouTubeBaseline(f.ledger, f.expected, new Date("2026-11-03T18:00:00Z")), false);
  assert.equal(initializeYouTubeBaseline(f.ledger, undefined, now), false, "the production correction rejects an unrelated ledger");
});
