// Run: node_modules/.bin/electron tests/ios-instagram-suggestions-browser.cjs
// Local Instagram-shaped fixtures; no live account or network access.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'vigil-instagram-suggestions-')));
const source = fs.readFileSync('ios/VigilSocial/VigilSocial/DOMAdapters.swift', 'utf8');
const stable = source.match(/private static let instagramStable = #"""([\s\S]*?)"""#/)[1];

async function main() {
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 390, height: 844, webPreferences: { sandbox: true } });
  await win.webContents.session.protocol.handle('https', () => new Response(
    '<!doctype html><html><body></body></html>', { headers: { 'content-type': 'text/html' } }
  ));
  const run = async code => {
    try { return await win.webContents.executeJavaScript(code); }
    catch (error) { throw new Error(`Fixture failed at ${code.slice(0, 80)} on ${win.webContents.getURL()}`, { cause: error }); }
  };
  const settle = () => run('new Promise(resolve => setTimeout(resolve, 150))');
  const hidden = id => run(`!!document.getElementById(${JSON.stringify(id)}).closest('[data-vigil-hidden-feature], [data-vigil-instagram-suggestions]')`);
  const moduleHTML = '<div id="suggestions" data-testid="suggested-users"><header><div role="heading" id="heading">Suggestions <strong>for you</strong></div><a href="/explore/people/">See all</a></header><div id="carousel" role="list"><div role="listitem"><div role="button" id="portrait"><img id="face" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==" width="40" height="40" alt="stranger profile picture"></div><a id="handle" href="/stranger/">stranger</a><button id="follow">Follow</button></div><button aria-label="Next">Next</button></div></div>';
  await win.loadURL('https://www.instagram.com/');
  await run(`window.__vigilBridge=()=>{};window.fetch=async()=>({ok:false,status:429});
    document.body.innerHTML=${JSON.stringify('<nav id="nav"><a href="/">Home</a><a href="/direct/inbox/">Messages</a></nav><main><div id="stories"><a href="/stories/friend/1/">Friend story</a></div>' + moduleHTML + '<article id="post"><a href="/friend/">friend</a><p>Ordinary post</p><button>Follow</button></article><div role="dialog" id="message"><span>Suggestions for you</span><button>Follow</button></div></main>')}`);
  await run(stable);
  await settle();
  assert.equal(await hidden('suggestions'), false, 'show the complete account carousel');
  for (const id of ['nav', 'stories', 'post', 'message']) assert.equal(await hidden(id), false, `preserve ${id}`);
  for (const id of ['face', 'handle', 'follow']) {
    assert.equal(await run(`document.getElementById('${id}').checkVisibility({checkVisibilityCSS:true})`), true, id);
  }
  assert.equal(await run("document.getElementById('face').naturalWidth"), 1, 'portrait loaded');
  await run("const follow=document.getElementById('follow');follow.onclick=()=>follow.textContent='Requested';follow.click()");
  await settle();
  assert.equal(await run("document.getElementById('follow').textContent"), 'Requested');

  await run("document.getElementById('heading').textContent='Friends';");
  await settle();
  assert.equal(await hidden('suggestions'), false, 'recycled ordinary module is released');
  for (const label of ['Suggested for you', 'Suggestions for you', 'Suggested accounts']) {
    await run(`document.getElementById('heading').textContent=${JSON.stringify(label)}`);
    await settle();
    assert.equal(await hidden('suggestions'), false, label);
  }
  await run("document.documentElement.dataset.vigilFeatureSuggested='available';document.dispatchEvent(new Event('__vigilPolicyFeaturesChanged'))");
  await settle();
  assert.equal(await hidden('suggestions'), false, 'follow existing policy availability');
  await run("document.documentElement.dataset.vigilFeatureSuggested='blocked';document.dispatchEvent(new Event('__vigilPolicyFeaturesChanged'))");
  await settle();
  assert.equal(await hidden('suggestions'), false);

  await run("const next=document.querySelector('#carousel [aria-label=Next]');next.onclick=()=>{handle.href='/second/';handle.textContent='second';face.alt='second profile picture';follow.textContent='Follow'};next.click()");
  await settle();
  assert.equal(await run("handle.textContent==='second' && face.checkVisibility({checkVisibilityCSS:true}) && follow.checkVisibility()"), true, 'rotated card');
  await run("document.getElementById('suggestions').remove();document.querySelector('main').insertAdjacentHTML('afterbegin','<div data-testid=suggested-users id=late><div><span>Suggestions for you</span></div><div id=late-cards></div></div>')");
  await settle();
  assert.equal(await hidden('late'), true, 'unidentified tagged skeleton awaits its cards');
  await run("document.getElementById('late-cards').innerHTML='<div><a href=/another/>another</a><button>Follow</button></div>'");
  await settle();
  assert.equal(await hidden('late'), false, 'cards inserted separately remain visible');
  for (const id of ['nav', 'stories', 'post', 'message']) assert.equal(await hidden(id), false, `preserve ${id} after mutations`);

  await run("document.querySelector('main').insertAdjacentHTML('beforeend','<article id=recommended><span>Suggestions for you</span><a href=/someone/>someone</a></article>')");
  await settle();
  assert.equal(await hidden('recommended'), true, 'article recommendations recognize the plural label too');
  console.log('Instagram suggestions: visible portraits, handles, Follow, complete carousel, neighboring content, recycled nodes, late cards, and policy changes passed');
  win.destroy();
  app.quit();
}
void main().catch(error => { console.error(error); app.exit(1); });
