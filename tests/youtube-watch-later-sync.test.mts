import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { createHash } from 'node:crypto';
import { defaultState } from '../src/defaults.js';
import { youtubeAction, YOUTUBE_BASE_MS, YOUTUBE_WATCH_LATER_MAX } from '../src/youtubeLimits.js';
import { validateYouTubeLedgerSeed } from '../src/youtubeSharedWorker.js';
import type { YouTubeRequest } from '../src/youtubeLimits.js';

const ids = Array.from({ length: 20 }, (_, i) => `video${String(i).padStart(6, '0')}`);
const accountKey = 'a'.repeat(64);
const day = new Date('2026-11-01T17:00:00Z');
function ledger() {
  const state = defaultState();
  const act = (body: YouTubeRequest, now = day) => youtubeAction(state, body, now);
  const sync = (videoIds: string[], now = day, overrides: YouTubeRequest = {}) => {
    const before = act({ action: 'watch-later-checkpoint' }, now);
    const known = new Set(before.watchLater?.videoIds || []);
    return act({ action: 'watch-later-sync', accountKey, complete: true,
      day: before.day, revision: before.watchLater?.revision || 0, videoIds,
      cards: videoIds.filter(id => !known.has(id)).slice(0, 4).map(videoId => ({ videoId, title: `Title ${videoId}` })),
      ...overrides }, now);
  };
  return { state, act, sync };
}

test('alternating saves across Mac Safari, phone Safari and Vigil use the same four account selections', () => {
  const surfaces = [ledger(), ledger(), ledger()];
  const playlist: string[] = [];
  for (const surface of surfaces) surface.sync(playlist);
  for (const [index, id] of ids.slice(0, 4).entries()) {
    const surface = surfaces[index % 3];
    surface.sync(playlist);
    assert.equal(surface.act({ action: 'save', videoId: id }).ok, true);
    playlist.push(id);
    surface.sync(playlist);
  }
  for (const surface of surfaces) {
    const reply = surface.sync(playlist);
    assert.deepEqual(reply.slots.map(slot => slot?.videoId), ids.slice(0, 4));
    assert.equal(surface.act({ action: 'save', videoId: ids[4] }).ok, false);
    assert.equal(reply.usedMs, 0);
    assert.equal(reply.lease, null);
  }
});

test('first reconciliation imports existing saves and preserves locked, removed and completed usage', () => {
  const f = ledger();
  f.act({ action: 'save', videoId: ids[0] });
  const current = f.state.youtubeLimits!;
  current.slots[0]!.locked = true;
  current.slots[0]!.completed = true;
  current.slots[0]!.removed = true;
  current.usedMs = 72000;
  current.played[ids[0]] = 72000;
  const reply = f.sync(ids.slice(0, 4));
  assert.equal(reply.slots.filter(Boolean).length, 4);
  assert.equal(reply.slots[0]!.locked, true);
  assert.equal(reply.slots[0]!.completed, true);
  assert.equal(reply.slots[0]!.removed, false);
  assert.equal(reply.usedMs, 72000);
  assert.equal(f.act({ action: 'start', videoId: ids[0], client: 'app' }).ok, false);
  f.sync([]);
  assert.equal(f.act({ action: 'save', videoId: ids[4] }).ok, false, 'a removed remote entry cannot refund a used slot');
});

test('midnight resets the daily allowance while retaining only the last playlist checkpoint', () => {
  const f = ledger();
  f.sync(ids.slice(0, 4));
  const tomorrow = new Date('2026-11-02T17:00:00Z');
  assert.equal(f.sync(ids.slice(0, 4).reverse(), tomorrow).slots.filter(Boolean).length, 0, 'old entries and sort changes are not new saves');
  assert.equal(f.sync(ids.slice(0, 5), tomorrow).slots[0]!.videoId, ids[4]);
  const restored = JSON.parse(JSON.stringify(f.state));
  assert.equal(youtubeAction(restored, { action: 'status' }, tomorrow).slots[0]!.videoId, ids[4]);
  for (const id of ids.slice(5)) f.sync([id], tomorrow);
  assert.equal(f.state.youtubeLimits!.watchLater!.videoIds.length, 1, 'checkpoint replaces the previous list instead of retaining a history');
  assert.equal(f.state.youtubeLimits!.slots.filter(Boolean).length, 4);
  assert.equal(f.state.youtubeLimits!.watchLaterOverflow, true);
});

test('an observed fifth account save saturates the day without freeing consumed slots or creating a larger bucket', () => {
  const f = ledger();
  const reply = f.sync(ids.slice(0, 5));
  assert.equal(reply.slots.filter(Boolean).length, 4);
  assert.equal(reply.watchLaterOverflow, true);
  f.act({ action: 'remove', videoId: ids[0] });
  assert.equal(f.act({ action: 'save', videoId: ids[5] }).ok, false);
  assert.equal(f.act({ action: 'save', videoId: ids[5], replace: ids[1] }).ok, false);
  assert.equal(f.act({ action: 'status' }).watchLater, undefined, 'playback/status replies do not repeat the roster');
});

test('invalid, partial, stale, wrong-day and different-account snapshots never clear or replace the checkpoint', () => {
  const f = ledger();
  f.sync(ids.slice(0, 2));
  for (const invalid of [
    { complete: false }, { videoIds: [ids[0], ids[0]] }, { videoIds: ['invalid'] },
    { videoIds: Array.from({ length: YOUTUBE_WATCH_LATER_MAX + 1 }, (_, i) => `v${String(i).padStart(10, '0')}`) },
    { accountKey: 'b'.repeat(64) }, { day: '2026-10-31' }, { revision: 0 },
    { cards: [{ videoId: ids[2], title: '' }] }
  ]) {
    const before = structuredClone(f.state.youtubeLimits);
    assert.equal(f.sync(ids.slice(0, 3), day, invalid).ok, false);
    assert.deepEqual(f.state.youtubeLimits, before);
  }
  const before = f.act({ action: 'watch-later-checkpoint' });
  f.sync(ids.slice(0, 3));
  assert.equal(f.act({ action: 'watch-later-sync', accountKey, complete: true, videoIds: ids.slice(0, 2), cards: [],
    day: before.day, revision: before.watchLater!.revision }).ok, false);
  assert.deepEqual(f.state.youtubeLimits!.watchLater!.videoIds, ids.slice(0, 3));
});

test('unchanged snapshots are idempotent, cannot reset watch time, and remain valid migration seeds', () => {
  const f = ledger();
  f.sync(ids.slice(0, 4));
  f.state.youtubeLimits!.usedMs = YOUTUBE_BASE_MS;
  f.state.youtubeLimits!.grace = { status: 'ended', videoId: null, usedMs: 1200000 };
  const before = structuredClone(f.state.youtubeLimits);
  f.sync(ids.slice(0, 4).reverse());
  assert.deepEqual(f.state.youtubeLimits, before);
  assert.equal(f.act({ action: 'start', videoId: ids[0], client: 'safari' }).ok, false);
  assert.deepEqual(validateYouTubeLedgerSeed(f.state).youtubeLimits, before);
  f.state.youtubeLimits!.watchLater!.videoIds.push('bad');
  assert.throws(() => validateYouTubeLedgerSeed(f.state));
});

const source = await readFile(new URL('../extension/youtube-limits.js', import.meta.url), 'utf8');
const helpers = source.slice(source.indexOf('  // Feed metadata'), source.indexOf('  function prepareCurrentVideo()'));
const renderer = (videoId: string) => ({ playlistVideoRenderer: { videoId, title: { simpleText: `Saved ${videoId}` } } });
function accountFixture(options: { signedIn?: boolean; malformed?: boolean; repeat?: boolean; failContinuation?: boolean; empty?: boolean; modern?: boolean; cookie?: string } = {}) {
  const requests: { url: string; options: Record<string, unknown> }[] = [];
  const initial = { contents: { playlistVideoListRenderer: { playlistId: 'WL', contents: options.empty ? [] : [renderer(ids[0]),
    { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: 'next' } } } }] } },
    recommendations: [{ videoRenderer: { videoId: ids[8], title: { simpleText: 'Recommendation' } } }] };
  if (options.modern && !options.empty) {
    const item = initial.contents.playlistVideoListRenderer.contents[1];
    if (!('continuationItemRenderer' in item)) throw new Error('Missing fixture continuation');
    const endpoint = item.continuationItemRenderer.continuationEndpoint;
    Object.assign(endpoint, { commandExecutorCommand: { commands: [
      { playlistVotingRefreshPopupCommand: { command: { reloadContinuationItemsCommand: { continuation: 'not-a-next-page' } } } },
      { continuationCommand: endpoint.continuationCommand }
    ] } });
    delete (endpoint as { continuationCommand?: unknown }).continuationCommand;
  }
  const config = { LOGGED_IN: options.signedIn !== false, DATASYNC_ID: 'same-account-channel', SESSION_INDEX: '1',
    DELEGATED_SESSION_ID: '12345', INNERTUBE_CONTEXT_CLIENT_NAME: 2,
    INNERTUBE_CONTEXT: { client: { clientName: 'MWEB', clientVersion: 'fixture' } } };
  const api = runInNewContext(`${helpers}\n({readWatchLater, watchLaterPage, jsonAfter, youtubePageConfiguration, watchLaterBrowseHeaders})`, {
    location: new URL('https://m.youtube.com/playlist?list=WL'), topFrame: true, AbortSignal, TextEncoder,
    document: { cookie: options.cookie ?? 'SAPISID=fixture-session' },
    crypto: { subtle: { digest: async (algorithm: string, bytes: Uint8Array) => createHash(algorithm.replace('-', '').toLowerCase()).update(bytes).digest() } },
    accountFetch: async (url: string, fetchOptions: Record<string, unknown>) => {
      requests.push({ url, options: fetchOptions });
      return { ok: !(url.includes('browse') && options.failContinuation),
        text: async () => `${options.modern ? "ytcfg.set('EMERGENCY_BASE_URL', '/error_204');" : ''}ytcfg.set(${JSON.stringify(config)});${options.modern ? 'ytcfg.set("initialInnerWidth", window.innerWidth);ytcfg.set({"CSI_SERVICE_NAME":"youtube"});' : ''}window['ytInitialData'] = ${JSON.stringify(options.malformed ? { contents: {} } : initial)};`,
        json: async () => ({ onResponseReceivedActions: [{ appendContinuationItemsAction: { targetId: 'VLWL', continuationItems: [renderer(options.repeat ? ids[0] : ids[1])] } }] }) };
    }
  });
  return { api, requests };
}

test('account reconciliation reads every playlist page, excludes recommendations and bypasses HTTP caches', async () => {
  const f = accountFixture();
  const snapshot = await f.api.readWatchLater();
  assert.deepEqual(Array.from(snapshot.cards, (card: { videoId: string }) => card.videoId), ids.slice(0, 2));
  assert.equal(snapshot.accountKey, createHash('sha256').update('same-account-channel').digest('hex'));
  assert.deepEqual(f.requests.map(request => request.url), ['/playlist?list=WL', '/youtubei/v1/browse']);
  for (const request of f.requests) {
    assert.equal(request.options.cache, 'no-store');
    assert.equal(request.options.credentials, 'include');
    assert.equal(request.options.redirect, 'error');
  }
  assert.equal(JSON.parse(f.requests[1].options.body as string).continuation, 'next');
});

test('signed-out pages, unfamiliar structures, duplicate pages and failed continuations never become empty snapshots', async () => {
  for (const options of [{ signedIn: false }, { malformed: true }, { repeat: true }, { failContinuation: true }]) {
    await assert.rejects(accountFixture(options).api.readWatchLater());
  }
  assert.equal((await accountFixture({ empty: true }).api.readWatchLater()).cards.length, 0);
});

test('the live bootstrap format skips string-valued settings and merges every JSON configuration object', async () => {
  const f = accountFixture({ modern: true });
  const snapshot = await f.api.readWatchLater();
  assert.deepEqual(Array.from(snapshot.cards, (card: { videoId: string }) => card.videoId), ids.slice(0, 2));
  const config = f.api.youtubePageConfiguration('ytcfg.set("initialInnerWidth", 100);ytcfg.set({"LOGGED_IN":true});ytcfg.set({"DATASYNC_ID":"account"});');
  assert.equal(config.LOGGED_IN, true);
  assert.equal(config.DATASYNC_ID, 'account');
  assert.equal(f.api.jsonAfter('ytcfg.set("initialWidth", window.innerWidth);ytcfg.set({"later":true});', /ytcfg\.set\(\s*/), null,
    'a non-JSON argument must not borrow a later object');
});

test('private continuation requests use a same-origin session proof and the selected account without persisting cookies', async () => {
  for (const cookie of ['SAPISID=fixture-session', '__Secure-3PAPISID=fixture-session', '__Secure-1PAPISID=fixture-session']) {
    const f = accountFixture({ modern: true, cookie });
    const snapshot = await f.api.readWatchLater();
    const headers = f.requests[1].options.headers as Record<string, string>;
    const [, timestamp, hash] = /^SAPISIDHASH (\d+)_(\w+)$/.exec(headers.Authorization)!;
    assert.equal(hash, createHash('sha1').update(`${timestamp} fixture-session https://m.youtube.com`).digest('hex'));
    assert.equal(headers['X-Goog-AuthUser'], '1');
    assert.equal(headers['X-Goog-PageId'], '12345');
    assert.equal(headers['X-Youtube-Client-Name'], '2');
    assert.equal(headers['X-Youtube-Client-Version'], 'fixture');
    assert.equal(f.requests[1].options.redirect, 'error');
    assert.equal('Authorization' in (f.requests[0].options.headers as object || {}), false);
    assert.equal(JSON.stringify(snapshot).includes('fixture-session'), false);
    assert.equal(Object.keys(snapshot).sort().join(','), 'accountKey,cards');
  }
});
