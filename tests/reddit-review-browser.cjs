const {app, BrowserWindow} = require('electron');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const source = fs.readFileSync('dist/runtime/extension/reddit-review-guard.js', 'utf8');
const post = 'https://www.reddit.com/r/reviews/comments/abc123/kettle/';
const other = 'https://www.reddit.com/r/reviews/comments/def456/another/';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
 await app.whenReady();
 const win = new BrowserWindow({show:false,width:1000,height:800,webPreferences:{sandbox:true}});
 await win.webContents.session.protocol.handle('https', () => new Response(`<!doctype html><html><body>
 <header id="navigation">Home <input type="search"></header><aside id="recommendations">More posts</aside>
 <style>shreddit-post, shreddit-comment { display:block; }</style><main><shreddit-post id="t3_abc123" permalink="${post}" author="u/EverydayEngineer"><header><a href="/r/reviews/">r/reviews</a><a href="/user/EverydayEngineer/">u/EverydayEngineer</a><time>2 days ago</time><button>Join</button></header><h1>Kettle review</h1><p id="post-text">This kettle lasted five years. Has anyone found a good replacement with a stainless steel interior?</p></shreddit-post>
 <shreddit-comment id="modern-comment" author="u/TeaAndToast"><header><a id="modern-author" href="/user/TeaAndToast/">u/TeaAndToast</a><time>1 day ago</time><button>Follow</button></header><div slot="text-body"><p>Mine is still working. A replaceable filter makes a big difference over time.</p></div><div slot="children"><shreddit-comment author="u/EverydayEngineer"><header><a href="/user/EverydayEngineer/">u/EverydayEngineer</a><time>1 day ago</time></header><div slot="text-body"><p>Thanks, that's exactly the kind of detail I was looking for.</p></div></shreddit-comment></div></shreddit-comment>
 <div class="thing comment" id="legacy-comment"><div class="entry"><p class="tagline"><a class="author" id="legacy-author" href="https://old.reddit.com/user/KettleCollector/">KettleCollector</a> · 12 hours ago</p><div class="md"><p>Check the warranty too. Our replacement was covered.</p></div></div><div class="child"><div class="thing comment" data-author="CarefulReader"><p>A useful tip, thank you.</p></div></div></div>
 <div id="comments"><p id="comment">Mine is still working.</p><button id="more">More replies</button><button id="reply">Reply</button><textarea></textarea>
 <button id="install-app">Download the Reddit app</button><a id="app-store" href="https://apps.apple.com/app/reddit/id1064216828">Get Reddit</a>
 <a id="permalink" href="${post}ghi789/?context=3">Comment link</a>
 <a id="another" href="${other}">Another Reddit post</a><a id="external" href="https://manufacturer.example/">Specifications</a></div>
 <shreddit-post id="t3_def456" permalink="${other}"><h2>Recommended post</h2><img src="data:,"></shreddit-post>
 <div id="shadow-host"></div></main></body></html>`,{headers:{'content-type':'text/html'}}));
 const install = async (allowed, pending=false) => {
  await win.webContents.executeJavaScript(`window.reviewMessages=[]; window.reviewReply=null; window.chrome={runtime:{getURL:path=>'https://vigil.invalid/'+path,sendMessage:message=>{reviewMessages.push(message); return ${pending?'new Promise(resolve=>{reviewReply=resolve})':`Promise.resolve({ok:${allowed}})`};}}}; void 0;`);
  await win.webContents.executeJavaScript(source);
 };
 await win.loadURL(post);
 await install(true,true);
 assert.equal(await win.webContents.executeJavaScript(`getComputedStyle(document.documentElement).visibility`),'hidden','post stays concealed while permission is unresolved');
 await win.webContents.executeJavaScript(`reviewReply({ok:true})`); await wait(30);
 const visibility = await win.webContents.executeJavaScript(`['navigation','recommendations','t3_abc123','comments','reply','more','another','external','t3_def456'].map(id=>getComputedStyle(document.getElementById(id)).display==='none')`);
 assert.deepEqual(visibility,[true,true,false,false,true,false,true,false,true]);
 assert.equal(await win.webContents.executeJavaScript(`getComputedStyle(document.documentElement).visibility`),'visible');
 assert.deepEqual(await win.webContents.executeJavaScript(`['install-app','app-store'].map(id=>getComputedStyle(document.getElementById(id)).display==='none')`),[true,true],'permitted reader pages hide app-download prompts');
 assert.deepEqual(await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('[data-vigil-review-meta]'), node=>node.textContent)`),['r/reviews · u/EverydayEngineer · 2 days ago','u/TeaAndToast · 1 day ago','u/EverydayEngineer · 1 day ago','CarefulReader'],'modern and legacy author context survives hidden headers');
 assert.equal(await win.webContents.executeJavaScript(`document.getElementById('legacy-author').nextElementSibling.textContent`),'KettleCollector','old Reddit keeps its inline author position');
 assert.equal(await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('[data-vigil-review-meta], [data-vigil-review-label]')).some(node=>node.matches('a, button') || node.querySelector('a, button, img'))`),false,'restored context contains text only');
 assert.equal(await win.webContents.executeJavaScript(`getComputedStyle(document.querySelector('main')).maxWidth`),'850px');
 assert.equal(await win.webContents.executeJavaScript(`getComputedStyle(document.querySelector('[slot=children]')).borderLeftWidth`),'1px','nested replies have a visible thread guide');
 if (process.env.VIGIL_REDDIT_PREVIEW_DIR) {
  const previewDir = process.env.VIGIL_REDDIT_PREVIEW_DIR;
  fs.mkdirSync(previewDir,{recursive:true});
  await win.webContents.executeJavaScript(`document.getElementById('comments').style.display='none'`);
  fs.writeFileSync(`${previewDir}/reddit-desktop.png`,(await win.webContents.capturePage()).toPNG());
  win.setSize(390,844); await wait(80);
  assert.equal(await win.webContents.executeJavaScript(`document.documentElement.scrollWidth <= innerWidth`),true,'mobile discussion fits without horizontal page scrolling');
  fs.writeFileSync(`${previewDir}/reddit-mobile.png`,(await win.webContents.capturePage()).toPNG());
  win.setSize(1000,800);
  await win.webContents.executeJavaScript(`document.getElementById('comments').style.removeProperty('display')`);
 }
 await win.webContents.executeJavaScript(`window.siteClicks=0; document.addEventListener('click',()=>siteClicks++); document.getElementById('another').click(); document.getElementById('reply').click();`);
 assert.equal(await win.webContents.executeJavaScript('siteClicks'),0,'hidden links and social controls remain inert');
 await win.webContents.executeJavaScript(`document.querySelector('[data-vigil-review-meta]').click(); document.getElementById('legacy-author').nextElementSibling.click(); document.getElementById('modern-author').click();`);
 assert.equal(await win.webContents.executeJavaScript('siteClicks'),0,'author labels and original profile links cannot activate Reddit handlers');
 await win.webContents.executeJavaScript(`document.getElementById('legacy-author').textContent='UpdatedReader'`); await wait(30);
 assert.equal(await win.webContents.executeJavaScript(`document.getElementById('legacy-author').nextElementSibling.textContent`),'UpdatedReader','author text updates without stale or duplicate names');
 await win.webContents.executeJavaScript(`document.getElementById('legacy-author').href=${JSON.stringify(other)}`); await wait(30);
 assert.equal(await win.webContents.executeJavaScript(`document.getElementById('legacy-comment').querySelector('[data-vigil-review-label]')`),null,'changing a profile to a forbidden post removes its label');
 await win.webContents.executeJavaScript(`document.getElementById('modern-comment').style.setProperty('display','none','important')`); await wait(30);
 assert.equal(await win.webContents.executeJavaScript(`getComputedStyle(document.getElementById('modern-comment')).display`),'none','reader appearance never reveals safety-hidden content');
 await win.webContents.executeJavaScript(`document.getElementById('comments').insertAdjacentHTML('beforeend','<button id="late-upvote" aria-label="Upvote">▲</button>'); document.getElementById('late-upvote').click();`);
 assert.equal(await win.webContents.executeJavaScript('siteClicks'),0,'new voting controls are blocked before observation');
 await win.webContents.executeJavaScript(`document.getElementById('more').click()`);
 assert.equal(await win.webContents.executeJavaScript('siteClicks'),1,'comment expansion remains usable');
 await win.webContents.executeJavaScript(`document.getElementById('shadow-host').attachShadow({mode:'open'}).innerHTML='<aside id="shadow-feed">Feed</aside><p id="shadow-comment">A helpful comment</p><a id="shadow-link" href="${other}">Other post</a>';`);
 await wait(1100);
 assert.deepEqual(await win.webContents.executeJavaScript(`['shadow-feed','shadow-comment','shadow-link'].map(id=>getComputedStyle(document.getElementById('shadow-host').shadowRoot.getElementById(id)).display==='none')`),[true,false,true]);
 await win.webContents.executeJavaScript(`document.getElementById('shadow-host').shadowRoot.innerHTML='<shreddit-comment id="shadow-card" author="ShadowReader"></shreddit-comment>'; document.getElementById('shadow-host').shadowRoot.getElementById('shadow-card').attachShadow({mode:'open'}).innerHTML='<header><a href="https://www.reddit.com/user/ShadowReader/">ShadowReader</a><time>3 hours ago</time></header><p>A helpful comment</p>';`);
 await wait(1100);
 assert.equal(await win.webContents.executeJavaScript(`document.getElementById('shadow-host').shadowRoot.getElementById('shadow-card').shadowRoot.querySelector('[data-vigil-review-meta]').textContent`),'ShadowReader · 3 hours ago','custom-element author metadata renders inside its own shadow root');
 await win.webContents.executeJavaScript(`document.getElementById('shadow-host').shadowRoot.innerHTML='<shreddit-comment id="slotted-card" author="SlottedReader"><a id="slotted-author" slot="authorName" href="https://www.reddit.com/user/SlottedReader/">SlottedReader</a><p>A slotted comment.</p></shreddit-comment>'; document.getElementById('shadow-host').shadowRoot.getElementById('slotted-card').attachShadow({mode:'open'}).innerHTML='<slot name="authorName"></slot><slot></slot>';`);
 await wait(1100);
 assert.equal(await win.webContents.executeJavaScript(`document.getElementById('shadow-host').shadowRoot.getElementById('slotted-author').nextElementSibling.slot`),'authorName','inert author text keeps its Web Component slot');
 assert.equal(await win.webContents.executeJavaScript(`document.getElementById('shadow-host').shadowRoot.getElementById('slotted-card').shadowRoot.querySelector('[data-vigil-review-meta]')`),null,'a visible slotted author needs no duplicate metadata row');
 await win.webContents.executeJavaScript(`document.getElementById('shadow-host').shadowRoot.innerHTML='<aside id="replaced-feed">Feed</aside><p id="replaced-comment">Still readable</p>';`);
 await wait(40);
 assert.deepEqual(await win.webContents.executeJavaScript(`['replaced-feed','replaced-comment'].map(id=>getComputedStyle(document.getElementById('shadow-host').shadowRoot.getElementById(id)).display==='none')`),[true,false],'a component render cannot remove the reader stylesheet');
 await win.webContents.executeJavaScript(`history.pushState({},'',${JSON.stringify(other)})`); await wait(200);
 assert.equal(win.webContents.getURL(),'about:blank','SPA changes to a second post are blocked');
 await win.loadURL(post); await install(false); await wait(100);
 assert.equal(win.webContents.getURL(),'about:blank','direct navigation has no permission');
 await win.loadURL('https://www.google.com/search?q=kettle+reddit');
 await win.webContents.executeJavaScript(`document.body.innerHTML='<a id="result" style="position:fixed;left:20px;top:20px;display:block;width:300px;height:80px" href="${post}">Kettle reviews</a>';`);
 await install(true);
 await win.webContents.executeJavaScript(`document.addEventListener('click',event=>{if(!event.isTrusted)event.preventDefault()});`);
 await win.webContents.executeJavaScript(`document.getElementById('result').dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}))`);
 assert.equal(await win.webContents.executeJavaScript(`reviewMessages.length`),0,'synthetic search clicks cannot mint permission');
 win.webContents.sendInputEvent({type:'mouseDown',x:40,y:40,button:'left',clickCount:1});
 win.webContents.sendInputEvent({type:'mouseUp',x:40,y:40,button:'left',clickCount:1});
 await wait(150);
 assert.equal(await win.webContents.executeJavaScript(`reviewMessages.some(message=>message.action==='open' && message.url===${JSON.stringify(post)})`),true,'trusted search-result clicks ask the background to open the exact post');
 await win.webContents.executeJavaScript(`document.getElementById('result').href='https://www.google.com/goto?opaque=result'`);
 win.webContents.sendInputEvent({type:'mouseDown',x:40,y:40,button:'left',clickCount:1});
 win.webContents.sendInputEvent({type:'mouseUp',x:40,y:40,button:'left',clickCount:1});
 await wait(100);
 assert.equal(await win.webContents.executeJavaScript(`reviewMessages.at(-1).url`),'https://www.google.com/goto?opaque=result','actual Google redirect clicks reach the background');
 const count = await win.webContents.executeJavaScript(`reviewMessages.length`);
 for (const destination of ['https://www.reddit.com/', 'https://www.reddit.com/r/reviews/', 'https://www.google.com/url?q=https%3A%2F%2Fwww.reddit.com%2F', 'https://duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.reddit.com%2Fr%2Freviews%2F']) {
  await win.webContents.executeJavaScript(`document.getElementById('result').href=${JSON.stringify(destination)}`);
  win.webContents.sendInputEvent({type:'mouseDown',x:40,y:40,button:'left',clickCount:1});
  win.webContents.sendInputEvent({type:'mouseUp',x:40,y:40,button:'left',clickCount:1});
  await wait(100);
  assert.equal(win.webContents.getURL(),'https://www.google.com/search?q=kettle+reddit','direct and wrapped feed clicks leave the search page in place');
  assert.equal(await win.webContents.executeJavaScript(`reviewMessages.length`),count,'feed clicks never start a redirect or download');
 }
 console.log('Reddit reader Chromium checks passed: inert author context, thread styling, safety-hidden content, concealed permission check, readable post/comments, hidden browsing UI, immediate social-control blocking, shadow DOM, SPA denial and trusted external clicks.');
 win.destroy(); app.quit();
}
void main().catch(error=>{console.error(error);app.exit(1)});
