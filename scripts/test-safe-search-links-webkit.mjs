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
const otherServices = [
  ['https://pixeldrain.com/u/fixture', 'PixelDrain'],
  ['https://files.catbox.moe/fixture.mp4', 'Catbox'],
  ['https://litterbox.catbox.moe/fixture.mp4', 'catbox.moe'],
  ['https://bunkr.cr/a/fixture', 'Bunkr Albums'],
  ['https://mediafire.com/file/fixture', 'MediaFire'],
  ['https://4shared.com/video/fixture', '4shared'],
  ['https://send.now/fixture', 'send.now'],
  ['https://swisstransfer.com/d/fixture', 'SwissTransfer'],
  ['https://filebin.net/fixture', 'Filebin'],
  ['https://sendvid.com/fixture', 'Sendvid'],
  ['https://imgbox.com/fixture', 'Imgbox'],
  ['https://streamable.com/fixture', 'streamable.com'],
  ['https://wetransfer.com/downloads/fixture', 'WeTransfer'],
  ['https://we.tl/t-fixture', 'we.tl'],
  ['https://onedrive.live.com/fixture', 'OneDrive'],
  ['https://1drv.ms/v/s!fixture', '1drv.ms'],
  ['https://my.pcloud.com/publink/show?code=fixture', 'pCloud'],
  ['https://gofile.today/l/d/fixture', 'gofile.today']
];
const otherServiceCards = otherServices.map(([url, name], index) =>
  `<div class="MjjYud" id="service-${index}-link"><a href="${url}"><h3>Shared collection</h3></a><p>Collection details</p></div>`
  + `<div class="MjjYud" id="service-${index}-name"><a href="https://example.org/index-${index}"><h3>Shared index</h3></a><p>Other files: ${name}, updated today.</p></div>`).join('');
// Synthetic destinations reproduce the screenshot without loading remote content.
const html = `<!doctype html><meta charset="utf-8"><title>Jane Example - Google Search</title>
<form role="search"><input name="q" value="Jane Example"></form><main id="search">
<div id="topstuff"></div><div id="rso">
${otherServiceCards}
<div class="MjjYud" id="unknown-provider"><a href="https://new-sharing-provider.example/fixture"><h3>New service: free file hosting</h3></a><p>Public folders and album links.</p></div>
<div class="MjjYud" id="ordinary-download"><a href="https://example.org/app"><h3>Download the application</h3></a><p>File your tax return.</p></div>
<div class="MjjYud" id="permanent-index"><a href="https://balbums.st/"><h3>Album index</h3></a><p>Reviewed directory</p></div>
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
<div class="MjjYud" id="rentry-index"><a href="https://rentry.co/fixture-index"><h3>WELCOME TO VIDZ4ALL.R.V - Rentry.co</h3></a></div>
<div class="MjjYud" id="rentry-opaque"><a href="https://www.google.com/url?opaque=fixture"><h3>Shared notes</h3></a><cite>https://rentry.co</cite></div>
<div class="MjjYud" id="bare-domain"><a href="https://vibranthealth.example/"><h3>Home</h3></a><p>... abella, bpsex, gj02 ... <b>gofile</b>.io, niam, skenta ...</p></div>
<div class="MjjYud" id="bare-name"><a href="https://union.example/"><h3>Home</h3></a><p>... <b>gofile</b>, ultimateshop.ru ... abella ...</p></div>
<div class="MjjYud" id="ordinary-words"><a href="https://example.org/support"><h3>Welcome to the group</h3></a><p>To go file for disability. Ordinary advice.</p></div>
<div class="MjjYud" id="context"><a href="https://example.org/opaque"><h3>Jane Example photos and links</h3></a><p>CONTEXTUAL DESCRIPTION</p></div>
</div></main><nav id="navigation">Search controls</nav>`;
const prefix = `const redirects=[];const location={hostname:'www.google.com',pathname:'/search',protocol:'https:',href:'https://www.google.com/search?q=Jane+Example&safe=active',replace(target){redirects.push(target)},assign(target){redirects.push(target)}};`;
const guard = await readFile(join(root, 'ios/VigilSocial/VigilYouTubeInteractionExtension/Resources/search-guard.js'), 'utf8');
const checks = `(async()=>{
  const rows=[]; const check=(value,label)=>rows.push({passed:!!value,label});
  const shown=id=>document.getElementById(id).getBoundingClientRect().height>0;
  const wait=()=>new Promise(resolve=>setTimeout(resolve,350));
  const files=['paste','reddit','justpaste','split','redirector','wrapped','group-file','fallback','home','rentry-index','rentry-opaque','bare-domain','bare-name','unknown-provider'];
  for(let index=0;index<${otherServices.length};index++)files.push('service-'+index+'-link','service-'+index+'-name');
  const notice=document.getElementById('topstuff');
  const banner=text=>notice.innerHTML='<div role="status">'+text+' <a href="https://www.google.com/safesearch">Learn more</a></div>';
  await wait();
  for(const id of files)check(shown(id),id+' needs SafeSearch context');
  check(!shown('reported'),'reported destination hidden without a banner');
  check(!shown('permanent-index'),'reviewed album index hidden even without SafeSearch notice');
  banner('SafeSearch is locked to filter by your network, browser, or device.');
  await wait();
  for(const id of files)check(!shown(id),'whole '+id+' hidden with current iPhone banner');
  for(const id of ['safe','lookalike','ordinary-words','ordinary-download','group-safe','group','search','rso','navigation','context'])check(shown(id),id+' preserved');
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
  const immediateIndex=document.createElement('div');immediateIndex.className='MjjYud';immediateIndex.innerHTML='<a href="https://rentry.co/new-fixture"><h3>New index</h3></a>';document.getElementById('rso').append(immediateIndex);
  const indexEvent=new MouseEvent('click',{bubbles:true,cancelable:true});immediateIndex.querySelector('a').dispatchEvent(indexEvent);
  check(indexEvent.defaultPrevented,'paste navigation intercepted before mutation scan');
  document.getElementById('fallback').querySelector('p').textContent='Ordinary replacement snippet.';
  await wait();check(shown('fallback'),'recycled safe card restored');check(document.getElementById('fallback').style.display==='grid','original display restored');
  location.href='https://www.google.com/search?q=Other+Topic&safe=active';notice.replaceChildren();
  await wait();for(const id of files)check(shown(id),id+' restored on unrelated search');
  notice.innerHTML='<div class="MjjYud"><a href="https://example.org/help"><h3>Help article</h3></a><p role="status">SafeSearch is locked to filter by your network, browser, or device. Learn more</p></div>';
  await wait();check(shown('paste'),'banner quoted inside a result supplies no evidence');
  notice.replaceChildren();
  notice.insertAdjacentHTML('afterend','<div id="desktop-notice">SafeSearch is locked to filter by safety settings applied to this browser. <a href="https://support.google.com/websearch/answer/510">Learn more</a></div>');
  await wait();check(!shown('paste'),'older banner remains protected');
  location.href='https://www.google.com/search?q=Another+Person&safe=active';document.getElementById('desktop-notice').remove();
  banner('Some results have been limited by SafeSearch.');
  await wait();
  for(const id of files.filter(id=>id!=='fallback'))check(!shown(id),id+' hidden with filtered-results notice alone');
  for(const id of ['safe','lookalike','ordinary-words','group-safe','navigation'])check(shown(id),id+' preserved with filtered-results notice');
  check(!shown('ordinary-download'),'existing filtered-results contributor rule still blocks a download label');
  check(!shown('context'),'contextually blocked result hides its full snippet');
  check(!document.body.innerText.includes('CONTEXTUAL DESCRIPTION'),'contextual result text is not selectable');
  location.href='https://www.google.com/search?q=abella+danger+gofile&safe=active';
  banner('SafeSearch is locked to filter by your network, browser, or device.');
  await wait();
  for(const id of ['rentry-index','bare-domain','bare-name'])check(!shown(id),id+' hidden for screenshot query with locked banner');
  banner('Some results have been limited by SafeSearch.');
  await wait();check(redirects.includes('about:blank'),'screenshot query with filtered-results evidence blocks the search itself');
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
