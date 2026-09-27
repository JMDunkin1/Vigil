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
  ...["r34", "R34", "r_34", "rule 34", "s3x", "s.3.x", "nud", "nuds", "nud3s", "s3xnud", "nudsex", "pornnudes", "p.o.r.n", "ｒ３４", "r​34", "%2572%2533%2534"].map(q => `https://www.reddit.com/search?q=${encodeURIComponent(q)}`),
  'https://www.reddit.com/over18?dest=/r/example',
  'https://old.reddit.com/api/over18',
  'https://www.reddit.com/r/gonewild/comments/example',
  'https://www.reddit.com/r/%70orn/',
  'https://www.reddit.com/user/HarleyDeanXXX/',
  'https://old.reddit.com/u/HarleyDeanXXX/comments/',
  'https://www.reddit.com/user/HarleyDean%2558%2558%2558/',
  'https://www.reddit.com/r/u_HarleyDeanXXX/',
  'https://www.reddit.com/search?q=HarleyDeanXXX',
  'https://www.reddit.com/search?q=nude+videos',
  ...['x', 'xx', '%2578%2578', 'ｘ', 'adult+video', 'unreviewed+videos'].map(q => `https://www.reddit.com/search?q=${q}`),
  'https://www.reddit.com/search?q=x&q=gardening',
  'https://www.reddit.com/search?q=programming&q=porn',
  'https://www.reddit.com/r/example/comments/demo/hot_box_sex/'
]) assert.equal(evaluate('safeURL', url), 'https://www.reddit.com/', url);
for (const url of [
  'https://www.reddit.com/search/?q=programming&include_over_18=on&include_over_18=on&nsfw=1',
  'https://old.reddit.com/r/programming/search.json?q=typescript',
  'https://www.reddit.com/search?q=typescript',
  ...['Xbox', 'SpaceX', 'x+axis', 'X-Men', 'adult+education'].map(q => `https://www.reddit.com/search?q=${q}`)
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
for (const label of ['r34', 's3x', 'nud', 's3xnud', 'pornnudes', 'p.o.r.n', 'ＰＯＲＮ', 'p\u200born', 'nude videos', 'gonewild']) assert.equal(evaluate('explicit', label), true, label);
for (const label of ['Learn programming', 'How to grow tomatoes', 'nudging', 'Nudibranch', 'Middlesex', 'SKU-R34567']) assert.equal(evaluate('explicit', label), false, label);
for (const label of ['HarleyDeanXXX', 'u/HarleyDeanＸＸＸ', 'HarleyDeanX\u200bXX']) assert.equal(evaluate('explicit', label), true, label);
for (const name of ['SpaceX', 'XboxFan', 'Alex', 'Maxx']) assert.equal(evaluate('safeURL', `https://www.reddit.com/user/${name}/`), null, name);
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

for (const label of ['Unreviewed videos', 'Show unreviewed videos', 'Unreviewed videos (12)']) assert.equal(evaluate('unreviewedLabel', label), true);
for (const label of ['A discussion about unreviewed videos', 'Unreviewed code', 'Videos']) assert.equal(evaluate('unreviewedLabel', label), false);
assert.equal(evaluate('safeURL', 'https://www.reddit.com/r/example/comments/id/x/'), null);

// Unsafe navigation must reach Vigil's page, never silently return to Reddit.
for (const query of ['r34', 's3x', 'nud', 's3xnud']) {
  const redirects: string[] = [];
  const url = new URL(`https://www.reddit.com/search?q=${query}`);
  const navigation = createContext({ URL, location: { href: url.href, hostname: url.hostname, replace: (target: string) => redirects.push(target) }, chrome: { runtime: { getURL: (path: string) => `chrome-extension://vigil/${path}` } } });
  runInContext(source, navigation);
  assert.deepEqual(redirects, ['chrome-extension://vigil/blocked.html']);
}
const variantRule = new RegExp(rules.find(rule => rule.id === 4)!.condition.regexFilter, 'i');
for (const query of ['r34', 's3x', 'nud', 's3xnud', 'pornnudes']) assert.equal(variantRule.test(`https://www.reddit.com/search?q=${query}`), true);
for (const query of ['nudging', 'nudibranch', 'NUD+command+reference', 'SKU-R34567', 'Middlesex']) assert.equal(variantRule.test(`https://www.google.com/search?q=${query}`), false);
