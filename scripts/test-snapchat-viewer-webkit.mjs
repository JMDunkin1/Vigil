#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(process.argv[2] || join(root, 'ios/VigilSocial/VigilSocial/DOMAdapters.swift'), 'utf8');
const extract = name => {
  const match = source.match(new RegExp(`private static let ${name} = #"""([\\s\\S]*?)"""#`));
  assert.ok(match, `Missing adapter ${name}`);
  return match[1];
};
const [base, fixture] = await Promise.all([
  readFile(join(root, 'tests/fixtures/snapchat-desktop-shell.html'), 'utf8'),
  readFile(join(root, 'tests/fixtures/snapchat-viewer.js'), 'utf8')
]);
const html = base.replace('</body>', `<script>${fixture}</script></body>`);
const steps = [];
for (const width of [320, 390, 402, 430]) for (const theme of ['light', 'dark']) {
  steps.push({ width, condition: `innerWidth===${width}` });
  for (const split of ['rows', 'columns']) for (const [w, h] of [[900, 1600], [1600, 900]]) for (const video of [false, true]) {
    steps.push({ action: `document.documentElement.setAttribute('theme','${theme}');fixtureOpenCompleteSnap('${split}',${w},${h},${video})`,
      condition: 'fixtureViewerFillsPhone()' });
  }
}
steps.push({ width: 402, action: "document.documentElement.setAttribute('theme','dark');fixtureOpenCompleteSnap()",
  condition: 'fixtureViewerFillsPhone()', snapshot: 'snap-fullscreen-reply' });
steps.push({ action: "fixtureTap('#fixture-react-0');document.getElementById('fixture-snap-reply').textContent='See you soon';fixtureTap('#fixture-send-reply');fixtureTap('#fixture-save-snap');fixtureTap('#fixture-pause-snap');fixtureTap('#fixture-mute-snap')",
  condition: "fixtureSnapReaction===0 && fixtureSnapReply==='See you soon' && fixtureSnapSaved && fixtureSnapPaused && fixtureSnapMuted" });
steps.push({ width: 320, action: "document.querySelector('.IHkYr>ul').scrollLeft=10000",
  condition: "innerWidth===320 && fixtureReached('#fixture-react-7')" },
{ action: "fixtureTap('#fixture-react-7');document.querySelector('.IHkYr>ul').scrollLeft=0",
  condition: 'fixtureSnapReaction===7 && fixtureViewerFillsPhone()' });
steps.push({ width: 390, height: 420, condition: 'innerHeight===420 && fixtureViewerFillsPhone()' });
steps.push({ action: "document.querySelector('.IHkYr').remove()", condition: 'document.querySelector(".P5ZpW").getBoundingClientRect().height<90 && document.querySelector(".b2f4R").getBoundingClientRect().height>=419' });
// Loading, hidden footer, and retained privacy shields cannot reintroduce a split.
steps.push({ action: "document.querySelector('.RdKti').innerHTML='Loading…';document.querySelector('.P5ZpW').remove()",
  condition: "document.querySelector('.RdKti').getBoundingClientRect().height>=419" });
steps.push({ width: 390, height: 780, action: 'fixtureOpenCompleteSnap()', condition: 'fixtureViewerFillsPhone()' });
for (const shield of ['ejVI4', 'eNF_J']) steps.push({
  action: `document.querySelector('.ecBYF').classList.add('ATeie');document.querySelector('.ecBYF>.${shield}').style.display='grid'`,
  condition: `document.elementFromPoint(195,390).classList.contains('${shield}') && getComputedStyle(document.querySelector('.dCE9D')).filter.includes('blur') && !fixtureReached('#fixture-close-snap') && !fixtureReached('#fixture-snap-reply')`
}, { action: `document.querySelector('.ecBYF>.${shield}').style.display='none'` });
steps.push({ action: "window.fixtureScreenshotShield=document.querySelector('.ecBYF>.eNF_J');document.querySelector('.S4e9r').appendChild(fixtureScreenshotShield);fixtureScreenshotShield.style.cssText='position:absolute;inset:0;display:grid;background:#888'",
  condition: "document.elementFromPoint(195,390)===fixtureScreenshotShield && !fixtureReached('#fixture-close-snap') && !fixtureReached('#fixture-snap-reply')" },
{ action: "document.querySelector('.ecBYF').appendChild(fixtureScreenshotShield);fixtureScreenshotShield.style.display='none'" });
steps.push({ action: "document.querySelector('.ecBYF').classList.remove('ATeie');fixtureTap('#fixture-close-snap')",
  condition: "!document.querySelector('.ecBYF') && getComputedStyle(document.querySelector('.ChLAv')).display!=='none'" });
steps.push({ width: 1000, action: 'fixtureOpenCompleteSnap()',
  condition: "document.querySelector('.b2f4R').getBoundingClientRect().height<390 && getComputedStyle(document.querySelector('.ChLAv')).display!=='none'" });

const unread = [];
for (const mode of ['snap', 'mixed']) for (const target of ['.BbZFb', '.O4POs', '.w15C2 .VKjn5']) unread.push({
  action: `fixtureSeedUnreadRow('${mode}');window.fixtureExpectedUnread=fixtureUnreadOpens+1;window.fixtureExpectedChat=fixtureChatOpens`,
  condition: "document.querySelector('[data-vigil-snap-layout=feed]')!==null"
}, { action: `fixtureTap('${target}')`, condition: 'fixtureUnreadOpens===fixtureExpectedUnread && fixtureChatOpens===fixtureExpectedChat && fixtureViewerFillsPhone()' },
{ action: "fixtureTap('#fixture-close-snap')", condition: "!document.querySelector('.ecBYF') && document.querySelector('[data-vigil-snap-layout=feed]')!==null" });
unread.push({ action: "fixtureSeedUnreadRow();window.fixtureExpectedUnread=fixtureUnreadOpens+1;window.fixtureExpectedChat=fixtureChatOpens",
  condition: "document.querySelector('[data-vigil-snap-layout=feed]')!==null" },
{ action: "document.querySelector('.O4POs').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))",
  condition: 'fixtureUnreadOpens===fixtureExpectedUnread && fixtureChatOpens===fixtureExpectedChat' });
for (const mode of ['chat', 'unavailable', 'hidden']) unread.push({
  action: `fixtureCloseSnap();fixtureSeedUnreadRow('${mode}');window.fixtureExpectedUnread=fixtureUnreadOpens;window.fixtureExpectedChat=fixtureChatOpens+1`,
  condition: "document.querySelector('[data-vigil-snap-layout=feed]')!==null"
}, { action: "fixtureTap('.BbZFb')", condition: "fixtureUnreadOpens===fixtureExpectedUnread && fixtureChatOpens===fixtureExpectedChat && !!document.querySelector('.aXEpU')" });
unread.push({ action: 'fixtureSeedUnreadRow()', condition: "document.querySelector('[data-vigil-snap-layout=feed]')!==null" },
{ action: "fixtureTap('.LNwMF')", condition: 'fixtureAvatarOpened && !document.querySelector(".ecBYF")' });
// Synthetic forwarding still passes through the original Spotlight/Discover guard.
unread.push({ action: "fixtureSeedUnreadRow('restricted')", condition: "document.querySelector('[data-vigil-snap-layout=feed]')!==null" },
{ action: "fixtureTap('.BbZFb')", condition: '!document.querySelector(".ecBYF")' });
unread.push({ width: 1000, action: 'fixtureSeedUnreadRow();window.fixtureExpectedUnread=fixtureUnreadOpens;window.fixtureExpectedChat=fixtureChatOpens+1',
  condition: 'innerWidth===1000' }, { action: "fixtureTap('.BbZFb')", condition: 'fixtureUnreadOpens===fixtureExpectedUnread && fixtureChatOpens===fixtureExpectedChat' });

// Also exercise an already-mounted viewer at document end. This phase must
// work before the first animation frame, with the real auto-z-index shields.
const privacyAtMount = [{ condition: 'fixtureViewerFillsPhone()' }];
for (const shield of ['ejVI4', 'eNF_J']) privacyAtMount.push({
  action: `document.querySelector('.ecBYF>.${shield}').style.display='grid'`,
  condition: `document.elementFromPoint(195,390).classList.contains('${shield}') && !fixtureReached('#fixture-close-snap') && !fixtureReached('#fixture-snap-reply')`
}, { action: `document.querySelector('.ecBYF>.${shield}').style.display='none'` });
privacyAtMount.push({ action: "window.fixtureScreenshotShield=document.querySelector('.ecBYF>.eNF_J');document.querySelector('.S4e9r').appendChild(fixtureScreenshotShield);fixtureScreenshotShield.style.cssText='position:absolute;inset:0;display:grid;background:#888'",
  condition: "document.elementFromPoint(195,390)===fixtureScreenshotShield && !fixtureReached('#fixture-close-snap') && !fixtureReached('#fixture-snap-reply')" });
const scenarios = [{ name: 'complete-snap-viewer', html, steps }, { name: 'unread-snap-row', html, steps: unread },
  { name: 'privacy-stacking-at-mount', html: html.replace('</body>', '<script>fixtureOpenCompleteSnap()</script></body>'), steps: privacyAtMount }]
  .filter(scenario => !process.argv[3] || scenario.name === process.argv[3]);
assert.ok(scenarios.length, 'Choose a known scenario');
const directory = await mkdtemp(join(tmpdir(), 'vigil-snapchat-viewer-webkit-'));
try {
  await Promise.all([
    writeFile(join(directory, 'adapter.js'), extract('snapchat') + extract('snapchatMobileLayout')),
    writeFile(join(directory, 'prelude.js'), "window.fixtureViewerErrors=[];addEventListener('error',event=>fixtureViewerErrors.push(event.message));"),
    writeFile(join(directory, 'scenarios.json'), JSON.stringify(scenarios))
  ]);
  const binary = join(directory, 'snapchat-viewer-test');
  await exec('xcrun', ['swiftc', join(root, 'tests/fixtures/snapchat-calls-webkit.swift'), '-o', binary], { timeout: 60000 });
  const result = await exec(binary, [directory], { timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
  process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  assert.equal(result.stdout.split(/\r?\n/u).filter(line => line.startsWith('PASS ')).length, scenarios.length);
} catch (error) {
  if (error.stdout) process.stderr.write(error.stdout);
  if (error.stderr) process.stderr.write(error.stderr);
  throw error;
} finally {
  console.log(`WebKit evidence retained at ${directory}`);
}
