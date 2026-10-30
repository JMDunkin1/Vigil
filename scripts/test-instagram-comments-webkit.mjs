#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const adapter = await readFile(process.argv[2] ? resolve(process.argv[2]) : join(root, 'ios/VigilSocial/VigilSocial/DOMAdapters.swift'), 'utf8');
const tests = await readFile(join(root, 'ios/VigilSocial/VigilSocialTests/VigilSocialTests.swift'), 'utf8');
const extract = name => adapter.match(new RegExp(`static let ${name} = #"""([\\s\\S]*?)"""#`))?.[1];
const guard = extract('instagramSingleReelGuard'), stable = extract('instagramStable');
const start = extract('instagramStableDocumentStartStyle');
const html = tests.match(/static let instagramCommentsInteractionHTML = #"""([\s\S]*?)"""#/)?.[1];
assert.ok(guard && stable && start && html);
const bootstrap = `window.__vigilDocumentID='comments-fixture';window.fixtureLocks=[];
  Object.defineProperty(window,'webkit',{configurable:true,value:{messageHandlers:{vigil:{postMessage:p=>{fixtureLocks.push(p);window.fixtureObserveNative?.(p);}}}}});`;
const modes = ['external', 'hidden', 'class', 'style', 'fade'].filter(mode => !process.argv[3] || process.argv[3] === mode);
assert.ok(modes.length);
const scenarios = modes.map(mode => ({ name: `Comments interact and dismiss: ${mode}`, html, path: '/direct/t/friend/', steps: [
  { action: `fixtureMode=${JSON.stringify(mode)};document.getElementById('preview').click()`, condition: "document.documentElement.hasAttribute('data-vigil-single-reel')" },
  ...[false, true].flatMap(viaHandle => [
    { action: "document.getElementById('open-comments').click()", condition: "document.getElementById('comments').dataset.vigilInstagramCommentsSheet==='true'" },
    { condition: "fixtureNativeAllows('handle')&&fixtureNativeAllows('list')&&fixtureNativeAllows('close')" },
    { condition: "fixtureCommentsWork()&&fixtureBackgroundContained()&&(fixtureMode!=='fade'||fixtureEarlyReady)" },
    { action: viaHandle ? "fixtureFire('handle','pointerdown',360);fixtureFire('handle','pointermove',560);fixtureFire('handle','pointerup',560)"
      : "fixtureFire('close','pointerdown',320);fixtureFire('close','pointermove',330);fixtureFire('close','pointerup',330)", condition: "document.getElementById('portal').hidden" },
    { condition: "fixtureLocks.filter(p=>p.type==='reelScrollLock').at(-1)?.scrollingRegions.length===0" },
    { condition: "fixtureBackgroundContained()&&document.documentElement.hasAttribute('data-vigil-single-reel')" }
  ])
] }));
const directory = await mkdtemp(join(tmpdir(), 'vigil-instagram-comments-'));
try {
  await Promise.all([writeFile(join(directory, 'guard.js'), bootstrap + start + guard),
    writeFile(join(directory, 'stable.js'), stable), writeFile(join(directory, 'scenarios.json'), JSON.stringify(scenarios))]);
  const executable = join(directory, 'comments-test');
  await execFileAsync('xcrun', ['swiftc', join(root, 'tests/fixtures/instagram-comments-interaction.swift'), '-o', executable], { timeout: 60000 });
  const marker = 'VIGIL_INSTAGRAM_COMMENTS_WEBKIT_COMPLETE';
  const result = await execFileAsync(executable, [directory, marker], { timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
  process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  assert.ok(result.stdout.split(/\r?\n/).includes(marker), 'Comments fixture did not complete');
  await rm(directory, { recursive: true, force: true });
} catch (error) {
  if (error.stdout) process.stderr.write(error.stdout);
  if (error.stderr) process.stderr.write(error.stderr);
  process.stderr.write(`Comments artifacts retained at ${directory}\n`);
  throw error;
}
