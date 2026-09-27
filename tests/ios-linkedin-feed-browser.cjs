// Run with: node_modules/.bin/electron tests/ios-linkedin-feed-browser.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const swift = fs.readFileSync('ios/VigilSocial/VigilSocial/DOMAdapters.swift', 'utf8');
const adapter = swift.match(/private static let linkedin = #"""([\s\S]*?)"""#/)[1];
const card = (id, degree = '<span aria-hidden="true"> • 1st</span><span class="visually-hidden">1st degree connection</span>', extra = '', actor = true) => `<div class="occludable-update" id="post-${id}"><article class="feed-shared-update-v2" data-urn="urn:li:activity:${id}">${actor ? `<div class="update-components-actor"><a href="/in/person-${id}/">Person ${id}</a><span class="update-components-actor__supplementary-actor-info">${degree}</span></div>` : ''}<p>Post ${id}: 1st degree connection</p>${extra}</article></div>`;
const pause = () => new Promise(resolve => setTimeout(resolve, 100));
async function main() {
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 390, height: 800, webPreferences: { sandbox: true } });
  await win.webContents.session.protocol.handle('https', () => new Response('<!doctype html><html><head></head><body></body></html>', { headers: { 'content-type': 'text/html' } }));
  const js = value => win.webContents.executeJavaScript(value);
  const visible = () => js(`[...document.querySelectorAll('[data-vigil-linkedin-post="allowed"]')].filter(n=>n.getClientRects().length).length`);
  const hidden = id => js(`!document.getElementById(${JSON.stringify(id)}).getClientRects().length`);
  await win.loadURL('https://www.linkedin.com/feed/');
  await js(adapter);
  const rejected = card(100, '2nd') + card(101, '3rd') + card(102, 'Following') + card(103, '1st', '', false)
    + card(104, '1st', '<div class="update-components-header">Suggested</div>')
    + card(105, '1st', '<div class="update-components-reshared-content">Unverified repost</div>')
    + card(106, '1st', '<div class="update-components-actor"><a href="/in/stranger/">Stranger</a><span class="dist-value">2nd</span></div>')
    + card(107, '1st', '<div class="update-components-actor__sub-description">Promoted</div>');
  await js(`document.body.innerHTML = ${JSON.stringify(`<nav><a id="jobs" href="/jobs/">Jobs</a><a id="messages" href="/messaging/">Messages</a><a id="video" href="/video/">Video</a></nav><main><button id="composer">Start a post</button><div role="feed">${rejected}${Array.from({length:25}, (_, i) => card(i + 1)).join('')}<div id="unknown">Unknown recommendation</div><button id="more">Show more</button></div></main><div class="artdeco-modal-overlay" id="upsell"><div role="dialog"><p>LinkedIn is better in the app</p><a href="linkedin://feed">Open in app</a></div></div><div role="dialog" id="ordinary"><button>Save changes</button></div>`)};`);
  await pause();
  assert.equal(await visible(), 20);
  for (const id of [100,101,102,103,104,105,106,107,21,22,23,24,25]) assert.equal(await hidden(`post-${id}`), true, `reject ${id}`);
  for (const id of ['unknown', 'more', 'upsell', 'video']) assert.equal(await hidden(id), true, id);
  for (const id of ['jobs', 'messages', 'ordinary', 'composer']) assert.equal(await hidden(id), false, id);
  assert.equal(await js(`document.querySelector('#vigil-linkedin-feed-status').textContent.includes('20-post limit')`), true);
  // Append new cards, duplicate an accepted ID, and recycle a formerly trusted card.
  await js(`document.querySelector('[role="feed"]').insertAdjacentHTML('beforeend', ${JSON.stringify(card(26) + card(1))}); document.querySelector('#post-2 .dist-value, #post-2 .update-components-actor__supplementary-actor-info').textContent='2nd'; document.querySelector('#post-3 article').setAttribute('data-urn','urn:li:activity:999');`);
  await pause();
  assert.equal(await visible(), 18);
  for (const id of ['post-26', 'post-2', 'post-3']) assert.equal(await hidden(id), true, id);
  // Removing/replacing every rendered card cannot replenish the visit budget.
  await js(`document.querySelector('[role="feed"]').innerHTML = ${JSON.stringify(Array.from({length:25}, (_, i) => card(i+200)).join(''))}; history.replaceState({},'', '/feed/?refresh=true');`);
  await pause();
  assert.equal(await visible(), 0);
  // Leaving the home feed restores ordinary route content; returning starts a new visit.
  await js(`history.pushState({}, '', '/messaging/');`);
  await pause();
  assert.equal(await hidden('post-200'), false);
  await js(`history.pushState({}, '', '/feed/');`);
  await pause();
  assert.equal(await visible(), 20);
  // Unknown layout fails closed, and a post with no stable identity is never admitted.
  await js(`history.pushState({}, '', '/jobs/');`);
  await pause();
  await js(`document.querySelector('main').innerHTML='<section id="new-layout">Unknown feed structure</section><article id="no-id"><div class="update-components-actor"><a href="/in/example/">Example</a><span class="dist-value">1st</span></div></article>'; history.pushState({}, '', '/feed/');`);
  await pause();
  assert.equal(await hidden('new-layout'), true);
  assert.equal(await hidden('no-id'), true);
  // App prompts inserted later cannot retain an orphan modal scroll lock.
  await js(`document.querySelector('#ordinary').remove(); document.body.style.overflow='hidden'; document.body.insertAdjacentHTML('beforeend','<div role="dialog" id="late-upsell"><button>Use the LinkedIn app</button></div><a id="app-banner" href="/">Use the app</a>');`);
  await pause();
  assert.equal(await hidden('late-upsell'), true);
  assert.equal(await js(`document.body.style.overflow`), '');
  assert.equal(await hidden('app-banner'), true);
  await js(`window.bodyClassMutations=0; new MutationObserver(records=>{window.bodyClassMutations+=records.length}).observe(document.body,{attributes:true,attributeFilter:['class']});`);
  await pause();
  assert.equal(await js('window.bodyClassMutations'), 0, 'hidden prompts must not cause a perpetual observer loop');
  console.log('LinkedIn browser regressions passed: 20 posts per visit, reciprocal-author badges, recommendations, reposts, unknown layouts, recycled cards, duplicates, SPA navigation, popups, and preserved ordinary controls.');
  win.destroy();
  app.quit();
}
void main().catch(error => { console.error(error); app.exit(1); });
