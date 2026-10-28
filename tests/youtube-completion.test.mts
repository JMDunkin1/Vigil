import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
const source = await readFile(new URL('../extension/youtube-limits.js', import.meta.url), 'utf8');
const screenSource = source.slice(source.indexOf('  function updateFinishedScreen()'), source.indexOf('  function updateHeldPlayer()'));
const ids = ['video000000', 'video000001', 'video000002', 'video000003'];
function fixture(bodyReady = true) {
  class Node {
    id = ''; className = ''; href = ''; textContent = ''; isConnected = false;
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
  const document = { body: bodyReady ? body : null, documentElement: new Node('html'), createElement: (tag: string) => new Node(tag) };
  const navigations: string[] = [];
  const initial = { day: '2026-10-28', slots: ids.map(videoId => ({ videoId, title: videoId, locked: false, removed: false })),
    usedMs: 0, grace: { status: 'unused', usedMs: 0, videoId: null }, external: [] };
  const api = runInNewContext(`let state = initial, finishedScreen, finishedSignature = '', id = '';
    const topFrame = true, verifiedWatchPages = new Set(), currentID = () => id;
    ${screenSource}
    ({update: updateFinishedScreen, state: () => state, set: value => {state = value;}, route: value => {id = value;},
      verify: value => verifiedWatchPages.add(state.day + ':' + value), screen: () => finishedScreen})`, {
    initial, document, window: {}, location: { assign: (url: string) => navigations.push(url) }
  });
  const content = () => api.screen()?._content as Node;
  const links = () => content()?.querySelector('nav')?.children || [];
  const heading = () => content()?.querySelector('h1')?.textContent;
  return { api, document, body, navigations, content, links, heading };
}
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
      assert.equal(f.content().querySelector('nav'), undefined);
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
test('completed saves disappear individually and all four completed saves leave no video list', () => {
  const f = fixture(); f.api.update(); assert.equal(f.links().length, 4);
  const state = f.api.state(); state.slots[0].completed = true;
  f.api.update(); assert.equal(f.links().length, 3);
  f.api.route(ids[0]); f.api.verify(ids[0]); f.api.update();
  assert.equal(f.api.screen().hidden, false, 'a cached check cannot reopen a finished save');
  for (const slot of state.slots) slot.completed = true;
  f.api.update(); assert.match(f.heading()!, /watched all your saved videos/);
  assert.equal(f.links().length, 0); assert.equal(f.content().querySelector('nav'), undefined);
});
test('first activation directly opens a save and polling does not replace the clicked row', () => {
  const f = fixture(); f.api.update();
  const first = f.links()[0], heading = f.content().querySelector('h1');
  const state = f.api.state(); state.slots[0].locked = true; state.usedMs = 16000;
  f.api.update();
  assert.equal(f.links()[0], first); assert.equal(f.content().querySelector('h1'), heading);
  let prevented = 0, stopped = 0;
  first.events.get('click')!({ button: 0, preventDefault: () => prevented++, stopPropagation: () => stopped++ });
  assert.deepEqual(f.navigations, ['/watch?v=video000000']);
  assert.equal(prevented, 1); assert.equal(stopped, 1);
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
