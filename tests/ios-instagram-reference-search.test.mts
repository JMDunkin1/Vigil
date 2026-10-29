import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const root = existsSync(join(runtimeRoot, 'ios')) ? runtimeRoot : resolve(runtimeRoot, '..', '..');
const source = readFileSync(join(root, 'ios/VigilSocial/VigilSocial/DOMAdapters.swift'), 'utf8');
const script = source.match(/static let instagramReferenceSearchGuard = #"""([\s\S]*?)"""#/u)![1]!;
const collector = script.slice(script.indexOf('const count ='), script.indexOf('const parseJSON ='));
function records(payload: unknown): { media: Record<string, Record<string, unknown>>; accounts: Record<string, Record<string, unknown>> } {
  return runInNewContext(`const mediaRecords=new Map(),accountRecords=new Map();${collector}
    collect(payload);({media:Object.fromEntries(mediaRecords),accounts:Object.fromEntries(accountRecords)});`, { payload }) as ReturnType<typeof records>;
}
test('reference search script parses and installs before the independent single-item guard', () => {
  assert.doesNotThrow(() => new Function(script));
  assert.match(source, /instagramReferenceSearchGuard \+ instagramSharedContentSeed\(sharedContentURL\) \+ instagramSingleReelGuard/u);
  assert.match(script, /followers: 10000, likes: 1000, views: 10000/u);
});
test('counts bind to the exact structured media and account identities', () => {
  const result = records({ data: { media: { shortcode: 'Target', like_count: 1000, play_count: 10000,
    owner: { username: 'Creator', follower_count: 10000 }, caption: { text: 'A reference' } },
  recommendations: [{ code: 'Different', like_count: 999999 }] } });
  assert.equal(result.media.Target!.likes, 1000);
  assert.equal(result.media.Target!.views, 10000);
  assert.equal(result.media.Target!.author, 'creator');
  assert.equal(result.accounts.creator!.followers, 10000);
  assert.equal(result.media.Different!.likes, 999999);
});
test('numeric strings, missing counts, captions, comments and unrelated metrics cannot qualify', () => {
  const result = records({ code: 'Target', like_count: '100000', play_count: -1,
    caption: '999999 likes', comments: [{ like_count: 999999 }],
    owner: { username: 'creator', follower_count: '100000' },
    unrelated: { code: 'Other', like_count: 999999 } });
  assert.equal(result.media.Target!.likes, null);
  assert.equal(result.media.Target!.views, null);
  assert.equal(result.accounts.creator, undefined);
});
test('GraphQL count fields and caption wrappers remain compatible', () => {
  const result = records({ shortcode: 'Graph', edge_media_preview_like: { count: 1000 }, video_view_count: 10000,
    owner: { username: 'creator', edge_followed_by: { count: 10000 } },
    edge_media_to_caption: { edges: [{ node: { text: 'Actual caption' } }] } });
  assert.equal(result.media.Graph!.likes, 1000);
  assert.equal(result.media.Graph!.views, 10000);
  assert.equal(result.accounts.creator!.followers, 10000);
  assert.equal(result.media.Graph!.text, 'Actual caption');
  assert.doesNotThrow(() => records({ shortcode: 'Unknown', edge_media_to_caption: { edges: {} } }));
});
