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

function touchFixture(parsed = true) {
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
  const observers: Array<() => void> = [];
  const document = { documentElement: parsed ? html : null, head: parsed ? html : null, getElementById: () => parsed ? html : null,
    createElement: () => new Element(), querySelectorAll: (selector: string) => selector === 'video' ? [video] : [],
    addEventListener(name: string, fn: (event: unknown) => void) { handlers.set(name, [...handlers.get(name) || [], fn]); } };
  const window: Record<string, unknown> = { innerWidth: 400, innerHeight: 800 }; window.top = window;
  runInNewContext(parity, {
    window, location: new URL('https://m.youtube.com/watch?v=abcdefghijk'),
    document,
    Element, HTMLElement: Element, HTMLAnchorElement: Element, URL,
    innerWidth: 400, innerHeight: 800, performance: { now: () => clock },
    MutationObserver: class {
      constructor(callback: (mutations: never[]) => void) { observers.push(() => callback([])); }
      observe() {} disconnect() {}
    },
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
  return { video, seeks, fire, window,
    parse() {
      parsed = true; document.documentElement = html; document.head = html;
      for (const observer of observers) observer();
    },
    button(label: string) { const control = new Element(); control.label = label; return control; },
    tap(x = 320, trusted = true) { fire('touchstart', video, trusted, x); clock += 40; const prevented = fire('touchend', video, trusted, x); clock += 60; return prevented; },
    advance(ms: number, value = position) { clock += ms; position = value; } };
}

test('document-start controls survive a missing page root and finish installing', () => {
  const f = touchFixture(false);
  assert.equal(f.window.__vigilYouTubeParityReady, true);
  assert.doesNotThrow(() => f.parse());
  assert.equal(f.tap(), false);
  assert.equal(f.tap(), true);
  assert.deepEqual(f.seeks, [70]);
});

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
  assert.equal(window.__vigilYouTubeResponseGuardReady, true);
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

test('a failed response guard cannot report completed ad protection', () => {
  const window = {};
  Object.defineProperty(window, 'fetch', { value: () => {}, writable: false });
  assert.throws(() => runInNewContext(responseGuard, {
    window, location: new URL('https://m.youtube.com/'), URL
  }), /read only|readonly|not writable|Cannot assign/i);
  assert.equal((window as Record<string, unknown>).__vigilYouTubeResponseGuardReady, undefined);
});

test('mobile initial-data strings and legacy player args lose only recognized ad arrays', () => {
  const window: Record<string, unknown> = {};
  runInNewContext(responseGuard, { window, location: new URL('https://m.youtube.com/watch?v=abcdefghijk'), URL });
  const player = { videoDetails: { videoId: 'abcdefghijk' }, playabilityStatus: { status: 'LOGIN_REQUIRED' },
    streamingData: { adaptiveFormats: [{ url: 'signed-original-stream' }] }, adPlacements: [{}], adSlots: [{}] };
  window.ytInitialData = JSON.stringify({ playerResponse: JSON.stringify(player), captions: { tracks: ['original-caption'] } });
  const clean = JSON.parse(window.ytInitialData as string);
  assert.deepEqual(JSON.parse(clean.playerResponse), { videoDetails: player.videoDetails,
    playabilityStatus: player.playabilityStatus, streamingData: player.streamingData });
  assert.deepEqual(clean.captions.tracks, ['original-caption']);
  const load = () => 'original-player-method';
  window.ytplayer = { load, optional: undefined, config: { args: { player_response: JSON.stringify(player), auth: 'retain' } } };
  const args = (window.ytplayer as { config: { args: { player_response: string; auth: string } } }).config.args;
  assert.equal('adSlots' in JSON.parse(args.player_response), false);
  assert.equal(args.auth, 'retain');
  assert.equal((window.ytplayer as { load: typeof load }).load, load);
  assert.equal('optional' in (window.ytplayer as object), true);
});

test('ad filtering composes with the existing native feed adapter and inline JSON parsing', () => {
  let data: unknown, feedWrites = 0;
  const window: Record<string, unknown> = {};
  Object.defineProperty(window, 'ytInitialData', { configurable: true,
    get: () => data, set(value) { data = value; feedWrites++; } });
  const context = { window, location: new URL('https://m.youtube.com/watch?v=abcdefghijk'), URL };
  runInNewContext(responseGuard, context);
  const player = { videoDetails: { videoId: 'abcdefghijk' }, playabilityStatus: { status: 'OK' }, playerAds: [{}] };
  window.ytInitialData = { playerResponse: player };
  assert.ok(feedWrites >= 1);
  assert.equal('playerAds' in (data as { playerResponse: object }).playerResponse, false);
  const inline = runInNewContext(responseGuard + `\nJSON.parse(${JSON.stringify(JSON.stringify(player))})`, context);
  assert.equal('playerAds' in inline, false, 'inline startup data can bypass fetch and initial globals');
  const unknown = { ...player, adSlots: { unexpected: true } };
  const untouched = runInNewContext(responseGuard + `\nJSON.parse(${JSON.stringify(JSON.stringify(unknown))})`, context);
  assert.deepEqual(JSON.parse(JSON.stringify(untouched)), unknown, 'unknown schema must retain the entire response');
});

test('network player filtering preserves media, captions and login checks across fetch and XHR', async () => {
  const payload = { playerResponse: { videoDetails: { videoId: 'abcdefghijk' },
    streamingData: { formats: [{ url: 'original-signed-stream' }] },
    playabilityStatus: { status: 'LOGIN_REQUIRED' }, captions: { tracks: ['original-captions'] }, adSlots: [{}] } };
  const raw = JSON.stringify(payload);
  class XHR {
    readyState = 4; status = 200; responseType = ''; responseURL = '';
    open(_method: string, url: string) { this.responseURL = url; }
    get response() { return this.responseType === 'json' ? payload : raw; }
    get responseText() { return raw; }
    getResponseHeader() { return 'application/json'; }
  }
  const nativeFetch = async () => new Response(raw, { headers: { 'Content-Type': 'application/json', ETag: 'stale-body-hash', 'Content-Length': String(raw.length) } });
  const window = { fetch: nativeFetch, XMLHttpRequest: XHR };
  runInNewContext(responseGuard, { window, location: new URL('https://m.youtube.com/watch?v=abcdefghijk'), URL, Response, Headers, Request });
  const fetched = await (window.fetch as (url: string) => Promise<Response>)('https://m.youtube.com/youtubei/v1/player');
  const clean = await fetched.json();
  assert.equal('adSlots' in clean.playerResponse, false);
  assert.deepEqual(clean.playerResponse.streamingData, payload.playerResponse.streamingData);
  assert.deepEqual(clean.playerResponse.playabilityStatus, payload.playerResponse.playabilityStatus);
  assert.deepEqual(clean.playerResponse.captions, payload.playerResponse.captions);
  assert.equal(fetched.headers.has('ETag'), false);
  assert.equal(fetched.headers.has('Content-Length'), false);
  const unrelated = await (window.fetch as (url: string) => Promise<Response>)('https://m.youtube.com/youtubei/v1/browse');
  assert.equal((await unrelated.json()).playerResponse.adSlots.length, 1, 'unrelated endpoints retain their original payload');
  for (const type of ['', 'text', 'json']) {
    const xhr = new window.XMLHttpRequest(); xhr.responseType = type;
    xhr.open('POST', 'https://m.youtube.com/youtubei/v1/player');
    const cleanXHR = typeof xhr.response === 'string' ? JSON.parse(xhr.response) : xhr.response;
    assert.equal('adSlots' in cleanXHR.playerResponse, false);
    assert.deepEqual(JSON.parse(JSON.stringify(cleanXHR)), clean);
  }
  assert.equal(payload.playerResponse.adSlots.length, 1, 'native response objects remain unmodified');
});
