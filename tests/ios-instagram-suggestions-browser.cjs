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
  win.webContents.session.protocol.handle('https', () => new Response(
    '<!doctype html><html><body></body></html>', { headers: { 'content-type': 'text/html' } }
  ));
  const run = code => win.webContents.executeJavaScript(code);
  const settle = () => run('new Promise(resolve => setTimeout(resolve, 150))');
  const hidden = id => run(`!!document.getElementById(${JSON.stringify(id)}).closest('[data-vigil-hidden-feature], [data-vigil-instagram-suggestions]')`);
  const moduleHTML = '<div id="suggestions"><div><span id="heading">Suggestions for you</span><a href="/explore/people/">See all</a></div><div id="carousel"><div><a href="/stranger/">stranger</a><button>Follow</button></div><button aria-label="Next">Next</button></div></div>';
  await win.loadURL('https://www.instagram.com/viewer/');
  await run(`window.__vigilBridge=()=>{};window.fetch=async()=>({ok:false,status:429});
    document.body.innerHTML=${JSON.stringify('<nav id="nav"><a href="/">Home</a><a href="/direct/inbox/">Messages</a></nav><main><div id="stories"><a href="/stories/friend/1/">Friend story</a></div>' + moduleHTML + '<article id="post"><a href="/friend/">friend</a><p>Ordinary post</p><button>Follow</button></article><div role="dialog" id="message"><span>Suggestions for you</span><button>Follow</button></div></main>')}`);
  await run(stable);
  await settle();
  assert.equal(await hidden('suggestions'), true, 'hide complete div carousel, including header, cards, and Next');
  for (const id of ['nav', 'stories', 'post', 'message']) assert.equal(await hidden(id), false, `preserve ${id}`);
  assert.equal(await run("getComputedStyle(document.getElementById('suggestions')).display"), 'none');

  await run("document.getElementById('heading').firstChild.data='Friends';");
  await settle();
  assert.equal(await hidden('suggestions'), false, 'recycled ordinary module is released');
  for (const label of ['Suggested for you', 'Suggestions for you', 'Suggested accounts']) {
    await run(`document.getElementById('heading').firstChild.data=${JSON.stringify(label)}`);
    await settle();
    assert.equal(await hidden('suggestions'), true, label);
  }
  await run("document.documentElement.dataset.vigilFeatureSuggested='available';document.dispatchEvent(new Event('__vigilPolicyFeaturesChanged'))");
  await settle();
  assert.equal(await hidden('suggestions'), false, 'follow existing policy availability');
  await run("document.documentElement.dataset.vigilFeatureSuggested='blocked';document.dispatchEvent(new Event('__vigilPolicyFeaturesChanged'))");
  await settle();
  assert.equal(await hidden('suggestions'), true);

  await run("document.getElementById('suggestions').remove();document.querySelector('main').insertAdjacentHTML('afterbegin','<div id=late><div><span>Suggestions for you</span></div><div id=late-cards></div></div>')");
  await settle();
  assert.equal(await hidden('late'), false, 'do not consume the page while cards are absent');
  await run("document.getElementById('late-cards').innerHTML='<div><a href=/another/>another</a><button>Follow</button></div>'");
  await settle();
  assert.equal(await hidden('late'), true, 'cards inserted separately still conceal the whole module');
  for (const id of ['nav', 'stories', 'post', 'message']) assert.equal(await hidden(id), false, `preserve ${id} after mutations`);

  await run("document.querySelector('main').insertAdjacentHTML('beforeend','<article id=recommended><span>Suggestions for you</span><a href=/someone/>someone</a></article>')");
  await settle();
  assert.equal(await hidden('recommended'), true, 'article recommendations recognize the plural label too');
  console.log('Instagram suggestions: complete carousel, neighboring content, recycled nodes, late cards, and policy changes passed');
  win.destroy();
  app.quit();
}
main().catch(error => { console.error(error); app.exit(1); });
