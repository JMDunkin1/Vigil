import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const root = existsSync(join(runtimeRoot, 'ios')) ? runtimeRoot : resolve(runtimeRoot, '..', '..');
const source = await readFile(join(root, 'ios/VigilSocial/VigilSocial/DOMAdapters.swift'), 'utf8');
const queue = source.slice(source.indexOf('const friendshipLookupQueue ='), source.indexOf('let emptyStateTimer ='));
const recovery = source.slice(source.indexOf('const retryUnavailableFriendships ='), source.indexOf('const removeStoryPlaceholders ='));
assert.ok(queue.includes('const fetchMutualFriendship ='));
assert.ok(recovery.includes("window.addEventListener('online'"));

interface NodeFixture {
  author: string;
  dataset: Record<string, string>;
}
interface RecoveryFixture {
  posts: NodeFixture[];
  stories: NodeFixture[];
  calls: string[];
  writes: Array<[string, boolean]>;
  events: Record<string, () => void>;
  setAvailable(value: boolean): void;
  setRoute(value: string): void;
  classify(): void;
  recover(): void;
  advance(milliseconds: number): Promise<void>;
  timerCount(): number;
}
function fixture(): RecoveryFixture {
  return runInNewContext(`
    let now = 1000000, available = false, route = 'feed', nextTimer = 0;
    const Date = { now: () => now }, timers = new Map(), events = {}, calls = [], writes = [];
    const setTimeout = (callback, delay) => { timers.set(++nextTimer, { at: now + delay, callback }); return nextTimer; };
    const clearTimeout = id => timers.delete(id);
    const window = { addEventListener: (event, callback) => { events[event] = callback; } };
    const document = { addEventListener() {} };
    const friendshipCache = new Map(), friendshipChecks = new Map();
    let friendshipLookupFailed = false;
    const currentMutualFriendship = async username => {
      calls.push(username);
      if (!available) throw new Error('temporary outage');
      return username === 'friend';
    };
    const recordFriendshipDiagnostic = () => {};
    const persistFriendship = (username, mutual) => writes.push([username, mutual]);
    const posts = ['friend', 'stranger'].map(author => ({ author, dataset: {} }));
    const stories = ['friend'].map(author => ({ author, dataset: {} }));
    const homeCards = () => posts, homeStoryControls = () => stories;
    const homeCardAuthor = node => node.author, storyAuthor = node => node.author;
    const instagramRoute = () => route, reconcileFriendsEmptyState = () => {};
    const classify = (node, key) => {
      if (node.dataset[key]) return;
      node.dataset[key] = 'pending';
      void fetchMutualFriendship(node.author).then(result => {
        node.dataset[key] = result === true ? 'friend' : result === false ? 'other' : 'unavailable';
      });
    };
    const classifyHomeCard = node => classify(node, 'vigilInstagramHomeRelationship');
    const classifyHomeStory = node => classify(node, 'vigilInstagramStoryRelationship');
    ${queue}
    ${recovery}
    globalThis.fixture = {
      posts, stories, calls, writes, events,
      setAvailable(value) { available = value; }, setRoute(value) { route = value; },
      classify() { posts.forEach(classifyHomeCard); stories.forEach(classifyHomeStory); },
      recover: retryUnavailableFriendships,
      timerCount: () => timers.size,
      async advance(milliseconds) {
        const end = now + milliseconds;
        for (let iteration = 0; iteration < 1000; iteration++) {
          for (let microtask = 0; microtask < 20; microtask++) await Promise.resolve();
          const first = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
          if (!first || first[1].at > end) {
            now = end;
            for (let microtask = 0; microtask < 20; microtask++) await Promise.resolve();
            return;
          }
          now = Math.max(now, first[1].at); timers.delete(first[0]); first[1].callback();
        }
        throw new Error('Recovery timer did not settle');
      }
    };
    fixture;
  `) as RecoveryFixture;
}

test('failed friend checks recover automatically using fresh proof and retain definite denials', async () => {
  const f = fixture();
  f.classify();
  await f.advance(250);
  assert.equal(f.posts[0].dataset.vigilInstagramHomeRelationship, 'unavailable');
  assert.equal(f.stories[0].dataset.vigilInstagramStoryRelationship, 'unavailable');
  assert.equal(f.writes.length, 0, 'an outage must never become a persisted denial');
  f.setAvailable(true);
  await f.advance(4999);
  assert.equal(f.posts[0].dataset.vigilInstagramHomeRelationship, 'unavailable');
  await f.advance(1);
  assert.equal(f.posts[0].dataset.vigilInstagramHomeRelationship, 'friend');
  assert.equal(f.stories[0].dataset.vigilInstagramStoryRelationship, 'friend');
  assert.equal(f.posts[1].dataset.vigilInstagramHomeRelationship, 'other');
  const count = f.calls.length;
  f.events.online();
  await f.advance(100000);
  assert.equal(f.calls.length, count, 'settled mutual and nonmutual accounts are not retried');
});

test('online recovery can retry sooner and offscreen failures resume when Home returns', async () => {
  const f = fixture();
  f.classify();
  await f.advance(250);
  f.setRoute('profile');
  await f.advance(6000);
  assert.equal(f.calls.length, 4, 'do not send background requests for a departed Home feed');
  assert.equal(f.timerCount(), 0, 'offscreen recovery must not spin a timer');
  f.setAvailable(true);
  f.setRoute('feed');
  f.recover();
  await f.advance(0);
  assert.equal(f.posts[0].dataset.vigilInstagramHomeRelationship, 'friend');

  const online = fixture();
  online.classify();
  await online.advance(250);
  online.setAvailable(true);
  online.events.online();
  await online.advance(0);
  assert.equal(online.posts[0].dataset.vigilInstagramHomeRelationship, 'friend');
});

test('an ongoing outage has bounded retry rounds and deduplicates posts and Stories by author', async () => {
  const f = fixture();
  f.classify();
  await f.advance(200000);
  assert.equal(f.calls.filter(name => name === 'friend').length, 8, 'initial two attempts plus three bounded recovery rounds');
  assert.equal(f.calls.filter(name => name === 'stranger').length, 8);
  assert.equal(f.timerCount(), 0);
  assert.equal(f.posts[0].dataset.vigilInstagramHomeRelationship, 'unavailable');
  assert.equal(f.writes.length, 0);
});
