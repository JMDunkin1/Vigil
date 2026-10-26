// Run with: node_modules/.bin/electron tests/ios-instagram-friends-browser.cjs
// Fictional accounts and mocked same-origin responses; no live Instagram session.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'vigil-instagram-friends-')));
const source = fs.readFileSync('ios/VigilSocial/VigilSocial/DOMAdapters.swift', 'utf8');
const stable = source.match(/private static let instagramStable = #"""([\s\S]*?)"""#/)[1]
  .replace('/* VIGIL_INFORMATIONAL_ACCOUNTS */ []', '["dining"]');
const guard = source.match(/static let instagramSingleReelGuard = #"""([\s\S]*?)"""#/)[1];

async function main() {
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 390, height: 844, webPreferences: { sandbox: true } });
  win.webContents.session.protocol.handle('https', request => new URL(request.url).pathname.endsWith('.svg')
    ? new Response('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="purple"/></svg>', {
      headers: { 'content-type': 'image/svg+xml' }
    })
    : new Response('<!doctype html><html><body></body></html>', { headers: { 'content-type': 'text/html' } }));
  const run = code => win.webContents.executeJavaScript(code);
  const settle = () => run('new Promise(resolve => setTimeout(resolve, 650))');
  for (const scenario of ['relay', 'document', 'legacy', 'unavailable']) {
    await win.loadURL('https://www.instagram.com/');
    await run(`sessionStorage.clear();localStorage.clear();
      window.scenario=${JSON.stringify(scenario)};window.calls=[];
      window.require = name => {
        if(name==='CometRelay')return {fetchQuery:(_environment,_query,variables,options)=>({toPromise:async()=>{
          calls.push(['relay',variables,options]);
          if(_query.fragment.selections[0]?.kind!=='LinkedField')return {__id:'client:root',__fragments:{}};
          const username=variables.data.query;
          return {xdt_api__v1__fbsearch__topsearch_connection:{users:[
            {user:{username:'lookalike',pk:'wrong',friendship_status:{following:true,followed_by:true}}},
            {user:{username,pk:'pk-'+username,id:'opaque-relay-id',friendship_status:{following:true}}}
          ]}};
        }})};
        if(name==='PolarisRelayEnvironment')return {default:{fixture:true}};
        if(name==='PolarisSearchBoxRefetchableQuery.graphql' && scenario==='relay')return {
          params:{id:'fixture-persisted-query'},fragment:{selections:[{kind:'FragmentSpread',name:'PolarisSearchBoxContainer_topsearch'}]},
          operation:{selections:[{kind:'LinkedField',name:'xdt_api__v1__fbsearch__topsearch_connection'}]}
        };
        if(name==='PolarisInstapi' && ['relay','document'].includes(scenario))return {apiPost:async (url,options)=>{
          calls.push(['batch',url,options]);
          const id=options.body.user_ids;
          return {data:{friendship_statuses:{[id]:id==='pk-partial'?{following:true}:{following:true,followed_by:id==='pk-friend'}}}};
        }};
        throw new Error('Module unavailable: '+name);
      };
      window.fetch=async input=>{
        const url=new URL(input,location.href);calls.push(['fetch',url.pathname]);
        if(url.pathname.includes('/accounts/current_user/'))return {ok:true,json:async()=>({user:{username:'viewer'}})};
        if(scenario==='legacy' && url.pathname.includes('/web/search/topsearch/'))return {ok:true,json:async()=>({users:[{user:{
          username:url.searchParams.get('query'),pk:'pk-'+url.searchParams.get('query'),friendship_status:{following:true}
        }}]})};
        if(scenario==='legacy' && url.pathname.includes('/friendships/show/'))return {ok:true,json:async()=>({data:{
          following:true,followed_by:url.pathname.includes('/pk-friend/')
        }})};
        // A legacy endpoint may succeed yet omit mutual-follow fields.
        if(scenario==='relay' && url.pathname.includes('/friendships/show/'))return {ok:true,json:async()=>({following:true})};
        if(scenario==='document' && /^\\/[a-z]+\\/$/.test(url.pathname)){
          const username=url.pathname.split('/')[1];
          const data={decoy:{username:'lookalike',pk:'wrong',friendship_status:{following:true,followed_by:true}},
            profile:{username,pk:'pk-'+username}};
          return {ok:true,text:async()=>'<html><script type="application/json">'+JSON.stringify(data)+'</scr'+'ipt></html>'};
        }
        if(scenario==='unavailable' && url.pathname.includes('/users/web_profile_info/'))return {ok:true,json:async()=>({user:{
          username:'lookalike',pk:'wrong',friendship_status:{following:true,followed_by:true}
        }})};
        return {ok:false,status:429};
      };
      document.body.innerHTML='<nav><a href="/viewer/" aria-label="Profile">Profile</a></nav><main><div role="list">'
        +['friend','other','partial','dining'].map(name=>'<a id="story-'+name+'" href="/stories/'+name+'/1/"><img alt="'+name+String.fromCharCode(39)+'s profile picture"></a>').join('')
        +'</div>'+['friend','other','partial','dining'].map(name=>'<article id="post-'+name+'"><a href="/'+name+'/">'+name+'</a></article>').join('')+'</main>';
    `);
    await run(stable);
    await settle();
    const state = await run(`(() => ({
      posts:Object.fromEntries(['friend','other','partial','dining'].map(name=>[name,document.getElementById('post-'+name).dataset.vigilInstagramHomeRelationship])),
      stories:Object.fromEntries(['friend','other','partial','dining'].map(name=>[name,document.getElementById('story-'+name).dataset.vigilInstagramStoryRelationship])),
      cache:JSON.parse(sessionStorage.getItem('vigil.instagram.mutual-friendships.v1:session')||'{}'),calls
    }))()`);
    assert.equal(state.posts.friend, scenario === 'unavailable' ? 'unavailable' : 'friend', scenario);
    assert.equal(state.stories.friend, scenario === 'unavailable' ? 'unavailable' : 'friend', scenario);
    assert.equal(state.posts.dining, 'friend', 'explicit exception survives failed lookups');
    assert.equal(state.stories.dining, 'friend');
    assert.notEqual(state.posts.other, 'friend');
    assert.notEqual(state.stories.other, 'friend');
    if (scenario === 'relay') {
      assert.equal(state.posts.partial, 'unavailable', 'missing reciprocal field is unknown, never friend');
      assert.equal(state.cache.partial, undefined, 'unknown is never persisted as nonfriend');
      assert.ok(state.calls.some(call => call[0] === 'relay' && call[2].fetchPolicy === 'network-only'));
      assert.ok(state.calls.filter(call => call[0] === 'batch').every(call => call[2].body.user_ids.startsWith('pk-')),
        'batch lookup must use the numeric PK identity, not an opaque Relay ID');
      assert.equal(state.calls.some(call => call[1] === '/api/v1/web/search/topsearch/'), false,
        'current relationship path must not require legacy search to succeed');
    }
    if (scenario === 'unavailable') assert.deepEqual(state.cache, {}, 'unverified and mismatched users cannot poison the cache');
    console.log('Instagram friends:', scenario, 'passed');
  }
  // Recipient wrappers must retain their own pointer lifecycle even when they
  // live inside the selected Reel's dialog. A generic modal is not an exemption.
  await win.loadURL('https://www.instagram.com/reel/Shared123/');
  await run(guard);
  await run(`document.body.innerHTML='<div role="dialog" id="viewer"><article><a href="/reel/Shared123/"><video src="/original.mp4"></video></a></article><button id="next" aria-label="Next reel">Next</button><div role="dialog" id="recipients"><div id="search-wrap" role="button"><input placeholder="Search" id="search"></div><button id="recipient">Friend</button></div><div role="dialog"><button id="unrelated">Elsewhere</button></div></div>';
    window.presses=[];for(const id of ['search-wrap','recipient','next','unrelated'])document.getElementById(id).addEventListener('pointerdown',()=>presses.push(id));`);
  await settle();
  assert.deepEqual(await run(`(() => {
    for(const id of ['search-wrap','recipient','next','unrelated'])document.getElementById(id).dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,pointerType:'touch'}));
    const input=document.getElementById('search');input.focus();input.value='a distant friend';
    input.dispatchEvent(new Event('input',{bubbles:true}));return {presses,focused:document.activeElement===input,
      sheetTouchAction:getComputedStyle(document.getElementById('recipients')).touchAction,
      searchTouchAction:getComputedStyle(document.getElementById('search-wrap')).touchAction,
      backgroundTouchAction:getComputedStyle(document.getElementById('next')).touchAction};
  })()`), { presses: ['search-wrap','recipient'], focused:true, sheetTouchAction:'auto', searchTouchAction:'auto', backgroundTouchAction:'pinch-zoom' });
  await run(`history.pushState({},'','/reel/Other/');`);
  assert.equal(await run('location.pathname'), '/reel/Shared123/');
  console.log('Instagram recipient sheet: passed');

  await win.loadURL('https://www.instagram.com/p/Shared123/');
  await run(guard);
  await run(`document.body.innerHTML='<article><a href="/p/Shared123/">Post</a><img id="photo" src="/photo.svg" style="width:300px;height:300px"></article>';`);
  await settle();
  assert.deepEqual(await run(`(() => {
    const photo=document.getElementById('photo');
    const fire=(type,id,x,y)=>{const event=new PointerEvent(type,{pointerId:id,pointerType:'touch',isPrimary:id===1,bubbles:true,cancelable:true,clientX:x,clientY:y});photo.dispatchEvent(event);return event.defaultPrevented;};
    fire('pointerdown',1,100,200);fire('pointerdown',2,200,200);
    const pinchBlocked=fire('pointermove',1,50,100)||fire('pointermove',2,250,300);
    fire('pointerup',1,50,100);fire('pointerup',2,250,300);
    fire('pointerdown',3,100,300);const swipeBlocked=fire('pointermove',3,100,100);fire('pointerup',3,100,100);
    return {pinchBlocked,swipeBlocked};
  })()`),{pinchBlocked:false,swipeBlocked:true});
  console.log('Instagram photo pinch and swipe containment: passed');

  await win.loadURL('https://www.instagram.com/direct/t/123/');
  await run(`document.body.innerHTML='<div role="button" id="wrap"><input id="search" placeholder="Search"></div>';window.wrapperClicks=0;
    document.getElementById('wrap').addEventListener('click',()=>wrapperClicks++);`);
  await run(stable);
  await run(`const wrap=document.getElementById('wrap');
    for(const type of ['pointerdown','pointerup'])wrap.dispatchEvent(new PointerEvent(type,{pointerType:'touch',isPrimary:true,pointerId:1,bubbles:true,cancelable:true}));`);
  await run(`document.getElementById('wrap').click()`);
  assert.equal(await run('wrapperClicks'),1,'a search wrapper must not receive a second synthetic activation that collapses it');
  console.log('Instagram Direct search wrapper: passed');

  await win.loadURL('https://www.instagram.com/friend/');
  await run(`document.body.innerHTML='<main><header><a href="/stories/friend/1/"><img id="avatar" alt="friend\\\'s profile picture" src="/avatar.svg"></a></header><article><img id="post" alt="Post photo" src="/post.svg"></article></main>';`);
  await run(stable);
  await settle();
  await run(`document.getElementById('avatar').click()`);
  assert.deepEqual(await run(`(() => {
    const viewer=document.getElementById('vigil-instagram-profile-photo');
    return {open:!!viewer,source:viewer?.querySelector('img').src,closeFocused:document.activeElement?.getAttribute('aria-label')};
  })()`),{open:true,source:'https://www.instagram.com/avatar.svg',closeFocused:'Close profile photo'});
  await run(`document.querySelector('[aria-label="Close profile photo"]').click();document.getElementById('post').click();`);
  assert.equal(await run(`!!document.getElementById('vigil-instagram-profile-photo')`),false,'post images must not be mistaken for avatars');
  await run(`document.getElementById('avatar').click();history.pushState({},'','/direct/inbox/');`);
  await settle();
  assert.equal(await run(`!!document.getElementById('vigil-instagram-profile-photo')`),false,'route changes close the avatar viewer');
  console.log('Instagram profile photo: passed');
  console.log('VIGIL_INSTAGRAM_FRIENDS_BROWSER_COMPLETE');
  win.destroy();
}
void main().then(()=>app.exit(0)).catch(error=>{console.error(error);app.exit(1);});
