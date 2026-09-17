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
async function playerFixture(nativeReply: boolean | 'safari' = false, initiallySaved = true, renewalDelay = 0, timerCadence = 50, settlementDelay = 0) {
  let accountSaved = initiallySaved;
  let clock = 0;
  const nodes: Node[] = [], intervals: { callback: Callback; ms: number; active: boolean }[] = [];
  const handlers = new Map<string, Callback[]>();
  class Node {
    id = ''; textContent = ''; type = ''; children: Node[] = []; style = { cssText: '' };
    events = new Map<string, Callback>();
    attributes = new Map<string,string>();
    constructor() { nodes.push(this); }
    append(...items: Node[]) { this.children.push(...items); }
    prepend(...items: Node[]) { this.children.unshift(...items); }
    after() {}
    remove() {}
    replaceChildren(...items: Node[]) { this.children = items; }
    getAttribute(name:string) { return this.attributes.get(name) ?? null; }
    setAttribute() {}
    removeAttribute() {}
    toggleAttribute(name:string, enabled:boolean) { if(enabled) this.attributes.set(name,''); else this.attributes.delete(name); }
    attachShadow() { return new Node(); }
    addEventListener(event: string, callback: Callback) { this.events.set(event, callback); }
    closest(selector: string): Node | null { return selector.includes('.ytp-play-button') && (this as Node) === (media as Node) ? this : null; }
    querySelector() { return null; }
    click() { this.events.get('click')?.({ preventDefault() {}, stopPropagation() {} }); }
  }
  const emit = (name: string) => { for (const callback of handlers.get(name) || []) callback({ target: media, isTrusted: true }); };
  const media = Object.assign(new Node(), {
    dataset: {} as Record<string, string>, webkitDisplayingFullscreen: false, pauseCount: 0, paused: true, ended: false, seeking: false, readyState: 4, currentTime: 0, playbackRate: 1, autoplay: false,
    pause() { if (!this.paused) this.pauseCount++; this.paused = true; },
    async play() { this.paused = false; emit('play'); emit('playing'); }
  });
  const state = defaultState();
  const act = (body: YouTubeRequest) => youtubeAction(state, body, new Date(Date.UTC(2026, 8, 7, 16) + clock));
  if (initiallySaved) act({ action: 'save', videoId: id });
  const replies: { at: number; resolve: () => void }[] = [];
  const delayedAct = (body: YouTubeRequest) => {
    const response = act(body);
    const delay = body.action === 'renew' ? renewalDelay : body.action === 'settle' ? settlementDelay : 0;
    return delay > 0
      ? new Promise(resolve => replies.push({ at: clock + delay, resolve: () => resolve(response) }))
      : Promise.resolve(response);
  };
  const window: Record<string, unknown> = { addEventListener() {} }; window.top = window;
  if (nativeReply === true) window.webkit = { messageHandlers: { vigilYouTube: { async postMessage(envelope: { body: YouTubeRequest }) { return delayedAct(envelope.body); } } } };
  if (nativeReply === 'safari') {
    Object.defineProperty(window, 'ytInitialData', { configurable: true, get() { throw new Error('Page globals unavailable in Safari isolated world'); } });
    Object.defineProperty(window, 'fetch', { configurable: false, set() { throw new Error('Read-only isolated fetch'); } });
  }
  const document = {
    documentElement: new Node(), body: new Node(), title: 'Fixture',
    createElement() { return new Node(); },
    getElementById(id: string) { return nodes.find(node => node.id === id); },
    querySelector() { return media; },
    querySelectorAll(selector: string) { return selector === 'video,audio' ? [media] : []; },
    addEventListener(event: string, callback: Callback) { handlers.set(event, [...handlers.get(event) || [], callback]); }
  };
  const location = Object.assign(new URL(`https://www.youtube.com/watch?v=${id}`), { assign(url: string) { location.href = url; } });
  runInNewContext(source, { window, document, location,
    crypto: webcrypto, URL, Element: Node, performance: { now: () => clock },
    setInterval(callback: Callback, ms: number) { const timer = { callback, ms, active: true }; intervals.push(timer); return timer; },
    clearInterval(timer: {active: boolean}) { timer.active = false; },
    setTimeout, clearTimeout, AbortSignal,
    fetch: async () => ({ ok: true, text: async () => `var ytInitialData = ${JSON.stringify({ contents: accountSaved ? [{ playlistVideoRenderer: { videoId: id, title: { simpleText: 'Real Watch Later video' } } }] : [] })};` }),
    browser: nativeReply === 'safari' ? { runtime: { async sendMessage(message: { youtube: YouTubeRequest }) { return delayedAct(message.youtube); } } } : undefined,
    chrome: nativeReply === 'safari' ? undefined : { runtime: { async sendMessage(message: { youtube: YouTubeRequest }) { return delayedAct(message.youtube); } } }
  });
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));
  await flush();
  const click = async (label: string) => {
    if (label === 'Pause') {
      media.pause();
      for (const interval of intervals) if (interval.active && interval.ms === 50) interval.callback();
    } else if (label === 'Play this video') {
      for (const callback of handlers.get('click') || []) callback({ isTrusted: true, target: media, preventDefault() {}, stopImmediatePropagation() {} });
    } else throw new Error(`Unexpected native control: ${label}`);
    await flush();
    if (label === 'Pause') await advance(5000, false);
  };
  const advance = async (milliseconds: number, moving = true) => {
    for (let elapsed = 0; elapsed < milliseconds; elapsed += 50) {
      clock += 50;
      for (let i = replies.length - 1; i >= 0; i--) {
        if (replies[i].at <= clock) replies.splice(i, 1)[0].resolve();
      }
      await flush();
      if (!media.paused && moving) media.currentTime += .05 * media.playbackRate;
      if (timerCadence > 50 && clock % 250 === 0 && !media.paused) emit('timeupdate');
      for (const interval of intervals) if (interval.active && clock % Math.max(interval.ms, timerCadence) === 0) interval.callback();
      await flush();
    }
  };
  const standardSave = async (remove = false) => {
    const context = new Node();
    for (const callback of handlers.get('click') || []) callback({ isTrusted: true, target: context });
    const control = new Node(); control.textContent = remove ? 'Remove from Watch Later' : 'Save to Watch Later';
    control.closest = () => control;
    control.click = () => { accountSaved = !remove; };
    for (const callback of handlers.get('click') || []) callback({ isTrusted: true, target: control, preventDefault() {}, stopImmediatePropagation() {} });
    await new Promise(resolve => setTimeout(resolve, 900));
    return accountSaved;
  };
  const key = async (type:string, repeat=false, target:unknown=media) => {
    for (const callback of handlers.get(type) || []) callback({isTrusted:true,key:' ',repeat,target,preventDefault(){},stopImmediatePropagation(){}});
    await flush();
  };
  const searchClick = async (path = '/results?search_query=school') => {
    location.href = `https://www.youtube.com${path}`;
    const link = Object.assign(new Node(), { href: `https://www.youtube.com/watch?v=${id}`, target: '' });
    link.closest = selector => selector === 'a[href]' ? link : null;
    for (const callback of handlers.get('click') || []) callback({ isTrusted: true, target: link, preventDefault() {}, stopImmediatePropagation() {} });
    await flush();
    // Let the route observer settle navigation before pressing Play.
    for (const interval of intervals) if (interval.active && interval.ms === 500) interval.callback();
    await flush();
  };
  const startupControl = async () => {
    const control = Object.assign(new Node(), { isConnected: true });
    control.closest = selector => selector.includes('.ytp-large-play-button') ? control : null;
    let initializations = 0;
    control.click = () => { initializations++; media.readyState = 4; };
    media.readyState = 0;
    for (const callback of handlers.get('click') || []) callback({ isTrusted: true, target: control, preventDefault() {}, stopImmediatePropagation() {} });
    await flush();
    return initializations;
  };
  return { location, startupControl, flush, searchClick, activeFastTimers: () => intervals.filter(timer => timer.active && timer.ms === 50).length, state, media, click, advance, emit, nodes, standardSave, root:document.documentElement, key, jump:(ms:number)=>{clock+=ms;} };
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

test('native WebKit promise replies populate slots and authorize playback without injected callbacks', async () => {
  const { state, media, click, advance, nodes } = await playerFixture(true);
  assert.ok(nodes.some(node => node.textContent.includes('3 saves left')));
  await click('Play this video');
  assert.equal(media.paused, false);
  await advance(500); await click('Pause');
  assert.ok(Math.abs(state.youtubeLimits!.usedMs - 500) < 1);
});

test('standard YouTube save and remove controls change the account playlist and daily slot together', async () => {
  const { state, standardSave } = await playerFixture(false, false);
  assert.equal(await standardSave(), true);
  assert.equal(state.youtubeLimits!.slots[0]!.videoId, id);
  assert.equal(await standardSave(true), false);
  assert.equal(state.youtubeLimits!.slots.filter(Boolean).length, 0);
});
test('a full daily allowance blocks the standard save before YouTube changes its playlist', async () => {
  const { state, standardSave } = await playerFixture(false, false);
  state.youtubeLimits!.slots = Array.from({ length: 4 }, (_, i) => ({ videoId: `other${String(i).padStart(6, '0')}`, title: `Existing ${i}`, locked: false, removed: false }));
  assert.equal(await standardSave(), false);
  assert.equal(state.youtubeLimits!.slots.filter(Boolean).length, 4);
});


test('brief native pauses retain authorization and resume without being re-paused', async () => {
  const { media, click, advance } = await playerFixture();
  await click('Play this video');
  await advance(500);
  media.pause();
  await advance(100, false);
  await media.play();
  await advance(500);
  assert.equal(media.paused, false);
  assert.equal(media.pauseCount, 1);
});

test('quality source reload preserves the current lease and excludes buffering from usage', async () => {
  const { state, media, click, advance, emit } = await playerFixture();
  await click('Play this video');
  await advance(500);
  media.pause(); emit('loadstart');
  await advance(1000, false);
  await media.play();
  await advance(500);
  assert.equal(media.paused, false);
  await click('Pause');
  assert.ok(Math.abs(state.youtubeLimits!.usedMs - 1000) < 1);
});

test('quality buffering longer than a lease renews without charging stalled time', async () => {
  const { state, media, click, advance, emit } = await playerFixture();
  await click('Play this video'); await advance(500);
  media.pause(); emit('loadstart');
  await advance(7000, false);
  await media.play(); await advance(500);
  assert.equal(media.paused, false);
  await click('Pause');
  assert.ok(Math.abs(state.youtubeLimits!.usedMs - 1000) < 1);
});

test('Safari isolated content world authorizes through its extension runtime without a page bridge', async () => {
  const { state, media, click, advance, nodes } = await playerFixture('safari');
  assert.ok(nodes.some(node => node.textContent.includes('3 saves left')));
  await media.play(); assert.equal(media.paused, true);
  await click('Play this video'); assert.equal(media.paused, false);
  await advance(500); await click('Pause');
  assert.ok(Math.abs(state.youtubeLimits!.usedMs - 500) < 1);
});

test('a pending browser play promise does not prevent authorization renewal during buffering', async () => {
  const { state, media, click, advance, emit } = await playerFixture();
  let resolvePlay!: () => void;
  media.play = () => {
    media.paused = false; emit('play'); emit('waiting');
    return new Promise<void>(resolve => { resolvePlay = resolve; });
  };
  await click('Play this video');
  await advance(6500, false);
  emit('playing'); resolvePlay();
  await advance(1000);
  assert.equal(media.paused, false, 'buffering must not strand playback behind the busy flag');
  assert.ok(state.youtubeLimits!.lease, 'bounded authorization remains live during buffering');
});

test('an unsaved video stays blocked and shows a dismissible save-first notification', async () => {
  const { media, click, nodes } = await playerFixture('safari', false);
  await click('Play this video');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(media.paused, true);
  assert.ok(nodes.some(node => node.textContent === 'Save this video to Watch Later first.'));
  const notice = nodes.find(node => node.id === 'vigil-youtube-notice') as unknown as {hidden:boolean};
  const dismiss = nodes.find(node => node.textContent === '×')!;
  assert.equal(notice.hidden, false);
  dismiss.click();
  assert.equal(notice.hidden, true);
  assert.equal(media.paused, true, 'dismissing a message never grants playback');
  await click('Play this video');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(notice.hidden, false, 'another blocked Play attempt explains the requirement again');
});


test('the held player exposes native Play controls until a saved video receives authorization', async () => {
  const unsaved = await playerFixture('safari', false);
  assert.equal(unsaved.root.getAttribute('data-vigil-playback-held'), '');
  await unsaved.click('Play this video');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(unsaved.root.getAttribute('data-vigil-playback-held'), '');
  assert.equal(unsaved.media.paused, true);
  const saved = await playerFixture(true);
  await saved.click('Play this video');
  assert.equal(saved.root.getAttribute('data-vigil-playback-held'), null);
  assert.equal(saved.media.paused, false);
});


test('space tap toggles once on release; holding uses 2x and restores the chosen speed', async () => {
  const f = await playerFixture('safari');
  await f.key('keydown'); await f.advance(100,false);
  assert.equal(f.media.paused,true);
  await f.key('keyup'); assert.equal(f.media.paused,false);
  f.media.playbackRate=1.25; f.emit('ratechange');
  await f.key('keydown'); await f.advance(400); await f.key('keydown',true);
  assert.equal(f.media.playbackRate,2); assert.equal(f.media.paused,false);
  await f.advance(500); await f.key('keyup');
  assert.equal(f.media.playbackRate,1.25); assert.equal(f.media.paused,false);
  await f.key('keydown'); await f.advance(100); await f.key('keyup');
  assert.equal(f.media.paused,true);
});

test('a paused video can sit for minutes and resume at its position without an expiry message', async () => {
  const f=await playerFixture(true);
  await f.click('Play this video'); await f.advance(1500);
  f.media.pause(); const position=f.media.currentTime;
  await f.advance(120000,false);
  assert.equal(f.media.currentTime,position); assert.equal(f.state.youtubeLimits!.lease,null);
  assert.ok(!f.nodes.some(node=>/expired|timed out/i.test(node.textContent)));
  await f.key('keydown'); await f.key('keyup');
  assert.equal(f.media.paused,false); assert.equal(f.media.currentTime,position);
  await f.advance(500); assert.ok(f.media.currentTime>position);
});

test('space does not intercept text entry', async()=>{
  const f=await playerFixture();
  await f.key('keydown',false,{tagName:'TEXTAREA'}); await f.key('keyup',false,{tagName:'TEXTAREA'});
  assert.equal(f.media.paused,true);
});


test('a suspended paused tab reacquires authorization on the first Play click without a timeout', async()=>{
  const f=await playerFixture('safari');
  await f.click('Play this video'); await f.advance(500); f.media.pause();
  const position=f.media.currentTime; f.jump(120000);
  await f.click('Play this video');
  assert.equal(f.media.paused,false); assert.equal(f.media.currentTime,position);
  assert.ok(!f.nodes.some(node=>/expired|timed out/i.test(node.textContent)));
});

test('high-frequency clock runs only for playback or a held spacebar', async () => {
  const fixture = await playerFixture();
  assert.equal(fixture.activeFastTimers(), 0);
  await fixture.click('Play this video');
  assert.equal(fixture.activeFastTimers(), 1);
  await fixture.click('Pause');
  assert.equal(fixture.activeFastTimers(), 0);
  await fixture.key('keydown');
  assert.equal(fixture.activeFastTimers(), 1);
  await fixture.key('keyup');
  await fixture.advance(100);
  assert.equal(fixture.activeFastTimers(), 1);
});


test('Safari renewal latency does not cause repeated playback dropouts', async () => {
  const { state, media, click, advance } = await playerFixture('safari', true, 750);
  await click('Play this video');
  await advance(30000);
  assert.equal(media.pauseCount, 0, 'renew before a delayed native reply exhausts the authorized tail');
  await click('Pause');
  assert.ok(Math.abs(state.youtubeLimits!.usedMs - 30000) < 1);
});

test('a stalled Safari renewal still stops at the existing playback allowance', async () => {
  const { media, click, advance } = await playerFixture('safari', true, 6000);
  await click('Play this video');
  await advance(2500);
  assert.equal(media.paused, true);
  assert.ok(media.currentTime <= 2.1 + Number.EPSILON * 10, 'pending renewal cannot grant additional playback');
});


test('background Safari playback survives throttled timers and native bridge latency', async () => {
  for (const cadence of [1000, 2000]) {
    const { state, media, click, advance } = await playerFixture('safari', true, 750, cadence);
    await click('Play this video');
    await advance(30000);
    assert.equal(media.pauseCount, 0, `no dropout with ${cadence} ms timer callbacks`);
    await click('Pause');
    assert.ok(Math.abs(state.youtubeLimits!.usedMs - 30000) < 1);
  }
});

test('a clicked YouTube search result plays without saving on phone and Safari', async () => {
  for (const transport of [true, 'safari'] as const) {
    const f = await playerFixture(transport, false);
    await f.searchClick();
    await f.click('Play this video');
    assert.equal(f.media.paused, false);
    await f.advance(3000);
    await f.click('Pause');
    assert.ok(f.state.youtubeLimits!.usedMs >= 2900);
    assert.equal(f.state.youtubeLimits!.slots.filter(Boolean).length, 0);
  }
});

test('clicking an unsaved home recommendation does not grant search playback', async () => {
  const f = await playerFixture('safari', false);
  await f.searchClick('/');
  assert.deepEqual(f.state.youtubeLimits!.external, []);
});


test('phone startup replays YouTube’s large Play control after authorization so the source initializes', async () => {
  const f = await playerFixture(true);
  assert.equal(await f.startupControl(), 1);
  assert.equal(f.media.readyState, 4);
  assert.equal(f.media.paused, false);
  assert.equal(f.root.getAttribute('data-vigil-playback-held'), null);
});

test('blocked startup never invokes YouTube’s Play handler', async () => {
  const f = await playerFixture(true, false);
  assert.equal(await f.startupControl(), 0);
  assert.equal(f.media.paused, true);
});

test('native fullscreen Play reacquires authorization after a long pause at the same position', async () => {
  const f = await playerFixture(true);
  await f.click('Play this video');
  await f.advance(1000);
  f.media.webkitDisplayingFullscreen = true;
  await f.click('Pause');
  const position = f.media.currentTime;
  await f.advance(120000, false);
  assert.equal(f.state.youtubeLimits!.lease, null);
  await f.media.play();
  await f.flush();
  assert.equal(f.media.paused, false);
  assert.equal(f.media.currentTime, position);
  assert.equal(f.media.webkitDisplayingFullscreen, true);
  await f.advance(500);
  await f.click('Pause');
  assert.ok(Math.abs(f.state.youtubeLimits!.usedMs - 1500) < 1);
});

test('fullscreen autoplay without prior deliberate playback remains blocked', async () => {
  const f = await playerFixture(true);
  f.media.webkitDisplayingFullscreen = true;
  await f.media.play();
  await f.flush();
  assert.equal(f.media.paused, true);
  assert.equal(f.state.youtubeLimits!.lease, null);
});

test('fullscreen resume still respects an exhausted daily allowance', async () => {
  const f = await playerFixture(true);
  await f.click('Play this video');
  f.media.webkitDisplayingFullscreen = true;
  await f.click('Pause');
  f.state.youtubeLimits!.usedMs = YOUTUBE_BASE_MS;
  f.state.youtubeLimits!.grace.status = 'ended';
  await f.media.play();
  await f.flush();
  assert.equal(f.media.paused, true);
  assert.equal(f.state.youtubeLimits!.lease, null);
});

test('a source reload abort during startup retries when media becomes playable without refreshing', async () => {
  const f = await playerFixture(true);
  const play = f.media.play.bind(f.media);
  f.media.play = async () => {
    f.emit('loadstart');
    const error = new Error('The operation was aborted.'); error.name = 'AbortError';
    throw error;
  };
  await f.click('Play this video');
  assert.ok(f.state.youtubeLimits!.lease);
  f.media.play = play;
  f.emit('canplay');
  await f.flush();
  assert.equal(f.media.paused, false);
  await f.advance(500);
  await f.click('Pause');
  assert.ok(Math.abs(f.state.youtubeLimits!.usedMs - 500) < 1);
});


test('Watch Later list/index URL updates preserve playback and metering for the same video', async () => {
  const f = await playerFixture(true);
  await f.click('Play this video');
  await f.advance(500);
  f.location.search += '&list=WL&index=2';
  await f.advance(1000);
  assert.equal(f.media.paused, false);
  await f.click('Pause');
  assert.ok(Math.abs(f.state.youtubeLimits!.usedMs - 1500) < 1);
});

test('a different video route revokes fullscreen resume intent', async () => {
  const f = await playerFixture(true);
  await f.click('Play this video');
  f.media.webkitDisplayingFullscreen = true;
  f.location.search = '?v=video000001';
  await f.advance(500);
  await f.media.play();
  await f.flush();
  assert.equal(f.media.paused, true);
  assert.equal(f.state.youtubeLimits!.lease, null);
});

test('fullscreen Play during a pending pause settlement resumes after the settlement completes', async () => {
  const f = await playerFixture(true, true, 0, 50, 1500);
  await f.click('Play this video');
  await f.advance(500);
  f.media.webkitDisplayingFullscreen = true;
  f.media.pause();
  await f.advance(1100, false);
  await f.media.play();
  await f.flush();
  assert.equal(f.media.paused, true, 'old authorization must remain stopped while settlement is pending');
  await f.advance(1500, false);
  assert.equal(f.media.paused, false, 'the fullscreen Play request must survive settlement latency');
});


test('phone content classification can hold startup longer than a lease without losing Play intent', async () => {
  const f = await playerFixture(true);
  const play = f.media.play.bind(f.media);
  f.media.play = async () => { f.media.dataset.vigilPlaybackRequested = 'true'; };
  await f.click('Play this video');
  await f.advance(7000, false);
  assert.equal(f.media.paused, true);
  assert.ok(f.state.youtubeLimits!.lease, 'classification must retain bounded authorization');
  assert.equal(f.state.youtubeLimits!.usedMs, 0, 'classification cannot spend watch time');
  delete f.media.dataset.vigilPlaybackRequested;
  f.media.play = play;
  await f.media.play();
  await f.advance(500);
  assert.equal(f.media.paused, false);
  await f.click('Pause');
  assert.ok(Math.abs(f.state.youtubeLimits!.usedMs - 500) < 1);
});

test('startup recovers when canplay arrives before the aborted play promise rejects', async () => {
  const f = await playerFixture(true);
  const play = f.media.play.bind(f.media);
  let attempts = 0;
  f.media.play = async () => {
    if (++attempts > 1) return play();
    f.emit('loadstart');
    f.emit('canplay');
    const error = new Error('Source changed'); error.name = 'AbortError';
    throw error;
  };
  await f.click('Play this video');
  await f.advance(100, false);
  assert.equal(f.media.paused, false);
  assert.equal(attempts, 2);
  await f.advance(500);
  await f.click('Pause');
  assert.ok(Math.abs(f.state.youtubeLimits!.usedMs - 500) < 1);
});

test('native full-screen entry supports the first Play without playing inline first', async () => {
  for (const saved of [true, false]) {
    const f = await playerFixture(true, saved);
    f.media.webkitDisplayingFullscreen = true;
    f.emit('webkitbeginfullscreen');
    assert.equal(f.state.youtubeLimits!.lease, null, 'entering fullscreen cannot start playback');
    await f.media.play();
    await f.flush();
    assert.equal(f.media.paused, !saved);
    assert.equal(Boolean(f.state.youtubeLimits!.lease), saved);
    assert.equal(f.media.webkitDisplayingFullscreen, true);
  }
});

test('an aborted full-screen resume uses the same bounded retry as initial startup', async () => {
  const f = await playerFixture(true);
  await f.click('Play this video');
  f.media.pause();
  f.media.webkitDisplayingFullscreen = true;
  const play = f.media.play.bind(f.media);
  let attempts = 0;
  f.media.play = async () => {
    if (++attempts > 1) return play();
    const error = new Error('Interrupted'); error.name = 'AbortError';
    throw error;
  };
  await f.key('keydown'); await f.key('keyup');
  await f.advance(100, false);
  assert.equal(f.media.paused, false);
  assert.equal(f.media.webkitDisplayingFullscreen, true);
});

test('buffering presents pending playback instead of a second large Play button', async () => {
  const f = await playerFixture(true);
  await f.click('Play this video');
  f.emit('waiting');
  await f.advance(100, false);
  assert.equal(f.root.getAttribute('data-vigil-playback-pending'), '');
  assert.equal(f.root.getAttribute('data-vigil-playback-held'), null);
  f.emit('playing');
  await f.advance(100);
  assert.equal(f.root.getAttribute('data-vigil-playback-pending'), null);
});
