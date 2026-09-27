const {app, BrowserWindow} = require('electron');
const fs = require('node:fs');
const assert = require('node:assert/strict');
async function main() {
 await app.whenReady();
 const win = new BrowserWindow({show:false, webPreferences:{sandbox:true}});
 await win.webContents.session.protocol.handle('https', () => new Response(`<!doctype html><body>
 <article id="ordinary"><h2>Learn programming</h2><button>Show comments</button></article>
 <section id="age-notice"><h2>NSFW search results are hidden</h2><p>Confirm you are over 18 and update your settings to see potentially explicit content.</p><button id="update-settings">Update Settings</button></section>
 <article id="r34"><h2>R34</h2><img src="data:," alt="thumbnail"></article>
 <shreddit-post id="explicit" post-title="nude videos"></shreddit-post>
 <shreddit-post id="marked" nsfw></shreddit-post>
 <shreddit-post id="safe" nsfw="false" post-title="Tomatoes"></shreddit-post>
 <shreddit-post id="adult-video" post-title="adult video compilation"><video></video></shreddit-post>
 <article id="xbox"><h2>Xbox and Model X news</h2></article>
 <main id="results"><section id="reviewed"><h2>Videos</h2><article>Gardening tutorial</article></section>
 <section id="unreviewed"><h2>Unreviewed videos</h2><article><h3>A video title</h3><video></video></article><button>Show more</button></section></main>
 <div id="host"></div><a id="search" href="/search?q=programming&nsfw=1">Search</a>
 <button id="safe-toggle" role="switch" aria-checked="true">Safe Search</button>
 <input id="over18" name="over_18" type="checkbox"><label for="over18">I am over eighteen years old</label>
 </body>`,{headers:{'content-type':'text/html'}}));
 await win.loadURL('https://www.reddit.com/r/programming');
 await win.webContents.executeJavaScript(`document.querySelector('#host').attachShadow({mode:'open'}).innerHTML = '<button id="age"><span>yes im over 18</span></button>'; window.siteClicks=0; document.addEventListener('click',()=>window.siteClicks++);`);
 await win.webContents.executeJavaScript(fs.readFileSync('ios/VigilSocial/VigilYouTubeInteractionExtension/Resources/reddit-child-lock.js','utf8'));
 assert.equal(await win.webContents.executeJavaScript(`getComputedStyle(document.getElementById('r34')).display`),'none','unflagged R34 thumbnail is concealed with its card');
 assert.equal(await win.webContents.executeJavaScript(`document.getElementById('age-notice').textContent`),'Vigil: Explicit sexual content is not allowed. This restriction applies at every age.');
 assert.equal(await win.webContents.executeJavaScript(`document.getElementById('update-settings')`),null,'age-setting CTA is removed');
 await win.webContents.executeJavaScript(`document.body.insertAdjacentHTML('beforeend','<section id="late-notice"><h2>NSFW search results are hidden</h2><p>Confirm you are over 18 and update your settings to see potentially explicit content.</p><button>Update Settings</button></section>'); document.querySelector('#late-notice button').click();`);
 assert.equal(await win.webContents.executeJavaScript('window.siteClicks'),0,'late settings CTA is blocked before the observer runs');
 assert.match(await win.webContents.executeJavaScript(`document.getElementById('late-notice').textContent`),/restriction applies at every age/);
 await win.webContents.executeJavaScript(`document.body.insertAdjacentHTML('beforeend', '<main id="account-feed"><article id="account-link"><a href="/user/HarleyDeanXXX/">u/HarleyDeanXXX</a><h2>Good enough</h2><video></video></article><shreddit-post id="account-attribute" author="HarleyDeanXXX" nsfw="false" post-title="Good enough"></shreddit-post><div class="thing" id="account-old" data-author="HarleyDeanXXX"><h2>Good enough</h2></div><article id="account-label"><span slot="authorName">u/HarleyDeanXXX</span><h2>Good enough</h2></article><article id="account-safe"><a href="/user/SpaceX/">u/SpaceX</a><h2>Launch today</h2></article><shreddit-post id="account-late" author="Gardener" post-title="Good enough"></shreddit-post><shreddit-post id="account-shadow"><div id="author-host"></div></shreddit-post></main>'); document.querySelector('#author-host').attachShadow({mode:'open'}).innerHTML='<div id="nested-host"></div>'; document.querySelector('#author-host').shadowRoot.querySelector('#nested-host').attachShadow({mode:'open'}).innerHTML='<a href="/user/HarleyDeanXXX/">u/HarleyDeanXXX</a>';`);
 await new Promise(r=>setTimeout(r,100));
 assert.deepEqual(await win.webContents.executeJavaScript(`['account-link','account-attribute','account-old','account-label','account-shadow','account-safe','account-feed','account-late'].map(id=>getComputedStyle(document.getElementById(id)).display==='none')`), [true,true,true,true,true,false,false,false]);
 await win.webContents.executeJavaScript(`document.getElementById('account-late').setAttribute('author','HarleyDeanXXX'); document.getElementById('account-feed').insertAdjacentHTML('beforeend','<article id="account-immediate" author="HarleyDeanXXX"><button>Play</button><video></video></article>'); document.querySelector('#account-immediate button').click();`);
 assert.equal(await win.webContents.executeJavaScript('window.siteClicks'),0,'new explicit author post cannot be played before the observer runs');
 await new Promise(r=>setTimeout(r,100));
 assert.deepEqual(await win.webContents.executeJavaScript(`['account-late','account-immediate'].map(id=>getComputedStyle(document.getElementById(id)).display==='none')`),[true,true]);
 console.log('Reddit author regression passed: screenshot account, unmarked posts, old Reddit, nested shadows, changing authors and immediate play blocked; ordinary account and feed preserved.');
 const categoryState = await win.webContents.executeJavaScript(`['adult-video','xbox','results','reviewed','unreviewed'].map(id => getComputedStyle(document.getElementById(id)).display === 'none')`);
 assert.deepEqual(categoryState, [true, false, false, false, true]);
 await win.webContents.executeJavaScript(`document.querySelector('#results').insertAdjacentHTML('beforeend', '<section id="late-category"><h2>Unreviewed videos</h2><button>Show</button><video></video></section>'); document.querySelector('#late-category button').click();`);
 assert.equal(await win.webContents.executeJavaScript('window.siteClicks'), 0, 'new unreviewed reveal is blocked synchronously');
 assert.equal(await win.webContents.executeJavaScript(`getComputedStyle(document.querySelector('#late-category')).display`), 'none');
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
 await win.webContents.executeJavaScript(`document.querySelector('#host').shadowRoot.innerHTML='<section id="shadow-category"><h2>Unreviewed videos</h2><video></video></section><article id="shadow-safe"><h2>Gardening</h2></article>';`);
 await new Promise(r=>setTimeout(r,100));
 assert.deepEqual(await win.webContents.executeJavaScript(`['shadow-category','shadow-safe'].map(id => getComputedStyle(document.querySelector('#host').shadowRoot.getElementById(id)).display === 'none')`), [true, false]);
 console.log('Reddit categories passed: unreviewed sections and adult-video posts hidden, adjacent safe results and Xbox preserved, immediate reveal and shadow DOM protected.');
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
 for (const host of ['cinecat.eu', 'catalog.example']) {
  await win.loadURL(`https://${host}/`);
  const titles = ['Cursed Psychic Video XXX ZERO 3', ...[3,6,7,8,9,10,11,12,13,14,15].map(n => `Roadside XXX ${n}`), 'Roadside ＸＸＸ 16', 'Roadside X\u200bXX 17'];
  await win.webContents.executeJavaScript(`document.body.innerHTML = '<main id="catalog"></main>'; ${JSON.stringify(titles)}.forEach((title, i) => { const card = document.createElement('a'); card.id = 'card-' + i; card.href = '/media/' + i; card.innerHTML = '<img src="data:," alt="poster"><div></div>'; card.lastElementChild.textContent = title; document.getElementById('catalog').append(card); }); document.getElementById('catalog').insertAdjacentHTML('beforeend', '<a id="safe-card" href="/media/xxxTrackingIdentifier"><img src="data:," alt="poster"><div>Roadside Romeo</div></a><a id="alt-card"><img src="data:," alt="Roadside XXX 18"><div>Untitled</div></a><a id="late-label"><img src="data:,"><div>Untitled</div></a><div id="shadow-host"></div>'); document.getElementById('shadow-host').attachShadow({mode:'open'}).innerHTML = '<a id="shadow-card"><img src="data:,"><span>Roadside XXX 19</span></a>';`);
  await win.webContents.executeJavaScript(fs.readFileSync('ios/VigilSocial/VigilYouTubeInteractionExtension/Resources/media-child-lock.js','utf8'));
  const catalogState = await win.webContents.executeJavaScript(`(() => { const hidden = element => getComputedStyle(element).display === 'none'; return { cards: Array.from(document.querySelectorAll('[id^="card-"]')).map(hidden), alt: hidden(document.getElementById('alt-card')), safe: hidden(document.getElementById('safe-card')), grid: hidden(document.getElementById('catalog')), shadow: hidden(document.getElementById('shadow-host').shadowRoot.getElementById('shadow-card')) }; })()`);
  assert.deepEqual(catalogState, {cards: titles.map(() => true), alt: true, safe: false, grid: false, shadow: true}, host);
  await win.webContents.executeJavaScript(`document.querySelector('#late-label img').alt = 'Roadside XXX 20'; document.getElementById('catalog').insertAdjacentHTML('beforeend', '<a id="late-card"><img src="data:,"><span>Roadside XXX 21</span></a>');`);
  await new Promise(r=>setTimeout(r,100));
  assert.deepEqual(await win.webContents.executeJavaScript(`['late-label', 'late-card'].map(id => getComputedStyle(document.getElementById(id)).display)`), ['none', 'none'], host);
 }
 console.log('Global catalogs passed: exact screenshot titles, poster labels, late cards, shadow DOM and normalized titles hidden; ordinary cards and URL identifiers preserved.');
 win.destroy(); app.quit();
}
void main().catch(e=>{console.error(e);app.exit(1)});
