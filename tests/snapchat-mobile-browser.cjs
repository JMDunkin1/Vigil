// Layout integration checks with a structural Snapchat Web fixture, never an account.
const {app, BrowserWindow} = require('electron');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const path = require('node:path');
async function main() {
  await app.whenReady();
  const win = new BrowserWindow({show:false,width:390,height:780,useContentSize:true,webPreferences:{sandbox:true}});
  const source = fs.readFileSync('ios/VigilSocial/VigilSocial/DOMAdapters.swift','utf8');
  const extract = name => source.match(new RegExp(`private static let ${name} = #"""([\\s\\S]*?)"""#`))[1];
  const mobile = extract('snapchatMobileLayout');
  const policy = extract('snapchat');
  const fixture = fs.readFileSync('tests/fixtures/snapchat-desktop-shell.html','utf8');
  await win.webContents.session.protocol.handle('https', () => new Response(fixture,{headers:{'content-type':'text/html; charset=utf-8'}}));
  const run = script => win.webContents.executeJavaScript(script);
  const settle = () => run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const hidden = id => run(`getComputedStyle(document.querySelector(${JSON.stringify(id)})).display === 'none'`);
  await win.loadURL('https://www.snapchat.com/web/');
  assert.equal(await hidden('.BbZFb'),true,'fixture reproduces the desktop collapsed feed');
  // Production Snapchat strips test IDs; verify the observed semantic fallback.
  await run("document.querySelector('[data-testid=\"app.feed.Search\"]').removeAttribute('data-testid')");
  await run(policy + mobile); await settle();
  assert.equal(await hidden('.yC1EG'),true);
  await run("document.querySelector('.vigil-snap-search').click()");await settle();
  for (const width of [320,390,430]) {
    win.setContentSize(width,780); await settle();
    const sizes = await run(`(() => {const rect=s=>document.querySelector(s).getBoundingClientRect();return {feed:rect('.BL7do').width,row:rect('.O4POs').width,title:rect('.BbZFb').width,search:rect('.yC1EG').height,overflow:document.documentElement.scrollWidth>innerWidth,rows:[...document.querySelectorAll('[role=listitem]')].every(x=>x.offsetHeight===74 && Math.abs(x.getBoundingClientRect().height-60)<1)}})()`);
    assert.ok(Math.abs(sizes.feed-width)<1);assert.ok(Math.abs(sizes.row-width)<1);assert.ok(sizes.title>130);assert.ok(sizes.search>=44);assert.equal(sizes.overflow,false);assert.equal(sizes.rows,true);
    assert.equal(await hidden('#restricted'),true);assert.equal(await hidden('#discover'),true);
  }
  win.setContentSize(390,780);await settle();
  await run("document.querySelector('.vigil-snap-search').click()");await settle();
  const out=process.env.VIGIL_SNAPCHAT_SCREENSHOTS;
  if(out){fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'chat-light.png'),(await win.webContents.capturePage()).toPNG());}
  await run(`document.querySelector('[aria-label=Profile]').click();document.querySelector('[title="View friend requests"]').click();document.querySelector('.w15C2 button').click();`);
  assert.deepEqual(await run('[profileOpened,friendsOpened,cameraOpened]'),[true,true,true]);await settle();
  assert.equal(await run(`document.querySelector('#shell').dataset.vigilSnapLayout`),'dialog');
  assert.equal(await run(`location.pathname`),'/web/','friend panel opens without route navigation');
  assert.equal(await hidden('.Vbjsg'),false);
  const bounded = selector => run(`(() => {const el=document.querySelector(${JSON.stringify(selector)});const r=el.getBoundingClientRect();return r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight})()`);
  const hit = selector => run(`(() => {const el=document.querySelector(${JSON.stringify(selector)});const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))})()`);
  for(const height of [420,780]){
    win.setContentSize(390,height);await settle();
    assert.equal(await bounded('.JB8Z3'),true,'real friend panel fits keyboard-sized viewport');
    assert.equal(await run(`document.querySelector('.buksD').scrollHeight > document.querySelector('.buksD').clientHeight`),true,'friend results scroll inside bounded dialog');
  }
  assert.equal(await hit('[aria-label="Find friends"]'),true,'friend search receives touches');
  await run(`document.querySelector('[aria-label="Find friends"]').value='fixture.friend';document.querySelector('.JB8Z3 button').click()`);
  assert.equal(await run('friendAdded'),'fixture.friend');
  assert.equal(await hit('[title="View friend requests"]'),true,'original dismissal toggle receives touches');
  await run(`document.querySelector('[title="View friend requests"]').click()`);await settle();
  assert.equal(await run(`document.querySelector('.LtQF8')`),null);
  await run(`fixtureSwipe('.O4POs',[[5,150],[160,152]])`);await settle();
  assert.equal(await run(`document.querySelector('#shell').dataset.vigilSnapLayout`),'feed','feed half swipe must never open/read a chat');
  await run("document.querySelector('.vigil-snap-tabs [data-panel=camera]').click()");await settle();
  assert.equal(await hidden('.BL7do'),true);assert.equal(await hidden('.Vbjsg'),false);
  await run("document.querySelector('.vigil-snap-tabs [data-panel=feed]').click()");await settle();
  assert.equal(await hidden('.BL7do'),false);
  await run(`document.querySelector('.O4POs').click()`);await settle();
  assert.equal(await hidden('.BL7do'),true);
  assert.equal(await hidden('.Vbjsg'),false);
  await run(`document.querySelector('[contenteditable]').textContent='draft';document.querySelector('[aria-label=Send]').click();document.querySelector('[aria-label="Audio call"]').click()`);
  assert.deepEqual(await run('[fixtureSent,callOpened]'),['draft',true]);
  for(const height of [420,780]){win.setContentSize(390,height);await settle();assert.ok(await run(`document.querySelector('[contenteditable]').getBoundingClientRect().bottom <= innerHeight`));}
  if(out)fs.writeFileSync(path.join(out,'conversation-light.png'),(await win.webContents.capturePage()).toPNG());
  await run(`document.documentElement.setAttribute('theme','dark')`);await settle();
  if(out)fs.writeFileSync(path.join(out,'conversation-dark.png'),(await win.webContents.capturePage()).toPNG());
  for (const [points,options] of [
    [[[5,180],[65,180]],{}],
    [[[5,180],[40,260],[180,265]],{}],
    [[[5,180],[160,180]],{startCount:2}],
    [[[5,180],[160,180]],{moveCount:2}],
    [[[5,180],[160,180]],{cancel:true}],
    [[[80,180],[200,180]],{}]
  ]) {
    await run(`fixtureSwipe('.messages',${JSON.stringify(points)},${JSON.stringify(options)})`);await settle();
    assert.equal(await run(`document.querySelector('#shell').dataset.vigilSnapLayout`),'detail','cancelled gesture leaves chat open');
  }
  for (const selector of ['[contenteditable]','[aria-label="Send"]']) {
    await run(`fixtureSwipe(${JSON.stringify(selector)},[[5,180],[160,180]])`);await settle();
    assert.equal(await run(`document.querySelector('#shell').dataset.vigilSnapLayout`),'detail','interactive targets never trigger edge back');
  }
  for(const className of ['S4e9r','hpge3','Rnl06','PvwWu']){
    await run(`document.querySelector('.Vbjsg').insertAdjacentHTML('beforeend', '<div class="${className}" id="gesture-overlay"></div>')`);await settle();
    await run(`fixtureSwipe('.messages',[[5,180],[160,180]])`);await settle();
    assert.equal(await run(`document.querySelector('.aXEpU') !== null`),true,'active media/call overlay cancels edge back');
    await run(`document.getElementById('gesture-overlay').remove()`);await settle();
  }
  await run(`fixtureSwipe('.messages',[[5,180],[110,182]])`);await settle();
  assert.equal(await hidden('.BL7do'),false);
  if(out)fs.writeFileSync(path.join(out,'chat-dark.png'),(await win.webContents.capturePage()).toPNG());
  await run(`document.querySelector('[title="New Chat"]').click()`);await settle();
  assert.equal(await hidden('.Vbjsg'),false,'new chat dialog remains reachable');
  assert.equal(await run(`document.querySelector('#shell').dataset.vigilSnapLayout`),'dialog');
  for(const height of [420,780]){win.setContentSize(390,height);await settle();assert.equal(await bounded('.c9yiB'),true,'new chat fits visual viewport');assert.equal(await hit('.c9yiB input'),true);}
  await run(`document.querySelector('.c9yiB button').click()`);await settle();
  assert.equal(await run(`document.querySelector('#shell').dataset.vigilSnapLayout`),'feed');
  await run(`closeChat();document.querySelector('.XlW_1').innerHTML='<div class="AbUJt">Profile</div>'`);await settle();
  assert.equal(await run(`document.querySelectorAll('.vigil-snap-chat-title').length`),1,'React header remount recovers without duplicating titles');
  win.setContentSize(1100,780);await settle();
  assert.equal(await run(`document.querySelector('.BL7do').getBoundingClientRect().width`),340,'desktop layout is preserved');
  await run(`document.querySelector('.Fpg8t').className='future-layout'`);await settle();
  assert.equal(await run(`document.querySelector('[data-vigil-snap-layout]') === null`),true,'unknown shell falls back');
  win.setContentSize(390,780);
  await win.loadURL('https://www.snapchat.com/web/');
  await run(`document.getElementById('shell').className='svUon';document.getElementById('shell').insertAdjacentHTML('afterbegin','<div class="bkCIM"><div class="uSkZ8" onclick="window.nativeCameraOpened=true"><svg></svg></div><div class="uSkZ8" onclick="window.nativeSpotlightOpened=true"><svg></svg></div><div class="uSkZ8" onclick="window.nativeGamesOpened=true"><svg></svg></div></div>')`);
  await run(policy+mobile);await settle();
  assert.equal(await run(`document.querySelector('.vigil-snap-tabs') === null`),true,'real rail retains original controls');
  assert.equal(await run(`document.querySelectorAll('.vigil-snap-return-chat').length`),1);
  await run(`document.querySelector('.bkCIM > .uSkZ8').click()`);await settle();
  assert.equal(await run('nativeCameraOpened'),true,'original camera click action preserved');
  assert.equal(await run(`document.querySelector('#shell').dataset.vigilSnapLayout`),'camera');
  assert.equal(await hidden('.Vbjsg'),false);
  await run(`document.querySelector('.vigil-snap-return-chat').click()`);await settle();
  assert.equal(await run(`document.querySelector('#shell').dataset.vigilSnapLayout`),'feed');
  assert.equal(await hidden('.BL7do'),false);
  assert.equal(await hidden('.bkCIM > .uSkZ8:nth-child(2)'),true);
  assert.equal(await hidden('.bkCIM > .uSkZ8:nth-child(3)'),false);
  await win.loadURL('https://www.snapchat.com/web/');await run(policy);await settle();
  await run(`document.body.insertAdjacentHTML('beforeend', '<div id="policy-cases"><div class="bkCIM"><div class="uSkZ8" onclick="window.railCamera=true"><svg></svg></div><div class="uSkZ8" onclick="window.railSpotlight=true"><svg></svg></div><div class="uSkZ8" onclick="window.railGames=true"><svg></svg></div></div><div class="n8ZwA" id="shared-spotlight" onclick="window.sharedSpotlight=true"><img class="NluRC"></div><div class="n8ZwA" id="friend-story" onclick="window.friendStory=true"><img class="lrASL"></div><div class="ecBYF" onclick="window.lightbox=true">Friend media</div><div class="FDMBo"><div class="UZxw_"><button class="Rknx9" onclick="window.spotlightClosed=(window.spotlightClosed||0)+1">Close</button></div></div></div>')`);await settle();
  assert.equal(await hidden('.bkCIM > .uSkZ8:nth-child(2)'),true);
  assert.equal(await hidden('#shared-spotlight'),true);
  assert.equal(await hidden('.FDMBo'),true);
  assert.equal(await run('spotlightClosed'),1,'inline Spotlight invokes its genuine close action');
  for(const selector of ['.bkCIM > .uSkZ8:first-child','.bkCIM > .uSkZ8:nth-child(3)','#friend-story','.ecBYF'])assert.equal(await hidden(selector),false,'allowed camera, games and friend media remain');
  await run(`document.querySelectorAll('#policy-cases .uSkZ8, #shared-spotlight, #friend-story, .ecBYF').forEach(el=>el.click())`);
  assert.deepEqual(await run('[railCamera,railGames,friendStory,lightbox,!!window.railSpotlight,!!window.sharedSpotlight]'),[true,true,true,true,false,false]);
  await run(`document.querySelector('.FDMBo').appendChild(document.createElement('span'))`);await settle();
  assert.equal(await run('spotlightClosed'),1,'reconciliation does not repeatedly close one player');
  await win.loadURL('https://accounts.snapchat.com/v2/login');await run(mobile);
  assert.equal(await run(`!!window.__vigilSnapchatMobileInstalled`),false,'authentication remains untouched');
  console.log('Snapchat mobile layout passed: 320/390/430px, desktop, chat/back, search, compose, camera/call controls, dialogs, keyboard-sized viewport, dark mode, remount, fallback, authentication, and restricted features.');
  win.destroy();app.quit();
}
void main().catch(error=>{console.error(error);app.exit(1)});
