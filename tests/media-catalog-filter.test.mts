import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';

const source = await readFile(new URL('../extension/media-child-lock.js', import.meta.url), 'utf8');
const start = source.indexOf('  const isContextualPlatform =');
const end = source.indexOf('  const isX =');
assert.ok(start > 0 && end > start);
for (const hostname of ['cinecat.eu', 'catalog.example', 'reddit.com']) {
  const context = createContext({ location: { hostname } });
  runInContext(source.slice(start, end), context);
  for (const title of [
    'Cursed Psychic Video XXX ZERO 3',
    ...[3, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].map(n => `Roadside XXX ${n}`),
    'Roadside ＸＸＸ 16', 'Roadside X\u200bXX 17', 'XXX', 'Roadside-XXX-18',
    'XXX videos', 'NSFW compilation', 'OnlyFans content', 'Chapter XXX videos',
    'Chapter XXX — Roadside XXX 12', 'Chapter XXX pornography'
  ]) assert.equal(runInContext(`explicitTitle(${JSON.stringify(title)})`, context), true, `${hostname}: ${title}`);
  for (const title of ['Roadside Romeo', 'Model X', 'Chapter XXX', 'Super Bowl XXX highlights', 'XXXTrackingIdentifier', 'prefixXXX', 'XXXIV', '文XXX字']) {
    assert.equal(runInContext(`explicitTitle(${JSON.stringify(title)})`, context), false, `${hostname}: ${title}`);
  }
}
console.log('Global media title regression tests passed.');
