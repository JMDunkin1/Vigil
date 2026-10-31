#!/usr/bin/env node
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const adapter = await readFile(process.argv[2] ? resolve(process.argv[2]) : join(root, 'ios/VigilSocial/VigilSocial/DOMAdapters.swift'), 'utf8');
const tests = await readFile(join(root, 'ios/VigilSocial/VigilSocialTests/VigilSocialTests.swift'), 'utf8');
const extract = name => adapter.match(new RegExp(`static let ${name} = #"""([\\s\\S]*?)"""#`))?.[1];
const guard = extract('instagramSingleReelGuard'), stable = extract('instagramStable'), start = extract('instagramStableDocumentStartStyle');
const html = tests.match(/static let instagramSuggestedReelsHTML = #"""([\s\S]*?)"""#/)?.[1];
assert.ok(guard && stable && start && html);
for (const source of [guard, stable, start]) assert.doesNotThrow(() => new Function(source));
const bootstrap = `window.__vigilDocumentID='suggested-fixture';window.fixtureLocks=[];
Object.defineProperty(window,'webkit',{configurable:true,value:{messageHandlers:{vigil:{postMessage:p=>fixtureLocks.push(p)}}}});`;
const modes = ['cold', 'warm', 'anonymous', 'animated', 'pointerless', 'panned', 'main-rail', 'thread-header', 'chat', 'chat-button', 'caption', 'caption-button', 'covered', 'recipient', 'hidden'];
const scenarios = modes.map(mode => {
  const blocked = ['cold', 'warm', 'anonymous', 'animated', 'pointerless', 'panned', 'main-rail'].includes(mode);
  return {name: `Suggested Reel boundary: ${mode}`, html, path: '/direct/t/friend/', steps: [
    {action: `fixtureActivate('${mode}')`, delay: blocked ? 0 : 250},
    ...(mode === 'warm' ? [{condition: "document.documentElement.hasAttribute('data-vigil-single-reel')"},
      {action: "document.getElementById('label').firstChild.data='Suggested'"}] : []),
    {condition: blocked ? 'fixtureSuggestedBlocked()' : "!fixtureLocks.some(p=>p.type==='instagramSuggestedReels')&&!document.querySelector('[data-vigil-instagram-suggested-reels]')"},
    ...(blocked ? [{action: "window.__vigilDocumentID='ready-fixture';window.__vigilInstagramSharedItem.synchronizeNativeGestureGuard()",
      condition: "fixtureLocks.filter(p=>p.type==='instagramSuggestedReels').at(-1)?.documentID==='ready-fixture'"}] : [])
  ]};
});
const directory = await mkdtemp(join(tmpdir(), 'vigil-instagram-suggested-'));
try {
  await Promise.all([writeFile(join(directory, 'guard.js'), bootstrap + start + guard),
    writeFile(join(directory, 'stable.js'), stable), writeFile(join(directory, 'scenarios.json'), JSON.stringify(scenarios))]);
  const executable = join(directory, 'suggested-test');
  await run('xcrun', ['swiftc', join(root, 'tests/fixtures/instagram-comments-interaction.swift'), '-o', executable], {timeout: 60000});
  const marker = 'VIGIL_INSTAGRAM_SUGGESTED_WEBKIT_COMPLETE';
  const result = await run(executable, [directory, marker], {timeout: 120000, maxBuffer: 2 * 1024 * 1024});
  process.stdout.write(result.stdout);
  assert.ok(result.stdout.split(/\r?\n/).includes(marker));
  await rm(directory, {recursive: true, force: true});
} catch (error) {
  if (error.stdout) process.stderr.write(error.stdout);
  if (error.stderr) process.stderr.write(error.stderr);
  process.stderr.write(`Suggested Reel artifacts retained at ${directory}\n`);
  throw error;
}
