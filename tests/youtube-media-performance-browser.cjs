const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const assert = require('node:assert/strict');
app.setPath('userData', fs.mkdtempSync('/tmp/vigil-youtube-media-performance-'));
let completed = false;
process.on('exit', () => { if (!completed) process.exitCode = 1; });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  await app.whenReady();
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await win.webContents.session.protocol.handle('https', () => new Response(`<!doctype html><title>YouTube</title>
      <main><div id="player"><video></video><span id="clock">0:00</span></div>
      <form><input id="search" type="search"></form><section id="feed"></section></main>`,
    { headers: { 'content-type': 'text/html' } }));
    await win.loadURL('https://www.youtube.com/watch?v=abcdefghijk');
    await win.webContents.executeJavaScript(`
      document.getElementById('feed').innerHTML = Array.from({length:100},(_,i)=>
        '<article><a href="/watch?v=video'+i+'"><img src="data:," alt="Astronomy tutorial '+i+'"><h3>The science of stars '+i+'</h3></a>'
        +Array.from({length:30},(_,j)=>'<div class="layout"><span>Channel '+i+' episode '+j+'</span></div>').join('')+'</article>').join('');
      window.metrics={matches:0,fullScans:0};
      for (const owner of [Document.prototype, Element.prototype]) {
        const original=owner.querySelectorAll;
        owner.querySelectorAll=function(selector) {
          if(selector==='*'&&(this===document||this===document.documentElement||this===document.body)) metrics.fullScans++;
          return original.call(this,selector);
        };
      }
      // Drive the full health heartbeat explicitly, keeping timing-independent
      // work-count assertions separate from the optional elapsed-time sample.
      window.setInterval=callback=>{window.healthHeartbeat=callback;return 1;};
      window.siteClicks=0;
      document.addEventListener('click',event=>{event.preventDefault();siteClicks++;});
    `);
    const source = fs.readFileSync(process.env.VIGIL_PERF_SOURCE || 'ios/VigilSocial/VigilYouTubeInteractionExtension/Resources/media-child-lock.js', 'utf8')
      .replace('function containsContextualExplicitMedia(value) {', 'function containsContextualExplicitMedia(value) { window.metrics.matches++;');
    const coldMs = await win.webContents.executeJavaScript(`(()=>{const start=performance.now();${source}\nreturn performance.now()-start;})()`);
    await wait(30);
    const steady = await win.webContents.executeJavaScript(`(()=>{
      metrics={matches:0,fullScans:0};const start=performance.now();
      for(let i=0;i<5;i++)window.dispatchEvent(new Event('focus'));
      return {...metrics,ms:performance.now()-start,nodes:document.querySelectorAll('*').length};
    })()`);
    console.log(JSON.stringify({ coldMs, fullHealthScans: steady }));
    assert.equal(steady.fullScans, 10, 'full health scans retain both mixed-platform and general inspection');
    assert.ok(steady.matches < 1000, 'unchanged element text reuses classification without skipping inspection');

    await win.webContents.executeJavaScript(`metrics={matches:0,fullScans:0};
      for(let i=0;i<60;i++){
        document.getElementById('clock').style.transform='translateX('+i+'px)';
        document.getElementById('clock').firstChild.data='0:'+i;
        document.getElementById('player').className='playing state-'+i;
      }`);
    await wait(30);
    let metrics = await win.webContents.executeJavaScript('metrics');
    assert.equal(metrics.fullScans, 0, 'player animation and clock changes do not walk the whole page');
    assert.ok(metrics.matches < 20, 'player changes do not reclassify the feed');

    await win.webContents.executeJavaScript(`metrics={matches:0,fullScans:0};
      for(let i=0;i<30;i++)document.getElementById('search').dispatchEvent(new KeyboardEvent('keydown',{key:'a',bubbles:true,cancelable:true}));`);
    metrics = await win.webContents.executeJavaScript('metrics');
    assert.equal(metrics.fullScans, 0, 'ordinary typing never synchronously scans the feed');
    assert.ok(metrics.matches < 50);

    // Recycled nodes must use current text, attributes and URL, including
    // immediate activation before MutationObserver has delivered its records.
    await win.webContents.executeJavaScript(`document.getElementById('feed').insertAdjacentHTML('afterend',
      '<article id="recycled"><a href="/watch?v=ordinary"><img src="data:," alt="Astronomy"><h3>Stars</h3></a></article>'
      +'<a id="split" href="/watch?v=split"><img src="data:,"><span>Cream</span><span> recipe</span></a>'
      +'<article id="aggregate"><span>Spicy</span><a href="/watch?v=aggregate"> food</a><video></video></article>'
      +'<span id="preference-label">Captions</span><button id="preference" aria-labelledby="preference-label"></button>'
      +'<label id="external-label" for="external-input">Captions</label><input id="external-input" type="checkbox">'
      +'<button id="nested-button"><span>Show comments</span></button>'
      +'<div role="group" id="group"><span>Captions</span><button>Show</button></div>');`);
    await wait(30);
    await win.webContents.executeJavaScript(`
      document.querySelector('#recycled h3').firstChild.data='NSFW videos';
      document.querySelector('#recycled a').click();
      document.querySelector('#split span:last-child').firstChild.data=' pie videos';
      document.getElementById('split').click();
      document.querySelector('#aggregate a').textContent=' clips';
      document.querySelector('#aggregate a').click();`);
    assert.equal(await win.webContents.executeJavaScript('siteClicks'), 0, 'all three newly unsafe targets block before observer delivery');
    assert.deepEqual(await win.webContents.executeJavaScript(`['recycled','split','aggregate'].map(id=>getComputedStyle(document.getElementById(id)).display==='none')`), [true, true, true]);

    await win.webContents.executeJavaScript(`
      document.getElementById('preference-label').firstChild.data='Show sensitive media';
      document.getElementById('external-label').firstChild.data='Show sensitive media';
      document.querySelector('#nested-button span').firstChild.data='Show sensitive media';
      document.querySelector('#group span').firstChild.data='Show sensitive media';
    `);
    await wait(30);
    assert.equal(await win.webContents.executeJavaScript(`getComputedStyle(document.getElementById('preference')).display`), 'none', 'external accessible labels invalidate their dependent controls');
    assert.deepEqual(await win.webContents.executeJavaScript(`['external-input','nested-button','group'].map(id=>getComputedStyle(document.getElementById(id)).display==='none')`), [true, true, true], 'external form labels, nested buttons and preference groups retain enforcement');

    await win.webContents.executeJavaScript(`
      document.getElementById('feed').insertAdjacentHTML('afterend','<article id="attribute"><img src="data:," alt="Stars"></article><div id="shadow-host"></div>');
      document.querySelector('#attribute img').setAttribute('alt','NSFW videos');
      document.getElementById('shadow-host').attachShadow({mode:'open'}).innerHTML='<article id="shadow-unsafe"><h3>NSFW videos</h3><video></video></article><article id="shadow-safe">Stars</article>';
    `);
    await wait(30);
    assert.equal(await win.webContents.executeJavaScript(`getComputedStyle(document.getElementById('attribute')).display`), 'none', 'new alt text still blocks its media container');
    assert.deepEqual(await win.webContents.executeJavaScript(`['shadow-unsafe','shadow-safe'].map(id=>getComputedStyle(document.getElementById('shadow-host').shadowRoot.getElementById(id)).display==='none')`), [true, false], 'new shadow roots are inspected in the same pass');
    await win.webContents.executeJavaScript(`document.getElementById('shadow-host').shadowRoot.getElementById('shadow-safe').textContent='NSFW videos';`);
    await wait(30);
    assert.equal(await win.webContents.executeJavaScript(`getComputedStyle(document.getElementById('shadow-host').shadowRoot.getElementById('shadow-safe')).display`), 'none', 'shadow-root text changes retain enforcement');

    assert.equal(await win.webContents.executeJavaScript(`getComputedStyle(document.getElementById('feed').firstElementChild).display`), 'block', 'ordinary neighboring feed content stays usable');
    await win.webContents.executeJavaScript(`metrics={matches:0,fullScans:0};healthHeartbeat();`);
    assert.ok((await win.webContents.executeJavaScript('metrics.fullScans')) >= 2, 'full periodic enforcement remains active after incremental scans');
    completed = true;
    console.log('YouTube performance and dynamic enforcement checks passed.');
  } finally { win.destroy(); }
}
void main().then(() => app.quit()).catch(error => { console.error(error); app.exit(1); });
