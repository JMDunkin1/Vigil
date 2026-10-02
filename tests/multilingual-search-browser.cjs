const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');

async function main() {
  const server = http.createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(`<!doctype html>
      <title>Jane Example - Google Search</title><main id="results">
      <a id="unsafe" href="https://script.google.com/macros/s/opaque/exec"><h3>Jane Example <span>فيديو</span> <span>إباحي</span></h3></a>
      <a id="safe" href="https://script.google.com/macros/s/ordinary/exec"><h3>Jane Example <span>فيديو تعليمي</span></h3></a>
      <a id="spicy" href="https://example.org/opaque"><h3><span>Spicy</span> <span>clips</span></h3></a>
      <a id="recipe" href="https://example.org/recipe"><h3><span>Spicy chicken</span> <span>clips</span></h3></a>
      <a id="cream" href="https://example.org/opaque2"><h3><span>Cream pie</span> <span>videos</span></h3></a>
      <a id="dessert" href="https://example.org/recipe2"><h3><span>Banana cream pie</span> <span>video</span></h3></a>
      <a id="nude" href="https://example.org/opaque3"><h3><span>Nude</span> <span>videos</span></h3></a>
      <a id="art" href="https://example.org/art"><h3><span>Nude art drawing</span> <span>videos</span></h3></a>
      <div id="host"></div></main>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await app.whenReady();
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await win.loadURL(`http://127.0.0.1:${server.address().port}/search?q=Jane+Example&safe=active`);
    const filter = await fs.readFile('ios/VigilSocial/VigilYouTubeInteractionExtension/Resources/media-child-lock.js', 'utf8');
    await win.webContents.executeJavaScript(filter);
    assert.deepEqual(await win.webContents.executeJavaScript(`['unsafe','safe','spicy','recipe','cream','dessert','nude','art','results'].map(id => getComputedStyle(document.getElementById(id)).display === 'none')`), [true, false, true, false, true, false, true, false, false]);
    const immediate = await win.webContents.executeJavaScript(`(() => {
      let siteClicks = 0; document.addEventListener('click', () => siteClicks++);
      document.querySelector('#host').attachShadow({mode:'open'}).innerHTML = '<a href="https://script.google.com/macros/s/new/exec"><h3><span>色情</span><span>视频</span></h3></a>';
      const heading = document.querySelector('#host').shadowRoot.querySelector('h3');
      const event = new MouseEvent('click', {bubbles:true, composed:true, cancelable:true});
      heading.dispatchEvent(event);
      return {siteClicks, cancelled:event.defaultPrevented, hidden:getComputedStyle(heading.closest('a')).display === 'none'};
    })()`);
    assert.deepEqual(immediate, { siteClicks: 0, cancelled: true, hidden: true }, 'a newly inserted shadow result is blocked before its observer runs');
    console.log('Split Arabic and contextual English labels concealed; names, cooking, art and result grid preserved; immediate Chinese shadow-link click blocked.');
  } finally {
    win.destroy();
    await new Promise(resolve => server.close(resolve));
  }
}
void main().then(() => app.quit()).catch(error => { console.error(error); app.exit(1); });
