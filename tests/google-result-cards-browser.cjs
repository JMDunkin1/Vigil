const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');

const fixture = `<!doctype html><html><head><meta charset="utf-8"><title>Manga sites - Google Search</title>
<style>body{font:16px system-ui;margin:32px;background:#202124;color:#ddd}a{color:#9ac0ff}main{max-width:760px}.MjjYud,.unknown-card{padding:12px;border-bottom:1px solid #555}h3{margin:4px 0}cite{font-style:normal}img{width:24px;height:24px}</style></head><body>
<form role="search"><input value="manga sites"></form><main id="search">
<section aria-label="AI Overview"><ul>
<li id="ai-blocked"><a href="https://mangafire.to/">MangaFire</a>: DANGLING BLOCKED DESCRIPTION</li>
<li id="ai-text"><strong>MangaDex</strong>: DANGLING TEXT-ONLY DESCRIPTION</li>
<li id="ai-safe"><a href="https://example.org/">Library</a>: ordinary recommendation</li>
</ul></section><div id="rso">
<div class="MjjYud" id="blocked"><div><div class="N54PNb BToiNc"><div class="kb0PBd"><div class="yuRUbf"><span><a href="https://atsu.moe/"><h3>Atsumaru</h3><cite>https://atsu.moe</cite></a></span></div></div><div>BLOCKED ORGANIC SNIPPET</div></div></div><table><tr><td><a href="https://atsu.moe/new"><h3>Latest releases</h3></a><span>BLOCKED SITELINK DESCRIPTION</span></td></tr></table></div>
<div class="MjjYud" id="safe"><a href="https://example.org/"><h3>Library</h3><cite>https://example.org</cite></a><p>Keep this neighboring result and its description.</p></div>
<div class="MjjYud" id="wrapped"><a href="https://www.google.com/url?q=https%3A%2F%2Fmangafire.to%2F"><h3>Reader</h3></a><p>BLOCKED REDIRECT SNIPPET</p></div>
<div class="MjjYud" id="opaque"><a href="https://www.google.com/goto?url=opaque-bytes"><h3>Online reader</h3><cite>https://manta.net › browse</cite></a><p>BLOCKED CITATION SNIPPET</p></div>
<div class="MjjYud" id="opaque-safe"><a href="https://www.google.com/goto?url=opaque-bytes"><h3>Library archive</h3><cite>https://example.org › archive</cite></a><p>Keep opaque safe result.</p></div>
<div class="MjjYud" id="metadata-safe"><a href="https://www.google.com/url?q=https%3A%2F%2Fexample.org%2F%3Fnonce%3Datsumaru"><h3>Library metadata</h3></a><p>Keep opaque query metadata.</p></div>
<div class="unknown-card" id="fallback"><div><div><a href="https://mangafire.to/"><h3>Reader listings</h3></a></div><p>BLOCKED FALLBACK SNIPPET</p></div></div>
<div class="MjjYud" id="group"><div class="MjjYud" id="group-blocked"><a href="https://mangafire.to/"><h3>Reader</h3></a><p>BLOCKED GROUP SNIPPET</p></div><div class="MjjYud" id="group-safe"><a href="https://example.org/"><h3>Public library</h3></a><p>Keep group sibling.</p></div></div>
<div class="MjjYud" id="recycled" style="display:grid"><a href="https://manta.net/"><h3>Book catalog</h3></a><p>Recycled result description.</p></div>
<div class="MjjYud" id="explicit-label"><a href="https://example.org/opaque"><h3>NSFW videos</h3></a><p>BLOCKED EXPLICIT LABEL SNIPPET</p></div>
<div class="MjjYud" id="video-group"><div id="video-blocked"><a href="https://example.org/video1"><h3>NSFW videos</h3></a><p>BLOCKED VIDEO DESCRIPTION</p></div><div id="video-safe"><a href="https://example.org/video2"><h3>Manga drawing tutorial</h3></a><p>Keep the neighboring video description.</p></div></div>
</div></main><nav id="navigation"><a href="https://www.google.com/search?q=manga+sites&start=10">Next</a></nav></body></html>`;

async function main() {
  const server = http.createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(fixture);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1100, height: 1000, webPreferences: { sandbox: true } });
  try {
    await win.loadURL(`http://127.0.0.1:${server.address().port}/search?q=manga+sites&safe=active`);
    const prefix = `const location={hostname:'www.google.com',pathname:'/search',protocol:'https:',href:'https://www.google.com/search?q=manga+sites&safe=active',replace(){},assign(){}};`;
    for (const asset of ['google-safe-search.js', 'media-child-lock.js']) {
      await win.webContents.executeJavaScript(`(()=>{${prefix}${await fs.readFile('dist/runtime/extension/' + asset, 'utf8')}\n})();`);
    }
    const visible = id => win.webContents.executeJavaScript(`document.getElementById(${JSON.stringify(id)}).getBoundingClientRect().height > 0`);
    for (const id of ['blocked', 'wrapped', 'opaque', 'fallback', 'group-blocked', 'recycled', 'explicit-label', 'ai-blocked', 'ai-text', 'video-blocked']) {
      assert.equal(await visible(id), false, `${id}: hide the entire result, including its description`);
    }
    for (const id of ['safe', 'opaque-safe', 'metadata-safe', 'group-safe', 'group', 'ai-safe', 'rso', 'search', 'navigation', 'video-safe', 'video-group']) {
      assert.equal(await visible(id), true, `${id}: preserve the neighboring result or page controls`);
    }
    assert.equal(await win.webContents.executeJavaScript(`document.body.innerText.includes('BLOCKED ORGANIC SNIPPET')`), false);
    assert.equal(await win.webContents.executeJavaScript(`document.body.innerText.includes('BLOCKED SITELINK DESCRIPTION')`), false);
    await win.webContents.executeJavaScript(`document.getElementById('recycled').querySelector('a').href='https://example.org/';`);
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.equal(await visible('recycled'), true, 'reclassify recycled cards and restore their original display');
    assert.equal(await win.webContents.executeJavaScript(`document.getElementById('recycled').style.display`), 'grid');
    await win.webContents.executeJavaScript(`document.getElementById('blocked').style.removeProperty('display');document.getElementById('rso').insertAdjacentHTML('beforeend','<div class="MjjYud" id="dynamic"><a href="https://mangafire.to/"><h3>Reader</h3></a><p>BLOCKED DYNAMIC SNIPPET</p></div>');`);
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.equal(await visible('dynamic'), false, 'hide results inserted after document load');
    assert.equal(await visible('blocked'), false, 'reapply hiding after a site changes inline styles');
    const immediate = await win.webContents.executeJavaScript(`(()=>{let clicks=0;document.addEventListener('click',()=>clicks++);document.getElementById('rso').insertAdjacentHTML('beforeend','<div class="MjjYud"><a id="immediate" href="https://www.google.com/goto?url=new-opaque"><h3>New online reader</h3><cite>https://manta.net</cite></a><p>New result snippet</p></div>');const event=new MouseEvent('click',{bubbles:true,cancelable:true});document.getElementById('immediate').dispatchEvent(event);return {clicks,cancelled:event.defaultPrevented};})()`);
    assert.deepEqual(immediate, { clicks: 0, cancelled: true }, 'block wrapped-result clicks before mutation scanning');
    if (process.argv[2]) await fs.writeFile(process.argv[2], (await win.webContents.capturePage()).toPNG());
    console.log('Complete Google results, sitelinks, AI rows, redirects, citations and dynamic content filtered; neighboring results, controls and recycled cards preserved.');
  } finally {
    win.destroy(); await new Promise(resolve => server.close(resolve));
  }
}
void main().then(() => app.quit()).catch(error => { console.error(error); app.exit(1); });
