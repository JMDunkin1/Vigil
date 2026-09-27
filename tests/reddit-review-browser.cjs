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
 <shreddit-post id="t3_abc123" permalink="${post}"><h1>Kettle review</h1><p id="post-text">This kettle lasted five years.</p></shreddit-post>
 <div id="comments"><p id="comment">Mine is still working.</p><button id="more">More replies</button><button id="reply">Reply</button><textarea></textarea>
 <a id="permalink" href="${post}ghi789/?context=3">Comment link</a>
 <a id="another" href="${other}">Another Reddit post</a><a id="external" href="https://manufacturer.example/">Specifications</a></div>
 <shreddit-post id="t3_def456" permalink="${other}"><h2>Recommended post</h2><img src="data:,"></shreddit-post>
 <div id="shadow-host"></div></body></html>`,{headers:{'content-type':'text/html'}}));
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
 await win.webContents.executeJavaScript(`window.siteClicks=0; document.addEventListener('click',()=>siteClicks++); document.getElementById('another').click(); document.getElementById('reply').click();`);
 assert.equal(await win.webContents.executeJavaScript('siteClicks'),0,'hidden links and social controls remain inert');
 await win.webContents.executeJavaScript(`document.getElementById('comments').insertAdjacentHTML('beforeend','<button id="late-upvote" aria-label="Upvote">▲</button>'); document.getElementById('late-upvote').click();`);
 assert.equal(await win.webContents.executeJavaScript('siteClicks'),0,'new voting controls are blocked before observation');
 await win.webContents.executeJavaScript(`document.getElementById('more').click()`);
 assert.equal(await win.webContents.executeJavaScript('siteClicks'),1,'comment expansion remains usable');
 await win.webContents.executeJavaScript(`document.getElementById('shadow-host').attachShadow({mode:'open'}).innerHTML='<aside id="shadow-feed">Feed</aside><p id="shadow-comment">A helpful comment</p><a id="shadow-link" href="${other}">Other post</a>';`);
 await wait(1100);
 assert.deepEqual(await win.webContents.executeJavaScript(`['shadow-feed','shadow-comment','shadow-link'].map(id=>getComputedStyle(document.getElementById('shadow-host').shadowRoot.getElementById(id)).display==='none')`),[true,false,true]);
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
 await win.webContents.executeJavaScript(`document.getElementById('result').href='https://www.reddit.com/'`);
 win.webContents.sendInputEvent({type:'mouseDown',x:40,y:40,button:'left',clickCount:1});
 win.webContents.sendInputEvent({type:'mouseUp',x:40,y:40,button:'left',clickCount:1});
 await wait(100);
 assert.equal(win.webContents.getURL(),'https://www.google.com/search?q=kettle+reddit','accidental Reddit homepage clicks leave the search page in place');
 assert.equal(await win.webContents.executeJavaScript(`reviewMessages.length`),count,'homepage clicks produce no notice');
 console.log('Reddit reader Chromium checks passed: concealed permission check, readable post/comments, hidden browsing UI, immediate social-control blocking, shadow DOM, SPA denial and trusted external clicks.');
 win.destroy(); app.quit();
}
void main().catch(error=>{console.error(error);app.exit(1)});
