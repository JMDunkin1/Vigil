import test from "node:test";
import assert from "node:assert/strict";
import { defaultState } from "../src/defaults.js";
import { youtubeAction, YOUTUBE_BASE_MS, YOUTUBE_GRACE_MS, YOUTUBE_FULL, YOUTUBE_USED } from "../src/youtubeLimits.js";
import { protectedStateSnapshot } from "../src/seal.js";
import type { YouTubeRequest } from "../src/youtubeLimits.js";
const ids = Array.from({ length: 30 }, (_, index) => `video${String(index).padStart(6, '0')}`);
function setup() {
  const state = defaultState();
  let now = new Date('2026-09-07T16:00:00Z');
  const act = (input: YouTubeRequest) => youtubeAction(state, { client: 'tab-a', ...input }, now);
  act({ action: 'status' });
  const play = (id: string, ms: number, ended = false) => {
    let remaining = ms;
    while (remaining > 0) {
      const lease = act({ action: 'start', videoId: id }).lease;
      assert.ok(lease);
      const elapsed = Math.min(remaining, lease.milliseconds);
      now = new Date(now.getTime() + elapsed);
      assert.equal(act({ action: 'settle', leaseId: lease.id, playedMs: elapsed, ended: ended && elapsed === remaining }).ok, true);
      remaining -= elapsed;
    }
  };
  return { state, act, play, advance: (ms: number) => { now = new Date(now.getTime() + ms); } };
}
test('four slots, exact full copy, duplicate saves and atomic replacement', () => {
  const { act, state } = setup();
  for (const id of ids.slice(0, 4)) assert.equal(act({ action: 'save', videoId: id }).ok, true);
  assert.equal(act({ action: 'save', videoId: ids[0] }).slots.filter(Boolean).length, 4);
  assert.equal(act({ action: 'save', videoId: ids[4] }).message, YOUTUBE_FULL);
  assert.equal(act({ action: 'save', videoId: ids[4], replace: ids[0] }).ok, true);
  assert.equal(state.youtubeLimits!.slots[0]!.videoId, ids[4]);
});
test('15 seconds is replaceable; 15.001 locks cumulatively across removal and re-save', () => {
  const { act, play, state } = setup();
  act({ action: 'save', videoId: ids[0] }); play(ids[0], 8000);
  act({ action: 'remove', videoId: ids[0] }); act({ action: 'save', videoId: ids[0] }); play(ids[0], 7000);
  assert.equal(state.youtubeLimits!.slots[0]!.locked, false);
  play(ids[0], 1);
  assert.equal(state.youtubeLimits!.slots[0]!.locked, true);
  act({ action: 'remove', videoId: ids[0] });
  assert.equal(state.youtubeLimits!.slots[0]!.removed, true);
  act({ action: 'save', videoId: ids[0] });
  assert.equal(state.youtubeLimits!.slots.filter(Boolean).length, 1);
  assert.equal(state.youtubeLimits!.slots[0]!.removed, false);
});
test('all locked slots retain quota after completion and removal', () => {
  const { act, play } = setup();
  for (const id of ids.slice(0, 4)) { act({ action: 'save', videoId: id }); play(id, 15001, true); act({ action: 'remove', videoId: id }); }
  assert.equal(act({ action: 'save', videoId: ids[4] }).message, YOUTUBE_USED);
});
test('short completed videos remain replaceable', () => {
  const { act, play } = setup(); act({ action: 'save', videoId: ids[0] }); play(ids[0], 12000, true);
  assert.equal(act({ action: 'remove', videoId: ids[0] }).slots.filter(Boolean).length, 0);
});
test('external playback uses time without allocating a slot; discovery requires saving', () => {
  const { act, play, state } = setup();
  assert.equal(act({ action: 'start', videoId: ids[0] }).ok, false);
  act({ action: 'external', videoId: ids[0] }); play(ids[0], 16000);
  assert.equal(state.youtubeLimits!.slots.filter(Boolean).length, 0);
  assert.equal(state.youtubeLimits!.usedMs, 16000);
  act({ action: 'save', videoId: ids[0] }); assert.equal(state.youtubeLimits!.slots[0]!.locked, true);
  assert.equal(act({ action: 'start', videoId: ids[1] }).ok, false);
});
test('only actual settled playback counts, including the first seconds', () => {
  const { act, advance, state } = setup(); act({ action: 'save', videoId: ids[0] });
  const lease = act({ action: 'start', videoId: ids[0] }).lease!;
  advance(4000); act({ action: 'settle', leaseId: lease.id, playedMs: 250 });
  assert.equal(state.youtubeLimits!.usedMs, 250);
});
test('concurrent players and replacement during authorization are refused', () => {
  const { act } = setup(); act({ action: 'save', videoId: ids[0] });
  act({ action: 'start', videoId: ids[0] });
  assert.equal(act({ action: 'start', videoId: ids[0], client: 'tab-b' }).ok, false);
  assert.equal(act({ action: 'save', videoId: ids[1], replace: ids[0] }).ok, false);
  assert.equal(act({ action: 'remove', videoId: ids[0] }).ok, false);
});
test('expired reservations and duplicate settlements cannot mint time after a crash', () => {
  const { act, advance, state } = setup(); act({ action: 'save', videoId: ids[0] });
  const lease = act({ action: 'start', videoId: ids[0] }).lease!;
  advance(5001); act({ action: 'status' });
  assert.equal(state.youtubeLimits!.usedMs, lease.milliseconds);
  assert.equal(act({ action: 'settle', leaseId: lease.id, playedMs: 0 }).ok, false);
  assert.equal(state.youtubeLimits!.usedMs, lease.milliseconds);
});
test('two-hour boundary captures one grace video; reopening on another device keeps remaining time', () => {
  const { act, play, state } = setup(); act({ action: 'save', videoId: ids[0] });
  state.youtubeLimits!.usedMs = YOUTUBE_BASE_MS - 500;
  play(ids[0], 1000);
  assert.equal(state.youtubeLimits!.usedMs, YOUTUBE_BASE_MS);
  assert.equal(state.youtubeLimits!.grace.usedMs, 500);
  const restored = structuredClone(state);
  const result = youtubeAction(restored, { action: 'start', videoId: ids[0], client: 'phone' }, new Date('2026-09-07T16:05:00Z'));
  assert.equal(result.ok, true); assert.equal(result.grace.usedMs, 500);
});
test('switching to even an unsaved video ends grace and cannot be undone', () => {
  const { act, play, state } = setup(); act({ action: 'save', videoId: ids[0] });
  state.youtubeLimits!.usedMs = YOUTUBE_BASE_MS - 1; play(ids[0], 1);
  assert.equal(act({ action: 'start', videoId: ids[1] }).ok, false);
  assert.equal(act({ action: 'start', videoId: ids[0] }).ok, false);
  assert.equal(state.youtubeLimits!.grace.status, 'ended');
});
test('grace ends at natural completion or precisely twenty minutes', () => {
  for (const ended of [true, false]) {
    const { act, play, state } = setup(); act({ action: 'save', videoId: ids[0] });
    state.youtubeLimits!.usedMs = YOUTUBE_BASE_MS - 1; play(ids[0], 1);
    state.youtubeLimits!.grace.usedMs = ended ? 0 : YOUTUBE_GRACE_MS - 500;
    play(ids[0], 500, ended);
    assert.equal(act({ action: 'start', videoId: ids[0] }).ok, false);
  }
});
test('ending exactly at the base boundary does not allow replay grace', () => {
  const { act, play, state } = setup(); act({ action: 'save', videoId: ids[0] });
  state.youtubeLimits!.usedMs = YOUTUBE_BASE_MS - 1; play(ids[0], 1, true);
  assert.equal(act({ action: 'start', videoId: ids[0] }).ok, false);
});
test('feeds freeze twenty unique IDs independently across restart and other accounts', () => {
  const { act, state } = setup(); const cards = ids.map(videoId => ({ videoId, title: `Title for ${videoId}` }));
  act({ action: 'feed', feed: 'home', cards: [...cards, ...cards] });
  act({ action: 'feed', feed: 'subscriptions', cards: cards.slice().reverse() });
  act({ action: 'feed', feed: 'home', cards: cards.slice().reverse() });
  assert.deepEqual(state.youtubeLimits!.feeds.home!.map(card => card.videoId), ids.slice(0, 20));
  assert.equal(state.youtubeLimits!.feeds.subscriptions![0].videoId, ids[29]);
  const restored = structuredClone(state);
  assert.equal(youtubeAction(restored, { action: 'status' }, new Date('2026-09-07T17:00:00Z')).feeds.home!.length, 20);
});
test('day reset uses persisted authority timezone and cannot roll backwards', () => {
  const { act, state } = setup(); act({ action: 'save', videoId: ids[0] });
  const yesterday = youtubeAction(state, { action: 'status' }, new Date('2026-09-06T16:00:00Z'));
  assert.equal(yesterday.slots.filter(Boolean).length, 1);
  const tomorrow = youtubeAction(state, { action: 'status' }, new Date('2026-09-08T16:00:00Z'));
  assert.equal(tomorrow.slots.filter(Boolean).length, 0);
});
test('ledger changes are protected by the existing state seal', () => {
  const { state } = setup();
  const before = protectedStateSnapshot(state as unknown as Record<string, unknown>);
  const changed = structuredClone(state); changed.youtubeLimits!.usedMs++;
  assert.notDeepEqual(before, protectedStateSnapshot(changed as unknown as Record<string, unknown>));
});

test('renewals retain ownership and charge each cumulative interval only once', () => {
  const { act, advance, state } = setup(); act({ action: 'save', videoId: ids[0] });
  const first = act({ action: 'start', videoId: ids[0] }).lease!;
  advance(1500);
  const renewed = act({ action: 'renew', leaseId: first.id, playedMs: 1500 }).lease!;
  assert.equal(renewed.id, first.id);
  assert.equal(state.youtubeLimits!.usedMs, 1500);
  assert.equal(act({ action: 'start', videoId: ids[0], client: 'other' }).ok, false);
  assert.equal(act({ action: 'renew', leaseId: first.id, playedMs: 1000 }).ok, false);
  advance(1000);
  act({ action: 'settle', leaseId: renewed.id, playedMs: 2500 });
  assert.equal(state.youtubeLimits!.usedMs, 2500);
  assert.equal(act({ action: 'settle', leaseId: renewed.id, playedMs: 2500 }).ok, false);
});

test('a partial feed fills to twenty without replacing its first IDs and repairs timestamp titles', () => {
  const { act, state } = setup();
  act({ action: 'feed', feed: 'home', cards: ids.slice(0, 4).map(videoId => ({ videoId, title: `Title ${videoId}` })) });
  state.youtubeLimits!.feeds.home![0].title = '6:15';
  act({ action: 'save', videoId: ids[0], title: '6:15' });
  act({ action: 'feed', feed: 'home', cards: ids.map(videoId => ({ videoId, title: `Correct ${videoId}` })) });
  assert.deepEqual(state.youtubeLimits!.feeds.home!.map(card => card.videoId), ids.slice(0, 20));
  assert.equal(state.youtubeLimits!.slots[0]!.title, `Correct ${ids[0]}`);
  act({ action: 'feed', feed: 'home', cards: ids.slice().reverse().map(videoId => ({ videoId, title: `Title ${videoId}` })) });
  assert.deepEqual(state.youtubeLimits!.feeds.home!.map(card => card.videoId), ids.slice(0, 20));
});
