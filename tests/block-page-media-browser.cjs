const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');

async function main() {
  const { blockedPage } = await import('../dist/runtime/src/server/pages.js');
  const { defaultState } = await import('../dist/runtime/src/defaults.js');
  const filter = await fs.readFile('ios/VigilSocial/VigilYouTubeInteractionExtension/Resources/media-child-lock.js', 'utf8');
  const server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end(blockedPage({
      url: new URL(request.url, 'http://127.0.0.1'),
      state: defaultState()
    }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await app.whenReady();
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    for (const label of ['This page', 'NSFW', 'OnlyFans', 'Porn']) {
      await win.loadURL(`http://127.0.0.1:${server.address().port}/blocked?site=${encodeURIComponent(label)}&kind=adult-blocklist`);
      await win.webContents.executeJavaScript(filter);
      // Also exercise the mutation scan while the block explanation is visible.
      await win.webContents.executeJavaScript(`document.querySelector('.reason').append(' NSFW content stays blocked.');`);
      await new Promise(resolve => setTimeout(resolve, 100));
      const visible = await win.webContents.executeJavaScript(`(() => {
        const shown = element => element.getBoundingClientRect().height > 0
          && getComputedStyle(element).visibility === 'visible';
        return {
          panel: shown(document.querySelector('main')),
          heading: shown(document.querySelector('h1')),
          reasonHidden: !shown(document.querySelector('.reason')),
          back: shown(document.querySelector('#leaveBlockedPage'))
        };
      })()`);
      assert.deepEqual(visible, { panel: true, heading: true, reasonHidden: true, back: true }, label);
      // Filtering must still run on the very same page; a marker is no bypass.
      await win.webContents.executeJavaScript(`document.body.insertAdjacentHTML('beforeend', '<article id="unsafe"><img src="data:," alt="poster"><h2>NSFW videos</h2></article>');`);
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(await win.webContents.executeJavaScript(`getComputedStyle(document.querySelector('#unsafe')).display`), 'none');
    }
    console.log('Block page remains visible with flagged labels and changing explanations; media filtering stays active.');
  } finally {
    win.destroy();
    await new Promise(resolve => server.close(resolve));
  }
}

void main().then(() => app.quit()).catch(error => { console.error(error); app.exit(1); });
