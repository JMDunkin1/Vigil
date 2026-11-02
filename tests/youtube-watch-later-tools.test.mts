import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../extension/youtube-limits.js', import.meta.url), 'utf8');
const openSource = source.slice(source.indexOf('  async function openWatchLaterTools('), source.indexOf('  async function reviewWatchLaterTools('));
const runSource = source.slice(source.indexOf('  async function runWatchLaterClear('), source.indexOf('  // END WATCH LATER BULK CLEAR'));
const reviewSource = source.slice(source.indexOf('  async function reviewWatchLaterTools('), source.indexOf('  async function runWatchLaterClear('));
class Node {
  children: Node[] = [];
  textContent = '';
  className = '';
  open = false;
  isConnected = true;
  disabled = false;
  inert = false;
  hidden = false;
  shadow?: Node;
  style = {};
  attributes = new Map<string, string>();
  handlers = new Map<string, (event: unknown) => void>();
  constructor(readonly tag: string) {}
  append(...nodes: Node[]) { this.children.push(...nodes); }
  attachShadow() { this.shadow = new Node('shadow'); return this.shadow; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  removeAttribute(name: string) { this.attributes.delete(name); }
  addEventListener(name: string, callback: (event: unknown) => void) { this.handlers.set(name, callback); }
  showModal() { this.open = true; }
  close() { this.open = false; }
  remove() { this.isConnected = false; }
  contains(node: Node): boolean { return this === node || this.children.some(child => child.contains(node)); }
  closest(_selector: string): Node | null { return null; }
  querySelector(): Node | null { return null; }
  getBoundingClientRect() { return { left: 10, top: 10, right: 350, bottom: 200, width: 340, height: 190 }; }
  dispatched: string[] = [];
  dispatchEvent(event: Event) { this.dispatched.push(event.type); return true; }
  focus() {}
}
function fixture() {
  let reloads = 0, clears = 0;
  const body = new Node('body');
  const api = runInNewContext(`let watchLaterTools=null,bulkClearRunning=false,bulkClearStopped=false;
    ${openSource}\n({openWatchLaterTools,ui:()=>watchLaterTools,running:value=>{bulkClearRunning=value;}})`, {
    topFrame: true, document: { body, activeElement: new Node('button'), createElement: (tag: string) => new Node(tag) },
    location: { hostname: 'www.youtube.com', reload: () => { reloads++; } },
    reviewWatchLaterTools: async () => {}, exportWatchLater: () => {}, runWatchLaterClear: () => { clears++; }
  });
  return { api, reloads: () => reloads, clears: () => clears };
}
test('Watch Later tools have one primary button, a progress bar and a three-dot menu without video previews or explanatory paragraphs', async () => {
  const f = fixture(); await f.api.openWatchLaterTools(); const ui = f.api.ui();
  assert.deepEqual(Array.from(ui.dialog.children, (node: Node) => node.tag), ['div', 'p', 'progress', 'button']);
  assert.equal(ui.dialog.children[0].children[0].textContent, 'Clear Watch Later');
  assert.equal(ui.clear.textContent, 'Clear all');
  assert.equal(ui.progress.hidden, true);
  assert.deepEqual(Array.from(ui.options.children[1].children, (node: Node) => node.textContent), ['Export list', 'Refresh page', 'Close']);
  assert.equal(ui.options.children[0].textContent, '⋮');
  ui.review.handlers.get('click')({ isTrusted: true }); assert.equal(f.reloads(), 1);
  ui.snapshot = {}; ui.loading = false;
  ui.clear.handlers.get('click')({ isTrusted: false }); assert.equal(f.clears(), 0);
  ui.clear.handlers.get('click')({ isTrusted: true }); assert.equal(f.clears(), 1);
});
test('verified completion reloads the whole page, while Stop and partial failures leave the result available', async () => {
  for (const result of [
    { removed: 2, remaining: 0, stopped: false, failure: '' },
    { removed: 1, remaining: 1, stopped: true, failure: '' },
    { removed: 1, remaining: 1, stopped: false, failure: 'Network failed' }
  ]) {
    const f = fixture(); await f.api.openWatchLaterTools(); const ui = f.api.ui();
    ui.snapshot = { cards: [{}, {}] }; let reloads = 0;
    const run = runInNewContext(`let watchLaterChanging=false,bulkClearRunning=false,bulkClearStopped=false,watchLaterCheckedAt=0;
      ${runSource}\nrunWatchLaterClear`, {
      watchLaterTools: ui, location: { reload: () => { reloads++; } },
      clearWatchLaterSnapshot: async () => result
    });
    await run();
    assert.equal(reloads, !result.stopped && !result.failure ? 1 : 0);
    assert.equal(ui.summary.textContent, result.failure || (result.remaining ? '1 remaining' : 'No saved videos'));
    assert.equal(ui.clear.textContent, !result.failure && result.remaining === 0 ? 'Done' : 'Clear all');
    assert.equal(ui.clear.disabled, Boolean(result.failure) || result.remaining !== 0);
    assert.equal(ui.options.inert, false);
  }
});
test('empty playlists show a working Done button without an idle progress bar or disabled destructive action', async () => {
  const f = fixture(); await f.api.openWatchLaterTools(); const ui = f.api.ui();
  const review = runInNewContext(`${reviewSource}\nreviewWatchLaterTools`, {
    watchLaterTools: ui, bulkClearRunning: false, watchLaterSnapshot: { accountKey: 'same-account' },
    reconcileWatchLater: async () => {}, readWatchLater: async () => ({ accountKey: 'same-account', cards: [] })
  });
  await review();
  assert.equal(ui.summary.textContent, 'No saved videos');
  assert.equal(ui.progress.hidden, true); assert.equal(ui.clear.textContent, 'Done'); assert.equal(ui.clear.disabled, false);
  ui.clear.handlers.get('click')({ isTrusted: true }); assert.equal(ui.dialog.open, false);
  assert.equal(f.clears(), 0);
});
test('clicking the backdrop dismisses an idle dialog, while content clicks, drags out and running operations keep it open', async () => {
  const f = fixture(); await f.api.openWatchLaterTools(); const ui = f.api.ui();
  const down = (x: number) => ui.dialog.handlers.get('pointerdown')({ target: ui.dialog, clientX: x, clientY: 30 });
  const click = (x: number) => ui.dialog.handlers.get('click')({ isTrusted: true, target: ui.dialog, clientX: x, clientY: 30 });
  down(30); click(30); assert.equal(ui.dialog.open, true);
  down(30); click(0); assert.equal(ui.dialog.open, true, 'dragging out of the content is not an outside click');
  f.api.running(true); down(0); click(0); assert.equal(ui.dialog.open, true);
  f.api.running(false); down(0); click(0); assert.equal(ui.dialog.open, false);
});
test('the allowance strip has no permanent Watch Later button', () => {
  const mountSource = source.slice(source.indexOf('  function mount()'), source.indexOf('  // Feed metadata'));
  const body = new Node('body');
  const mount = runInNewContext(`let panel,notice,statusLine,message;${mountSource}\nmount`, {
    document: { body, createElement: (tag: string) => new Node(tag) }, playerFrame: true,
    positionAllowance() {}, render() {}, request: async () => ({}), show() {}
  });
  mount();
  assert.deepEqual(body.children[0].shadow!.children.map(node => node.tag), ['style', 'strong']);
});
test('the playlist action is added only to the Watch Later header menu and removed on navigation', () => {
  const menuSource = source.slice(source.indexOf('  // BEGIN WATCH LATER MENU'), source.indexOf('  // END WATCH LATER MENU'));
  const popup = new Node('popup'), header = new Node('header'), button = new Node('button');
  let headerMenu = false, opened = 0;
  button.closest = selector => selector.includes('button') ? button : headerMenu ? header : null;
  const location = new URL('https://www.youtube.com/');
  const api = runInNewContext(`let watchLaterMenuUntil=0,watchLaterMenuEntry=null,watchLaterMenuPopup=null;
    ${menuSource}\n({mountWatchLaterMenu,watchLaterMenuClick,entry:()=>watchLaterMenuEntry})`, {
    topFrame: true, Element: Node, Event, URL, location, performance: { now: () => 0 },
    document: { querySelectorAll: () => [popup], createElement: (tag: string) => new Node(tag) },
    controlLabel: () => 'Action menu', setTimeout: (fn: () => void) => { fn(); },
    openWatchLaterTools: async () => { opened++; }
  });
  const click = () => api.watchLaterMenuClick({ isTrusted: true, target: button });
  headerMenu = true; click(); assert.equal(api.entry(), null);
  location.href = 'https://www.youtube.com/playlist?list=WL';
  headerMenu = false; click(); assert.equal(api.entry(), null, 'video menus are not playlist menus');
  headerMenu = true; click(); const entry = api.entry();
  assert.equal(entry.textContent, 'Clear Watch Later…');
  assert.deepEqual(popup.dispatched, ['iron-resize']);
  entry.handlers.get('click')({ isTrusted: true, preventDefault() {}, stopPropagation() {} }); assert.equal(opened, 1);
  location.href = 'https://www.youtube.com/'; api.mountWatchLaterMenu(); assert.equal(entry.isConnected, false);
});
