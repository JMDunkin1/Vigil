#!/usr/bin/env node
// The same combined interaction fixture is exercised by iOS XCTest.
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
const html = tests.match(/static let instagramInteractionBoundariesHTML = #"""([\s\S]*?)"""#/)?.[1];
assert.ok(guard && stable && start && html);
for (const source of [guard, stable, start]) assert.doesNotThrow(() => new Function(source));
const bootstrap = `window.__vigilDocumentID='interaction-fixture';window.fixtureLocks=[];
  Object.defineProperty(window,'webkit',{configurable:true,value:{messageHandlers:{vigil:{postMessage:p=>fixtureLocks.push(p)}}}});`;
const modes = ['release', 'anonymous-release', 'link-release', 'moved-preview', 'recipient-animation', 'recipient-nested', 'recipient-backdrop', 'recipient-retained', 'recipient-retired',
  'recipient-reused', 'comments-reused', 'comments-press', 'send-press', 'keyboard-ancestor', 'cancelled-preview', 'ordinary-chat']
  .filter(mode => !process.argv[3] || process.argv[3] === mode);
assert.ok(modes.length);
const scenarios = modes.map(mode => ({name: `Interaction boundary: ${mode}`, html, path: '/direct/t/friend/', steps: [
  {action: `fixtureMode=${JSON.stringify(mode)};fixtureBegin()`, delay: 150, condition: 'fixtureReady()'},
  {condition: 'fixtureVerify()'},
  {action: 'fixtureFinish()', condition: 'fixtureReleased()'}
]}));
const directory = await mkdtemp(join(tmpdir(), 'vigil-instagram-interactions-'));
try {
  await Promise.all([writeFile(join(directory, 'guard.js'), bootstrap + start + guard),
    writeFile(join(directory, 'stable.js'), stable), writeFile(join(directory, 'scenarios.json'), JSON.stringify(scenarios))]);
  const executable = join(directory, 'interactions-test');
  await execFileAsync('xcrun', ['swiftc', join(root, 'tests/fixtures/instagram-comments-interaction.swift'), '-o', executable], {timeout: 60000});
  const marker = 'VIGIL_INSTAGRAM_INTERACTIONS_WEBKIT_COMPLETE';
  const result = await execFileAsync(executable, [directory, marker], {timeout: 180000, maxBuffer: 2 * 1024 * 1024});
  process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  assert.ok(result.stdout.split(/\r?\n/).includes(marker), 'Interaction fixture did not complete');
  await rm(directory, {recursive: true, force: true});
} catch (error) {
  if (error.stdout) process.stderr.write(error.stdout);
  if (error.stderr) process.stderr.write(error.stderr);
  process.stderr.write(`Interaction artifacts retained at ${directory}\n`);
  throw error;
}
