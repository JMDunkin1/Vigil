const {app, BrowserWindow} = require('electron');
const fs = require('node:fs');
const assert = require('node:assert/strict');
app.setPath('userData', fs.mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'vigil-platform-browser-')));
const source = fs.readFileSync('ios/VigilSocial/VigilYouTubeInteractionExtension/Resources/media-child-lock.js', 'utf8');
async function main() {
  await app.whenReady();
  const win = new BrowserWindow({show:false, webPreferences:{sandbox:true}});
  await win.webContents.session.protocol.handle('https', () => new Response('<!doctype html><body></body>', {headers:{'content-type':'text/html'}}));
  for (const host of ['x.com', 'twitter.com', 'bsky.app', 'pixiv.net', 'patreon.com', 'itch.io', 'creator.itch.io', 'discord.com']) {
    await win.loadURL(`https://${host}/`);
    await win.webContents.executeJavaScript(`document.body.innerHTML = \`
      <main id="feed">
        <article id="ordinary"><h2>Adult education and Middlesex gardening</h2><button id="comments">Show comments</button></article>
        <article id="explicit"><h2>Erotic story</h2><audio></audio></article>
        <div id="marked" data-nsfw="true"><img src="data:,"></div>
        <article id="warning"><span>Sexually explicit content</span><button>Show</button><video></video></article>
        <div class="game_cell" id="game"><span>R-18</span><img src="data:,"></div>
        <div id="chat-messages-unsafe"><p>NSFW pictures</p><img src="data:,"></div>
        <div id="chat-messages-safe"><p>Meeting at noon</p><button>Reply</button></div>
        <div role="dialog" id="age"><h2>Age-restricted channel</h2><button>Continue</button></div>
        <label id="setting">Display sensitive media<input type="checkbox" checked></label>
        <fieldset id="preference"><legend>Adult content</legend><label>Hide<input type="radio"></label><label>Show<input type="radio"></label></fieldset>
        <label id="safe-search">Safe Search<input type="checkbox" checked></label>
        <button id="age-confirm">I am over 18</button>
        <button id="safe-spoiler">Show spoiler</button>
        <article id="author" data-author="ArtistNSFW"><h2>New work</h2><video></video></article><article id="cross-shadow"><video></video><div id="nested-author"></div></article><div id="shadow-host"></div><div id="late-mark" data-nsfw="false">Photo</div>
        <textarea id="composer">Discuss adult content restrictions</textarea>
      </main>\`;
      window.actions=0;
      for (const type of ['click', 'keydown', 'submit', 'change']) document.addEventListener(type, () => window.actions++);
      document.querySelector('#nested-author').attachShadow({mode:'open'}).innerHTML='<span class="author">ArtistXXX</span>';
      document.querySelector('#shadow-host').attachShadow({mode:'open'}).innerHTML='<article id="shadow-adult"><span>Adult content</span><button>View</button></article><article id="shadow-safe">Tomatoes</article>';
    `);
    await win.webContents.executeJavaScript(source);
    const hidden = await win.webContents.executeJavaScript(`['feed','ordinary','explicit','marked','warning','game','chat-messages-unsafe','chat-messages-safe','age','setting','preference','safe-search','age-confirm','safe-spoiler','composer','late-mark','author','cross-shadow'].map(id=>getComputedStyle(document.getElementById(id)).display==='none')`);
    assert.deepEqual(hidden, [false,false,true,true,true,true,true,false,true,true,true,true,true,false,false,false,true,true], host);
    assert.deepEqual(await win.webContents.executeJavaScript(`['shadow-adult','shadow-safe'].map(id=>getComputedStyle(document.querySelector('#shadow-host').shadowRoot.getElementById(id)).display==='none')`), [true,false], host);
    await win.webContents.executeJavaScript(`document.body.insertAdjacentHTML('beforeend','<article id="late"><span>This post may contain sensitive content</span><button>Show</button></article>'); document.querySelector('#late button').click();
      document.querySelector('#late button').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
      document.querySelector('#late-mark').setAttribute('data-nsfw','true');
      document.querySelector('#late-mark').dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));
      document.querySelector('#shadow-host').shadowRoot.innerHTML='<article id="shadow-late"><span>R-18</span><button>View</button></article>';
      document.querySelector('#shadow-host').shadowRoot.querySelector('button').dispatchEvent(new MouseEvent('click',{bubbles:true,composed:true,cancelable:true}));
    `);
    assert.equal(await win.webContents.executeJavaScript('window.actions'), 0, `${host}: immediate actions blocked`);
    await win.webContents.executeJavaScript(`document.querySelector('#comments').click(); document.querySelector('#safe-spoiler').click();`);
    assert.equal(await win.webContents.executeJavaScript('window.actions'), 2, `${host}: ordinary interactions preserved`);
    await win.webContents.executeJavaScript(`document.querySelector('#ordinary h2').textContent='R-18 story';`);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await win.webContents.executeJavaScript(`getComputedStyle(document.querySelector('#ordinary')).display`), 'none', `${host}: changing text`);
    console.log(`${host}: labels, text/audio cards, age gates, preferences, shadow roots, immediate actions and ordinary content passed`);
  }
  win.destroy();
  app.quit();
}
void main().catch(error => {console.error(error); app.exit(1);});
