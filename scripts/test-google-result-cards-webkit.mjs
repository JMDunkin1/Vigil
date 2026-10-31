#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
const execute = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const test = await readFile(join(root, 'tests/google-result-cards-browser.cjs'), 'utf8');
const html = test.match(/const fixture = `([\s\S]*?)`;/)?.[1];
assert.ok(html, 'The browser fixture must be shared between Chromium and WebKit');
const prefix = `const location={hostname:'www.google.com',pathname:'/search',protocol:'https:',href:'https://www.google.com/search?q=manga+sites&safe=active',replace(){},assign(){}};`;
const scripts = await Promise.all(['google-safe-search.js', 'media-child-lock.js'].map(async name =>
  `(()=>{${prefix}${await readFile(join(root, 'dist/runtime/extension', name), 'utf8')}\n})();`));
const checks = `(async()=>{
  const results=[]; const shown=id=>document.getElementById(id).getBoundingClientRect().height>0;
  const check=(value,label)=>results.push({passed:!!value,label});
  await new Promise(resolve=>setTimeout(resolve,400));
  for(const id of ['blocked','wrapped','opaque','fallback','group-blocked','recycled','explicit-label','ai-blocked','ai-text','video-blocked'])check(!shown(id),'whole '+id+' hidden');
  for(const id of ['safe','opaque-safe','metadata-safe','group-safe','group','ai-safe','rso','search','navigation','video-safe','video-group'])check(shown(id),id+' preserved');
  check(!document.body.innerText.includes('BLOCKED ORGANIC SNIPPET'),'organic snippet absent');
  check(!document.body.innerText.includes('BLOCKED SITELINK DESCRIPTION'),'sitelink snippet absent');
  document.getElementById('recycled').querySelector('a').href='https://example.org/';
  await new Promise(resolve=>setTimeout(resolve,350));
  check(shown('recycled'),'recycled safe result restored');
  check(document.getElementById('recycled').style.display==='grid','original display restored');
  document.getElementById('blocked').style.removeProperty('display');
  document.getElementById('rso').insertAdjacentHTML('beforeend','<div class="MjjYud" id="dynamic"><a href="https://mangafire.to/"><h3>Reader</h3></a><p>BLOCKED DYNAMIC SNIPPET</p></div>');
  await new Promise(resolve=>setTimeout(resolve,350));
  check(!shown('dynamic'),'dynamic result hidden'); check(!shown('blocked'),'hiding repaired after style change');
  let clicks=0; document.addEventListener('click',()=>clicks++);
  document.getElementById('rso').insertAdjacentHTML('beforeend','<div class="MjjYud"><a id="immediate" href="https://www.google.com/goto?url=new-opaque"><h3>New reader</h3><cite>https://manta.net</cite></a></div>');
  const event=new MouseEvent('click',{bubbles:true,cancelable:true});document.getElementById('immediate').dispatchEvent(event);
  check(clicks===0&&event.defaultPrevented,'wrapped-result click intercepted before scan');
  window.webkit.messageHandlers.results.postMessage(results);
})().catch(error=>window.webkit.messageHandlers.results.postMessage([{passed:false,label:String(error)}]));`;
const directory = await mkdtemp(join(tmpdir(), 'vigil-google-result-cards-'));
try {
  await Promise.all([writeFile(join(directory, 'guard.js'), scripts.join('\n') + checks), writeFile(join(directory, 'fixture.html'), html)]);
  const executable = join(directory, 'result-cards');
  await execute('xcrun', ['swiftc', join(root, 'tests/fixtures/google-result-cards.swift'), '-o', executable], { timeout: 60000 });
  const result = await execute(executable, [directory], { timeout: 45000, maxBuffer: 2 * 1024 * 1024 });
  process.stdout.write(result.stdout);
  assert.ok(result.stdout.split(/\r?\n/).includes('VIGIL_GOOGLE_RESULT_CARDS_COMPLETE'));
  await rm(directory, { recursive: true, force: true });
} catch (error) {
  if (error.stdout) process.stderr.write(error.stdout);
  if (error.stderr) process.stderr.write(error.stderr);
  process.stderr.write(`Google result fixture retained at ${directory}\n`);
  throw error;
}
