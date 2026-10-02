import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const root = basename(runtimeRoot) === 'runtime' ? dirname(dirname(runtimeRoot)) : runtimeRoot;
const resources = join(root, 'ios/VigilSocial/VigilYouTubeInteractionExtension/Resources');
const content = await readFile(join(resources, 'media-child-lock.js'), 'utf8');

function contentHarness(rootReady = true, visible = true, topFrame = true, scanFailures = 0, setupFailure: 'observe' | 'append' | null = null, extensionScheme = 'chrome-extension:') {
  const reports: unknown[] = [];
  const listeners = new Map<string, () => void>();
  const setup = { observeAttempts: 0, appendAttempts: 0, disconnects: 0, scans: 0 };
  let mutationCallback: () => void = () => {};
  let receive: (message: { type: string }) => void = () => {};
  const document = {
    documentElement: rootReady ? { append() {
      setup.appendAttempts += 1;
      if (setupFailure === 'append' && setup.appendAttempts === 1) throw new Error('Style append temporarily unavailable');
    } } : null as { append(): void } | null,
    visibilityState: visible ? 'visible' : 'hidden',
    hasFocus: () => false, // Safari's address bar owns focus after a private search.
    querySelectorAll: (selector: string) => {
      if (selector !== '*') return [];
      setup.scans += 1;
      if (scanFailures > 0) {
        scanFailures -= 1;
        throw new Error('Document scan temporarily unavailable');
      }
      return [];
    },
    createElement: () => ({ textContent: '' }),
    addEventListener: (name: string, handler: () => void) => listeners.set(name, handler)
  };
  const window: { top?: unknown; addEventListener: typeof document.addEventListener } = { addEventListener: document.addEventListener };
  window.top = topFrame ? window : {};
  runInNewContext(content, {
    window, document, location: new URL('https://www.google.com/search?q=cars&safe=active'),
    addEventListener: document.addEventListener,
    MutationObserver: class {
      constructor(callback: () => void) { mutationCallback = callback; }
      observe() {
        setup.observeAttempts += 1;
        if (setupFailure === 'observe' && setup.observeAttempts === 1) throw new Error('Observer temporarily unavailable');
      }
      disconnect() { setup.disconnects += 1; }
    },
    browser: { runtime: {
      getURL: () => {
        if (extensionScheme === 'invalid-context') throw new Error('Extension context unavailable');
        return `${extensionScheme}//vigil/`;
      },
      onMessage: { addListener(handler: typeof receive) { receive = handler; } },
      sendMessage: (message: unknown) => { reports.push(message); return Promise.resolve({ ok: true }); }
    } },
    setTimeout, setInterval: (handler: () => void) => listeners.set('interval', handler)
  });
  return { reports, document, listeners, setup, mutate: () => mutationCallback(), receive: (type: string) => receive({ type }) };
}
const page = contentHarness();
assert.equal(page.reports.length, 1, 'a protected private search reports even while the address bar owns focus');
page.listeners.get('pageshow')!();
assert.equal(page.reports.length, 2, 'restored pages report without waiting for the heartbeat');
page.receive('VIGIL_REQUEST_BROWSER_FILTER_HEALTH');
assert.equal(page.reports.length, 3, 'background activation re-scans without reloading the document');
page.document.visibilityState = 'hidden';
page.receive('VIGIL_REQUEST_BROWSER_FILTER_HEALTH');
assert.equal(page.reports.length, 3, 'activation requests cannot make a hidden page attest');
const loading = contentHarness(false);
assert.equal(loading.reports.length, 0, 'a missing document root cannot claim a successful scan');
loading.document.documentElement = { append() {} };
loading.listeners.get('DOMContentLoaded')!();
assert.equal(loading.reports.length, 1, 'a newly parsed document reports immediately');
assert.equal(contentHarness(true, false).reports.length, 0, 'hidden tabs cannot report');
assert.equal(contentHarness(true, true, false).reports.length, 0, 'subframes cannot report');
const recovering = contentHarness(true, true, true, 2);
assert.equal(recovering.reports.length, 0, 'an initial failed scan cannot attest protection');
for (const event of ['DOMContentLoaded', 'pageshow', 'focus', 'visibilitychange', 'interval']) {
  assert.ok(recovering.listeners.has(event), `initial scan failure must retain the ${event} recovery hook`);
}
recovering.listeners.get('interval')!();
assert.equal(recovering.reports.length, 0, 'a failed heartbeat scan cannot attest protection');
recovering.receive('VIGIL_REQUEST_BROWSER_FILTER_HEALTH');
assert.equal(recovering.reports.length, 1, 'a browser activation request recovers only after its full scan succeeds');
recovering.listeners.get('interval')!();
assert.equal(recovering.reports.length, 2, 'heartbeats continue after scan recovery');
for (const failure of ['observe', 'append'] as const) {
  const setupRecovery = contentHarness(true, true, true, 0, failure);
  assert.equal(setupRecovery.reports.length, 0, `failed ${failure} setup cannot attest protection`);
  assert.equal(setupRecovery.setup.disconnects, 1, 'partial observer setup must disconnect before retry');
  setupRecovery.listeners.get('interval')!();
  assert.equal(setupRecovery.setup.observeAttempts, 2, `failed ${failure} setup must retry observer attachment`);
  assert.equal(setupRecovery.setup.appendAttempts, failure === 'append' ? 2 : 1, 'recovery must finish style installation');
  assert.equal(setupRecovery.reports.length, 1, 'only complete filter setup and scan can attest recovery');
  setupRecovery.listeners.get('interval')!();
  assert.equal(setupRecovery.setup.observeAttempts, 2, 'successful recovery must not add duplicate observers');
  assert.equal(setupRecovery.reports.length, 2);
}

for (const visible of [true, false]) {
  const safari = contentHarness(true, visible, true, 0, null, 'safari-web-extension:');
  assert.equal(safari.setup.scans, 1, 'Safari still performs its initial full content scan');
  assert.equal(safari.setup.observeAttempts, 1, 'Safari still watches DOM changes');
  for (const event of ['DOMContentLoaded', 'pageshow', 'focus', 'visibilitychange', 'interval']) {
    const before: number = safari.setup.scans;
    safari.listeners.get(event)!();
    assert.equal(safari.setup.scans, before + 1, `Safari retains the ${event} enforcement scan`);
  }
  const beforeMutation = safari.setup.scans;
  safari.mutate();
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(safari.setup.scans, beforeMutation + 1, 'Safari DOM mutations still trigger enforcement scans');
  assert.equal(safari.reports.length, 0, 'Safari emits no unused per-page health connection messages');
}
const safariRecovering = contentHarness(true, true, true, 1, null, 'safari-web-extension:');
safariRecovering.listeners.get('interval')!();
assert.equal(safariRecovering.setup.scans, 2, 'Safari retries a failed content scan without a connection checker');
assert.equal(safariRecovering.reports.length, 0);
const staleContext = contentHarness(true, true, true, 0, null, 'invalid-context');
staleContext.listeners.get('interval')!();
assert.equal(staleContext.setup.scans, 2, 'a stale runtime identity cannot disable actual content scans');

console.log('Chrome health reports remain active; Safari filtering scans run without connection-check traffic.');
