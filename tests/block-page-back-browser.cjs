const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
app.on('window-all-closed', () => {});

async function configureSurface(win, script, reply = { ok: true, url: 'about:blank' }) {
  if (!script) return;
  await win.webContents.executeJavaScript(`(() => {
    const fixture = globalThis.__vigilBackFixture ||= { installed: false };
    fixture.reply = ${JSON.stringify(reply)};
    if (fixture.installed) return;
    // Installed handlers retain this runtime, including across BFCache restores.
    // Change its reply without replacing the API or adding competing handlers.
    globalThis.chrome = { runtime: {
      getURL: path => 'chrome-extension://vigil/' + path.replace(/^\\//, ''),
      sendMessage: async () => fixture.reply
    } };
    ${script}
    fixture.installed = true;
  })()`);
}

const loaded = (win, expectedURL, scenario) => new Promise((resolve, reject) => {
  const completedLoads = [];
  const timeout = setTimeout(() => {
    win.webContents.removeListener('did-finish-load', finish);
    reject(new Error(`Back navigation did not finish: ${scenario}; expected=${JSON.stringify(expectedURL)}; actual=${JSON.stringify(win.webContents.getURL())}; completedLoads=${JSON.stringify(completedLoads)}`));
  }, 10000);
  const finish = () => {
    const actualURL = win.webContents.getURL();
    completedLoads.push(actualURL);
    if (actualURL !== expectedURL) return;
    clearTimeout(timeout); win.webContents.removeListener('did-finish-load', finish); resolve();
  };
  win.webContents.on('did-finish-load', finish);
});

async function main() {
  const { blockedPage } = await import('../dist/runtime/src/server/pages.js');
  const { defaultState } = await import('../dist/runtime/src/defaults.js');
  const guard = await fs.readFile('dist/runtime/extension/reddit-review-guard.js', 'utf8');
  const navigation = await fs.readFile('dist/runtime/extension/blocked-navigation.js', 'utf8');
  const server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end(request.url === '/previous' || request.url === '/earlier'
      ? '<!doctype html><title>Previous page</title><h1>Previous page</h1>'
      : request.url.startsWith('/trap-')
      ? `<!doctype html><title>Denied history entry</title><script>
          const key = ${JSON.stringify('trap-')} + location.pathname;
          const bounce = () => location.${request.url === '/trap-replace' ? 'replace' : 'assign'}('/blocked');
          addEventListener('pageshow', event => { if (event.persisted) bounce(); });
          if (sessionStorage.getItem(key)) bounce();
          else sessionStorage.setItem(key, 'visited');
        </script>`
      : blockedPage({ url: new URL(request.url, 'http://127.0.0.1'), state: defaultState() }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await app.whenReady();
  const base = `http://127.0.0.1:${server.address().port}`;
  const surfaces = [['server', ''], ['content guard', guard], ['extension page', navigation]];
  try {
    for (const [surface, script] of surfaces) {
      for (const longerHistory of [false, true]) {
        const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
        try {
          if (longerHistory) await win.loadURL(`${base}/earlier`);
          await win.loadURL(`${base}/previous`);
          for (const visit of [1, 2]) {
            await win.loadURL(`${base}/blocked?visit=${visit}`);
            await configureSurface(win, script);
            const scenario = `${surface}, ${longerHistory ? 'long' : 'short'} history, fresh visit ${visit}`;
            const returned = loaded(win, `${base}/previous`, `${scenario}, Back`);
            await win.webContents.executeJavaScript(`document.querySelector('#leaveBlockedPage').click()`);
            await returned;
            assert.equal(win.webContents.getURL(), `${base}/previous`, 'a fresh block visit after successful Back still returns to the exact safe page');
            assert.equal(await win.webContents.executeJavaScript('document.querySelector("h1").textContent'), 'Previous page');
            if (visit === 1) {
              const forwarded = loaded(win, `${base}/blocked?visit=1`, `${scenario}, Forward`);
              win.webContents.navigationHistory.goForward();
              await forwarded;
              await configureSurface(win, script);
              const backAgain = loaded(win, `${base}/previous`, `${scenario}, Back after Forward`);
              await win.webContents.executeJavaScript(`document.querySelector('#leaveBlockedPage').click()`);
              await backAgain;
              assert.equal(win.webContents.getURL(), `${base}/previous`, 'browser Forward to the original blocker cannot skip the safe page on its next Back');
            }
          }
        } finally { win.destroy(); }
      }
    }
    for (const [surface, script] of surfaces) {
      for (const mode of ['replace', 'assign']) {
        const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
        try {
          await win.loadURL(`${base}/previous`);
          await win.loadURL(`${base}/trap-${mode}`);
          await win.loadURL(`${base}/blocked`);
          await configureSurface(win, script);
          const scenario = `${surface}, ${mode} bounce`;
          let returned = loaded(win, `${base}/blocked`, `${scenario}, initial Back`);
          await win.webContents.executeJavaScript(`document.querySelector('#leaveBlockedPage').click()`);
          await returned;
          assert.equal(win.webContents.getURL(), `${base}/blocked`, 'fixture reproduces the denied-entry bounce');
          await configureSurface(win, script);
          returned = loaded(win, `${base}/${mode === 'replace' ? 'previous' : 'blocked'}`, `${scenario}, unverified retry`);
          await win.webContents.executeJavaScript(`document.querySelector('#leaveBlockedPage').click()`);
          await returned;
          if (mode === 'replace') {
            assert.equal(win.webContents.getURL(), `${base}/previous`, 'retry skips a positively identified replacement bounce');
          } else {
            assert.equal(win.webContents.getURL(), `${base}/blocked`, 'an unverified appended redirect remains ambiguous with a fresh visit and retains one-step Back');
            if (script) {
              await configureSurface(win, script, { ok: true, url: `${base}/previous` });
              returned = loaded(win, `${base}/previous`, `${scenario}, verified return`);
              await win.webContents.executeJavaScript(`document.querySelector('#leaveBlockedPage').click()`);
              await returned;
              assert.equal(win.webContents.getURL(), `${base}/previous`, 'a verified destination still escapes an appended redirect bounce');
            }
          }
        } finally { win.destroy(); }
      }
    }
    for (const [, script] of surfaces.filter(([, script]) => script)) {
      const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
      try {
        await win.loadURL(`${base}/previous`);
        await win.loadURL(`${base}/blocked`);
        await configureSurface(win, script, { ok: true, url: 'about:blank', exhausted: true });
        await win.webContents.executeJavaScript(`document.querySelector('#leaveBlockedPage').click()`);
        assert.equal(win.webContents.getURL(), `${base}/blocked`, 'verified exhausted history does not revisit denied pages');
        assert.equal(await win.webContents.executeJavaScript('document.querySelector("#vigilBackStatus").hidden'), true, 'block page retains only Blocked and Back as visible text');
      } finally { win.destroy(); }
    }
    const empty = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
    try {
      await empty.loadURL(`${base}/blocked`);
      await empty.webContents.executeJavaScript(`document.querySelector('#leaveBlockedPage').click()`);
      assert.equal(empty.webContents.getURL(), `${base}/blocked`);
      assert.match(await empty.webContents.executeJavaScript('document.querySelector("#vigilBackStatus").textContent'), /previous page/);
    } finally { empty.destroy(); }
    console.log('Real browser Back handles fresh visits, replacement bounces, conservative unverified assign bounces, verified returns, exhausted history, and empty tabs.');
  } finally { await new Promise(resolve => server.close(resolve)); }
}
void main().then(() => app.quit()).catch(error => { console.error(error); app.exit(1); });
