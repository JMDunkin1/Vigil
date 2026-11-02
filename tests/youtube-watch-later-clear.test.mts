import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { defaultState } from '../src/defaults.js';
import { youtubeAction } from '../src/youtubeLimits.js';

const source = await readFile(new URL('../extension/youtube-limits.js', import.meta.url), 'utf8');
const parserSource = source.slice(source.indexOf('  function watchLaterRemoval('), source.indexOf('  async function readWatchLaterStart('));
const continuationSource = source.slice(source.indexOf('  function watchLaterContinuationTokens('), source.indexOf('  async function watchLaterBrowseHeaders('));
const runnerSource = source.slice(source.indexOf('  // BEGIN WATCH LATER BULK CLEAR'), source.indexOf('  function exportWatchLater('));
const ids = Array.from({ length: 45 }, (_, i) => `video${String(i).padStart(6, '0')}`);
const accountKey = 'a'.repeat(64);
const apiUrl = '/youtubei/v1/browse/edit_playlist';
function item(videoId: string) {
  return { videoId, title: videoId, removal: { apiUrl, action: { action: 'ACTION_REMOVE_VIDEO', removedVideoId: videoId } } };
}
const parse = runInNewContext(`${continuationSource}\n${parserSource}\n({watchLaterRemoval,watchLaterPage})`, {
  textOf: (value: string | { simpleText?: string }) => typeof value === 'string' ? value : value.simpleText || ''
});
function renderer(videoId = ids[0]) {
  return { videoId, title: 'Saved video', menu: { menuRenderer: { items: [{ menuServiceItemRenderer: { serviceEndpoint: {
    commandMetadata: { webCommandMetadata: { apiUrl } },
    playlistEditEndpoint: { playlistId: 'WL', actions: [{ action: 'ACTION_REMOVE_VIDEO', removedVideoId: videoId }] }
  } } }] } } };
}
test('only item-specific Watch Later removal commands are accepted, including opaque occurrence IDs', () => {
  const valid = renderer();
  assert.equal(parse.watchLaterRemoval(valid).action.removedVideoId, ids[0]);
  const action = valid.menu.menuRenderer.items[0].menuServiceItemRenderer.serviceEndpoint.playlistEditEndpoint.actions[0];
  Object.assign(action, { setVideoId: 'opaque-occurrence', removedVideoId: undefined });
  assert.equal(parse.watchLaterRemoval(valid).action.setVideoId, 'opaque-occurrence');
  const page = parse.watchLaterPage({ playlistVideoListRenderer: { playlistId: 'WL', contents: [{ playlistVideoRenderer: valid }] } }, false, true);
  assert.equal(page.cards[0].removal.action.setVideoId, 'opaque-occurrence');
  assert.equal(parse.watchLaterPage({ playlistVideoListRenderer: { contents: [{ playlistVideoRenderer: valid }] } }).cards[0].removal, undefined,
    'ordinary reconciliation does not transport edit commands');
});
test('foreign URLs, other playlists, add commands, mismatched videos and ambiguous commands are refused', () => {
  for (const change of [
    (v: ReturnType<typeof renderer>) => { v.menu.menuRenderer.items[0].menuServiceItemRenderer.serviceEndpoint.commandMetadata.webCommandMetadata.apiUrl = 'https://elsewhere.test/edit'; },
    (v: ReturnType<typeof renderer>) => { v.menu.menuRenderer.items[0].menuServiceItemRenderer.serviceEndpoint.playlistEditEndpoint.playlistId = 'PLother'; },
    (v: ReturnType<typeof renderer>) => { v.menu.menuRenderer.items[0].menuServiceItemRenderer.serviceEndpoint.playlistEditEndpoint.actions[0].action = 'ACTION_ADD_VIDEO'; },
    (v: ReturnType<typeof renderer>) => { v.menu.menuRenderer.items[0].menuServiceItemRenderer.serviceEndpoint.playlistEditEndpoint.actions[0].removedVideoId = ids[1]; },
    (v: ReturnType<typeof renderer>) => { v.menu.menuRenderer.items[0].menuServiceItemRenderer.serviceEndpoint.playlistEditEndpoint.actions.push({ action: 'ACTION_REMOVE_VIDEO', removedVideoId: ids[1] }); }
  ]) {
    const v = renderer(); change(v); assert.equal(parse.watchLaterRemoval(v), null);
  }
});
test('a known empty playlist message is valid, while errors, unselected tabs and mixed video content are not empty', () => {
  const empty = () => ({ contents: { twoColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { selected: true,
    content: { sectionListRenderer: { contents: [{ itemSectionRenderer: { contents: [
      { messageRenderer: { text: { simpleText: 'No videos in this playlist yet' } } }
    ] } }] } } } }] } } });
  assert.equal(parse.watchLaterPage(empty()).cards.length, 0);
  const mobile = empty();
  const data = mobile.contents as Record<string, unknown>;
  data.singleColumnBrowseResultsRenderer = data.twoColumnBrowseResultsRenderer; delete data.twoColumnBrowseResultsRenderer;
  assert.equal(parse.watchLaterPage(mobile).cards.length, 0);
  const unselected = empty(); unselected.contents.twoColumnBrowseResultsRenderer.tabs[0].tabRenderer.selected = false;
  assert.throws(() => parse.watchLaterPage(unselected));
  const error = empty();
  error.contents.twoColumnBrowseResultsRenderer.tabs[0].tabRenderer.content.sectionListRenderer.contents[0]
    .itemSectionRenderer.contents[0].messageRenderer.text.simpleText = 'Something went wrong';
  assert.throws(() => parse.watchLaterPage(error));
  assert.throws(() => parse.watchLaterPage({ contents: {} }));
});
test('ordinary sync and bulk review include the same hidden unavailable entries and continuations', async () => {
  const readerSource = source.slice(source.indexOf('  async function readWatchLater(editing'), source.indexOf('  // BEGIN WATCH LATER BULK CLEAR'));
  const page = (videos: string[], continuation = false) => ({ playlistVideoListRenderer: { playlistId: 'WL', contents: [
    ...videos.map(videoId => ({ playlistVideoRenderer: renderer(videoId) })),
    ...(continuation ? [{ continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: 'next' } } } }] : [])
  ] } });
  const requests: Record<string, unknown>[] = [];
  const read = runInNewContext(`${readerSource}\nreadWatchLater`, {
    AbortSignal, watchLaterPage: parse.watchLaterPage,
    readWatchLaterStart: async () => ({ initial: page(ids.slice(0, 1)), accountKey,
      config: { INNERTUBE_CONTEXT: { client: { clientName: 'WEB' } } } }),
    watchLaterBrowseHeaders: async () => ({}),
    accountFetch: async (_url: string, options: Record<string, unknown>) => {
      const body = JSON.parse(String(options.body)); requests.push({ ...options, parsedBody: body });
      return { ok: true, json: async () => body.browseId ? page(ids.slice(0, 2), true)
        : { appendContinuationItemsAction: { targetId: 'VLWL', continuationItems: [
          { playlistVideoRenderer: renderer(ids[2]) }
        ] } } };
    }
  });
  const normal = await read();
  assert.equal(normal.cards.length, 3);
  assert.ok(normal.cards.every((card: { removal?: unknown }) => card.removal === undefined));
  const full = await read(true);
  assert.equal(full.cards.length, 3); assert.ok(full.cards.every((card: { removal: unknown }) => card.removal));
  assert.equal(JSON.stringify(normal.cards.map((card: { videoId: string }) => card.videoId)),
    JSON.stringify(full.cards.map((card: { videoId: string }) => card.videoId)));
  const body = requests[0].parsedBody as { browseId: string; params: string };
  assert.equal(body.browseId, 'VLWL'); assert.equal(body.params, 'wgYCCAA=');
  assert.equal(requests[0].credentials, 'include'); assert.equal(requests[0].redirect, 'error');
});
test('export contains titles and watch URLs without account identity, session configuration or edit commands', async () => {
  const exportSource = source.slice(source.indexOf('  function exportWatchLater('), source.indexOf('  async function openWatchLaterTools('));
  let blob: Blob | undefined;
  const link = { href: '', download: '', click() {}, remove() {} };
  const exportList = runInNewContext(`${exportSource}\nexportWatchLater`, {
    Blob, URL: { createObjectURL(value: Blob) { blob = value; return 'blob:fixture'; }, revokeObjectURL() {} },
    setTimeout() {}, document: { createElement: () => link, body: { append() {} } }
  });
  exportList({ accountKey, config: { privateSession: 'fixture-only' }, cards: [item(ids[0])] });
  const backup = JSON.parse(await blob!.text());
  assert.deepEqual(Object.keys(backup).sort(), ['exportedAt', 'playlist', 'videos']);
  assert.deepEqual(backup.videos, [{ videoId: ids[0], title: ids[0], url: `https://www.youtube.com/watch?v=${ids[0]}` }]);
  assert.match(link.download, /^watch-later-\d{4}-\d{2}-\d{2}\.json$/);
});

function fixture(options: { count?: number; failBatch?: number; lostResponse?: boolean; stopAfter?: number; accountChange?: number;
  changedRoster?: boolean; unsupported?: boolean; ledgerAccount?: string; noEffect?: boolean; invalidReply?: boolean } = {}) {
  const reviewed = { accountKey, cards: ids.slice(0, options.count ?? 45).map(item), config: { INNERTUBE_CONTEXT: { client: { clientName: 'WEB' } } } };
  let playlist = reviewed.cards.map(card => card.videoId), stopped = false, batches = 0, identities = 0, reconciliations = 0;
  const writes: { url: string; options: RequestInit; body: { playlistId: string; actions: { removedVideoId: string }[] } }[] = [];
  const progress: number[] = [];
  const api = runInNewContext(`${runnerSource}\nclearWatchLaterSnapshot`, {
    AbortSignal, setTimeout: (fn: () => void) => { fn(); },
    readWatchLater: async (editing: boolean) => ({ ...reviewed,
      cards: (options.changedRoster && editing ? playlist.slice(1) : playlist).map(videoId => ({ ...item(videoId),
        ...(options.unsupported ? { removal: null } : {}) })) }),
    readWatchLaterStart: async () => ({ accountKey: ++identities === options.accountChange ? 'b'.repeat(64) : accountKey,
      config: reviewed.config }),
    request: async () => ({ watchLater: { accountKey: options.ledgerAccount || accountKey } }),
    watchLaterBrowseHeaders: async () => ({ 'Content-Type': 'application/json' }),
    accountFetch: async (url: string, fetchOptions: RequestInit) => {
      const body = JSON.parse(String(fetchOptions.body)); writes.push({ url, options: fetchOptions, body }); batches++;
      if (batches === options.failBatch && !options.lostResponse) return { ok: false };
      const removed = new Set(body.actions.map((action: { removedVideoId: string }) => action.removedVideoId));
      if (!options.noEffect) playlist = playlist.filter(id => !removed.has(id));
      if (options.stopAfter === batches) stopped = true;
      if (options.lostResponse && batches === options.failBatch) throw new Error('Timed out');
      return { ok: true, json: async () => options.invalidReply ? { status: 'STATUS_FAILED' } : { status: 'STATUS_SUCCEEDED' } };
    },
    reconcileWatchLater: async () => { reconciliations++; }
  });
  return { reviewed, writes, progress, playlist: () => playlist, reconciliations: () => reconciliations,
    run: () => api(reviewed, () => stopped, (submitted: number) => progress.push(submitted)) };
}
test('clearing the approved snapshot uses sequential bounded batches and verifies final membership', async () => {
  const f = fixture(); const result = await f.run();
  assert.equal(result.removed, 45); assert.equal(result.remaining, 0); assert.equal(result.failure, '');
  assert.deepEqual(f.writes.map(write => write.body.actions.length), [20, 20, 5]);
  assert.deepEqual(f.progress, [20, 40, 45]); assert.equal(f.reconciliations(), 1);
  for (const write of f.writes) {
    assert.equal(write.url, apiUrl); assert.equal(write.body.playlistId, 'WL');
    assert.equal(write.options.credentials, 'include'); assert.equal(write.options.redirect, 'error');
  }
});
test('Stop and a failed batch preserve partial progress without retries or deleting more entries', async () => {
  for (const options of [{ stopAfter: 1 }, { failBatch: 2 }, { failBatch: 1, lostResponse: true }, { accountChange: 2 }]) {
    const f = fixture(options); const result = await f.run();
    assert.equal(result.removed, 20); assert.equal(result.remaining, 25);
    assert.equal(f.writes.length, 'failBatch' in options && options.failBatch === 2 ? 2 : 1);
    assert.equal(f.reconciliations(), 1);
  }
});
test('changed playlists, missing removal commands and an unbound account cannot start any deletions', async () => {
  for (const options of [{ changedRoster: true }, { unsupported: true }, { ledgerAccount: 'b'.repeat(64) }]) {
    const f = fixture(options); await assert.rejects(f.run()); assert.equal(f.writes.length, 0);
  }
});
test('an HTTP success cannot claim a cleared playlist without a verified absence', async () => {
  for (const options of [{ noEffect: true }, { invalidReply: true }]) {
    const result = await fixture(options).run(); assert.notEqual(result.failure, '');
  }
});
test('an empty Watch Later reconciliation cannot refund locked or replaceable daily slots, watch time or grace', () => {
  const state = defaultState(); const now = new Date('2026-11-02T18:00:00Z');
  youtubeAction(state, { action: 'status' }, now);
  const ledger = state.youtubeLimits!;
  youtubeAction(state, { action: 'watch-later-sync', complete: true, day: ledger.day, revision: 0,
    accountKey, videoIds: ids.slice(0, 5), cards: [] }, now);
  ledger.slots[0]!.locked = true; ledger.played[ids[0]] = 45000; ledger.usedMs = 7200000;
  ledger.grace = { status: 'ended', videoId: ids[0], usedMs: 1200000 };
  const before = structuredClone(ledger);
  youtubeAction(state, { action: 'watch-later-sync', complete: true, day: ledger.day, revision: ledger.watchLater!.revision,
    accountKey, videoIds: [], cards: [] }, now);
  assert.deepEqual(ledger.slots, before.slots); assert.equal(ledger.usedMs, before.usedMs);
  assert.deepEqual(ledger.grace, before.grace); assert.deepEqual(ledger.played, before.played);
  assert.equal(ledger.watchLaterOverflow, true);
  assert.equal(youtubeAction(state, { action: 'save', videoId: ids[5] }, now).ok, false);
});
