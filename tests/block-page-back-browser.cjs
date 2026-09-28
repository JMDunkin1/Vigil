const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
app.on('window-all-closed', () => {});

async function main() {
  const { blockedPage } = await import('../dist/runtime/src/server/pages.js');
  const { defaultState } = await import('../dist/runtime/src/defaults.js');
  const guard = await fs.readFile('dist/runtime/extension/reddit-review-guard.js', 'utf8');
  const navigation = await fs.readFile('dist/runtime/extension/blocked-navigation.js', 'utf8');
  const server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end(request.url === '/previous'
      ? '<!doctype html><title>Previous page</title><h1>Previous page</h1>'
      : blockedPage({ url: new URL(request.url, 'http://127.0.0.1'), state: defaultState() }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await app.whenReady();
  const base = `http://127.0.0.1:${server.address().port}`;
  const mock = `globalThis.chrome = { runtime: {
    getURL: path => 'chrome-extension://vigil/' + path.replace(/^\\//, ''),
    sendMessage: async () => ({ ok: true, url: 'about:blank' })
  } };`;
  try {
    for (const script of ['', guard, navigation]) {
      const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
      try {
        await win.loadURL(`${base}/previous`);
        await win.loadURL(`${base}/blocked`);
        if (script) await win.webContents.executeJavaScript(mock + script);
        const returned = new Promise(resolve => win.webContents.once('did-finish-load', resolve));
        await win.webContents.executeJavaScript(`document.querySelector('#leaveBlockedPage').click()`);
        await returned;
        assert.equal(win.webContents.getURL(), `${base}/previous`);
        assert.equal(await win.webContents.executeJavaScript('document.querySelector("h1").textContent'), 'Previous page');
      } finally { win.destroy(); }
    }
    const empty = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
    try {
      await empty.loadURL(`${base}/blocked`);
      await empty.webContents.executeJavaScript(`document.querySelector('#leaveBlockedPage').click()`);
      assert.equal(empty.webContents.getURL(), `${base}/blocked`);
      assert.match(await empty.webContents.executeJavaScript('document.querySelector("#vigilBackStatus").textContent'), /previous page/);
    } finally { empty.destroy(); }
    console.log('Real browser Back returns to the previous document for server, content-script, and extension-page handlers; empty tabs retain a clear explanation.');
  } finally { await new Promise(resolve => server.close(resolve)); }
}
void main().then(() => app.quit()).catch(error => { console.error(error); app.exit(1); });
