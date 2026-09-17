const {app, BrowserWindow} = require('electron');
const fs = require('node:fs');
const assert = require('node:assert/strict');
async function main() {
 await app.whenReady();
 const win = new BrowserWindow({show:false, webPreferences:{sandbox:true}});
 await win.webContents.session.protocol.handle('https', () => new Response(`<!doctype html><body>
 <article id="ordinary"><h2>Learn programming</h2><button>Show comments</button></article>
 <shreddit-post id="explicit" post-title="nude videos"></shreddit-post>
 <shreddit-post id="marked" nsfw></shreddit-post>
 <shreddit-post id="safe" nsfw="false" post-title="Tomatoes"></shreddit-post>
 <div id="host"></div><a id="search" href="/search?q=programming&nsfw=1">Search</a>
 <button id="safe-toggle" role="switch" aria-checked="true">Safe Search</button>
 <input id="over18" name="over_18" type="checkbox"><label for="over18">I am over eighteen years old</label>
 </body>`,{headers:{'content-type':'text/html'}}));
 await win.loadURL('https://www.reddit.com/r/programming');
 await win.webContents.executeJavaScript(`document.querySelector('#host').attachShadow({mode:'open'}).innerHTML = '<button id="age"><span>yes im over 18</span></button>'; window.siteClicks=0; document.addEventListener('click',()=>window.siteClicks++);`);
 await win.webContents.executeJavaScript(fs.readFileSync('ios/VigilSocial/VigilYouTubeInteractionExtension/Resources/reddit-child-lock.js','utf8'));
 const result = await win.webContents.executeJavaScript(`(() => {
 const hidden=id=>getComputedStyle(document.getElementById(id)).display==='none';
 const shadow=document.querySelector('#host').shadowRoot;
 shadow.querySelector('span').dispatchEvent(new MouseEvent('click',{bubbles:true,composed:true,cancelable:true}));
 return {ordinary:hidden('ordinary'), explicit:hidden('explicit'), marked:hidden('marked'), safe:hidden('safe'), toggle:hidden('safe-toggle'), age:getComputedStyle(shadow.querySelector('button')).display, clicks:window.siteClicks, url:document.getElementById('search').href, pref:hidden('over18')};
 })()`);
 assert.deepEqual({...result,url:undefined},{ordinary:false,explicit:true,marked:true,safe:false,toggle:true,age:'none',clicks:0,url:undefined,pref:true});
 assert.equal(new URL(result.url).searchParams.get('include_over_18'),'off');
 await win.webContents.executeJavaScript(`document.querySelector('#host').shadowRoot.innerHTML='<article id="late"><h2>OnlyFans content</h2></article>';`);
 await new Promise(r=>setTimeout(r,100));
 assert.equal(await win.webContents.executeJavaScript(`getComputedStyle(document.querySelector('#host').shadowRoot.querySelector('#late')).display`),'none');
 await win.webContents.executeJavaScript(`document.body.insertAdjacentHTML('beforeend', '<div id="grid"><div id="movie"><img src="data:," alt="poster"><div>Roadside XXX 6</div></div><div id="normal"><img src="data:," alt="poster"><div>Roadside Romeo</div></div></div>');`);
 await win.webContents.executeJavaScript(fs.readFileSync('ios/VigilSocial/VigilYouTubeInteractionExtension/Resources/media-child-lock.js','utf8'));
 const catalog = await win.webContents.executeJavaScript(`['movie','normal','grid'].map(id=>getComputedStyle(document.getElementById(id)).display)`);
 assert.equal(catalog[0], 'none'); assert.notEqual(catalog[1], 'none'); assert.notEqual(catalog[2], 'none');
 await win.webContents.executeJavaScript(`document.getElementById('normal').lastElementChild.textContent='Roadside XXX 14';`);
 await new Promise(r=>setTimeout(r,100));
 assert.equal(await win.webContents.executeJavaScript(`getComputedStyle(document.getElementById('normal')).display`),'none');
 console.log('Media catalog passed: explicit titles remove the entire poster card, ordinary titles stay visible, late title changes are filtered.');
 console.log('Real Chromium DOM passed: shadow age gate, late shadow posts, safe-search controls, old Reddit preferences, keyword posts, NSFW flags, ordinary content preserved.');
 for (const host of ['x.com', 'twitter.com']) {
  await win.loadURL(`https://${host}/home`);
  await win.webContents.executeJavaScript(`document.body.innerHTML = '<article id="safe"><span>My garden today</span><img src="data:,"></article><article id="adult"><div>NSFW videos</div><div><img src="data:,"></div></article><article id="warning"><span>The following media includes potentially sensitive content.</span><button>Show</button><video></video></article><label id="setting">Hide sensitive content<input type="checkbox" checked></label>'; window.revealed=0; document.addEventListener('click',()=>window.revealed++);`);
  await win.webContents.executeJavaScript(fs.readFileSync('ios/VigilSocial/VigilYouTubeInteractionExtension/Resources/media-child-lock.js','utf8'));
  const states = await win.webContents.executeJavaScript(`['safe','adult','warning','setting'].map(id=>getComputedStyle(document.getElementById(id)).display)`);
  assert.notEqual(states[0],'none'); for (const state of states.slice(1)) assert.equal(state,'none');
  await win.webContents.executeJavaScript(`document.body.insertAdjacentHTML('beforeend','<article id="late"><span>This post may contain sensitive content</span><button>View</button></article>'); document.querySelector('#late button').click();`);
  assert.equal(await win.webContents.executeJavaScript('window.revealed'),0,'a newly inserted reveal must be blocked before the next observer scan');
  assert.equal(await win.webContents.executeJavaScript(`getComputedStyle(document.getElementById('late')).display`),'none');
 }
 console.log('X and Twitter passed: whole explicit posts, sensitive warnings, search controls, immediate dynamic reveal, ordinary posts preserved.');
 win.destroy(); app.quit();
}
void main().catch(e=>{console.error(e);app.exit(1)});
