const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'vigil-chrome-parity-browser-'));
app.setPath('userData', userData);
const root = path.resolve('dist/runtime/extension');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const scripts = [...new Set(manifest.content_scripts.filter(entry => entry.world !== 'MAIN')
  .flatMap(entry => entry.js))].filter(name => name !== 'youtube-bridge.js');
let completed = false;
app.on('will-quit', () => {
  if (!completed) { console.error('Browser parity tests were interrupted before completion.'); app.exit(1); }
});
const setup = `globalThis.chrome = { runtime: {
  getURL: () => 'https://vigil-fixture.test/blocked',
  onMessage: { addListener() {} },
  sendMessage(_message, callback) {
    const result = {ok:true, browserNoiseBlockingEnabled:false, focusedSocialCleanupEnabled:false};
    callback?.(result); return Promise.resolve(result);
  }
}}; void 0;`;

async function waitFor(check, label) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out: ${label}`);
}

async function main() {
  await app.whenReady();
  const win = new BrowserWindow({ show:false, webPreferences:{ sandbox:true } });
  const html = '<!doctype html><title>Ordinary catalog</title><body><form method="post"><input type="search" name="q"><button>Search</button></form><a id="safe" href="/ordinary">Ordinary reference</a></body>';
  await win.webContents.session.protocol.handle('https', request => new Response(
    new URL(request.url).hostname === 'vigil-fixture.test' ? '<!doctype html><h1>Blocked</h1>' : html,
    { headers:{'content-type':'text/html'} }
  ));
  async function load(url, frameOnly = false) {
    await win.loadURL(url);
    const names = frameOnly ? manifest.content_scripts.filter(entry => entry.all_frames && entry.world !== 'MAIN'
      && !entry.js.includes('youtube-bridge.js')).flatMap(entry => entry.js) : scripts;
    await win.webContents.executeJavaScriptInIsolatedWorld(999, [
      {code:setup}, ...names.map(name => ({code:fs.readFileSync(path.join(root,name),'utf8') + '\n;void 0;'}))
    ]);
  }
  try {
    // Load the actual packaged scripts together in Chromium's isolated world:
    // one guard must not prevent another from compiling or installing.
    await load('https://catalog.example/');
    assert.equal(await win.webContents.executeJavaScript('getComputedStyle(document.body).visibility'), 'visible');
    assert.equal(win.webContents.getURL(), 'https://catalog.example/');

    for (const query of ['honeytoon', 'adult manhwa', 'mature webtoon', 'p.o.r.n', 'spicy clips', 'naked girls']) {
      await load('https://catalog.example/');
      await win.webContents.executeJavaScript(`document.querySelector('input').value=${JSON.stringify(query)}; document.querySelector('input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));`);
      await waitFor(() => win.webContents.getURL() === 'https://vigil-fixture.test/blocked', `keyword ${query}`);
    }
    for (const query of ['manhwa', 'Middlesex gardening', 'adult education video', 'uncensored interview', 'banana cream pie video']) {
      await load('https://catalog.example/');
      await win.webContents.executeJavaScript(`document.querySelector('input').value=${JSON.stringify(query)}; document.querySelector('input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));`);
      await new Promise(resolve => setTimeout(resolve, 150));
      assert.equal(win.webContents.getURL(), 'https://catalog.example/', query);
    }
    await load('https://catalog.example/');
    await win.webContents.executeJavaScript(`history.pushState({},'', '/search?q=%2568%256F%256E%2565%2579%2574%256F%256F%256E');`);
    await waitFor(() => win.webContents.getURL() === 'https://vigil-fixture.test/blocked', 'encoded SPA keyword');

    // An opaque shared-file URL loses its explicit card label in a new tab.
    // Middle-click must therefore enforce that label in the originating page.
    await load('https://catalog.example/');
    assert.equal(await win.webContents.executeJavaScript(`
      const anchor = document.querySelector('#safe');
      anchor.href = 'https://files.example/content/f41aXXx183bb8b';
      anchor.textContent = 'Nude girls photos';
      !anchor.dispatchEvent(new MouseEvent('auxclick',{button:1,bubbles:true,cancelable:true}));
    `), true, 'middle-click cancels the explicit opaque-file link');
    await waitFor(() => win.webContents.getURL() === 'https://vigil-fixture.test/blocked', 'middle-click explicit card');

    // Only the all-frame manifest groups are present in an embedded document.
    await load('https://reader.toomics.com/chapter', true);
    await waitFor(() => win.webContents.getURL() === 'https://vigil-fixture.test/blocked', 'offline Toomics subdomain');
    await load('https://catalog.example/', true);
    await win.webContents.executeJavaScript(`document.querySelector('input').value='honeytoon'; document.querySelector('form').requestSubmit();`);
    await waitFor(() => win.webContents.getURL() === 'https://vigil-fixture.test/blocked', 'embedded POST search');
    console.log('Packaged Chrome scripts passed Chromium isolated-world startup, keyword actions, ordinary searches, encoded SPA navigation and all-frame domain/POST protection.');
    completed = true;
  } finally { win.destroy(); }
}
void main().then(() => app.quit()).catch(error => { console.error(error); app.exit(1); });
