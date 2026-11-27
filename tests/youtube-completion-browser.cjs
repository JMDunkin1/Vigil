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
  let accountProgress = [];
  await win.webContents.session.protocol.handle('https', request => {
    const url = new URL(request.url);
    const path = url.pathname;
    if (url.hostname === 'i.ytimg.com') {
      return new Response(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jA1sAAAAASUVORK5CYII=', 'base64'), {
        headers: { 'Content-Type': 'image/png' }
      });
    }
    const playlist = { contents: { playlistVideoListRenderer: { playlistId: 'WL', contents: slots.filter(Boolean).map((slot, index) => ({
      playlistVideoRenderer: { videoId: slot.videoId, title: { simpleText: slot.title },
        ...(index === 0 ? { thumbnailOverlays: [{ thumbnailOverlayResumePlaybackRenderer: { percentDurationWatched: accountProgress[index] } }] }
          : { thumbnail: { thumbnailViewModel: { overlays: [{ thumbnailBottomOverlayViewModel: {
            progressBar: { thumbnailOverlayProgressBarViewModel: { startPercent: accountProgress[index] } }
          } }] } } })
      }
    })) } } };
    if (path === '/playlist') return new Response('ytcfg.set({"LOGGED_IN":true,"DATASYNC_ID":"fixture","INNERTUBE_CONTEXT":{"client":{}}});var ytInitialData=' + JSON.stringify(playlist) + ';');
    if (path === '/youtubei/v1/browse') return Response.json(playlist);
    return new Response(`<!doctype html><html><body>
    <style>ytd-app{--yt-spec-base-background:#0f0f0f;--yt-spec-text-primary:#f1f1f1;--yt-spec-text-secondary:#aaa;--yt-spec-raised-background:#212121;--yt-spec-badge-chip-background:#272727}section{background:white;color:black}body{margin:0;background:#0f0f0f;color:white}ytd-masthead{display:block;position:fixed;height:56px;top:0;left:0;width:100%;z-index:10}#start{height:56px}#background,#frosted-glass{position:absolute;inset:0;height:112px;background:#222}#start{position:relative;z-index:1}ytd-rich-grid-renderer{display:grid;grid-template-columns:repeat(3,1fr);padding-top:56px}ytd-rich-item-renderer{display:block;height:120px}#header{height:56px}ytd-rich-item-renderer img{height:90px;width:160px}ytd-watch-next-secondary-results-renderer{display:block}</style>
    <ytd-app><ytd-masthead><div id="background"></div><div id="frosted-glass"></div><div id="start">YouTube</div></ytd-masthead><ytd-page-manager><ytd-rich-grid-renderer><div id="header">Topics</div>
    ${ids.map(id=>`<ytd-rich-item-renderer><ytd-rich-grid-media><a href="/watch?v=${id}"><img src="data:,"><h3>Title ${id}</h3></a></ytd-rich-grid-media></ytd-rich-item-renderer>`).join('')}
    </ytd-rich-grid-renderer><ytd-watch-next-secondary-results-renderer id="related">Other videos</ytd-watch-next-secondary-results-renderer><video></video></ytd-page-manager></ytd-app></body></html>`,{headers:{'content-type':'text/html'}});
  });
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
    accountProgress=[];
    win.setSize(native ? 390 : 1200, native ? 844 : 850);
    await win.loadURL('https://www.youtube.com/'); await install(native);
    assert.equal(await win.webContents.executeJavaScript(`getComputedStyle(document.getElementById('frosted-glass')).height`),'56px');
    assert.equal(await win.webContents.executeJavaScript(`getComputedStyle(document.getElementById('header')).display`),'none');
    assert.equal(await win.webContents.executeJavaScript(`[...document.querySelectorAll('ytd-rich-item-renderer')].filter(node=>getComputedStyle(node).display!=='none').length`),18, JSON.stringify(await win.webContents.executeJavaScript(`({requests:__testRequests,attrs:document.documentElement.outerHTML.slice(0,200),card:document.querySelector('ytd-rich-item-renderer').outerHTML})`)));
    assert.equal(await win.webContents.executeJavaScript(`__testRequests.some(body=>body.action==='feed')`),false,'a feed refresh never changes the daily ledger');
    const nativeThumbnails = () => win.webContents.executeJavaScript(`[...document.querySelectorAll('ytd-rich-grid-media > a img')].slice(0,3).map(image=>getComputedStyle(image).filter)`);
    await win.webContents.executeJavaScript(`[...document.querySelectorAll('ytd-rich-grid-media > a')].slice(0,2).forEach((link,index)=>{
      link.id='thumbnail';
      link.insertAdjacentHTML('beforeend',index===0
        ? '<ytd-thumbnail-overlay-resume-playback-renderer><i id="progress" style="width:100%"></i></ytd-thumbnail-overlay-resume-playback-renderer>'
        : '<yt-thumbnail-view-model><div class="ytThumbnailOverlayProgressBarHostWatchedProgressBar"></div></yt-thumbnail-view-model>');
    });`);
    await wait(600);
    assert.deepEqual(await nativeThumbnails(),['brightness(0)','none','none']);
    assert.equal(await win.webContents.executeJavaScript(`getComputedStyle(document.querySelector('[data-vigil-native-progress="in-progress"]'),'::after').content`),'"In progress"');
    await win.webContents.executeJavaScript(`document.querySelector('ytd-thumbnail-overlay-resume-playback-renderer').remove();`);
    await wait(600);
    assert.deepEqual(await nativeThumbnails(),['none','none','none']);
    // Drive the normal status transport with the mounted handler's next response.
    slots=ids.slice(0,4).map(videoId=>({videoId,title:['The science of building better habits','How a tiny team built something remarkable','A closer look at the world around us','The ideas worth taking your time with'][ids.indexOf(videoId)],locked:false,removed:false}));
    await win.webContents.executeJavaScript(`__testReply=${JSON.stringify(status())}; window.postMessage({type:'VIGIL_YOUTUBE_REPLY'},location.origin);`);
    // A route change triggers prepare/check and delivers the current ledger immediately.
    await win.webContents.executeJavaScript(`history.pushState({},'', '/watch?v=other000001')`); await wait(750);
    assert.equal(await win.webContents.executeJavaScript(`document.documentElement.hasAttribute('data-vigil-saves-finished')`),true);
    assert.equal(await win.webContents.executeJavaScript(`getComputedStyle(document.querySelector('ytd-app')).display`),'none','all discovery UI disappears');
    const complete = await win.webContents.executeJavaScript(`(()=>{const root=testShadows.get(document.getElementById('vigil-youtube-finished'));return {heading:root.querySelector('h1').textContent,links:[...root.querySelectorAll('a')].map(a=>a.href),images:[...root.querySelectorAll('img')].map(img=>[img.src,img.naturalWidth]),titles:[...root.querySelectorAll('.title')].map(title=>title.textContent)}})()`);
    assert.equal(complete.heading,'Today’s saved videos');
    assert.equal(complete.links.length,4);
    assert.deepEqual(complete.images,slots.map(slot=>[`https://i.ytimg.com/vi/${slot.videoId}/mqdefault.jpg`,1]));
    assert.deepEqual(complete.titles,slots.map(slot=>slot.title));
    accountProgress=[100,42,0,101];
    await win.webContents.executeJavaScript(`window.dispatchEvent(new Event('focus'))`);
    await wait(650);
    const savedThumbnailStates = await win.webContents.executeJavaScript(`[...testShadows.get(document.getElementById('vigil-youtube-finished')).querySelectorAll('a.card')].map(card=>[
      new URL(card.href).searchParams.get('v'), !!card.querySelector('img'), getComputedStyle(card.querySelector('.poster')).backgroundColor, card.querySelector('.card-status')?.textContent || ''
    ])`);
    assert.deepEqual(savedThumbnailStates, [
      [ids[0], false, 'rgb(0, 0, 0)', 'Watched'], [ids[1], true, 'rgb(33, 33, 33)', 'In progress'],
      [ids[2], true, 'rgb(33, 33, 33)', ''], [ids[3], true, 'rgb(33, 33, 33)', '']
    ], 'account progress changes the card appearance while keeping its playback link');
    const appearance = await win.webContents.executeJavaScript(`(()=>{const host=document.getElementById('vigil-youtube-finished'),root=testShadows.get(host),main=root.querySelector('main');window.fixtureEntrance=main.getAnimations()[0];return {background:getComputedStyle(host).backgroundColor,text:getComputedStyle(main).color,entry:getComputedStyle(root.querySelector('a')).backgroundColor,animation:getComputedStyle(main).animationName}})()`);
    assert.equal(appearance.background,'rgb(15, 15, 15)','native theme wins over the page’s white section styling');
    assert.equal(appearance.text,'rgb(241, 241, 241)');
    assert.equal(appearance.entry,'rgba(0, 0, 0, 0)');
    assert.equal(appearance.animation,'vigil-content-in');
    await win.webContents.executeJavaScript(`__testReply.slots[0].locked=false; history.pushState({},'', '/watch?v=other000002')`);
    await wait(750);
    assert.equal(await win.webContents.executeJavaScript(`testShadows.get(document.getElementById('vigil-youtube-finished')).querySelector('main').getAnimations()[0]===window.fixtureEntrance`),true,'playback metadata and allowance polling do not replay the entrance animation');
    fs.writeFileSync(`/tmp/vigil-youtube-saved-${native?'phone':'desktop'}.png`,(await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript(`document.querySelector('ytd-app').style.cssText='--yt-spec-base-background:#fff;--yt-spec-text-primary:#0f0f0f;--yt-spec-text-secondary:#606060;--yt-spec-raised-background:#f2f2f2'`);
    await wait(600);
    assert.equal(await win.webContents.executeJavaScript(`getComputedStyle(document.getElementById('vigil-youtube-finished')).backgroundColor`),'rgb(255, 255, 255)','theme changes follow YouTube without rebuilding the menu');
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    assert.equal(await win.webContents.executeJavaScript(`getComputedStyle(testShadows.get(document.getElementById('vigil-youtube-finished')).querySelector('main')).animationName`),'none','reduced motion is respected');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[]});
    win.webContents.debugger.detach();

    await win.webContents.executeJavaScript(`history.pushState({},'', '/@channel')`); await wait(600);
    assert.equal(await win.webContents.executeJavaScript(`document.documentElement.hasAttribute('data-vigil-saves-finished')`),true,'channel browsing remains closed');
    await win.webContents.executeJavaScript(`history.pushState({},'', '/watch?v=${ids[0]}')`); await wait(600);
    assert.equal(await win.webContents.executeJavaScript(`document.documentElement.hasAttribute('data-vigil-saves-finished')`),false,'saved watch pages remain available');
    assert.equal(await win.webContents.executeJavaScript(`getComputedStyle(document.getElementById('related')).display`),'none','saved playback does not expose a recommendation feed');
    await win.webContents.executeJavaScript(`history.pushState({},'', '/watch?v=external001')`); await wait(600);
    assert.equal(await win.webContents.executeJavaScript(`document.documentElement.hasAttribute('data-vigil-saves-finished')`),false,'verified external videos remain usable');

    const refresh = async (changes, route) => {
      await win.webContents.executeJavaScript(`Object.assign(__testReply,${JSON.stringify(changes)}); history.pushState({},'',${JSON.stringify(route)})`);
      await wait(750);
    };
    const screen = () => win.webContents.executeJavaScript(`(()=>{
      const host=document.getElementById('vigil-youtube-finished'),root=testShadows.get(host),heading=root.querySelector('h1');
      const message=root.querySelector('.finished-message'),headingBox=heading.getBoundingClientRect();
      return {hidden:host.hidden,heading:heading.textContent,links:[...root.querySelectorAll('a')].map(a=>a.href),
        cards:[...root.querySelectorAll('.card')].map(card=>{
          const box=card.getBoundingClientRect(),poster=card.querySelector('.poster');
          return {title:card.querySelector('.title').textContent,status:card.querySelector('.card-status')?.textContent,
            photo:!!poster.querySelector('img'),background:getComputedStyle(poster).backgroundColor,box:[box.x,box.y,box.width,box.height]};
        }),centered:!!message && Math.abs(headingBox.y+headingBox.height/2-innerHeight/2)<1,opacity:getComputedStyle(host).opacity};
    })()`);
    await refresh({},'/watch?v=other000006');
    const before = await screen();
    if (native) {
      const [first, second] = before.cards.map(card => card.box);
      assert.equal(first[0],0,'mobile thumbnails reach the viewport edge');
      assert.equal(second[1],first[1]+first[3],'no spacer between mobile cards');
    }
    const completed = slots.map((slot,index)=>({...slot,completed:index===0}));
    await refresh({slots:completed},'/watch?v=other000003');
    const partial = await screen();
    assert.equal(partial.links.length,3,'only unwatched cards remain playable');
    assert.deepEqual(partial.cards.map(card=>card.box),before.cards.map(card=>card.box),'completion keeps the grid geometry');
    assert.equal(partial.cards[0].status,'Watched');
    assert.equal(partial.cards[0].photo,false);
    assert.equal(partial.cards[0].background,'rgb(0, 0, 0)');
    assert.equal(partial.cards[1].photo,true);
    await refresh({},`/watch?v=${ids[0]}`);
    assert.equal((await screen()).hidden,false,'a cached successful check cannot reopen a completed saved video');
    await refresh({slots:completed.map(slot=>({...slot,completed:true}))},'/watch?v=other000004');
    const done = await screen();
    assert.equal(done.heading,'You’ve watched all your saved videos for today.');
    assert.equal(done.centered,true);
    assert.equal(done.links.length,0);
    assert.deepEqual(done.cards.map(card=>card.status),Array(4).fill('Watched'));
    assert.ok(done.cards.every(card=>!card.photo && card.background==='rgb(0, 0, 0)'));
    assert.deepEqual(done.cards.map(card=>card.box),before.cards.map(card=>card.box));
    assert.deepEqual(done.cards.map(card=>card.title),slots.map(slot=>slot.title));
    assert.equal(done.opacity,'1','the opaque surface never reveals the underlying feed during entrance');
    for (const saved of [slots, [slots[0],null,null,null]]) {
      await refresh({slots:saved,usedMs:7200000,grace:{status:'ended',videoId:ids[0],usedMs:1200000}},`/watch?v=${ids[1]}`);
      const timed = await screen();
      assert.match(timed.heading,/run out of watch time/);
      assert.equal(timed.hidden,false);
      assert.equal(timed.links.length,0,'time exhaustion hides even unwatched saved videos before all slots fill');
      await refresh({},'/watch?v=external001');
      assert.equal((await screen()).hidden,false,'time exhaustion also closes verified external watch pages');
    }
    await refresh({slots,grace:{status:'active',videoId:ids[0],usedMs:1000}},`/watch?v=${ids[0]}`);
    assert.equal((await screen()).hidden,true,'the established finish-current-video grace remains available');
    await refresh({},`/watch?v=${ids[1]}`);
    assert.equal((await screen()).links.length,0,'grace never offers other saved videos');

    // Exercise a real first click/tap, including a YouTube delegated click
    // handler that tries to consume the retargeted shadow-host event.
    await refresh({usedMs:0,grace:{status:'unused',videoId:null,usedMs:0}},'/watch?v=other000005');
    await win.webContents.executeJavaScript(`document.addEventListener('click',event=>{if(event.target.id==='vigil-youtube-finished')event.preventDefault();});`);
    if (native) await win.webContents.executeJavaScript(`document.addEventListener('touchend',event=>event.preventDefault(),{passive:false});`);
    const point = await win.webContents.executeJavaScript(`(()=>{const rect=testShadows.get(document.getElementById('vigil-youtube-finished')).querySelector('a').getBoundingClientRect();return {x:Math.round(rect.x+rect.width/2),y:Math.round(rect.y+rect.height/2)}})()`);
    const navigated = new Promise(resolve=>win.webContents.once('did-finish-load',resolve));
    if (native) {
      win.webContents.debugger.attach('1.3');
      await win.webContents.debugger.sendCommand('Emulation.setTouchEmulationEnabled',{enabled:true});
      await win.webContents.debugger.sendCommand('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point]});
      await win.webContents.debugger.sendCommand('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    } else {
      win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});
      win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});
    }
    await Promise.race([navigated,wait(3000).then(()=>{throw new Error('First saved-video activation did not navigate');})]);
    assert.equal(new URL(win.webContents.getURL()).searchParams.get('v'),ids[0],'one activation opens the selected saved video');
    if(native) win.webContents.debugger.detach();
  }
  console.log('YouTube browser checks passed: 18-video feed, collapsed header backdrop, completion states, single-click/tap navigation, stable animation, saved playback, hidden recommendations, and external links on web and app.');
  win.destroy(); app.quit();
}
void main().catch(error=>{console.error(error);app.exit(1)});
