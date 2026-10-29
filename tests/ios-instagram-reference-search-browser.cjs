// Run: node_modules/.bin/electron tests/ios-instagram-reference-search-browser.cjs
// Same-origin fixtures only; never uses a live Instagram account.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'vigil-instagram-reference-')));
const swift = fs.readFileSync('ios/VigilSocial/VigilSocial/DOMAdapters.swift', 'utf8');
const extract = name => swift.match(new RegExp(`(?:private )?static let ${name} = #"""([\\s\\S]*?)"""#`))[1];
const reference = extract('instagramReferenceSearchGuard');
const single = extract('instagramSingleReelGuard');
const stable = extract('instagramStable');
async function main() {
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 390, height: 844, webPreferences: { sandbox: true } });
  let payload = {}, profile = {}, delay = 0;
  const requests = [];
  win.webContents.session.protocol.handle('https', async request => {
    const url = new URL(request.url);
    requests.push(url.pathname);
    if (url.pathname === '/p/Target123/' || url.pathname === '/reel/Target123/') {
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      return new Response(`<html><body><script type="application/json">${JSON.stringify(payload)}</script></body></html>`,
        { headers: { 'content-type': 'text/html' } });
    }
    if (url.pathname.includes('/web_profile_info/')) return new Response(JSON.stringify({ data: { user: profile } }),
      { headers: { 'content-type': 'application/json' } });
    if (url.pathname === '/fixture-response') return new Response(JSON.stringify(payload),
      { headers: { 'content-type': 'application/json' } });
    return new Response('<!doctype html><html><body><main><input aria-label="Search"><a id="result" href="/p/Target123/">Result</a><a id="tag" href="/explore/tags/topic/">Tag</a><button id="posts" role="tab">Posts</button><button id="places" role="tab">Places</button></main><nav><a id="reels" href="/reels/">Reels</a></nav></body></html>',
      { headers: { 'content-type': 'text/html' } });
  });
  const run = code => win.webContents.executeJavaScript(code);
  const settle = (ms = 100) => run(`new Promise(resolve => setTimeout(resolve, ${ms}))`);
  const load = async (query = 'basketball', textVerdict = 'safe') => {
    requests.length = 0;
    await win.loadURL(`https://www.instagram.com/explore/search/keyword/${query ? `?q=${encodeURIComponent(query)}` : ''}`);
    await run(`window.__vigilDocumentID='fixture-document';window.textRequests=[];window.openRequests=[];window.textVerdict=${JSON.stringify(textVerdict)};
      window.webkit={messageHandlers:{vigil:{postMessage: payload=>{
        if(payload.type==='instagramSearchText'){
          window.textRequests.push(payload.text);
          setTimeout(()=>window.__vigilResolveInstagramSearchText(payload.documentID,payload.requestID,
            payload.text.includes('sensitive_reference')?'sensitive':window.textVerdict),0);
        }
        if(payload.type==='instagramSearchOpen')setTimeout(()=>{
          if(window.__vigilInstagramReferenceSearch.allowsResult(payload.destination))window.openRequests.push(new URL(payload.destination,location.href).href);
          window.__vigilResolveInstagramSearchOpen(payload.documentID,payload.requestID);
        },0);
      }}}};window.__vigilBridge=()=>{};void 0;`);
    await run(reference + single + stable);
    await settle(150);
    if(query && textVerdict==='safe')assert.equal(await run(`new Promise(resolve=>{let ticks=0;const poll=()=>{
      if(['allowed','denied'].includes(document.getElementById('result').dataset.vigilInstagramReferenceResult))return resolve(true);
      if(++ticks>400)return resolve(false);setTimeout(poll,10);};poll();})`),true,'prefilter settles');
  };
  const click = async () => { await run("document.getElementById('result').click()"); await settle(250); };
  const record = (likes = 0, views = 0) => ({ shortcode: 'Target123', like_count: likes, play_count: views,
    owner: { username: 'small_creator' }, caption: { text: 'A basketball reference' } });
  for (const scenario of ['viral-likes', 'viral-views', 'big-account', 'below', 'missing', 'string-counts', 'wrong-post', 'wrong-account']) {
    payload = record(); profile = { username: 'small_creator', follower_count: 50 }; delay = 0;
    if (scenario === 'viral-likes') payload.like_count = 1000;
    if (scenario === 'viral-views') payload.play_count = 10000;
    if (scenario === 'big-account') profile.follower_count = 10000;
    if (scenario === 'below') { payload.like_count = 999; payload.play_count = 9999; profile.follower_count = 9999; }
    if (scenario === 'missing') payload = {};
    if (scenario === 'string-counts') { payload.like_count = '999999'; payload.play_count = '999999'; profile.follower_count = '999999'; }
    if (scenario === 'wrong-post') payload = { ...record(999999), shortcode: 'Other456', comments: [{ like_count: 999999 }] };
    if (scenario === 'wrong-account') profile = { username: 'lookalike', follower_count: 999999 };
    await load();
    const expected = ['viral-likes', 'viral-views', 'big-account'].includes(scenario);
    assert.deepEqual(await run(`({query:window.__vigilInstagramReferenceSearch.hasQuery(),
      result:getComputedStyle(document.getElementById('result')).display!=='none',
      tag:getComputedStyle(document.getElementById('tag')).display!=='none',
      posts:getComputedStyle(document.getElementById('posts')).display!=='none',
      places:getComputedStyle(document.getElementById('places')).display!=='none',
      reels:getComputedStyle(document.getElementById('reels')).display!=='none'})`),
    { query: true, result: expected, tag: false, posts: true, places: false, reels: false }, scenario);
    // An SPA router must not skip the tap's verification.
    await run("history.pushState({},'', '/p/Other456/')");
    assert.ok((await run('location.pathname')).startsWith('/explore/'), `${scenario}: unverified History destination`);
    await click();
    const opened=await run('window.openRequests');
    assert.equal(opened.length, expected ? 1 : 0, scenario);
    assert.equal(await run("window.__vigilInstagramReferenceSearch.allowsResult('/p/Target123/')"), expected, scenario);
    assert.equal(await run("window.__vigilInstagramReferenceSearch.allowsResult('/p/Other456/')"), false, scenario);
    if (expected) assert.equal(opened[0], 'https://www.instagram.com/p/Target123/', scenario);
    assert.equal(await run("document.getElementById('vigil-instagram-reference-status')===null"), true, 'no per-result popup');
    console.log('Instagram reference search:', scenario, 'passed');
  }
  payload = record(1000); profile = {}; delay = 0;
  await load('');
  assert.equal(await run("getComputedStyle(document.getElementById('result')).display"), 'none', 'no default discovery grid');
  await click(); assert.equal((await run('window.openRequests.length')), 0, 'no-query results never open');
  await run("const input=document.querySelector('input');input.value='basketball';input.dispatchEvent(new Event('input',{bubbles:true}))");
  await settle(); await click(); assert.equal((await run('window.openRequests.length')), 1, 'typed query enables reference lookup');
  await run("document.querySelector('input').value='';document.querySelector('input').dispatchEvent(new Event('input',{bubbles:true}))");
  await settle();
  assert.equal(await run('window.__vigilInstagramReferenceSearch.hasQuery()'), false, 'clearing query revokes access');
  await load('basketball', 'unknown'); await click();
  assert.equal((await run('window.openRequests.length')), 0, 'unavailable classifier never authorizes search');
  assert.equal(await run("getComputedStyle(document.getElementById('result')).display"), 'none');
  payload.caption.text='sensitive_reference';await load();await click();
  assert.equal((await run('window.openRequests.length')), 0, 'popular content still needs a safe text verdict');
  payload=record(1000);await load(); delay = 150;
  await run("document.getElementById('result').click();const input=document.querySelector('input');input.value='different query';input.dispatchEvent(new Event('input',{bubbles:true}))");
  await settle(350);
  assert.equal((await run('window.openRequests.length')), 0, 'old-query completion cannot navigate');
  delay = 0;
  await load();
  await run("document.getElementById('result').href='/reel/Target123/';void fetch('/fixture-response')");
  await settle(); requests.length = 0; await click();
  assert.equal(await run('window.openRequests[0]'), 'https://www.instagram.com/reel/Target123/', 'same-origin search metadata supports Reels');
  assert.equal(requests.includes('/reel/Target123/'), false, 'reuse verified structured response data');
  await load();
  await run("document.getElementById('result').click();document.getElementById('result').href='/p/Other456/'");
  await settle(250);
  assert.deepEqual(await run('window.openRequests'), ['https://www.instagram.com/p/Target123/'],
    'a recycled tile cannot redirect the exact originally approved item to a different post');
  await load();
  await run("history.pushState({},'', '/explore/search/keyword/?q=another');");
  assert.equal(await run('window.__vigilInstagramReferenceSearch.hasQuery()'), false, 'new URL query closes prepaint access');
  await settle();
  assert.equal(await run('window.__vigilInstagramReferenceSearch.hasQuery()'), true, 'new URL query is checked independently');
  win.destroy();
  console.log('VIGIL_INSTAGRAM_REFERENCE_SEARCH_COMPLETE');
  app.quit();
}
void main().catch(error => { console.error(error); app.exit(1); });
