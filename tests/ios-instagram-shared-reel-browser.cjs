// Run with: node_modules/.bin/electron tests/ios-instagram-shared-reel-browser.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const source = fs.readFileSync('ios/VigilSocial/VigilSocial/DOMAdapters.swift', 'utf8');
const guard = source.match(/static let instagramSingleReelGuard = #"""([\s\S]*?)"""#/)[1];

async function main() {
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 390, height: 844, webPreferences: { sandbox: true } });
  win.webContents.session.protocol.handle('https', request => new URL(request.url).pathname.endsWith('.svg')
    ? new Response('<svg xmlns="http://www.w3.org/2000/svg" width="390" height="700"><rect width="390" height="700" fill="purple"/></svg>', {
      headers: { 'content-type': 'image/svg+xml' }
    })
    : new Response('<!doctype html><html><body></body></html>', {
      headers: { 'content-type': 'text/html' }
    }));
  const run = async code => {
    const result = await win.webContents.executeJavaScript(code);
    await win.webContents.executeJavaScript('new Promise(resolve => setTimeout(resolve, 0))');
    return result;
  };
  for (const path of ['/p/Shared123/']) {
    await win.loadURL(`https://www.instagram.com${path}`);
    await run(guard);
    await run(`document.body.innerHTML = ${JSON.stringify(`
      <style>body{margin:0} main{height:812px;overflow-y:auto} article,video{display:block;width:390px;height:700px}</style>
      <main id="stack">
        <article id="shared-card"><a href="${path}"><video id="shared" src="/original.mp4"></video></a><img id="poster" src="/poster.svg" style="position:absolute;top:0;width:390px;height:600px"></article>
        <article><video id="suggested" src="/suggested.mp4"></video></article>
        <button id="next" aria-label="Next reel">Next</button>
        <button id="like">Like</button><button id="back">Back</button>
        <div data-vigil-instagram-comments-sheet="true"><textarea id="comment"></textarea></div>
      </main>`)};
      window.starts = 0; window.releases = 0; window.clicks = 0;
      for (const type of ['pointerdown', 'touchstart', 'mousedown', 'contextmenu']) {
        document.getElementById('shared').addEventListener(type, () => {
          window.starts++;
          // Model a hold listener that starts loading a recommendation without
          // changing the permalink or waiting for vertical movement.
          document.getElementById('shared').src = '/suggested.mp4';
        });
      }
      for (const type of ['pointerup', 'touchend', 'mouseup']) {
        document.getElementById('shared').addEventListener(type, () => window.releases++);
      }
      document.getElementById('shared').addEventListener('click', () => window.clicks++);
    `);
    const state = await run(`(() => {
      const media = document.getElementById('shared');
      const fire = (target, type, y = 300) => {
        const event = type.startsWith('pointer')
          ? new PointerEvent(type, { bubbles:true, cancelable:true, pointerType:'touch', clientX:100, clientY:y })
          : new Event(type, { bubbles:true, cancelable:true });
        if (type.startsWith('touch')) Object.defineProperty(event, 'touches', {
          value: type === 'touchend' ? [] : [{clientX:100,clientY:y}]
        });
        target.dispatchEvent(event);
        return event.defaultPrevented;
      };
      fire(media, 'pointerdown'); fire(media, 'pointerup');
      fire(media, 'touchstart'); fire(media, 'touchend');
      fire(media, 'mousedown'); fire(media, 'mouseup');
      const menuBlocked = fire(media, 'contextmenu');
      fire(media, 'click');
      fire(media, 'pointerdown');
      const swipeBlocked = fire(media, 'pointermove', 100);
      fire(media, 'pointerup', 100);
      let controls = 0;
      for (const id of ['like','back','comment']) {
        const control = document.getElementById(id);
        control.addEventListener('pointerdown', () => controls++);
        fire(control, 'pointerdown'); fire(control, 'pointerup');
      }
      const nextBlocked = fire(document.getElementById('next'), 'pointerdown');
      const stack = document.getElementById('stack');
      stack.scrollTop = 400;
      stack.dispatchEvent(new Event('scroll', {bubbles:true}));
      history.pushState({}, '', '/reel/Other456/');
      return { starts, releases, clicks, menuBlocked, swipeBlocked, controls, nextBlocked,
        path:location.pathname, source:media.getAttribute('src'),
        visible:getComputedStyle(media).visibility,
        suggested:getComputedStyle(document.getElementById('suggested')).visibility,
        scrollLocked: stack.scrollTop === 0 && getComputedStyle(stack).overflowY === 'hidden' };
    })()`);
    assert.deepEqual(state, {
      starts:0, releases:0, clicks:1, menuBlocked:true, swipeBlocked:true, controls:3, nextBlocked:true,
      path, source:'/original.mp4', visible:'visible', suggested:'hidden', scrollLocked:true
    }, path);
    assert.deepEqual(await run(`(() => {
      const media = document.getElementById('shared');
      window.pauseCalls = 0;
      media.pause = () => window.pauseCalls++;
      Object.defineProperty(media, 'paused', { configurable:true, get:() => false });
      media.src = '/suggested.mp4';
      media.dispatchEvent(new Event('loadedmetadata'));
      return { allowed: media.dataset.vigilSingleReelMedia,
        visible: getComputedStyle(media).visibility,
        card: document.getElementById('shared-card').dataset.vigilSingleReelCard,
        pauseCalls };
    })()`), { allowed: 'blocked', visible: 'hidden', card: 'blocked', pauseCalls: 1 },
    `${path}: photo-post protection freezes unrelated media`);
  }
  // Direct keeps its thread mounted under the viewer and may hide a portal
  // ancestor before removing the dialog. Neither transition may hide messages.
  for (const route of ['/direct/t/123/', '/reel/Shared123/']) {
    await win.loadURL(`https://www.instagram.com${route}`);
    await run(guard);
    await run(`document.body.innerHTML = ${JSON.stringify(`
      <style>body{margin:0} video,img{width:390px;height:700px} #portal{position:fixed;inset:0}</style>
      <main id="thread"><article id="message"><a href="/reel/Shared123/"><img src="/poster.svg"></a></article></main>
      <div id="portal"><div role="dialog" id="viewer"><article id="selected"><a href="/reel/Shared123/"><video id="opened" src="/original.mp4"></video></a></article></div></div>
    `)}; history.pushState({}, '', ${JSON.stringify(route)});`);
    assert.equal(await run(`getComputedStyle(document.getElementById('message')).visibility`), 'visible',
      `${route}: viewer containment must not classify the retained Direct thread`);
    await run(`document.getElementById('portal').style.display = 'none'; history.pushState({}, '', '/direct/t/123/');`);
    assert.deepEqual(await run(`({ pinned: document.documentElement.hasAttribute('data-vigil-single-reel'),
      visible: getComputedStyle(document.getElementById('message')).visibility,
      blocked: document.querySelectorAll('[data-vigil-single-reel-card="blocked"]').length })`),
      { pinned: false, visible: 'visible', blocked: 0 }, 'closing a retained viewer releases all chat classifications');
    await run(`document.getElementById('portal').style.display = '';`);
    assert.equal(await run(`getComputedStyle(document.getElementById('opened')).visibility`), 'visible',
      'the same shared reel can be reopened');
  }
  // Inline Direct Reel previews must not activate full-screen containment,
  // hide chat rows, or block scrolling. An explicitly opened viewer should
  // contain gestures and route changes without touching the player or chat.
  await win.loadURL('https://www.instagram.com/direct/t/123/');
  await run(guard);
  await run(`window.__vigilDocumentID='direct-fixture'; window.__vigilNativeScrollLocks=[];
    void Object.defineProperty(window,'webkit',{configurable:true,value:{messageHandlers:{vigil:{
      postMessage: payload => window.__vigilNativeScrollLocks.push(payload)
    }}}});`);
  await run(`document.body.innerHTML = ${JSON.stringify(`
    <style>body{margin:0} img,video{display:block;width:300px;height:500px}#opened{width:390px;height:780px}#portal{position:fixed;inset:0}</style>
    <main id="thread" role="dialog" aria-modal="true">
      <article id="message-before"><span>Language barrier be damned</span><a href="/reel/Shared123/"><img src="/poster-before.svg"></a></article>
      <article id="message-after"><a href="/reel/Other456/"><img src="/poster-after.svg"></a><span>Another message</span></article>
    </main>
  `)}; history.pushState({}, '', '/direct/t/123/');`);
  assert.deepEqual(await run(`({ pinned: document.documentElement.hasAttribute('data-vigil-single-reel'),
    before: getComputedStyle(document.getElementById('message-before')).visibility,
    after: getComputedStyle(document.getElementById('message-after')).visibility,
    wheelBlocked: (() => { const e = new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:100});
      document.getElementById('thread').dispatchEvent(e); return e.defaultPrevented; })() })`),
    { pinned: false, before: 'visible', after: 'visible', wheelBlocked: false },
    'inline Reel previews in a Direct thread remain visible and scrollable');
  await run(`(() => { const link=document.getElementById('message-before').querySelector('a');
    link.addEventListener('click',event=>event.preventDefault(),{once:true});
    link.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window})); })()`);
  await run(`const portal = document.createElement('div'); portal.id='portal'; portal.innerHTML =
    '<div role="dialog" aria-modal="true" id="viewer"><article id="selected"><a href="/reel/Shared123/"><video id="opened" src="/original.mp4"></video></a></article><button id="next" aria-label="Next reel">Next</button></div>';
    document.getElementById('thread').append(portal);`);
  assert.equal(await run(`(() => { const e = new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:10});
    document.dispatchEvent(e); return [document.documentElement.hasAttribute('data-vigil-single-reel'), e.defaultPrevented]; })()`)
    .then(value => JSON.stringify(value)), JSON.stringify([true, true]),
    'an explicitly opened full-screen Reel blocks viewer scrolling');
  assert.deepEqual(await run(`window.__vigilNativeScrollLocks.map(message => message.locked)`), [true],
    'opening a shared Reel asks the native WKWebView to disable its scroll view');
  assert.equal(await run(`getComputedStyle(document.documentElement).touchAction`), 'pinch-zoom',
    'an open Reel disables native touch panning while preserving pinch zoom');
  assert.equal(await run(`(() => { const sheet=document.createElement('div');
    sheet.setAttribute('data-vigil-instagram-comments-sheet','true'); document.body.append(sheet);
    return getComputedStyle(document.documentElement).touchAction; })()`), 'auto',
    'the native pan lock yields while an Instagram comments sheet is open');
  assert.equal(await run(`document.querySelector('[data-vigil-instagram-comments-sheet]').remove();
    getComputedStyle(document.documentElement).touchAction`), 'pinch-zoom',
    'closing the comments sheet restores the Reel pan lock');
  assert.deepEqual(await run(`(() => { let nextClicks=0; const next=document.getElementById('next');
    next.addEventListener('click',()=>nextClicks++);
    const e=new MouseEvent('click',{bubbles:true,cancelable:true,view:window}); next.dispatchEvent(e);
    history.pushState({}, '', '/reel/Other456/');
    return { nextBlocked:e.defaultPrevented, nextClicks, path:location.pathname }; })()`),
    { nextBlocked:true, nextClicks:0, path:'/direct/t/123/' },
    'Next Reel controls and recommendations cannot leave the selected shared Reel');
  assert.deepEqual(await run(`(() => { const video = document.getElementById('opened');
    let taps = 0; const presses=[]; video.addEventListener('click',() => taps++);
    for (const type of ['pointerdown','pointerup','touchstart','touchend','mousedown','mouseup']) {
      video.addEventListener(type,()=>presses.push(type));
    }
    const down = new PointerEvent('pointerdown',{bubbles:true,cancelable:true,pointerType:'touch',clientX:100,clientY:600});
    const move = new PointerEvent('pointermove',{bubbles:true,cancelable:true,pointerType:'touch',clientX:100,clientY:200});
    const up = new PointerEvent('pointerup',{bubbles:true,cancelable:true,pointerType:'touch',clientX:100,clientY:200});
    video.dispatchEvent(down); video.dispatchEvent(move); video.dispatchEvent(up);
    const touchStart=new Event('touchstart',{bubbles:true,cancelable:true});
    Object.defineProperty(touchStart,'touches',{value:[{clientX:100,clientY:600}]}); video.dispatchEvent(touchStart);
    const touchEnd=new Event('touchend',{bubbles:true,cancelable:true});
    Object.defineProperty(touchEnd,'touches',{value:[]}); video.dispatchEvent(touchEnd);
    video.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true,view:window}));
    video.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,cancelable:true,view:window}));
    video.closest('a').addEventListener('click',event=>event.preventDefault(),{once:true});
    const tap = new MouseEvent('click',{bubbles:true,cancelable:true,view:window}); video.dispatchEvent(tap);
    video.src='/recycled-player.mp4';
    return { swipeBlocked:move.defaultPrevented, pressEventsReachedPlayer:presses.length,
      tapReachedPlayer:taps===1,
      visible:getComputedStyle(video).visibility, source:video.getAttribute('src'),
      chat:getComputedStyle(document.getElementById('message-before')).visibility }; })()`),
    { swipeBlocked:true, pressEventsReachedPlayer:0, tapReachedPlayer:true,
      visible:'visible', source:'/recycled-player.mp4', chat:'visible' },
    'Reel swipes and hold-start events are contained while taps, recycling, and chat visibility remain intact');
  await run(`history.pushState({}, '', '/reel/Shared123/');
    document.getElementById('portal').style.opacity = '0';
    history.pushState({}, '', '/direct/t/123/');
    document.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:100}));`);
  assert.deepEqual(await run(`({ pinned: document.documentElement.hasAttribute('data-vigil-single-reel'),
    before: getComputedStyle(document.getElementById('message-before')).visibility,
    after: getComputedStyle(document.getElementById('message-after')).visibility,
    touchAction: getComputedStyle(document.documentElement).touchAction,
    wheelBlocked: (() => { const e = new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:100});
      document.getElementById('thread').dispatchEvent(e); return e.defaultPrevented; })() })`),
    { pinned: false, before: 'visible', after: 'visible', touchAction: 'auto', wheelBlocked: false },
    'returning from a closed Reel route must release a retained transparent viewer and restore chat scrolling');
  assert.deepEqual(await run(`window.__vigilNativeScrollLocks.map(message => message.locked)`), [true, false],
    'closing a shared Reel restores native chat scrolling');
  await run(`document.getElementById('portal').style.display = 'none';`);
  assert.deepEqual(await run(`({ pinned: document.documentElement.hasAttribute('data-vigil-single-reel'),
    before: getComputedStyle(document.getElementById('message-before')).visibility,
    after: getComputedStyle(document.getElementById('message-after')).visibility,
    blocked: document.querySelectorAll('[data-vigil-single-reel-card="blocked"]').length })`),
    { pinned: false, before: 'visible', after: 'visible', blocked: 0 },
    'closing a nested Reel viewer releases all Direct message attachments');
  await run(`document.getElementById('portal').style.display = ''; document.getElementById('portal').style.opacity = '1';`);
  await run(`(() => { const link=document.getElementById('message-before').querySelector('a');
    link.addEventListener('click',event=>event.preventDefault(),{once:true});
    link.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window})); })()`);
  assert.equal(await run(`document.documentElement.hasAttribute('data-vigil-single-reel')`), true,
    'reopening a shared Reel reactivates only gesture and route containment');
  await win.loadURL('https://www.instagram.com/reel/Shared123/');
  await run(guard);
  await run(`document.body.innerHTML = '<style>video,img{width:390px;height:700px}</style><main><article id="selected"><a href="/reel/Shared123/"><video id="opened" src="/original.mp4"></video></a><img id="poster" src="/poster.svg"></article><article><video src="/suggested.mp4"></video></article></main>'`);
  await run(`document.body.innerHTML = '<style>video,img{width:390px;height:700px}#poster{position:absolute;inset:0}</style><main><div id="selected"><a href="/reel/Shared123/"><video id="opened" src="/original.mp4"></video></a><img id="poster" src="/poster.svg"></div><div id="suggestion"><video id="suggested" src="/suggested.mp4"></video></div></main>'`);
  assert.deepEqual(await run(`({selected:getComputedStyle(document.getElementById('opened')).visibility,
    media:document.getElementById('opened').dataset.vigilSingleReelMedia || '',
    card:document.getElementById('selected').dataset.vigilSingleReelCard || '',
    suggestion:getComputedStyle(document.getElementById('suggestion')).visibility})`),
    { selected: 'visible', media: '', card: '', suggestion: 'visible' },
    'Reel playback remains visible while Instagram recycles the active player and poster');
  assert.deepEqual(await run(`(() => { const video = document.getElementById('opened');
    const stack = document.querySelector('main'); stack.style.height='500px'; stack.style.overflowY='auto';
    stack.scrollTop=80; stack.dispatchEvent(new Event('scroll',{bubbles:true}));
    const wheel = new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:50}); stack.dispatchEvent(wheel);
    video.src='/recycled-player.mp4';
    return { pinned:document.documentElement.hasAttribute('data-vigil-single-reel'),
      source:video.getAttribute('src'), visible:getComputedStyle(video).visibility,
      scrollTop:stack.scrollTop, wheelBlocked:wheel.defaultPrevented,
      scrollLock:stack.hasAttribute('data-vigil-single-reel-scroll') }; })()`),
    { pinned:true, source:'/recycled-player.mp4', visible:'visible', scrollTop:80, wheelBlocked:true, scrollLock:false },
    'the selected Reel remains visible while wheel movement is contained without locking its scroll ancestors');
  await run(`document.getElementById('poster').src='/poster-hydrated.svg'`);
  assert.equal(await run(`getComputedStyle(document.getElementById('opened')).visibility`), 'visible',
    'poster source replacement keeps the anonymous shared reel visible');
  await run(`document.getElementById('poster').src = '/replacement.svg';`);
  assert.equal(await run(`getComputedStyle(document.getElementById('opened')).visibility`), 'visible',
    'a delayed poster refresh must not veto the unchanged selected video');
  await run(`const selected = document.getElementById('selected');
    const wrapper = document.createElement('div'); selected.before(wrapper); wrapper.append(selected);
    selected.removeAttribute('id'); selected.removeAttribute('role'); selected.outerHTML = selected.outerHTML.replaceAll('article', 'div');`);
  assert.equal(await run(`getComputedStyle(document.getElementById('opened')).visibility`), 'visible',
    'a delayed layout wrapper remount preserves the exact selected video source');
  // Exercise the browser's compositor input, not just cancelable JS events.
  // A root-only touch-action misses nested scrollers and caption/control hits.
  await win.loadURL('https://www.instagram.com/reel/Shared123/');
  await run(guard);
  await run(`document.body.innerHTML = ${JSON.stringify(`
    <style>
      body{margin:0}#stack{height:780px;overflow-y:scroll;scroll-snap-type:y mandatory}
      article{height:780px;scroll-snap-align:start}video{width:390px;height:600px;display:block}
      #caption,#like{display:block;width:390px;height:80px}
    </style>
    <main id="stack"><article>Earlier prefetched item</article>
      <article><video id="opened" muted loop></video><div id="caption">Sent reel caption</div><button id="like">Like</button></article>
      <article>Recommendation</article>
    </main>
  `)}; document.getElementById('stack').scrollTop=780;`);
  assert.deepEqual(await run(`({offset:document.getElementById('stack').scrollTop,
    snap:getComputedStyle(document.getElementById('stack')).scrollSnapType,
    overflow:getComputedStyle(document.getElementById('stack')).overflowY,
    caption:getComputedStyle(document.getElementById('caption')).touchAction,
    button:getComputedStyle(document.getElementById('like')).touchAction})`),
  {offset:780,snap:'y mandatory',overflow:'scroll',caption:'pinch-zoom',button:'pinch-zoom'},
  'the selected item can align before input; nested scroll layout and non-media hit targets stay intact');
  win.webContents.debugger.attach('1.3');
  for (const y of [300, 640, 720]) {
    for (const yDistance of [3, -3, -400, 400]) {
      await win.webContents.debugger.sendCommand('Input.synthesizeScrollGesture', {
        x:200, y, xDistance:0, yDistance, gestureSourceType:'touch'
      });
      assert.equal(await run(`document.getElementById('stack').scrollTop`), 780,
        `trusted ${yDistance}px pull at y=${y} cannot move into a neighbour`);
    }
  }
  // Comments may scroll, but their presence must not unlock the background.
  await run(`document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(`
    <section id="comments" data-vigil-instagram-comments-sheet="true" style="position:fixed;top:400px;left:0;width:390px;height:300px;overflow-y:auto">
      <div style="height:1500px">Comments</div>
    </section>`)});`);
  await win.webContents.debugger.sendCommand('Input.synthesizeScrollGesture', {
    x:200,y:550,xDistance:0,yDistance:-200,gestureSourceType:'touch'
  });
  assert.ok(await run(`document.getElementById('comments').scrollTop > 0`), 'trusted swipes scroll comments');
  await win.webContents.debugger.sendCommand('Input.synthesizeScrollGesture', {
    x:200,y:250,xDistance:0,yDistance:-400,gestureSourceType:'touch'
  });
  assert.equal(await run(`document.getElementById('stack').scrollTop`), 780, 'comments do not unlock the Reel behind them');
  win.webContents.debugger.detach();
  await run(`document.getElementById('comments').remove()`);
  assert.deepEqual(await run(`(() => {
    const caption=document.getElementById('caption');
    caption.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,clientX:100,clientY:640}));
    let siteMoves=0; caption.addEventListener('pointermove',()=>siteMoves++);
    const move=new PointerEvent('pointermove',{bubbles:true,cancelable:true,clientX:100,clientY:639});
    caption.dispatchEvent(move);
    const stack=document.getElementById('stack'); stack.scrollTop=1400;
    stack.dispatchEvent(new Event('scroll'));
    return {tapStillAllowed:!move.defaultPrevented,siteMoves,offset:stack.scrollTop};
  })()`), {tapStillAllowed:true,siteMoves:0,offset:780}, 'a tiny pull cannot reach the viewer or move it, while tap jitter remains usable');
  assert.deepEqual(await run(`(async () => {
    const canvas=document.createElement('canvas');canvas.width=32;canvas.height=32;
    const stream=canvas.captureStream(10), recorder=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8'}), chunks=[];
    recorder.ondataavailable=event=>chunks.push(event.data);
    const done=new Promise(resolve=>recorder.onstop=resolve);recorder.start();
    canvas.getContext('2d').fillRect(0,0,32,32);
    await new Promise(resolve=>setTimeout(resolve,200));recorder.stop();await done;
    stream.getTracks().forEach(track=>track.stop());
    const blob=new Blob(chunks,{type:recorder.mimeType});
    let player=document.getElementById('opened'), guardPauseCalls=0;
    const pause=player.pause.bind(player);player.pause=()=>{guardPauseCalls++;pause();};
    player.src=URL.createObjectURL(blob);await player.play();
    player.src=URL.createObjectURL(blob);await player.play();
    const replacement=player.cloneNode();player.replaceWith(replacement);player=replacement;await player.play();
    const result={playing:!player.paused,visible:getComputedStyle(player).visibility,guardPauseCalls};
    player.pause();return result;
  })()`), {playing:true,visible:'visible',guardPauseCalls:0},
  'real Reel playback survives source rotation and a React player remount without a guard pause or gray-out');
  // No link is present on some Direct previews. Pin a newly opened viewer,
  // without interpreting the already visible full-size chat previews as one.
  for (const kind of ['video', 'img']) {
    await win.loadURL('https://www.instagram.com/direct/t/123/');
    await run(guard);
    await run(`document.body.innerHTML = ${JSON.stringify(`
      <style>body{margin:0}#thread{height:844px;overflow:auto}img{width:390px;height:300px}</style>
      <main id="thread" role="dialog"><button id="preview"><img src="/poster.svg"></button><div style="height:1500px">Messages</div></main>
    `)}; document.getElementById('preview').onclick=()=>{
      const viewer=document.createElement('div'); viewer.id='viewer'; viewer.setAttribute('role','dialog');
      viewer.style='position:fixed;inset:0;overflow-y:auto';
      viewer.innerHTML='<${kind} id="opened" style="width:390px;height:300px" src="/poster.svg"></${kind}><p style="height:1000px">Caption</p>';
      document.body.append(viewer);
    };`);
    assert.equal(await run(`document.documentElement.hasAttribute('data-vigil-single-reel')`), false,
      `${kind}: large inline messages do not pin the chat`);
    await run(`document.getElementById('preview').click()`);
    assert.deepEqual(await run(`(() => {
      const event=new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:100});
      document.getElementById('opened').dispatchEvent(event);
      return {pinned:document.documentElement.hasAttribute('data-vigil-single-reel'),blocked:event.defaultPrevented,
        visible:getComputedStyle(document.getElementById('opened')).visibility};
    })()`), {pinned:true,blocked:true,visible:'visible'}, `${kind}: a landscape share without a link is viewable and contained`);
    await run(`document.getElementById('viewer').hidden=true`);
    assert.equal(await run(`document.documentElement.hasAttribute('data-vigil-single-reel')`), false,
      `${kind}: closing restores the thread`);
  }
  for (const initialSource of ['', 'src="about:blank"']) {
    await win.loadURL('https://www.instagram.com/p/LazyVideo/');
    await run(guard);
    await run(`document.body.innerHTML = ${JSON.stringify(`
      <style>article,video{display:block;width:390px;height:600px}</style>
      <article><a href="/p/LazyVideo/"><video id="lazy" ${initialSource}></video></a></article>`)};`);
    await run(`document.getElementById('lazy').src = '/original.mp4'`);
    assert.equal(await run(`document.getElementById('lazy').dataset.vigilSingleReelMedia`), 'allowed',
      `a selected video hydrates once from ${initialSource || 'missing src'}`);
    await run(`document.getElementById('lazy').src = '/suggested.mp4'`);
    assert.equal(await run(`document.getElementById('lazy').dataset.vigilSingleReelMedia`), 'blocked',
      'a hydrated video freezes its first usable source');
  }
  const mixedCarousel = async (lazy = false) => {
    await win.loadURL('https://www.instagram.com/p/Mixed123/');
    await run(guard);
    // Create real decodable video in Chromium so both original video slides
    // can exercise play(), rather than only dispatching a synthetic play event.
    const videoURLs = await run(`(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 32; canvas.height = 32;
      const context = canvas.getContext('2d');
      const stream = canvas.captureStream(10);
      const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
      const chunks = [];
      recorder.ondataavailable = event => chunks.push(event.data);
      const done = new Promise(resolve => recorder.onstop = resolve);
      recorder.start();
      context.fillStyle = 'purple'; context.fillRect(0, 0, 32, 32);
      await new Promise(resolve => setTimeout(resolve, 200));
      recorder.stop(); await done;
      stream.getTracks().forEach(track => track.stop());
      const blob = new Blob(chunks, { type: recorder.mimeType });
      return [URL.createObjectURL(blob), URL.createObjectURL(blob)];
    })().catch(error => { throw new Error('Video fixture: ' + error.message); })`);
    await run(`document.body.innerHTML = ${JSON.stringify(`
      <style>
        body{margin:0} article{width:390px} #track{display:flex;overflow-x:auto;width:390px;height:600px}
        .slide{position:relative;flex:0 0 390px;width:390px;height:600px}
        .slide video,.slide img{display:block;width:390px;height:600px}
        #poster{position:absolute;inset:0;pointer-events:none}
      </style>
      <main>
        <article id="shared-card"><a href="/p/Mixed123/">Selected post</a>
          <div id="track" aria-roledescription="carousel">
            <div class="slide" id="slide-one"><video id="first" muted loop src="${videoURLs[0]}"></video><img id="poster" src="/poster.svg"></div>
            <div class="slide" id="slide-two"><img id="photo" src="${lazy ? 'about:blank' : '/photo.svg'}"></div>
            <div class="slide" id="slide-three"><video id="third" muted loop ${lazy ? '' : `src="${videoURLs[1]}"`}></video></div>
          </div>
          <button id="next-photo" aria-label="Next photo">Next photo</button>
          <button id="previous-photo" aria-label="Previous photo">Previous photo</button>
        </article>
        <article><a href="/p/Other456/"><video id="suggested" src="/suggested.mp4"></video></a></article>
      </main>`)};
      window.holds = 0; window.nextClicks = 0;
      for (const id of ['first', 'photo', 'third']) {
        for (const type of ['pointerdown', 'touchstart', 'mousedown', 'contextmenu']) {
          document.getElementById(id).addEventListener(type, () => {
            window.holds++;
            document.getElementById('first').src = '/suggested.mp4';
          });
        }
      }
      document.getElementById('next-photo').onclick = () => {
        window.nextClicks++; document.getElementById('track').scrollLeft += 390;
      };
      document.getElementById('previous-photo').onclick = () => {
        document.getElementById('track').scrollLeft -= 390;
      }; void 0;`);
    return videoURLs;
  };
  const carouselState = () => run(`({
    first: document.getElementById('first').dataset.vigilSingleReelMedia,
    third: document.getElementById('third').dataset.vigilSingleReelMedia,
    card: document.getElementById('shared-card').dataset.vigilSingleReelCard,
    holds, nextClicks, path: location.pathname
  })`);
  await mixedCarousel();
  assert.deepEqual(await carouselState(), {
    first: 'allowed', third: 'allowed', card: 'allowed', holds: 0, nextClicks: 0, path: '/p/Mixed123/'
  }, 'distinct original photo/video slides retain their own authorization');
  const gestures = await run(`(() => {
    const media = document.getElementById('first');
    const fire = (type, x = 300, y = 300) => {
      const event = type.startsWith('pointer')
        ? new PointerEvent(type, { bubbles:true, cancelable:true, pointerType:'touch', clientX:x, clientY:y })
        : new Event(type, { bubbles:true, cancelable:true });
      if (type.startsWith('touch')) Object.defineProperty(event, 'touches', {
        value: type === 'touchend' ? [] : [{clientX:x, clientY:y}]
      });
      media.dispatchEvent(event); return event.defaultPrevented;
    };
    fire('pointerdown'); const horizontalPointer = fire('pointermove', 100); fire('pointerup', 100);
    fire('touchstart'); const horizontalTouch = fire('touchmove', 100); fire('touchend', 100);
    fire('mousedown'); fire('mouseup'); const contextmenu = fire('contextmenu');
    fire('pointerdown'); const verticalPointer = fire('pointermove', 300, 100); fire('pointerup', 300, 100);
    fire('touchstart'); const verticalTouch = fire('touchmove', 300, 100); fire('touchend', 300, 100);
    return { horizontalPointer, horizontalTouch, verticalPointer, verticalTouch, contextmenu,
      touchAction: getComputedStyle(media).touchAction, holds };
  })()`);
  assert.deepEqual(gestures, { horizontalPointer: false, horizontalTouch: false,
    verticalPointer: true, verticalTouch: true, contextmenu: true, touchAction: 'pan-x pinch-zoom', holds: 0 },
  'horizontal native panning remains available while holds and vertical advancement are contained');
  // Chromium's trusted input path verifies that propagation containment still
  // leaves the browser's native horizontal carousel scrolling functional.
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Input.synthesizeScrollGesture', {
    x: 200, y: 300, xDistance: -300, yDistance: 0, gestureSourceType: 'touch'
  });
  assert.ok(await run(`document.getElementById('track').scrollLeft > 0`), 'trusted horizontal swipe scrolls the original carousel');
  win.webContents.debugger.detach();
  await run(`document.getElementById('track').scrollLeft = 0`);
  for (const id of ['first', 'third']) {
    if (id === 'third') {
      await run(`document.getElementById('next-photo').click(); document.getElementById('next-photo').click()`);
      assert.equal(await run(`document.getElementById('track').scrollLeft`), 780, 'Next photo reaches the original third slide');
    }
    assert.deepEqual(await run(`(async () => {
      const video = document.getElementById(${JSON.stringify(id)});
      await video.play();
      const state = { playing: !video.paused, allowed: video.dataset.vigilSingleReelMedia,
        visible: getComputedStyle(video).visibility };
      video.pause(); return state;
    })()`), { playing: true, allowed: 'allowed', visible: 'visible' }, `${id}: original carousel video plays`);
  }
  await run(`document.getElementById('previous-photo').click()`);
  assert.equal(await run(`document.getElementById('track').scrollLeft`), 390, 'Previous photo remains usable');
  await run(`document.getElementById('third').src = '/suggested.mp4'`);
  assert.deepEqual(await carouselState(), {
    first: 'allowed', third: 'blocked', card: 'blocked', holds: 0, nextClicks: 2, path: '/p/Mixed123/'
  }, 'a known carousel video node cannot inherit a recommendation source');
  const lazySources = await mixedCarousel(true);
  await run(`document.getElementById('third').src = ${JSON.stringify(lazySources[1])};
    document.getElementById('photo').src = '/photo.svg';`);
  assert.deepEqual(await run(`(async () => {
    const video = document.getElementById('third'); await video.play();
    const state = { allowed: video.dataset.vigilSingleReelMedia, playing: !video.paused,
      card: document.getElementById('shared-card').dataset.vigilSingleReelCard };
    video.pause(); return state;
  })()`), { allowed: 'allowed', playing: true, card: 'allowed' },
  'original empty carousel video and photo shells each acquire their first usable source');
  const recycledSources = await mixedCarousel(true);
  await run(`document.querySelector('#shared-card > a').href = '/p/Other456/'`);
  await run(`document.getElementById('third').src = ${JSON.stringify(recycledSources[1])}`);
  await run(`document.querySelector('#shared-card > a').href = '/p/Mixed123/'`);
  assert.deepEqual(await run(`(async () => {
    const video = document.getElementById('third');
    try { await video.play(); } catch (_) {}
    return { allowed: video.dataset.vigilSingleReelMedia, paused: video.paused };
  })()`), { allowed: 'blocked', paused: true }, 'a recycled post cannot recover permission to hydrate a pending slide');
  await mixedCarousel();
  await run(`document.getElementById('third').outerHTML = document.getElementById('third').outerHTML`);
  assert.deepEqual(await run(`(async () => {
    const video = document.getElementById('third'); await video.play();
    const state = { allowed: video.dataset.vigilSingleReelMedia, playing: !video.paused };
    video.pause(); return state;
  })()`), { allowed: 'allowed', playing: true }, 'an exact-source remount inside its original slide retains playback');
  await run(`document.querySelector('article:last-child').append(document.getElementById('third'))`);
  assert.deepEqual(await run(`(async () => {
    const video = document.getElementById('third');
    try { await video.play(); } catch (_) {}
    return { allowed: video.dataset.vigilSingleReelMedia, paused: video.paused,
      visible: getComputedStyle(video).visibility };
  })()`), { allowed: 'blocked', paused: true, visible: 'hidden' },
  'even an original source cannot play after moving outside the selected post');
  await mixedCarousel();
  await run(`document.getElementById('slide-two').appendChild(document.getElementById('third')); void 0;`);
  assert.deepEqual(await run(`(async () => {
    const video = document.getElementById('third');
    try { await video.play(); } catch (_) {}
    return { allowed: video.dataset.vigilSingleReelMedia, paused: video.paused };
  })()`), { allowed: 'blocked', paused: true }, 'an original source moved into another slide loses playback permission');
  await mixedCarousel();
  await run(`const slide = document.createElement('div'); slide.className = 'slide';
    slide.innerHTML = '<video id="new-slide" src="/suggested.mp4"></video>';
    document.getElementById('track').appendChild(slide); void 0;`);
  assert.equal(await run(`document.getElementById('new-slide').dataset.vigilSingleReelMedia`), 'blocked',
    'a later inserted unknown slide does not acquire carousel permission');
  const photoPage = async initialSource => {
    await win.loadURL('https://www.instagram.com/p/Photo123/');
    await run(guard);
    await run(`document.body.innerHTML = ${JSON.stringify(`
      <style>body{margin:0} article,img{display:block;width:390px;height:700px}</style>
      <main>
        <article id="shared-card"><a id="permalink" href="/p/Photo123/"><img id="shared" ${initialSource}></a></article>
        <article id="other-card"><a href="/p/Other456/"><img id="other" src="/other.svg"></a></article>
      </main>`)};`);
  };
  const loadPhoto = async (attribute, value) => run(`new Promise((resolve, reject) => {
    const image = document.getElementById('shared');
    image.addEventListener('load', () => resolve({ loaded: image.complete, width: image.naturalWidth }), { once: true });
    image.addEventListener('error', () => reject(new Error('Photo fixture failed to load')), { once: true });
    image.setAttribute(${JSON.stringify(attribute)}, ${JSON.stringify(value)});
  })`);
  const photoState = () => run(`({
    shared: getComputedStyle(document.getElementById('shared')).visibility,
    other: getComputedStyle(document.getElementById('other')).visibility,
    card: document.getElementById('shared-card').dataset.vigilSingleReelCard,
    path: location.pathname
  })`);
  for (const [initialSource, attribute, value] of [
    ['', 'src', '/photo.svg'],
    ['src=""', 'srcset', '/photo.svg 1x'],
    ['src="about:blank"', 'src', '/photo.svg'],
    ['src="about:blank"', 'srcset', '/photo.svg 1x']
  ]) {
    await photoPage(initialSource);
    assert.deepEqual(await loadPhoto(attribute, value), { loaded: true, width: 390 });
    assert.deepEqual(await photoState(), {
      shared: 'visible', other: 'hidden', card: 'allowed', path: '/p/Photo123/'
    }, `single photo hydrates from ${initialSource || 'missing src'} through ${attribute}`);
    for (const destination of ['/p/Other456/', '/reel/Other456/', '/stories/other/456/', '/reels/']) {
      await run(`history.pushState({}, '', ${JSON.stringify(destination)})`);
      assert.equal((await photoState()).path, '/p/Photo123/', `photo cannot navigate to ${destination}`);
    }
    await loadPhoto(attribute, attribute === 'srcset' ? '/replacement.svg 1x' : '/replacement.svg');
    assert.deepEqual(await photoState(), {
      shared: 'hidden', other: 'hidden', card: 'blocked', path: '/p/Photo123/'
    }, 'a loaded photo cannot inherit a different source');
  }
  await photoPage('');
  await run(`document.getElementById('permalink').href = '/p/Other456/'`);
  await loadPhoto('src', '/replacement.svg');
  await run(`document.getElementById('permalink').href = '/p/Photo123/'`);
  assert.equal((await photoState()).shared, 'hidden', 'a recycled card cannot acquire its first source after changing post identity');
  const dataPhoto = 'data:image/svg+xml;base64,' + Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="390" height="700"><rect width="390" height="700" fill="blue"/></svg>'
  ).toString('base64');
  await photoPage(`src="${dataPhoto}"`);
  assert.equal((await photoState()).shared, 'visible', 'a substantive data image retains normal initial authorization');
  await loadPhoto('src', '/replacement.svg');
  assert.equal((await photoState()).shared, 'hidden', 'data images are content and retain the source freeze');
  console.log('Shared reel hold regressions passed for reel/post permalinks and Direct modals; playback taps, comments, Like, and Back remain usable.');
  console.log('Single-photo lazy src/srcset hydration passed; source replacement, recycled posts, unrelated media, and feed/story/reel navigation remain blocked.');
  console.log('Mixed photo/video carousel playback, horizontal swipes, photo arrows, hold containment, and source/slide freezes passed.');
  console.log('Poster hydration, retained portal close/reopen, viewer boundaries, and unchanged-source layout remounts passed.');
  console.log('VIGIL_INSTAGRAM_SHARED_REEL_BROWSER_COMPLETE');
  win.destroy();
  app.quit();
}
void main().catch(error => { console.error(error); app.exit(1); });
