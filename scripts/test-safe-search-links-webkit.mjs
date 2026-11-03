#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const directory = await mkdtemp(join(tmpdir(), 'vigil-safe-search-links-'));
// Synthetic destinations reproduce the screenshot without loading remote content.
const html = `<!doctype html><meta charset="utf-8"><title>Jane Example - Google Search</title>
<form role="search"><input name="q" value="Jane Example"></form><main id="search">
<div id="topstuff"></div><div id="rso">
<div class="MjjYud" id="paste"><a href="https://rentry.co/fixture"><h3>Copy and paste link below</h3></a><p>https://gofile.io/d/fixture. Copy and paste link below</p></div>
<div class="MjjYud" id="reddit"><a href="https://www.reddit.com/r/example/comments/fixture"><h3>Ordinary title</h3></a><p>Link: https://gofile.io/d/another-fixture. Other text</p></div>
<div class="MjjYud" id="justpaste"><a href="https://justpaste.it/fixture"><h3>Shared notes</h3></a><p>https://mega.nz/folder/fixture#key</p></div>
<div class="MjjYud" id="split"><a href="https://example.org/files"><h3>Shared notes</h3></a><p>Link: https://<b>gofile</b>.io/d/split. Other text</p></div>
<div class="MjjYud" id="redirector"><a href="https://example.org/paste"><h3>Shared links</h3></a><p>Link: https://link-center.net/12345/fixture. Other text</p></div>
<div class="MjjYud" id="reported"><a href="https://justpaste.it/jarvisx"><h3>Shared notes</h3></a><p>Reported destination.</p></div>
<div class="MjjYud" id="wrapped"><a href="https://www.google.com/url?q=https%3A%2F%2Fgofile.io%2Fd%2Fwrapped-fixture"><h3>Download</h3></a><p>WRAPPED FILE DESCRIPTION</p></div>
<div class="MjjYud" id="group"><div class="MjjYud" id="group-file"><a href="https://example.org/collection"><h3>Files</h3></a><p>https://drive.google.com/file/d/fixture/view</p></div><div class="MjjYud" id="group-safe"><a href="https://example.org/library"><h3>Library</h3></a><p>Keep neighboring result.</p></div></div>
<div class="unknown-card" id="fallback" style="display:grid"><div><a href="https://example.org/notes"><h3>Notes</h3></a></div><p>https://dropbox.com/s/fixture/book.pdf</p></div>
<div class="MjjYud" id="safe"><a href="https://example.org/article"><h3>Ordinary article</h3></a><p>Keep this result.</p></div>
<div class="MjjYud" id="lookalike"><a href="https://example.org/guide"><h3>URL examples</h3></a><p>https://gofile.io.example.org/d/fixture</p></div>
<div class="MjjYud" id="home"><a href="https://gofile.io/"><h3>Cloud storage homepage</h3></a><p>Homepage without a shared file.</p></div>
<div class="MjjYud" id="context"><a href="https://example.org/opaque"><h3>Jane Example photos and links</h3></a><p>CONTEXTUAL DESCRIPTION</p></div>
</div></main><nav id="navigation">Search controls</nav>`;
const prefix = `const location={hostname:'www.google.com',pathname:'/search',protocol:'https:',href:'https://www.google.com/search?q=Jane+Example&safe=active',replace(){},assign(){}};`;
const guard = await readFile(join(root, 'ios/VigilSocial/VigilYouTubeInteractionExtension/Resources/search-guard.js'), 'utf8');
const checks = `(async()=>{
  const rows=[]; const check=(value,label)=>rows.push({passed:!!value,label});
  const shown=id=>document.getElementById(id).getBoundingClientRect().height>0;
  const wait=()=>new Promise(resolve=>setTimeout(resolve,350));
  const files=['paste','reddit','justpaste','split','redirector','wrapped','group-file','fallback'];
  const notice=document.getElementById('topstuff');
  const banner=text=>notice.innerHTML='<div role="status">'+text+' <a href="https://www.google.com/safesearch">Learn more</a></div>';
  await wait();
  for(const id of files)check(shown(id),id+' needs SafeSearch context');
  check(!shown('reported'),'reported destination hidden without a banner');
  banner('SafeSearch is locked to filter by your network, browser, or device.');
  await wait();
  for(const id of files)check(!shown(id),'whole '+id+' hidden with current iPhone banner');
  for(const id of ['safe','lookalike','home','group-safe','group','search','rso','navigation','context'])check(shown(id),id+' preserved');
  check(!document.body.innerText.includes('https://gofile.io/d/fixture'),'plain-text shared URL cannot be selected or copied from rendered text');
  check(!document.body.innerText.includes('WRAPPED FILE DESCRIPTION'),'redirected file result hides its snippet');
  document.getElementById('paste').style.removeProperty('display');
  document.getElementById('rso').insertAdjacentHTML('beforeend','<div class="MjjYud" id="dynamic"><a href="https://example.org/more"><h3>More notes</h3></a><p>https://mega.nz/file/dynamic#key</p></div>');
  await wait();
  check(!shown('paste'),'site style changes cannot reveal a hidden snippet');
  check(!shown('dynamic'),'dynamically inserted snippet hidden');
  let siteEvents=0;document.addEventListener('contextmenu',()=>siteEvents++);
  const immediate=document.createElement('div');immediate.className='MjjYud';immediate.innerHTML='<a href="https://example.org/new"><h3>New notes</h3></a><p>https://gofile.io/d/immediate</p>';document.getElementById('rso').append(immediate);
  const event=new MouseEvent('contextmenu',{bubbles:true,cancelable:true});immediate.querySelector('a').dispatchEvent(event);
  check(event.defaultPrevented&&siteEvents===0,'copy-link menu intercepted before mutation scan');
  document.getElementById('fallback').querySelector('p').textContent='Ordinary replacement snippet.';
  await wait();check(shown('fallback'),'recycled safe card restored');check(document.getElementById('fallback').style.display==='grid','original display restored');
  location.href='https://www.google.com/search?q=Other+Topic&safe=active';notice.replaceChildren();
  await wait();for(const id of files)check(shown(id),id+' restored on unrelated search');
  notice.innerHTML='<div class="MjjYud"><a href="https://example.org/help"><h3>Help article</h3></a><p role="status">SafeSearch is locked to filter by your network, browser, or device. Learn more</p></div>';
  await wait();check(shown('paste'),'banner quoted inside a result supplies no evidence');
  notice.replaceChildren();
  notice.insertAdjacentHTML('afterend','<div id="desktop-notice">SafeSearch is locked to filter by safety settings applied to this browser. <a href="https://support.google.com/websearch/answer/510">Learn more</a></div>');
  await wait();check(!shown('paste'),'older banner remains protected');
  location.href='https://www.google.com/search?q=Jane+Example&safe=active';
  banner('Some results have been limited by SafeSearch.');
  await wait();check(!shown('context'),'contextually blocked result hides its full snippet');
  check(!document.body.innerText.includes('CONTEXTUAL DESCRIPTION'),'contextual result text is not selectable');
  window.webkit.messageHandlers.results.postMessage(rows);
})().catch(error=>window.webkit.messageHandlers.results.postMessage([{passed:false,label:String(error)}]));`;

try {
  await writeFile(join(directory, 'fixture.html'), html);
  await writeFile(join(directory, 'guard.js'), `(()=>{${prefix}${guard}\n${checks}\n})();`);
  const executable = join(directory, 'safe-search-links');
  await execute('xcrun', ['swiftc', join(root, 'tests/fixtures/google-result-cards.swift'), '-o', executable], { timeout: 60000 });
  const result = await execute(executable, [directory], { timeout: 45000, maxBuffer: 2 * 1024 * 1024 });
  process.stdout.write(result.stdout);
  assert.ok(result.stdout.split(/\r?\n/).includes('VIGIL_GOOGLE_RESULT_CARDS_COMPLETE'));
  await rm(directory, { recursive: true, force: true });
} catch (error) {
  if (error.stdout) process.stderr.write(error.stdout);
  if (error.stderr) process.stderr.write(error.stderr);
  process.stderr.write(`SafeSearch link fixture retained at ${directory}\n`);
  throw error;
}
