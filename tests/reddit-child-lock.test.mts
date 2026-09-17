import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';

const source = await readFile(new URL('../extension/reddit-child-lock.js', import.meta.url), 'utf8');
const helperStart = source.indexOf('  const redditHost =');
const helperEnd = source.indexOf('  const enforceURL =');
assert.ok(helperStart > 0 && helperEnd > helperStart);
const helpers = source.slice(helperStart, helperEnd).replace('  if (!redditHost(location.hostname)) return;', '');
const context = createContext({ URL, location: new URL('https://www.reddit.com/r/programming/') });
runInContext(helpers, context);
const evaluate = (name: string, value: string): unknown => runInContext(`${name}(${JSON.stringify(value)})`, context);
for (const url of [
  'https://www.reddit.com/over18?dest=/r/example',
  'https://old.reddit.com/api/over18',
  'https://www.reddit.com/r/gonewild/comments/example',
  'https://www.reddit.com/r/%70orn/',
  'https://www.reddit.com/search?q=nude+videos',
  'https://www.reddit.com/search?q=programming&q=porn',
  'https://www.reddit.com/r/example/comments/demo/hot_box_sex/'
]) assert.equal(evaluate('safeURL', url), 'https://www.reddit.com/', url);
for (const url of [
  'https://www.reddit.com/search/?q=programming&include_over_18=on&include_over_18=on&nsfw=1',
  'https://old.reddit.com/r/programming/search.json?q=typescript',
  'https://www.reddit.com/search?q=typescript'
]) {
  const next = new URL(String(evaluate('safeURL', url)));
  assert.equal(next.searchParams.get('include_over_18'), 'off');
  assert.equal(next.searchParams.getAll('include_over_18').length, 1);
  assert.equal(next.searchParams.get('nsfw'), '0');
  assert.equal(evaluate('safeURL', next.href), null, 'must not loop on the safe URL');
}
assert.equal(evaluate('safeURL', 'https://reddit.com.example.org/search?q=porn'), null);
assert.equal(evaluate('safeURL', 'https://www.reddit.com/r/programming/comments/demo'), null);
for (const label of ['Yes, I am over 18', "Yes, I'm over 18", 'yes im over 18', 'I am over eighteen', 'Continue to mature content']) assert.equal(evaluate('ageConfirmation', label), true, label);
for (const label of ['18 years of research', 'Show comments', 'I am a programmer']) assert.equal(evaluate('ageConfirmation', label), false, label);
for (const label of ['ＰＯＲＮ', 'p\u200born', 'nude videos', 'gonewild']) assert.equal(evaluate('explicit', label), true, label);
for (const label of ['Learn programming', 'How to grow tomatoes']) assert.equal(evaluate('explicit', label), false, label);
console.log('Reddit child-lock URL and age-confirmation regression tests passed.');
const rules = JSON.parse(await readFile(new URL('../extension/rules.json', import.meta.url), 'utf8')) as Array<{id:number;condition:{regexFilter:string};action:{redirect:{transform?:{queryTransform:{addOrReplaceParams:Array<{key:string;value:string}>}};extensionPath?:string}}}>;
const searchRule = rules.find(rule => rule.id === 5);
assert.ok(searchRule);
assert.equal(new RegExp(searchRule.condition.regexFilter, 'i').test('https://old.reddit.com/r/programming/search.json?q=test'), true);
assert.equal(new RegExp(searchRule.condition.regexFilter, 'i').test('https://reddit.com.example.org/search?q=test'), false);
assert.deepEqual(searchRule.action.redirect.transform?.queryTransform.addOrReplaceParams, [{key:'include_over_18',value:'off'}, {key:'nsfw',value:'0'}]);
const ageRule = rules.find(rule => rule.id === 6);
assert.ok(ageRule);
assert.equal(new RegExp(ageRule.condition.regexFilter, 'i').test('https://www.reddit.com/api/over18'), true);
assert.equal(ageRule.action.redirect.extensionPath, '/blocked.html');
