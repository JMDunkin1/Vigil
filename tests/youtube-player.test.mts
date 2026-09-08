import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import { defaultState } from '../src/defaults.js';
import type { YouTubeRequest } from '../src/youtubeLimits.js';
import { youtubeAction, YOUTUBE_BASE_MS } from '../src/youtubeLimits.js';
const source = await readFile(new URL('../extension/youtube-limits.js', import.meta.url), 'utf8');
const id = 'video000000';
type Callback = (event?: unknown) => unknown;
async function playerFixture() {
  let clock = 0;
  const nodes: Node[] = [], intervals: { callback: Callback; ms: number }[] = [];
  const handlers = new Map<string, Callback[]>();
  class Node {
    id = ''; textContent = ''; type = ''; children: Node[] = []; style = { cssText: '' };
    events = new Map<string, Callback>();
    constructor() { nodes.push(this); }
    append(...items: Node[]) { this.children.push(...items); }
    prepend(...items: Node[]) { this.children.unshift(...items); }
    after() {}
    remove() {}
    replaceChildren(...items: Node[]) { this.children = items; }
    getAttribute() { return null; }
    setAttribute() {}
    removeAttribute() {}
    toggleAttribute() {}
    attachShadow() { return new Node(); }
    addEventListener(event: string, callback: Callback) { this.events.set(event, callback); }
    closest() { return null; }
    click() { this.events.get('click')?.({ preventDefault() {}, stopPropagation() {} }); }
  }
  const emit = (name: string) => { for (const callback of handlers.get(name) || []) callback({ target: media }); };
  const media = Object.assign(new Node(), {
    pauseCount: 0, paused: true, ended: false, seeking: false, readyState: 4, currentTime: 0, playbackRate: 1, autoplay: false,
    pause() { if (!this.paused) this.pauseCount++; this.paused = true; },
    async play() { this.paused = false; emit('play'); emit('playing'); }
  });
  const state = defaultState();
  const act = (body: YouTubeRequest) => youtubeAction(state, body, new Date(Date.UTC(2026, 8, 7, 16) + clock));
  act({ action: 'save', videoId: id });
  const window: Record<string, unknown> = { addEventListener() {} }; window.top = window;
  const document = {
    documentElement: new Node(), title: 'Fixture',
    createElement() { return new Node(); },
    getElementById(id: string) { return nodes.find(node => node.id === id); },
    querySelector() { return media; },
    querySelectorAll(selector: string) { return selector === 'video,audio' ? [media] : []; },
    addEventListener(event: string, callback: Callback) { handlers.set(event, [...handlers.get(event) || [], callback]); }
  };
  runInNewContext(source, { window, document, location: new URL(`https://www.youtube.com/watch?v=${id}`),
    crypto: webcrypto, URL, Element: Node, performance: { now: () => clock },
    setInterval(callback: Callback, ms: number) { intervals.push({ callback, ms }); },
    setTimeout, clearTimeout, chrome: { runtime: { async sendMessage(message: { youtube: YouTubeRequest }) { return act(message.youtube); } } }
  });
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));
  await flush();
  const click = async (label: string) => { const node = nodes.find(node => node.textContent === label); assert.ok(node, label); node.click(); await flush(); };
  const advance = async (milliseconds: number, moving = true) => {
    for (let elapsed = 0; elapsed < milliseconds; elapsed += 50) {
      clock += 50;
      if (!media.paused && moving) media.currentTime += .05 * media.playbackRate;
      for (const interval of intervals) if (clock % interval.ms === 0) interval.callback();
      await flush();
    }
  };
  return { state, media, click, advance, emit, nodes };
}
test('player gates autoplay and meters the first playback seconds', async () => {
  const { state, media, click, advance } = await playerFixture();
  await media.play(); assert.equal(media.paused, true);
  await click('Play this video'); assert.equal(media.paused, false);
  await advance(1000); await click('Pause');
  assert.ok(Math.abs(state.youtubeLimits!.usedMs - 1000) < 1);
  assert.equal(media.paused, true);
});
test('buffering and pauses spend no playback allowance; 2x uses elapsed playing time', async () => {
  const { state, media, click, advance, emit } = await playerFixture();
  await click('Play this video');
  await advance(500);
  emit('waiting'); await advance(1000, false); emit('playing');
  media.playbackRate = 2; emit('ratechange');
  await advance(500); await click('Pause'); await advance(2000);
  assert.ok(Math.abs(state.youtubeLimits!.usedMs - 1000) < 1);
});
test('seek jumps do not spend time or release a saved slot', async () => {
  const { state, media, click, advance, emit } = await playerFixture();
  await click('Play this video'); await advance(500);
  media.seeking = true; emit('seeking'); media.currentTime += 3600;
  await advance(500, false); media.seeking = false; emit('seeked');
  await advance(500); await click('Pause');
  assert.ok(Math.abs(state.youtubeLimits!.usedMs - 1000) < 1);
  assert.equal(state.youtubeLimits!.slots[0]!.locked, false);
});
test('renewal preserves actual playback through the base limit and natural end closes grace', async () => {
  const { state, media, click, advance, emit } = await playerFixture();
  state.youtubeLimits!.usedMs = YOUTUBE_BASE_MS - 500;
  await click('Play this video'); await advance(1000);
  assert.equal(state.youtubeLimits!.grace.status, 'active');
  media.ended = true; media.paused = true; emit('ended');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.youtubeLimits!.grace.status, 'ended');
  await click('Play this video'); assert.equal(media.paused, true);
});

test('authorization renewals do not interrupt ordinary playback', async () => {
  const { state, media, click, advance } = await playerFixture();
  await click('Play this video'); await advance(6000);
  assert.equal(media.pauseCount, 0);
  await click('Pause');
  assert.ok(Math.abs(state.youtubeLimits!.usedMs - 6000) < 1);
});
