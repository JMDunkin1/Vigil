import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const projectRoot = existsSync(resolve(runtimeRoot, 'ios')) ? runtimeRoot : resolve(runtimeRoot, '../..');
const resources = resolve(projectRoot, 'ios/VigilSocial/VigilYouTubeInteractionExtension/Resources');
const parity = await readFile(resolve(resources, 'youtube-parity.js'), 'utf8');
const responseGuard = await readFile(resolve(resources, 'youtube-player-response.js'), 'utf8');

function touchFixture() {
  let clock = 0, position = 60;
  const seeks: number[] = [], attributes = new Map<string, string>();
  const handlers = new Map<string, Array<(event: unknown) => void>>();
  class Element {
    isConnected = true; style = { transform: '', transition: '' }; textContent = ''; id = '';
    label = ''; ad = false;
    getBoundingClientRect() { return { left: 0, top: 0, right: 400, bottom: 225, width: 400, height: 225 }; }
    getAttribute(name: string) { return name === 'aria-label' ? this.label : attributes.get(name); }
    setAttribute(name: string, value: string) { attributes.set(name, value); }
    removeAttribute(name: string) { attributes.delete(name); }
    append() {}
    closest(selector: string): Element | null {
      if (selector === '.ad-showing, .ad-interrupting') return this.ad ? player : null;
      if (selector.includes('ytm-player') || selector === '#player') return player;
      if (selector.includes('button') && this.label) return this;
      return null;
    }
    contains(value: unknown) { return value instanceof Element; }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    matches() { return false; }
  }
  const player = new Element();
  const video = Object.assign(new Element(), { duration: 200, seeking: true });
  // Simulate WebKit reporting the old position while a seek remains in flight.
  Object.defineProperty(video, 'currentTime', { get: () => position, set: (value: number) => { seeks.push(value); } });
  const html = new Element();
  const window: Record<string, unknown> = { innerWidth: 400, innerHeight: 800 }; window.top = window;
  runInNewContext(parity, {
    window, location: new URL('https://m.youtube.com/watch?v=abcdefghijk'),
    document: { documentElement: html, head: html, getElementById: () => html,
      createElement: () => new Element(), querySelectorAll: (selector: string) => selector === 'video' ? [video] : [],
      addEventListener(name: string, fn: (event: unknown) => void) { handlers.set(name, [...handlers.get(name) || [], fn]); } },
    Element, HTMLElement: Element, HTMLAnchorElement: Element, URL,
    innerWidth: 400, innerHeight: 800, performance: { now: () => clock },
    MutationObserver: class { observe() {} disconnect() {} },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    addEventListener() {}, setInterval() {}, setTimeout() {}, requestAnimationFrame(fn: () => void) { fn(); }
  });
  const fire = (name: string, target: Element, trusted = true, x = 320, y = 100) => {
    let prevented = false, stopped = false;
    const point = { clientX: x, clientY: y };
    const event = { isTrusted: trusted, target, touches: name === 'touchend' ? [] : [point], changedTouches: [point],
      preventDefault() { prevented = true; }, stopImmediatePropagation() { stopped = true; } };
    for (const handler of handlers.get(name) || []) { handler(event); if (stopped) break; }
    return prevented;
  };
  return { video, seeks, fire, button(label: string) { const control = new Element(); control.label = label; return control; },
    tap(x = 320, trusted = true) { fire('touchstart', video, trusted, x); clock += 40; const prevented = fire('touchend', video, trusted, x); clock += 60; return prevented; },
    advance(ms: number, value = position) { clock += ms; position = value; } };
}

test('every additional rapid player tap seeks another ten seconds during an unfinished seek', () => {
  const f = touchFixture();
  assert.equal(f.tap(), false);
  for (let i = 0; i < 5; i++) assert.equal(f.tap(), true);
  assert.deepEqual(f.seeks, [70, 80, 90, 100, 110]);
  assert.equal(f.fire('click', f.video), true, 'compatibility clicks cannot also toggle playback');
  f.advance(700, 110);
  assert.equal(f.tap(80), false); assert.equal(f.tap(80), true);
  assert.equal(f.seeks.at(-1), 100);
});

test('ten-second buttons accumulate in either direction and clamp to the media boundaries', () => {
  const f = touchFixture(), forward = f.button('Seek forward 10 seconds'), back = f.button('Rewind 10 seconds');
  for (let i = 0; i < 3; i++) assert.equal(f.fire('click', forward), true);
  assert.deepEqual(f.seeks, [70, 80, 90]);
  f.fire('click', back); assert.equal(f.seeks.at(-1), 80);
  f.advance(700, 197); f.fire('click', forward); assert.equal(f.seeks.at(-1), 199.99);
  f.advance(700, 3); f.fire('click', back); assert.equal(f.seeks.at(-1), 0);
});

test('synthetic taps and active advertisements cannot invoke the custom seek path', () => {
  const f = touchFixture(); f.tap(320, false); f.tap(320, false);
  assert.equal(f.seeks.length, 0);
  f.video.ad = true; f.tap(); f.tap();
  assert.equal(f.seeks.length, 0);
});

test('the page response guard prunes nested mobile players and handles subsequent initial responses', () => {
  const window: Record<string, unknown> = {};
  runInNewContext(responseGuard, { window, location: new URL('https://m.youtube.com/watch?v=abcdefghijk'), URL });
  const player = { videoDetails: { videoId: 'abcdefghijk', keywords: ['economics', 'lecture'] }, streamingData: { formats: [{ url: 'original-stream' }] }, adPlacements: [{}], playerAds: [{}], adSlots: [{}] };
  window.ytInitialPlayerResponse = { contents: [{ watch: { playerResponse: player } }], metadata: { adPlacements: 'retain ordinary metadata' } };
  const clean = JSON.parse(JSON.stringify(window.ytInitialPlayerResponse));
  assert.deepEqual(clean.contents[0].watch.playerResponse, { videoDetails: player.videoDetails, streamingData: player.streamingData });
  assert.equal(clean.metadata.adPlacements, 'retain ordinary metadata');
  assert.equal(player.adPlacements.length, 1, 'sanitizing must not mutate the source object');
  window.ytInitialPlayerResponse = player;
  assert.equal('playerAds' in (window.ytInitialPlayerResponse as object), false);
  window.ytInitialPlayerResponse = { ...player, adSlots: { unknownSchema: true } };
  assert.equal('adPlacements' in (window.ytInitialPlayerResponse as object), true, 'unexpected schemas preserve the response');
});
