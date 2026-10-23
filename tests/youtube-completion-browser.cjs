const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const source = fs.readFileSync('dist/runtime/extension/youtube-limits.js', 'utf8');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const ids = Array.from({length: 25}, (_, i) => `video${String(i).padStart(6, '0')}`);
async function main() {
  await app.whenReady();
  const win = new BrowserWindow({show:false, width:1200, height:850, webPreferences:{sandbox:true}});
  let slots = [];
  await win.webContents.session.protocol.handle('https', () => new Response(`<!doctype html><html><body>
    <style>body{margin:0;background:#0f0f0f;color:white}ytd-masthead{display:block;position:fixed;height:56px;top:0;left:0;width:100%;z-index:10}#start{height:56px}#background,#frosted-glass{position:absolute;inset:0;height:112px;background:#222}#start{position:relative;z-index:1}ytd-rich-grid-renderer{display:grid;grid-template-columns:repeat(3,1fr);padding-top:56px}ytd-rich-item-renderer{display:block;height:120px}#header{height:56px}ytd-rich-item-renderer img{height:90px;width:160px}ytd-watch-next-secondary-results-renderer{display:block}</style>
    <ytd-app><ytd-masthead><div id="background"></div><div id="frosted-glass"></div><div id="start">YouTube</div></ytd-masthead><ytd-page-manager><ytd-rich-grid-renderer><div id="header">Topics</div>
    ${ids.map(id=>`<ytd-rich-item-renderer><ytd-rich-grid-media><a href="/watch?v=${id}"><img src="data:,"><h3>Title ${id}</h3></a></ytd-rich-grid-media></ytd-rich-item-renderer>`).join('')}
    </ytd-rich-grid-renderer><ytd-watch-next-secondary-results-renderer id="related">Other videos</ytd-watch-next-secondary-results-renderer><video></video></ytd-page-manager></ytd-app></body></html>`,{headers:{'content-type':'text/html'}}));
  // Exercise compatibility with a live Mac companion predating external metadata.
  const status = () => ({ok:true,day:'2026-10-23',slots,usedMs:0,grace:{status:'unused',usedMs:0},feeds:{home:ids.slice().reverse().slice(0,20).map(videoId=>({videoId}))},serverTime:Date.now()});
  win.webContents.on('console-message', event => { if (/Error/.test(event.message)) console.log(event.message); });
  const install = async native => {
    await win.webContents.executeJavaScript(`window.testShadows=new Map(); const attach=Element.prototype.attachShadow; Element.prototype.attachShadow=function(options){const root=attach.call(this,options);testShadows.set(this,root);return root;}; void 0;`);
    await win.webContents.executeJavaScript(`window.__testReply=${JSON.stringify(status())}; window.__testRequests=[]; const reply=body=>{__testRequests.push(body);const result={...__testReply,serverTime:Date.now()};if(body.action==='check'&&!result.slots.some(slot=>slot?.videoId===body.videoId&&!slot.removed)&&body.videoId!=='external001'){result.ok=false;result.message='Save this video to Watch Later before playing.';}return Promise.resolve(result)}; ${native ? 'window.webkit={messageHandlers:{vigilYouTube:{postMessage:envelope=>reply(envelope.body)}}};window.__vigilYouTubeInitialStatus=__testReply;' : 'window.chrome={runtime:{sendMessage:message=>reply(message.youtube)}};'} void 0;`);
    await win.webContents.executeJavaScript(source + "\nvoid 0;");
    await wait(650);
  };
  for (const native of [false,true]) {
    slots=[];
    await win.loadURL('https://www.youtube.com/'); await install(native);
    assert.equal(await win.webContents.executeJavaScript(`getComputedStyle(document.getElementById('frosted-glass')).height`),'56px');
    assert.equal(await win.webContents.executeJavaScript(`getComputedStyle(document.getElementById('header')).display`),'none');
    assert.equal(await win.webContents.executeJavaScript(`[...document.querySelectorAll('ytd-rich-item-renderer')].filter(node=>getComputedStyle(node).display!=='none').length`),20, JSON.stringify(await win.webContents.executeJavaScript(`({requests:__testRequests,attrs:document.documentElement.outerHTML.slice(0,200),card:document.querySelector('ytd-rich-item-renderer').outerHTML})`)));
    assert.equal(await win.webContents.executeJavaScript(`__testRequests.some(body=>body.action==='feed')`),false,'a feed refresh never changes the daily ledger');
    // Drive the normal status transport with the mounted handler's next response.
    slots=ids.slice(0,4).map(videoId=>({videoId,title:`Saved ${videoId}`,locked:true,removed:false}));
    await win.webContents.executeJavaScript(`__testReply=${JSON.stringify(status())}; window.postMessage({type:'VIGIL_YOUTUBE_REPLY'},location.origin);`);
    // A route change triggers prepare/check and delivers the current ledger immediately.
    await win.webContents.executeJavaScript(`history.pushState({},'', '/watch?v=other000001')`); await wait(750);
    assert.equal(await win.webContents.executeJavaScript(`document.documentElement.hasAttribute('data-vigil-saves-finished')`),true);
    assert.equal(await win.webContents.executeJavaScript(`getComputedStyle(document.querySelector('ytd-app')).display`),'none','all discovery UI disappears');
    const complete = await win.webContents.executeJavaScript(`(()=>{const root=testShadows.get(document.getElementById('vigil-youtube-finished'));return {text:root.textContent,links:[...root.querySelectorAll('a')].map(a=>a.href),images:root.querySelectorAll('img').length}})()`);
    assert.match(complete.text,/saved all four videos today/); assert.equal(complete.links.length,4); assert.equal(complete.images,0);
    await win.webContents.executeJavaScript(`history.pushState({},'', '/@channel')`); await wait(600);
    assert.equal(await win.webContents.executeJavaScript(`document.documentElement.hasAttribute('data-vigil-saves-finished')`),true,'channel browsing remains closed');
    await win.webContents.executeJavaScript(`history.pushState({},'', '/watch?v=${ids[0]}')`); await wait(600);
    assert.equal(await win.webContents.executeJavaScript(`document.documentElement.hasAttribute('data-vigil-saves-finished')`),false,'saved watch pages remain available');
    assert.equal(await win.webContents.executeJavaScript(`getComputedStyle(document.getElementById('related')).display`),'none','saved playback does not expose a recommendation feed');
    await win.webContents.executeJavaScript(`history.pushState({},'', '/watch?v=external001')`); await wait(600);
    assert.equal(await win.webContents.executeJavaScript(`document.documentElement.hasAttribute('data-vigil-saves-finished')`),false,'verified external videos remain usable');
  }
  console.log('YouTube browser checks passed: fresh twenty, collapsed header backdrop, completion screen, saved playback, hidden recommendations, and external links on web and app.');
  win.destroy(); app.quit();
}
void main().catch(error=>{console.error(error);app.exit(1)});
