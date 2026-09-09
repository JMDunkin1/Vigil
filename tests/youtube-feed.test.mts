import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
const source = await readFile(new URL('../extension/youtube-limits.js', import.meta.url), 'utf8');
const helpers = source.slice(source.indexOf('  // Feed metadata'), source.indexOf('  function feedName()'));
const ids = Array.from({ length: 25 }, (_, i) => `video${String(i).padStart(6, '0')}`);
const renderer = (id: string, i: number) => ({ videoWithContextRenderer: { videoId: id, headline: { runs: [{ text: `Full video title ${i}` }] }, lengthText: { simpleText: '6:15' } } });
function fixture() {
  const requests: string[] = [];
  const page = { contents: ids.slice(0, 4).map(renderer), next: { continuationCommand: { token: 'page-two' } } };
  const continuation = { contents: ids.slice(4).map(renderer) };
  const api = runInNewContext(`${helpers}\n({videoCards,jsonAfter})`, {
    document: { querySelectorAll: () => [] }, AbortSignal,
    fetch: async (url: string) => {
      requests.push(url);
      return { ok: true, text: async () => `var ytInitialData = ${JSON.stringify(page)};ytcfg.set(${JSON.stringify({ INNERTUBE_CONTEXT: { client: { clientName: 'MWEB', clientVersion: 'test' } } })});`, json: async () => continuation };
    }
  });
  return { api, requests };
}
test('mobile feed reads full headlines instead of thumbnail durations', () => {
  const { api } = fixture();
  const result = api.videoCards({ contents: ids.slice(0, 4).map(renderer) });
  assert.equal(result.cards[0].title, 'Full video title 0');
  assert.equal(result.cards[0].duration, '6:15');
});
test('JSON extraction handles braces and escaped quotes within video titles without evaluation', () => {
  const { api } = fixture();
  const value = { title: 'A { brace } and "quoted" title' };
  assert.equal(api.jsonAfter(`var ytInitialData = ${JSON.stringify(value)};`, /ytInitialData\s*=\s*/).title, value.title);
});
test('iPhone escaped initial data yields full feed metadata without evaluating JavaScript', () => {
  const { api } = fixture();
  const page = { contents: ids.slice(0, 20).map(renderer) };
  const encoded = JSON.stringify(page).replace(/[^a-zA-Z0-9 ]/g, c => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
  const parsed = api.jsonAfter(`var ytInitialData = '${encoded}'; window.alert('must never run');`, /ytInitialData\s*=\s*/);
  assert.equal(api.videoCards(parsed).cards.length, 20);
  assert.equal(api.videoCards(parsed).cards[0].title, 'Full video title 0');
});
test('native feed retains YouTube renderer models, thumbnails, and a stable twenty-item set', () => {
  const begin = source.indexOf('  const nativeCardSelector');
  const end = source.indexOf('  if (topFrame)', begin);
  const cache = new Map<string, string>();
  const api = runInNewContext(`${helpers}\n${source.slice(begin, end)}\n({nativeFeedData})`, {
    state: { day: '2026-09-08' }, feedName: () => 'home', domCards: () => [],
    localStorage: { getItem: (key: string) => cache.get(key), setItem: (key: string, value: string) => cache.set(key, value) }
  });
  const items = ids.map((id, i) => ({ ...renderer(id, i), thumbnail: { source: `original-${i}` } }));
  const first = api.nativeFeedData({ contents: { richGridRenderer: { contents: items } } });
  const firstItems = first.contents.richGridRenderer.contents;
  assert.equal(firstItems.length, 20);
  assert.equal(firstItems[0].thumbnail.source, 'original-0');
  const reopened = api.nativeFeedData({ contents: { richGridRenderer: { contents: items.slice().reverse() } } });
  assert.equal(reopened.contents.richGridRenderer.contents[0].videoWithContextRenderer.videoId, ids[0]);
});
