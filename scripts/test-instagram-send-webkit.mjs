#!/usr/bin/env node
// Runs the production item guard and the same HTML fixture used by iOS XCTest.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const adapterPath = process.argv[2] ? resolve(process.argv[2]) : join(root, 'ios/VigilSocial/VigilSocial/DOMAdapters.swift');
const [adapter, tests] = await Promise.all([
  readFile(adapterPath, 'utf8'),
  readFile(join(root, 'ios/VigilSocial/VigilSocialTests/VigilSocialTests.swift'), 'utf8')
]);
const guard = adapter.match(/static let instagramSingleReelGuard = #"""([\s\S]*?)"""#/)?.[1];
const html = tests.match(/static let instagramSendRoundtripHTML = #"""([\s\S]*?)"""#/)?.[1];
assert.ok(guard && html, 'Production guard and iOS fixture must both be present');
const bootstrap = `window.__vigilDocumentID='send-fixture';window.fixtureLocks=[];
  Object.defineProperty(window,'webkit',{configurable:true,value:{messageHandlers:{vigil:{postMessage:p=>fixtureLocks.push(p)}}}});`;
const scenarios = ['aria', 'display', 'opacity', 'opening-gap', 'closing-gap', 'remount', 'anonymous'].map(mode => {
  const cycle = [
    { action: "document.getElementById('send').click()", condition: "document.getElementById('picker')?.dataset.vigilInstagramRecipientSheet==='true'" },
    { condition: "document.documentElement.hasAttribute('data-vigil-single-reel')" },
    { condition: `(()=>{const e=new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:100});
      document.getElementById('recipients').dispatchEvent(e);document.getElementById('query').focus();
      return !e.defaultPrevented&&document.activeElement.id==='query';})()` },
    { action: "document.getElementById('dismiss').click()", condition: "!document.getElementById('viewer').hasAttribute('aria-hidden')" },
    { condition: 'fixtureContained()' },
    { condition: "fixtureLocks.filter(p=>p.type==='reelScrollLock').every(p=>p.locked)" },
    { condition: "fixtureLocks.filter(p=>p.type==='reelScrollLock').at(-1)?.scrollingRegions.length===0" }
  ];
  return { name: `Send closes back to the same Reel: ${mode}`, html, path: '/direct/t/friend/', steps: [
    { action: `fixtureMode=${JSON.stringify(mode)};document.getElementById('preview').click()`,
      condition: "document.documentElement.hasAttribute('data-vigil-single-reel')" },
    ...cycle, ...cycle,
    { action: "document.getElementById('viewer').remove()", condition: "!document.documentElement.hasAttribute('data-vigil-single-reel')" },
    { condition: "fixtureLocks.filter(p=>p.type==='reelScrollLock').at(-1)?.locked===false" },
    { condition: `(()=>{const e=new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:100});
      document.getElementById('thread').dispatchEvent(e);return !e.defaultPrevented;})()` }
  ] };
});
scenarios.push({ name: 'Closing the viewer under Send releases Direct', html, path: '/direct/t/friend/', steps: [
  ...scenarios[0].steps.slice(0, 3),
  { action: "document.getElementById('viewer').remove();document.getElementById('picker').remove()",
    condition: "!document.documentElement.hasAttribute('data-vigil-single-reel')" },
  { condition: "fixtureLocks.filter(p=>p.type==='reelScrollLock').at(-1)?.locked===false" }
] });
scenarios.push({ name: 'An abandoned Send presentation cannot pin the chat forever', html, path: '/direct/t/friend/', steps: [
  scenarios[0].steps[0],
  { action: "fixtureSend=()=>document.getElementById('viewer').remove();document.getElementById('send').onclick=fixtureSend;document.getElementById('send').click()",
    condition: "!document.documentElement.hasAttribute('data-vigil-single-reel')" },
  { condition: "fixtureLocks.filter(p=>p.type==='reelScrollLock').at(-1)?.locked===false" }
] });
const directory = await mkdtemp(join(tmpdir(), 'vigil-instagram-send-'));
try {
  await Promise.all([
    writeFile(join(directory, 'guard.js'), bootstrap + guard),
    writeFile(join(directory, 'stable.js'), ''),
    writeFile(join(directory, 'scenarios.json'), JSON.stringify(scenarios))
  ]);
  const executable = join(directory, 'send-roundtrip-test');
  await execFileAsync('xcrun', ['swiftc', join(root, 'tests/fixtures/instagram-send-roundtrip.swift'), '-o', executable], {
    timeout: 60000, maxBuffer: 2 * 1024 * 1024
  });
  const result = await execFileAsync(executable, [directory], { timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
  process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  assert.ok(result.stdout.split(/\r?\n/).includes('VIGIL_INSTAGRAM_SEND_ROUNDTRIP_WEBKIT_COMPLETE'), 'WebKit fixture did not complete');
  await rm(directory, { recursive: true, force: true });
} catch (error) {
  if (error.stdout) process.stderr.write(error.stdout);
  if (error.stderr) process.stderr.write(error.stderr);
  process.stderr.write(`Send roundtrip artifacts retained at ${directory}\n`);
  throw error;
}
