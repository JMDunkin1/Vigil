import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const root = existsSync(join(runtimeRoot, 'ios')) ? runtimeRoot : resolve(runtimeRoot, '..', '..');
const source = await readFile(join(root, 'ios/VigilSocial/VigilSocial/DOMAdapters.swift'), 'utf8');
const code = source.slice(source.indexOf('const storyRailViewportStates ='), source.indexOf('const storyRailResizeObserver ='));
class Rail {
  isConnected = true;
  scrollLeft = 0;
  getBoundingClientRect() { return { left: 0, right: 120 }; }
}
function fixture() {
  const rail = new Rail();
  const context = {
    HTMLElement: Rail, rail,
    homeStoryControls: () => [],
    storyAuthor: () => '', storyItemFor: () => null
  };
  return { rail, evaluate: (expression: string) => runInNewContext(`${code}\n${expression}`, { ...context }) };
}
test('own profile at the start is remembered even without a classified story author', () => {
  const { evaluate } = fixture();
  assert.equal(evaluate('rememberStoryRailViewport(rail).atStart'), true);
  assert.equal(evaluate('restoreStoryRailViewport(rail, [], rememberStoryRailViewport(rail))'), true);
});
test('a delayed story layout flush cannot undo a swipe away from the start', () => {
  const { rail, evaluate } = fixture();
  assert.equal(evaluate(`const state = rememberStoryRailViewport(rail);
    rail.scrollLeft = 80;
    restoreStoryRailViewport(rail, [], state);`), false);
  assert.equal(rail.scrollLeft, 80);
});
