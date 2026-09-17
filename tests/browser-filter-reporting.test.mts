import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const root = basename(runtimeRoot) === 'runtime' ? dirname(dirname(runtimeRoot)) : runtimeRoot;
const resources = join(root, 'ios/VigilSocial/VigilYouTubeInteractionExtension/Resources');
const content = await readFile(join(resources, 'media-child-lock.js'), 'utf8');
const background = await readFile(join(resources, 'youtube-background.js'), 'utf8');

function contentHarness(rootReady = true, visible = true, topFrame = true) {
  const reports: unknown[] = [];
  const listeners = new Map<string, () => void>();
  const document = {
    documentElement: rootReady ? { append() {} } : null as { append(): void } | null,
    visibilityState: visible ? 'visible' : 'hidden',
    hasFocus: () => false, // Safari's address bar owns focus after a private search.
    querySelectorAll: () => [],
    createElement: () => ({ textContent: '' }),
    addEventListener: (name: string, handler: () => void) => listeners.set(name, handler)
  };
  const window: { top?: unknown; addEventListener: typeof document.addEventListener } = { addEventListener: document.addEventListener };
  window.top = topFrame ? window : {};
  runInNewContext(content, {
    window, document, location: new URL('https://www.google.com/search?q=cars&safe=active'),
    addEventListener: document.addEventListener,
    MutationObserver: class { observe() {} },
    browser: { runtime: { sendMessage: (message: unknown) => { reports.push(message); return Promise.resolve({ ok: true }); } } },
    setTimeout, setInterval: (handler: () => void) => listeners.set('interval', handler)
  });
  return { reports, document, listeners };
}
const page = contentHarness();
assert.equal(page.reports.length, 1, 'a protected private search reports even while the address bar owns focus');
page.listeners.get('pageshow')!();
assert.equal(page.reports.length, 2, 'restored pages report without waiting for the heartbeat');
const loading = contentHarness(false);
assert.equal(loading.reports.length, 0, 'a missing document root cannot claim a successful scan');
loading.document.documentElement = { append() {} };
loading.listeners.get('DOMContentLoaded')!();
assert.equal(loading.reports.length, 1, 'a newly parsed document reports immediately');
assert.equal(contentHarness(true, false).reports.length, 0, 'hidden tabs cannot report');
assert.equal(contentHarness(true, true, false).reports.length, 0, 'subframes cannot report');

type Sender = { frameId: number; url: string; tab: { active: boolean; windowId?: number } };
let receive: (message: unknown, sender: Sender) => Promise<unknown> | undefined = () => undefined;
let focused = true;
let windowFailure = false;
const relayed: Array<{ url: string }> = [];
const ignoredEvent = { addListener() {} };
runInNewContext(background, {
  URL,
  browser: {
    runtime: {
      onMessage: { addListener(handler: typeof receive) { receive = handler; } },
      sendNativeMessage: async (_name: string, message: { url: string }) => { relayed.push(message); return { ok: true }; }
    },
    windows: { get: async () => { if (windowFailure) throw new Error('window closed'); return { focused }; } },
    webNavigation: { onCommitted: ignoredEvent, onCreatedNavigationTarget: ignoredEvent },
    tabs: { onRemoved: ignoredEvent }
  }
});
const message = { type: 'VIGIL_BROWSER_FILTER_HEALTH', revision: '2026-09-17.1', url: 'https://forged.example/' };
const sender: Sender = { frameId: 0, url: 'https://www.google.com/search?q=cars&safe=active', tab: { active: true, windowId: 7 } };
await receive(message, sender);
assert.equal(relayed.length, 1);
assert.equal(relayed[0].url, sender.url, 'only the browser-provided sender URL is trusted');
focused = false;
await receive(message, sender);
focused = true;
await receive(message, { ...sender, tab: { active: false, windowId: 7 } });
await receive(message, { ...sender, tab: { active: true } });
await receive(message, { ...sender, frameId: 1 });
await receive({ ...message, revision: 'old' }, sender);
windowFailure = true;
await receive(message, sender);
assert.equal(relayed.length, 1, 'background windows, inactive tabs, iframes, missing windows and stale filters fail closed');
console.log('Browser filter reports cover private address-bar focus, page lifecycle and trusted foreground-window checks.');
