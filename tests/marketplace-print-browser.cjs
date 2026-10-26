const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const assert = require('node:assert/strict');
let completed = false;
process.on('exit', () => {
  if (!completed) { process.stderr.write('Marketplace browser fixture exited before completion.\n'); process.exitCode = 1; }
});

async function main() {
  await app.whenReady();
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  win.webContents.on('console-message', details => { if (details.level === 'error') console.error(details.message); });
  await win.webContents.session.protocol.handle('https', () => new Response('<!doctype html><title>Print catalog</title><main><ul id="results"></ul></main>', { headers: { 'content-type': 'text/html' } }));
  const guard = fs.readFileSync('ios/VigilSocial/VigilYouTubeInteractionExtension/Resources/media-child-lock.js', 'utf8');
  for (const [host, attributes, path] of [
    ['www.etsy.com', 'class="v2-listing-card" data-listing-id="123"', '/listing/123/item'],
    ['www.ebay.com', 'class="s-card"', '/itm/123'],
    ['www.amazon.com', 'data-component-type="s-search-result" data-asin="B012345678"', '/dp/B012345678']
  ]) {
    await win.loadURL(`https://${host}/`);
    const card = (id, title, attr = attributes) => host === 'www.etsy.com' && attr
      ? `<li id="${id}"><div><div ${attr}><div class="listing-link" data-listing-id="123"><a data-listing-id="123" href="${path}"><img src="data:," alt="Product"></a></div><h3><a href="${path}">${title}</a></h3></div><button>Buy</button></div></li>`
      : `<li id="${id}" ${attr}><a href="${path}"><img src="data:," alt="Product"></a><h3><a href="${path}">${title}</a></h3><button>Buy</button></li>`;
    const html = card('lingerie', '<span>Pink Thong Lingerie</span> <span>Photo Print (Mature)</span>')
      + card('mature', 'Art Photo Print (Mature)')
      + card('sexy', 'Signed Autographed Sexy8x10 Photo with COA')
      + card('safe', 'Henry Danger Family Movie Poster')
      + card('sewing', 'Lingerie sewing pattern print')
      + card('alt', 'Untitled')
      + card('late', 'Untitled')
      + card('etsy-li', 'Lingerie Model Woman, 8x10 Photo', '')
      + (host === 'www.etsy.com' ? '<li id="reviewed"><a href="/listing/4596079411/neutral-title"><img src="data:,"></a><h3>A neutral title</h3><button>Buy</button></li>' : '')
      + '<li><div id="shadow-host"></div></li>';
    await win.webContents.executeJavaScript(`document.getElementById('results').innerHTML = ${JSON.stringify(html)};
      document.querySelector('#alt img').alt = 'Provocative Digital Wall Art Print';
      document.getElementById('shadow-host').attachShadow({mode:'open'}).innerHTML = ${JSON.stringify(card('shadow', 'Shibari Rope Art Poster'))};
      window.siteClicks = 0; document.addEventListener('click', event => { event.preventDefault(); window.siteClicks++; });`);
    await win.webContents.executeJavaScript(guard);
    const hidden = async ids => win.webContents.executeJavaScript(`${JSON.stringify(ids)}.map(id => getComputedStyle(document.getElementById(id)).display === 'none')`);
    assert.deepEqual(await hidden(['lingerie', 'mature', 'sexy', 'alt', 'safe', 'sewing', 'results']), [true, true, true, true, false, false, false], host);
    assert.equal(await win.webContents.executeJavaScript(`getComputedStyle(document.getElementById('shadow-host').shadowRoot.getElementById('shadow')).display`), 'none', `${host}: shadow product card`);
    if (host === 'www.etsy.com') assert.deepEqual(await hidden(['etsy-li']), [true], 'Etsy list items without a card class still hide with their media');
    if (host === 'www.etsy.com') assert.deepEqual(await hidden(['reviewed']), [true], 'reviewed explicit imagery hides its card despite a neutral title');
    await win.webContents.executeJavaScript(`document.querySelector('#late h3 a').innerHTML = '<span>Lingerie</span> <span>Photo Print</span>';
      document.getElementById('results').insertAdjacentHTML('beforeend', ${JSON.stringify(card('immediate', 'Boudoir Photo Print'))});
      document.querySelector('#immediate img').click();`);
    assert.equal(await win.webContents.executeJavaScript('window.siteClicks'), 0, `${host}: immediate navigation is blocked before the observer runs`);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepEqual(await hidden(['late', 'immediate', 'safe', 'results']), [true, true, false, false], `${host}: dynamic cards`);
  }
  console.log('Amazon, eBay and Etsy: full cards, split labels, alt text, shadow roots, late changes and immediate navigation passed; ordinary adjacent products preserved.');
  completed = true;
  win.destroy();
  app.quit();
}
void main().catch(error => { console.error(error); app.exit(1); });
