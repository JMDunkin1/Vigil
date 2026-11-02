import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../extension/youtube-limits.js', import.meta.url), 'utf8');
const openSource = source.slice(source.indexOf('  async function openWatchLaterTools('), source.indexOf('  async function reviewWatchLaterTools('));
const runSource = source.slice(source.indexOf('  async function runWatchLaterClear('), source.indexOf('  // END WATCH LATER BULK CLEAR'));
class Node {
  children: Node[] = [];
  textContent = '';
  className = '';
  open = false;
  isConnected = true;
  disabled = false;
  inert = false;
  style = {};
  attributes = new Map<string, string>();
  handlers = new Map<string, (event: unknown) => void>();
  constructor(readonly tag: string) {}
  append(...nodes: Node[]) { this.children.push(...nodes); }
  attachShadow() { return new Node('shadow'); }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  removeAttribute(name: string) { this.attributes.delete(name); }
  addEventListener(name: string, callback: (event: unknown) => void) { this.handlers.set(name, callback); }
  showModal() { this.open = true; }
  close() { this.open = false; }
  focus() {}
}
function fixture() {
  let reloads = 0, clears = 0;
  const body = new Node('body');
  const api = runInNewContext(`let watchLaterTools=null,bulkClearRunning=false,bulkClearStopped=false;
    ${openSource}\n({openWatchLaterTools,ui:()=>watchLaterTools})`, {
    topFrame: true, document: { body, activeElement: new Node('button'), createElement: (tag: string) => new Node(tag) },
    location: { hostname: 'www.youtube.com', reload: () => { reloads++; } },
    reviewWatchLaterTools: async () => {}, exportWatchLater: () => {}, runWatchLaterClear: () => { clears++; }
  });
  return { api, reloads: () => reloads, clears: () => clears };
}
test('Watch Later tools have one primary button, a progress bar and a three-dot menu without video previews or explanatory paragraphs', async () => {
  const f = fixture(); await f.api.openWatchLaterTools(); const ui = f.api.ui();
  assert.deepEqual(Array.from(ui.dialog.children, (node: Node) => node.tag), ['div', 'p', 'progress', 'button']);
  assert.equal(ui.dialog.children[0].children[0].textContent, 'Watch Later');
  assert.equal(ui.clear.textContent, 'Clear');
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
    assert.equal(ui.summary.textContent, result.failure || (result.remaining ? '1 remaining' : 'Empty'));
    assert.equal(ui.clear.textContent, 'Clear'); assert.equal(ui.clear.disabled, true);
    assert.equal(ui.options.inert, false);
  }
});
