import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const root = basename(runtimeRoot) === 'runtime' ? dirname(dirname(runtimeRoot)) : runtimeRoot;
const source = await readFile(join(root, 'ios/VigilSocial/VigilYouTubeInteractionExtension/Resources/youtube-background.js'), 'utf8');
type Navigation = { tabId: number; frameId: number; url: string; transitionType?: string };
function event<T>() {
  const listeners: Array<(value: T) => void> = [];
  return { addListener: (listener: (value: T) => void) => listeners.push(listener), emit: (value: T) => listeners.forEach(listener => listener(value)) };
}
const before = event<Navigation>();
const committed = event<Navigation>();
const error = event<Navigation>();
const activated = event<{ tabId: number }>();
const focus = event<number>();
const removed = event<number>();
const stored = new Map<string, unknown>();
const native: Array<Record<string, unknown>> = [];
let receive: (message: unknown, sender: { url: string; tab: { id: number } }) => unknown = () => undefined;
const noConnectionWork = () => { throw new Error('Safari must not poll or query per-page connection health'); };
runInNewContext(source, {
  URL,
  setInterval: noConnectionWork,
  browser: {
    runtime: {
      onMessage: { addListener: (listener: typeof receive) => { receive = listener; } },
      sendNativeMessage: async (_host: string, message: Record<string, unknown>) => { native.push(message); return { ok: true }; }
    },
    windows: { onFocusChanged: focus, get: noConnectionWork },
    tabs: { onActivated: activated, onRemoved: removed, get: noConnectionWork, query: noConnectionWork, sendMessage: noConnectionWork },
    webNavigation: { onBeforeNavigate: before, onCommitted: committed, onErrorOccurred: error, getFrame: noConnectionWork },
    storage: { local: {
      get: async (keys: string | string[]) => Object.fromEntries(
        (Array.isArray(keys) ? keys : [keys]).map(key => [key, stored.get(key)])
      ),
      set: async (values: Record<string, unknown>) => { for (const [key, value] of Object.entries(values)) stored.set(key, value); },
      remove: async (keys: string | string[]) => { for (const key of Array.isArray(keys) ? keys : [keys]) stored.delete(key); }
    } }
  }
});
const sender = { url: 'https://www.google.com/search?q=library', tab: { id: 12 } };
await receive({ type: 'VIGIL_BROWSER_FILTER_HEALTH', revision: '2026-09-17.1' }, sender);
await receive({ type: 'VIGIL_BROWSER_NAVIGATION', url: sender.url }, sender);
activated.emit({ tabId: 12 });
focus.emit(7);
focus.emit(-1);
before.emit({ tabId: 12, frameId: 0, url: sender.url });
error.emit({ tabId: 12, frameId: 0, url: sender.url });
assert.equal(native.length, 0, 'Safari page health and navigation activity produce no connection-check traffic');

const youtubeSender = { url: 'https://www.youtube.com/watch?v=abcdefghijk', tab: { id: 12 } };
for (const action of ['browser-filter-health', 'browser-navigation', 'external']) {
  await receive({ type: 'VIGIL_YOUTUBE', youtube: { action } }, youtubeSender);
}
await receive({ type: 'VIGIL_YOUTUBE', youtube: { action: 'status' } }, sender);
assert.equal(native.length, 0, 'page-facing messages cannot forge protected browser evidence or external YouTube grants');
await receive({ type: 'VIGIL_YOUTUBE', youtube: { action: 'status', client: 'player' } }, youtubeSender);
assert.equal(native.length, 1, 'actual YouTube enforcement requests remain connected');
assert.equal(native[0].action, 'status');
assert.equal(native[0].client, 'safari:12:undefined:player');

const flush = async () => { await new Promise(resolve => setImmediate(resolve)); };
committed.emit({ tabId: 12, frameId: 0, url: sender.url });
await flush();
assert.equal(stored.get('youtube-source:12'), true);
committed.emit({ tabId: 12, frameId: 0, url: youtubeSender.url, transitionType: 'link' });
await flush();
assert.equal(native.length, 2, 'browser-owned external navigation provenance remains enforced');
assert.equal(native[1].action, 'external');
assert.equal(native[1].videoId, 'abcdefghijk');
assert.equal(stored.get('youtube-source:12'), false);
removed.emit(12); await flush();
assert.equal(stored.has('youtube-source:12'), false);
console.log('Safari has no page-connection traffic or polling; YouTube enforcement and navigation provenance remain active.');
