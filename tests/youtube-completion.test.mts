import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
const source = await readFile(new URL('../extension/youtube-limits.js', import.meta.url), 'utf8');
const screenSource = source.slice(source.indexOf('  function updateFinishedScreen()'), source.indexOf('  function updateHeldPlayer()'));
const renderSource = source.slice(source.indexOf('  function render()'), source.indexOf('  const sample ='));
const ids = ['video000000', 'video000001', 'video000002', 'video000003'];
function fixture(bodyReady = true) {
  class Node {
    id = ''; className = ''; href = ''; src = ''; textContent = ''; isConnected = false;
    children: Node[] = [];
    attributes = new Map<string, string>();
    events = new Map<string, (event: unknown) => void>();
    shadow: Node | null = null;
    _content?: Node;
    hidden = false;
    append(...nodes: Node[]) { for (const node of nodes) { node.isConnected = true; this.children.push(node); } }
    replaceChildren(...nodes: Node[]) { this.children = nodes; }
    setAttribute(name: string, value: string) { this.attributes.set(name, value); }
    toggleAttribute(name: string, enabled: boolean) { if (enabled) this.attributes.set(name, ''); else this.attributes.delete(name); }
    attachShadow() { this.shadow = new Node(); return this.shadow; }
    querySelector(tag: string) { return this.children.find(node => node.tag === tag); }
    addEventListener(name: string, callback: (event: unknown) => void) { this.events.set(name, callback); }
    constructor(readonly tag = '') {}
  }
  const body = new Node('body');
  const panel = new Node('aside'), statusLine = new Node('strong');
  const document = { body: bodyReady ? body : null, documentElement: new Node('html'), createElement: (tag: string) => new Node(tag) };
  const navigations: string[] = [];
  const initial = { day: '2026-10-28', slots: ids.map(videoId => ({ videoId, title: videoId, locked: false, removed: false })),
    usedMs: 0, grace: { status: 'unused', usedMs: 0, videoId: null }, external: [] };
  const api = runInNewContext(`let state = initial, finishedScreen, finishedSignature = '', id = '', playing = false, lease, settlingPlayback = false, watchLaterSnapshot;
    const topFrame = true, verifiedWatchPages = new Set(), currentID = () => id;
    ${screenSource}
    ${renderSource}
    ({update: updateFinishedScreen, render, state: () => state, set: value => {state = value;}, route: value => {id = value;},
      verify: value => verifiedWatchPages.add(state.day + ':' + value), screen: () => finishedScreen,
      play: value => { playing = Boolean(value); lease = value ? {videoId: value} : null; },
      playlist: value => { watchLaterSnapshot = value; }})`, {
    initial, document, panel, statusLine, window: {}, location: { assign: (url: string) => navigations.push(url) }
  });
  const content = () => api.screen()?._content as Node;
  const grid = () => content()?.children.find(node => node.className === 'cards');
  const cards = () => grid()?.children.map(item => item.children[0]) || [];
  const links = () => cards().filter(card => card.tag === 'a');
  const completion = () => content()?.children.find(node => node.className === 'finished-message');
  const heading = () => (completion() || content())?.querySelector('h1')?.textContent;
  return { api, document, body, panel, statusLine, navigations, content, grid, cards, links, completion, heading };
}
test('four saved videos show their thumbnails and titles alongside the remaining time', () => {
  const f = fixture(), state = f.api.state();
  state.slots[0].title = 'A saved video title';
  const thumbnail = `https://i.ytimg.com/vi/${ids[0]}/hqdefault.jpg`;
  f.api.playlist({ day: state.day, cards: [{videoId: ids[0], channel: 'The creator', duration: '12:34', thumbnail}] });
  f.api.render();
  assert.equal(f.heading(), 'Today’s saved videos');
  assert.deepEqual(f.content().children.map(node => node.tag), ['div', 'h1', 'div']);
  assert.equal(f.content().children[0].children.length, 1);
  assert.equal(f.cards().length, 4);
  assert.deepEqual(f.cards().map(card => card.children[0].children[0].tag), ['img', 'img', 'img', 'img']);
  assert.equal(f.cards()[0].children[0].children[0].src, thumbnail);
  assert.equal(f.cards()[0].children[1].children[0].textContent, 'A saved video title');
  assert.equal(f.cards()[0].children[1].children[1].textContent, 'The creator');
  assert.equal(f.cards()[0].children[0].children[1].textContent, '12:34');
  assert.equal(f.statusLine.textContent, '120 min left');
  assert.equal(f.panel.attributes.has('data-duplicate-status'), false);

  f.api.route(ids[0]); f.api.render();
  assert.equal(f.statusLine.textContent, '0 saves left · 120 min left');

  state.usedMs = 7200000; state.grace.status = 'ended';
  f.api.render();
  assert.match(f.heading()!, /run out of watch time/);
  assert.deepEqual(f.content().children.map(node => node.tag), ['div', 'h1']);
  assert.equal(f.content().children[0].children.length, 1);
  assert.equal(f.panel.attributes.has('data-duplicate-status'), true);
});
test('time exhaustion takes priority with any number of saves and on saved or verified external routes', () => {
  for (const saves of [0, 1, 4]) {
    const f = fixture(), state = f.api.state();
    state.slots = state.slots.map((slot: unknown, index: number) => index < saves ? slot : null);
    state.usedMs = 7200000; state.grace.status = 'ended'; state.external = [ids[0]];
    for (const id of ['', ids[0], ids[1]]) {
      f.api.route(id); f.api.verify(id); f.api.update();
      assert.equal(f.api.screen().hidden, false);
      assert.match(f.heading()!, /run out of watch time/);
      assert.equal(f.links().length, 0);
      assert.equal(f.grid(), undefined);
    }
  }
});
test('the existing grace allows only its current video and never offers other saved videos', () => {
  const f = fixture(), state = f.api.state();
  state.usedMs = 7200000;
  state.grace = { status: 'active', videoId: ids[0], usedMs: 1000 };
  f.api.update(); assert.equal(f.links().length, 0);
  f.api.route(ids[0]); f.api.update(); assert.equal(f.api.screen().hidden, true);
  f.api.route(ids[1]); f.api.update(); assert.equal(f.api.screen().hidden, false); assert.equal(f.links().length, 0);
  state.grace.usedMs = 1200000;
  f.api.route(ids[0]); f.api.update(); assert.equal(f.api.screen().hidden, false);
});
test('watched cards keep their position and the final grid remains visible with four disabled cards', () => {
  const f = fixture(); f.api.update(); assert.equal(f.links().length, 4);
  const state = f.api.state(); state.slots[0].completed = true;
  f.api.update(); assert.equal(f.links().length, 3);
  assert.deepEqual(f.cards().map(card => card.attributes.has('data-inactive')), [true, false, false, false]);
  assert.equal(f.cards()[0].children[0].querySelector('img'), undefined);
  assert.deepEqual(f.links().map(card => card.href), ids.slice(1).map(id => '/watch?v=' + id));
  f.api.route(ids[0]); f.api.verify(ids[0]); f.api.update();
  assert.equal(f.api.screen().hidden, false, 'a cached check cannot reopen a finished save');
  f.api.play(ids[0]); f.api.update();
  assert.equal(f.api.screen().hidden, true, 'the existing lease can still play the ending');
  f.api.play(null);
  for (const slot of state.slots) slot.completed = true;
  for (const grace of ['unused', 'ended']) {
    state.grace.status = grace;
    f.api.update(); assert.equal(f.heading(), 'You’ve watched all your saved videos for today.');
    assert.equal(f.completion()?.attributes.get('role'), 'status');
    assert.equal(f.links().length, 0);
    assert.deepEqual(f.cards().map(card => card.children[0].children.map(child => child.textContent)), Array(4).fill(['Watched']));
  }
});
test('local playback progress labels a full-color playable card before account progress syncs', () => {
  const f = fixture(), state = f.api.state();
  state.slots[0].locked = true;
  f.api.update();
  const card = f.links()[0];
  assert.equal(card.href, '/watch?v=' + ids[0]);
  assert.equal(card.children[0].querySelector('img')?.src, `https://i.ytimg.com/vi/${ids[0]}/mqdefault.jpg`);
  assert.equal(card.children[0].attributes.has('data-in-progress'), true);
  assert.equal(card.children[0].children[0].textContent, 'In progress');
});
test('first activation directly opens a save and polling does not replace the clicked card', () => {
  const f = fixture(); f.api.update();
  const first = f.links()[0], heading = f.content().querySelector('h1');
  const state = f.api.state(); state.usedMs = 16000;
  f.api.update();
  assert.equal(f.links()[0], first); assert.equal(f.content().querySelector('h1'), heading);
  let prevented = 0, stopped = 0;
  first.events.get('click')!({ button: 0, preventDefault: () => prevented++, stopPropagation: () => stopped++ });
  assert.deepEqual(f.navigations, ['/watch?v=video000000']);
  assert.equal(prevented, 1); assert.equal(stopped, 1);
});
test('a saved card ignores a scroll, long press and cancelled touch while accepting a single tap', () => {
  const f = fixture(); f.api.update();
  const link = f.links()[1];
  const touch = (type: string, x: number, timeStamp: number) => {
    const point = { identifier: 1, clientX: x, clientY: 100 };
    link.events.get(type)!({ touches: type === 'touchend' ? [] : [point], changedTouches: [point],
      timeStamp, cancelable: true, preventDefault() {}, stopPropagation() {} });
  };
  touch('touchstart', 10, 0); touch('touchmove', 45, 100); touch('touchend', 10, 160);
  touch('touchstart', 10, 200); touch('touchend', 10, 800);
  touch('touchstart', 10, 1000); touch('touchcancel', 10, 1010); touch('touchend', 10, 1050);
  assert.deepEqual(f.navigations, []);
  touch('touchstart', 10, 1200); touch('touchend', 12, 1250);
  assert.deepEqual(f.navigations, ['/watch?v=video000001']);
});
test('document-start gating precedes the body and mounting waits until content is assembled', () => {
  const f = fixture(false); f.api.update();
  assert.equal(f.document.documentElement.attributes.has('data-vigil-saves-finished'), true);
  assert.equal(f.api.screen(), undefined);
  f.document.body = f.body; f.api.update();
  assert.equal(f.api.screen().hidden, false); assert.equal(f.links().length, 4);
  assert.equal(f.body.children.filter(node => node.id === 'vigil-youtube-finished').length, 1);
  assert.doesNotMatch(f.api.screen().shadow.children[0].textContent, /animation:vigil-surface-in/);
  assert.match(source, /if \(!document.body\) document.addEventListener\('DOMContentLoaded', clean/);
});
