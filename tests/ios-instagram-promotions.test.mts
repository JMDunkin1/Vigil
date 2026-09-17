import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext, Script } from 'node:vm';

const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const root = existsSync(join(runtimeRoot, 'ios')) ? runtimeRoot : resolve(runtimeRoot, '..', '..');
const source = readFileSync(join(root, 'ios/VigilSocial/VigilSocial/DOMAdapters.swift'), 'utf8');
const adapterStart = source.indexOf('    private static let instagramStable = #"""') + '    private static let instagramStable = #"""'.length;
const adapter = source.slice(adapterStart, source.indexOf('    """#', adapterStart));
const code = adapter.slice(adapter.indexOf('const instagramPromotionKind ='), adapter.indexOf('const hideInstagramPromotions ='));
function classify(text: string, attributes: Record<string, string> = {}, icon = '') {
  return runInNewContext(`${code}\ninstagramPromotionKind(node)`, {
    URL, location: { href: 'https://www.instagram.com/example/' },
    node: {
      textContent: text,
      getAttribute: (name: string) => attributes[name] || null,
      querySelectorAll: () => icon ? [{ getAttribute: () => icon }] : []
    }
  });
}
test('Instagram adapter remains valid JavaScript', () => {
  assert.doesNotThrow(() => new Script(adapter));
});
test('app promotion labels include the recurring Use the app banner', () => {
  for (const label of ['Use the app', 'Open app', 'Get the Instagram app', 'Download the app', 'Open Instagram']) {
    assert.equal(classify(label), 'app', label);
  }
});
test('Threads promotions match their icon, badge label, or actual destination', () => {
  assert.equal(classify('2', {}, 'Threads'), 'threads');
  assert.equal(classify('Threads 2 notifications'), 'threads');
  assert.equal(classify('', { href: 'https://www.threads.com/@example' }), 'threads');
  assert.equal(classify('', { href: 'https://www.threads.net/@example' }), 'threads');
  assert.equal(classify('', { href: 'barcelona://user?username=example' }), 'threads');
});
test('ordinary Instagram controls and lookalike domains remain visible', () => {
  for (const label of ['Profile', 'Notifications', 'Log in', 'Send', 'Follow', 'Message', 'My thoughts on Threads']) {
    assert.equal(classify(label), null, label);
  }
  assert.equal(classify('', { href: 'https://threads.com.example.org/' }), null);
  assert.equal(classify('', { href: '/direct/inbox/' }), null);
});
