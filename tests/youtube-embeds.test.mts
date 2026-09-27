import test from 'node:test';
import assert from 'node:assert/strict';
import { createYouTubeEmbedPolicy, youtubeEmbedID } from '../src/youtubeEmbeds.js';

const id = 'abcdefghijk', other = 'zyxwvutsrqp';
function fixture(topURL = 'https://example.edu/economics', host = 'www.youtube.com') {
  const values: Record<string, unknown> = {};
  const frames = [
    { frameId: 0, parentFrameId: -1, url: topURL, documentId: 'top-1' },
    { frameId: 1, parentFrameId: 0, url: `https://${host}/embed/${id}`, documentId: 'embed-1' }
  ];
  const api = { storage: {
    async get(key: string) { return { [key]: values[key] }; },
    async set(items: Record<string, unknown>) { Object.assign(values, items); }
  }, async frames() { return frames; } };
  return { frames, api, policy: createYouTubeEmbedPolicy(api), sender: () => ({ tab: { id: 4 }, ...frames[1] }) };
}

test('only individual HTTPS embeds qualify, including privacy-enhanced hosts', () => {
  for (const host of ['youtube.com', 'www.youtube.com', 'www.youtube-nocookie.com']) {
    assert.equal(youtubeEmbedID(`https://${host}/embed/${id}?start=40`), id);
    for (const suffix of ['?list=PL123', '?playlist=zyxwvutsrqp']) assert.equal(youtubeEmbedID(`https://${host}/embed/${id}${suffix}`), null);
  }
  for (const url of [`http://www.youtube.com/embed/${id}`, `https://youtube.com.evil.test/embed/${id}`,
    `https://www.youtube.com/shorts/${id}`, `https://www.youtube.com/watch?v=${id}`]) assert.equal(youtubeEmbedID(url), null);
});

test('browser-confirmed external embeds survive worker restart but do not authorize recommendations', async () => {
  const f = fixture();
  assert.equal(await f.policy.eligible(f.sender(), id), false, 'no grant without navigation evidence');
  await f.policy.register(f.sender());
  assert.equal(await f.policy.eligible(f.sender(), id), true);
  assert.equal(await createYouTubeEmbedPolicy(f.api).eligible(f.sender(), id), true);
  assert.equal(await f.policy.eligible(f.sender(), other), false);
  f.frames[1].url = `https://www.youtube.com/embed/${other}`;
  f.frames[1].documentId = 'embed-2';
  await f.policy.register(f.sender());
  assert.equal(await f.policy.eligible(f.sender(), other), false, 'navigating inside the iframe cannot grant another video');
  await f.policy.reset(4);
  await f.policy.register(f.sender());
  assert.equal(await f.policy.eligible(f.sender(), other), true, 'a fresh containing page can embed another video');
});

test('YouTube ancestors, missing frames, forged URL/document and opaque origins do not grant exemptions', async () => {
  for (const url of ['https://www.youtube.com/', 'https://youtu.be/abcdefghijk', 'https://www.youtube-nocookie.com/', 'about:blank']) {
    const f = fixture(url);
    await f.policy.register(f.sender());
    assert.equal(await f.policy.eligible(f.sender(), id), false);
  }
  const f = fixture();
  await f.policy.register({ ...f.sender(), url: `https://www.youtube.com/embed/${other}` });
  assert.equal(await f.policy.eligible(f.sender(), id), false);
  await f.policy.register({ ...f.sender(), documentId: 'stale-document' });
  assert.equal(await f.policy.eligible(f.sender(), id), false);
  f.frames[1].parentFrameId = 99;
  await f.policy.register(f.sender());
  assert.equal(await f.policy.eligible(f.sender(), id), false);
});

test('all ancestors must be external; sibling embeds serialize independent authorizations', async () => {
  const f = fixture();
  f.frames.push({ frameId: 2, parentFrameId: 0, url: 'https://www.youtube.com/', documentId: 'middle' });
  f.frames[1].parentFrameId = 2;
  await f.policy.register(f.sender());
  assert.equal(await f.policy.eligible(f.sender(), id), false);
  await f.policy.reset(4);
  f.frames[2].url = 'https://example.edu/widget';
  f.frames.push({ frameId: 3, parentFrameId: 0, url: `https://www.youtube-nocookie.com/embed/${other}`, documentId: 'other' });
  const sibling = { tab: { id: 4 }, ...f.frames[3] };
  await Promise.all([f.policy.register(f.sender()), f.policy.register(sibling)]);
  assert.equal(await f.policy.eligible(f.sender(), id), true);
  assert.equal(await f.policy.eligible(sibling, other), true);
});
