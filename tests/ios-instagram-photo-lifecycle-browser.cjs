// Run: node_modules/.bin/electron tests/ios-instagram-photo-lifecycle-browser.cjs
// Same-origin fixtures; no live account or network traffic.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const source = fs.readFileSync('ios/VigilSocial/VigilSocial/DOMAdapters.swift', 'utf8');
const guard = source.match(/static let instagramSingleReelGuard = #"""([\s\S]*?)"""#/)[1];

async function main() {
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 390, height: 844, webPreferences: { sandbox: true } });
  win.webContents.session.protocol.handle('https', () => new Response('<!doctype html><html><body></body></html>', {
    headers: { 'content-type': 'text/html' }
  }));
  const run = async code => {
    const result = await win.webContents.executeJavaScript(code);
    await win.webContents.executeJavaScript('new Promise(resolve => setTimeout(resolve, 0))');
    return result;
  };
  const open = async (nested = false) => {
    await win.loadURL('https://www.instagram.com/direct/t/123/');
    await run(guard);
    await run(`document.body.innerHTML = ${JSON.stringify(`
      <style>body{margin:0}img,video{display:block;width:300px;height:240px}
        #viewer{position:fixed;inset:0;background:black}#opened{width:390px;height:600px}</style>
      <main id="thread" role="dialog"><button id="preview"><img src="/preview.svg"></button>
        <article id="chat"><video id="chat-video" src="/chat.mp4"></video><span>A message</span></article>
      </main>`)};
      document.getElementById('preview').onclick=()=>{
        const viewer=document.createElement('div'); viewer.id='viewer';viewer.setAttribute('role','dialog');
        viewer.innerHTML='<article id="selected"><img id="opened" src="/photo.svg"></article>'
          +'<article id="suggestion"><img src="/other.svg"></article>';
        document.body.append(viewer);
      }; document.getElementById('preview').click();
      ${nested ? `const wrapper=document.createElement('article');document.body.append(wrapper);
        wrapper.append(document.getElementById('thread'), document.getElementById('viewer'));
        const selected=document.getElementById('selected');selected.replaceWith(...selected.childNodes);` : ''}`);
    assert.equal(await run(`document.documentElement.dataset.vigilSingleReelKind`), 'p');
    assert.equal(await run(`getComputedStyle(document.getElementById('opened')).visibility`), 'visible');
    assert.equal(await run(`getComputedStyle(document.getElementById('suggestion')).visibility`), 'hidden',
      'the open photo still conceals unselected viewer media');
  };
  await open();
  assert.equal(await run(`getComputedStyle(document.getElementById('chat-video')).visibility`), 'visible',
    'a photo viewer must not hide the retained conversation video');
  await run(`document.getElementById('thread').append(document.getElementById('suggestion'))`);
  assert.equal(await run(`getComputedStyle(document.getElementById('suggestion')).visibility`), 'visible',
    'React recycling a concealed viewer card into the chat releases its old classification');
  await run(`document.getElementById('viewer').style.transform='translateX(110vw)'`);
  assert.equal(await run(`document.documentElement.hasAttribute('data-vigil-single-reel')`), false,
    'an offscreen retained photo viewer releases containment');
  await run(`const oldViewer=document.getElementById('viewer');oldViewer.id='old-viewer';
    oldViewer.querySelectorAll('[id]').forEach(node=>node.id='old-'+node.id);
    document.getElementById('preview').click();`);
  assert.equal(await run(`document.querySelector('[data-vigil-single-reel-scope]').id`), 'viewer',
    'reopening selects the new photo viewer instead of its retained offscreen predecessor');

  await open();
  await run(`history.pushState({}, '', '/direct/t/456/');`);
  assert.deepEqual(await run(`({pinned:document.documentElement.hasAttribute('data-vigil-single-reel'),
    markers:document.querySelectorAll('[data-vigil-single-reel-card], [data-vigil-single-reel-media], [data-vigil-single-reel-scroll], [data-vigil-single-reel-scope]').length,
    chat:getComputedStyle(document.getElementById('chat-video')).visibility})`),
    { pinned:false, markers:0, chat:'visible' }, 'switching chats clears the previous viewer even if its portal is retained');

  // The same DOM node can leave the document before close and return later.
  await open();
  await run(`window.retained=document.getElementById('suggestion');retained.id='retained-suggestion';retained.remove();
    document.getElementById('viewer').remove();`);
  await run(`document.getElementById('thread').append(retained);document.getElementById('preview').click();`);
  assert.equal(await run(`getComputedStyle(retained).visibility`), 'visible',
    'detached cards cannot carry concealment into a later viewer session');
  assert.equal(await run(`getComputedStyle(document.getElementById('suggestion')).visibility`), 'hidden',
    'a later viewer still conceals its own unselected media');

  await open(true);
  assert.deepEqual(await run(`({photo:getComputedStyle(document.getElementById('opened')).visibility,
    chat:getComputedStyle(document.getElementById('chat-video')).visibility,
    other:getComputedStyle(document.getElementById('suggestion')).visibility})`),
    {photo:'visible',chat:'visible',other:'hidden'},
    'card discovery stops at the viewer even when the conversation has an article ancestor');
  win.destroy();
  console.log('Instagram photo viewer lifecycle passed');
}
void main().then(() => app.quit(), error => { console.error(error); app.exit(1); });
