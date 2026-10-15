// Run with: node_modules/.bin/electron tests/ios-instagram-shared-reel-browser.cjs
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
  const run = code => win.webContents.executeJavaScript(code);
  for (const path of ['/reel/Shared123/', '/p/Shared123/', '/direct/t/123/']) {
    await win.loadURL(`https://www.instagram.com${path}`);
    await run(guard);
    await run(`document.body.innerHTML = ${JSON.stringify(`
      <style>body{margin:0} article,video{display:block;width:390px;height:700px}</style>
      <main ${path.startsWith('/direct/') ? 'role="dialog"' : ''}>
        <article><a href="${path.startsWith('/p/') ? path : '/reel/Shared123/'}"><video id="shared" src="/original.mp4"></video></a></article>
        <article><video id="suggested" src="/suggested.mp4"></video></article>
        <button id="next" aria-label="Next reel">Next</button>
        <button id="like">Like</button><button id="back">Back</button>
        <div data-vigil-instagram-comments-sheet="true"><textarea id="comment"></textarea></div>
      </main>`)};
      window.starts = 0; window.releases = 0; window.clicks = 0;
      for (const type of ['pointerdown', 'touchstart', 'mousedown', 'contextmenu']) {
        document.getElementById('shared').addEventListener(type, () => {
          window.starts++;
          // Model a hold listener that starts loading a recommendation without
          // changing the permalink or waiting for vertical movement.
          document.getElementById('shared').src = '/suggested.mp4';
        });
      }
      for (const type of ['pointerup', 'touchend', 'mouseup']) {
        document.getElementById('shared').addEventListener(type, () => window.releases++);
      }
      document.getElementById('shared').addEventListener('click', () => window.clicks++);
    `);
    const state = await run(`(() => {
      const media = document.getElementById('shared');
      const fire = (target, type, y = 300) => {
        const event = type.startsWith('pointer')
          ? new PointerEvent(type, { bubbles:true, cancelable:true, pointerType:'touch', clientX:100, clientY:y })
          : new Event(type, { bubbles:true, cancelable:true });
        if (type.startsWith('touch')) Object.defineProperty(event, 'touches', {
          value: type === 'touchend' ? [] : [{clientX:100,clientY:y}]
        });
        target.dispatchEvent(event);
        return event.defaultPrevented;
      };
      fire(media, 'pointerdown'); fire(media, 'pointerup');
      fire(media, 'touchstart'); fire(media, 'touchend');
      fire(media, 'mousedown'); fire(media, 'mouseup');
      const menuBlocked = fire(media, 'contextmenu');
      fire(media, 'click');
      fire(media, 'pointerdown');
      const swipeBlocked = fire(media, 'pointermove', 100);
      fire(media, 'pointerup', 100);
      let controls = 0;
      for (const id of ['like','back','comment']) {
        const control = document.getElementById(id);
        control.addEventListener('pointerdown', () => controls++);
        fire(control, 'pointerdown'); fire(control, 'pointerup');
      }
      const nextBlocked = fire(document.getElementById('next'), 'pointerdown');
      history.pushState({}, '', '/reel/Other456/');
      return { starts, releases, clicks, menuBlocked, swipeBlocked, controls, nextBlocked,
        path:location.pathname, source:media.getAttribute('src'),
        visible:getComputedStyle(media).visibility,
        suggested:getComputedStyle(document.getElementById('suggested')).visibility };
    })()`);
    assert.deepEqual(state, {
      starts:0, releases:0, clicks:1, menuBlocked:true, swipeBlocked:true, controls:3, nextBlocked:true,
      path, source:'/original.mp4', visible:'visible', suggested:'hidden'
    }, path);
  }
  console.log('Shared reel hold regressions passed for reel/post permalinks and Direct modals; playback taps, comments, Like, and Back remain usable.');
  win.destroy();
  app.quit();
}
void main().catch(error => { console.error(error); app.exit(1); });
