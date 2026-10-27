// Run: node_modules/.bin/electron tests/snapchat-media-browser.cjs
// Uses fictional media and a generated stream; never opens an account or camera.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

async function main() {
  console.log('Checking Snapchat media with generated fixtures…');
  await app.whenReady();
  const win = new BrowserWindow({ show:false, width:390, height:780, useContentSize:true,
    webPreferences:{ sandbox:true, partition:'snapchat-media-fixture' } });
  const source = fs.readFileSync(process.env.VIGIL_SNAPCHAT_ADAPTERS || 'ios/VigilSocial/VigilSocial/DOMAdapters.swift','utf8');
  const extract = name => source.match(new RegExp(`private static let ${name} = #"""([\\s\\S]*?)"""#`))?.[1] || '';
  const fixture = fs.readFileSync('tests/fixtures/snapchat-desktop-shell.html','utf8');
  await win.webContents.session.protocol.handle('https', () => new Response(fixture,
    { headers:{'content-type':'text/html; charset=utf-8'} }));
  const run = code => win.webContents.executeJavaScript(code);
  const settle = () => run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const tap = selector => run(`(() => {
    const el=document.querySelector(${JSON.stringify(selector)}), r=el.getBoundingClientRect();
    const target=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
    if(!el.contains(target)) throw new Error('Control is covered: '+${JSON.stringify(selector)});
    target.click();
  })()`);
  const out = process.env.VIGIL_SNAPCHAT_SCREENSHOTS;
  const screenshot = async name => {
    if (!out) return;
    fs.mkdirSync(out,{recursive:true});
    fs.writeFileSync(path.join(out,name+'.png'),(await win.webContents.capturePage()).toPNG());
  };
  await win.loadURL('https://www.snapchat.com/web/');
  console.log('Fixture loaded.');
  await run(extract('snapchat') + extract('snapchatMobileLayout'));
  for (const theme of ['light','dark']) for (const width of [320,390,430]) {
    win.setContentSize(width,780); await settle();
    await run(`document.documentElement.setAttribute('theme','${theme}')`);
    for (const split of ['rows','columns']) for (const size of [[900,1600],[1600,900]]) {
      await run(`fixtureOpenSnap('${split}',${size.join(',')})`); await settle();
      const geometry = await run(`(() => {
        const rect=s=>document.querySelector(s).getBoundingClientRect();
        const player=rect('.b2f4R'),image=document.getElementById('fixture-snap-image');
        const scale=Math.min(player.width/${size[0]},player.height/${size[1]});
        return {width:player.width,height:player.height,photoWidth:${size[0]}*scale,
          chatHidden:getComputedStyle(document.querySelector('.ChLAv')).display==='none',
          imageWidth:image.getBoundingClientRect().width,imageHeight:image.getBoundingClientRect().height,
          fit:getComputedStyle(image).objectFit,overflow:document.documentElement.scrollWidth>innerWidth};
      })()`);
      assert.ok(geometry.width>=width-1,'snap player should use the phone width');
      assert.ok(geometry.height>=700,'snap player should use the phone height');
      assert.ok(geometry.photoWidth>=Math.min(width,732*size[0]/size[1])-1,
        'photo should use all available space while retaining its full frame');
      assert.equal(geometry.chatHidden,true,'chat must not share the viewing area');
      assert.ok(geometry.imageWidth>=width-1 && geometry.imageHeight>=700,'real player inline dimensions must expand too');
      assert.equal(geometry.fit,'contain','portrait and landscape snaps keep their complete frame');
      assert.equal(geometry.overflow,false);
      await tap('[aria-label=next]'); assert.equal(await run('fixtureNext'),true);
    }
  }
  win.setContentSize(390,780); await settle();
  await run(`fixtureOpenSnap('rows')`); await settle(); await screenshot('snap-phone');
  await run(`document.querySelector('.ecBYF').classList.add('ATeie');document.querySelector('.ecBYF>.ejVI4').style.display='grid'`);
  const privacy = await run(`(() => {
    const image=document.getElementById('fixture-snap-image'),r=image.getBoundingClientRect();
    return [getComputedStyle(image).filter.includes('blur'),document.elementFromPoint(r.left+r.width/2,r.top+r.height/2).classList.contains('ejVI4')];
  })()`);
  assert.deepEqual(privacy,[true,true],'real away shielding and blur must remain intact');
  await run(`document.querySelector('.ecBYF>.ejVI4').style.display='none';document.querySelector('.ecBYF>.eNF_J').style.display='grid'`);
  assert.equal(await run(`document.elementFromPoint(195,390).classList.contains('eNF_J')`),true);
  await run(`document.querySelector('.ecBYF>.eNF_J').style.display='none';document.querySelector('.ecBYF').classList.remove('ATeie')`);
  await tap('#fixture-reply-snap'); await settle();
  console.log('Fullscreen layouts and privacy passed; checking camera capture.');
  // Mock only the native request. The stream is real generated video, so its
  // dimensions and captured edge pixels can detect accidental preview cropping.
  await run(`window.fixtureStream=(()=>{
    const c=document.createElement('canvas');c.width=1200;c.height=900;
    const g=c.getContext('2d');g.fillStyle='#84b4d4';g.fillRect(0,0,1200,900);
    g.fillStyle='#f4b942';g.fillRect(0,0,144,900);g.fillStyle='#df635d';g.fillRect(1056,0,144,900);
    window.fixtureCameraCanvas=c;return c.captureStream(5);
  })();
  navigator.mediaDevices.getUserMedia=async constraints=>{window.fixtureConstraints=constraints;return fixtureStream};void 0;`);
  await run(extract('snapchatCameraBootstrap'));
  await run(`navigator.mediaDevices.getUserMedia({audio:false,video:{width:{ideal:406},height:{ideal:720},aspectRatio:{exact:9/16},deviceId:{exact:'selected-camera'}}}).then(stream=>{document.getElementById('local-video').srcObject=stream})`);
  await run(`new Promise(resolve=>{const v=document.getElementById('local-video');if(v.videoWidth)resolve();else v.addEventListener('loadeddata',()=>resolve(),{once:true})})`);
  const request = await run('fixtureConstraints');
  // Let WebKit choose a full sensor format; this generated stream checks
  // presentation rather than emulating physical sensor orientation.
  for(const key of ['aspectRatio','width','height'])assert.equal(key in request.video,false);
  assert.equal(request.audio,false); assert.deepEqual(request.video.deviceId,{exact:'selected-camera'});
  for (const [width,height] of [[320,780],[390,780],[430,780],[390,420]]) {
    win.setContentSize(width,height); await settle();
    const camera = await run(`(() => {
      const box=document.querySelector('.AEZEl').getBoundingClientRect();
      const video=document.getElementById('local-video');
      return [box.left,box.top,box.width,box.height,getComputedStyle(video).objectFit,video.videoWidth,video.videoHeight];
    })()`);
    assert.deepEqual(camera,[0,0,width,height,'contain',1200,900]);
    await tap('#fixture-switch-camera'); assert.equal(await run('fixtureCameraSwitched'),true);
    await tap('#fixture-capture');
    assert.deepEqual(await run('fixtureCapturedDimensions'),[1200,900]);
    const pixels=await run('fixtureCapturedPixels');
    assert.ok(pixels.every((value,index)=>Math.abs(value-[244,185,66,255,223,99,93,255][index])<=3),
      'capture retains both camera edges, allowing video color conversion rounding');
  }
  win.setContentSize(390,780); await settle(); await screenshot('camera-phone');
  await tap('#fixture-send-camera'); assert.equal(await run('fixtureCameraSent'),true);
  await tap('#fixture-close-camera'); await settle();
  assert.equal(await run(`document.querySelector('#shell').dataset.vigilSnapMedia`),'viewer','closing camera returns to full snap');
  await tap('#fixture-close-snap'); await settle();
  assert.equal(await run(`getComputedStyle(document.querySelector('.ChLAv')).display`),'block');
  assert.equal(await run(`document.querySelector('#shell').hasAttribute('data-vigil-snap-media')`),false);
  // Desktop retains its split viewer, camera crop, and native sizing.
  win.setContentSize(1100,780); await settle();
  await run(`fixtureOpenSnap();fixtureOpenReplyCamera()`); await settle();
  assert.equal(await run(`getComputedStyle(document.getElementById('local-video')).objectFit`),'cover');
  assert.ok(await run(`document.querySelector('.b2f4R').getBoundingClientRect().height < 390`));
  await run('fixtureStream.getTracks().forEach(track=>track.stop())');
  console.log('Snapchat fullscreen media, privacy, camera frame/capture, controls, viewport and desktop regressions passed.');
  win.destroy();app.quit();
}
void main().catch(error=>{console.error(error);app.exit(1)});
