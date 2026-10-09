// Offline DOM fixtures. Set VIGIL_DOM_MODULE to an external jsdom installation
// when it is not installed in the workspace; these fixtures make no requests.
const { JSDOM } = require(process.env.VIGIL_DOM_MODULE || 'jsdom');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { createContext, runInContext } = require('node:vm');
const { webcrypto } = require('node:crypto');
const reportPath = process.env.VIGIL_CONTEXT_TEST_REPORT;

async function main() {
  const guard = await fs.readFile(process.env.VIGIL_CONTEXT_GUARD || 'dist/runtime/extension/google-safe-search.js', 'utf8');
  const windows = [];
  const storageListeners = new WeakMap();
  const evidenceKey = 'vigil-safe-search-subjects-v1';
  const blocked = 'https://blocked.invalid/blocked.html';
  const notice = '<div id="topstuff"><div role="status" id="notice">Some results have been limited by SafeSearch.</div></div>';
  const files = '<a href="https://mega.nz/folder/fixture#key">https://mega.nz/folder/fixture#key</a><a href="https://gofile.io/d/fixture">https://gofile.io/d/fixture</a>';
  async function page(url, html, saved = {}, sharedStorage, options = {}) {
    const dom = new JSDOM(`<title>Jane Example</title>${html}`, {url, pretendToBeVisual: true});
    const window = dom.window;
    // jsdom parses and observes real DOM but has no layout engine.
    window.Element.prototype.getClientRects = function () { return this.closest('[hidden]') ? [] : [{}]; };
    const redirects = [];
    const storage = sharedStorage || { [evidenceKey]: saved };
    if (!storageListeners.has(storage)) storageListeners.set(storage, new Set());
    const listeners = storageListeners.get(storage);
    const notifyStorage = changes => { for (const listener of listeners) listener(changes, 'local'); };
    const chrome = {
      runtime: { getURL: () => blocked },
      storage: { onChanged: { addListener: listener => listeners.add(listener) }, local: {
        get: async keys => {
          const result = keys === null ? storage : Object.fromEntries([].concat(keys).map(key => [key, storage[key]]));
          if (options.storageReadGate) await options.storageReadGate;
          return JSON.parse(JSON.stringify(result));
        },
        set: async value => {
          const next = JSON.parse(JSON.stringify(value));
          const changes = Object.fromEntries(Object.entries(next).map(([key, newValue]) => [key, { oldValue: storage[key], newValue }]));
          Object.assign(storage, next);
          notifyStorage(changes);
        },
        remove: async keys => {
          const changes = Object.fromEntries([].concat(keys).map(key => [key, { oldValue: storage[key] }]));
          for (const key of [].concat(keys)) delete storage[key];
          notifyStorage(changes);
        }
      }}
    };
    const context = createContext({ URL, URLSearchParams, document: window.document,
      Element: window.Element, HTMLFormElement: window.HTMLFormElement, HTMLInputElement: window.HTMLInputElement, HTMLButtonElement: window.HTMLButtonElement, FormData: window.FormData, MouseEvent: window.MouseEvent, NodeFilter: window.NodeFilter, MutationObserver: window.MutationObserver,
      getComputedStyle: window.getComputedStyle.bind(window), crypto: webcrypto,
      location: {href: url, replace: target => redirects.push(target), assign: target => redirects.push(target)},
      addEventListener: window.addEventListener.bind(window),
      setTimeout: window.setTimeout.bind(window), setInterval() {}, console, chrome
    });
    if (options.clock) context.Date = class extends Date { static now() { return options.clock.now; } };
    const win = {webContents: {executeJavaScript: async code => runInContext(code, context)}, destroy: () => window.close()};
    windows.push(win);
    await win.webContents.executeJavaScript(guard);
    await new Promise(resolve => setTimeout(resolve, 180));
    return { win, redirects, storage };
  }
  const query = text => `https://www.google.com/search?q=${encodeURIComponent(text)}&safe=active`;
  try {
    for (const metadata of [
      '<input type="hidden" name="ei" value="AQpornTracked">',
      '<input type="hidden" name="ved" value="nsfwRandomTracking">',
      '<input hidden name="suggestion" value="naked girls">',
      '<input type="submit" name="btnK" value="Search naked girls">',
      '<input type="checkbox" name="preference" value="nsfw">',
      '<input disabled name="suggestion" value="naked girls">',
      '<input style="display:none" name="suggestion" value="naked girls">'
    ]) {
      const html = `<title>cars - Google Search</title><form id="search-form" action="https://www.google.com/search" role="search"><textarea name="q">cars</textarea>${metadata}<button>Search</button></form>`;
      const cars = await page(query('cars'), html);
      assert.deepEqual(cars.redirects, [], `non-query metadata must not block cars on arrival: ${metadata}`);
      await cars.win.webContents.executeJavaScript('document.querySelector("form").dispatchEvent(new MouseEvent("submit", {bubbles:true,cancelable:true}))');
      assert.ok(!cars.redirects.includes(blocked), `non-query metadata must not block cars on submission: ${metadata}`);
      for (const target of cars.redirects) assert.equal(new URL(target).searchParams.get('q'), 'cars');
    }
    for (const field of ['<input type="search" name="q" value="naked girls">', '<input type="hidden" name="q" value="naked girls">', '<input type="hidden" name="q[]" value="naked girls">']) {
      const html = `<form action="https://www.google.com/search">${field}<button>Search</button></form>`;
      const explicit = await page(query('cars'), html);
      await explicit.win.webContents.executeJavaScript('document.querySelector("form").dispatchEvent(new MouseEvent("submit", {bubbles:true,cancelable:true}))');
      assert.ok(explicit.redirects.includes(blocked), `real explicit query fields remain blocked: ${field}`);
    }
    for (const html of ['<div role="status">SafeSearch on</div>', '<div role="status">SafeSearch blurring is on</div>', `<div id="rso">${notice}</div>`, notice.replace('id="notice"', 'id="notice" hidden')]) {
      assert.deepEqual((await page(query('Jane Example photos'), html)).redirects, [], 'settings, quoted results and hidden notices supply no evidence');
    }
    for (const html of [
      `<blockquote>${notice}</blockquote>`,
      `<div role="status"><q>Some results have been limited by SafeSearch.</q></div>`,
      `<figure><figcaption>${notice}</figcaption></figure>`,
      '<div id="topstuff"><div role="status">No results have been limited by SafeSearch.</div></div>',
      '<div role="status">No explicit results were removed by SafeSearch.</div>',
      '<div role="status">If results are filtered by SafeSearch, open settings.</div>',
      '<div role="status">Help: "Some results have been limited by SafeSearch" means Google filtered results.</div>',
      '<div role="status">Some results have been limited by SafeSearch is an example notification.</div>',
      '<div id="topstuff"><q>Some results have been limited by SafeSearch.</q>SafeSearch on</div>'
    ]) {
      const quoted = await page(query('Jane Example photos'), html);
      assert.deepEqual(quoted.redirects, [], 'quoted, negated and conditional notice text does not create evidence');
      assert.equal(Object.values(quoted.storage).some(value => value && typeof value.subject === 'string'), false, 'untrusted notices cannot seed future blocks');
    }
    assert.ok((await page(query('Jane Example photos'), '<div role="status">Some results have been limited by <a href="https://www.google.com/safesearch">SafeSearch</a>. Learn more</div>')).redirects.includes(blocked), 'a genuine notice can link its SafeSearch label');
    assert.ok((await page(query('Jane Example photos'), `<main id="search">${notice}</main>`)).redirects.includes(blocked), 'real notice inside Google search container blocks the contributing query');
    for (const text of ['sex', 'sexual', 'nude', 'nudity', 'fetish', 'leaks', 'cream pie', 'mature', 'uncensored', 'steamy', 'spicy', 'adult', 'nude art', 'uncensored interview', 'medical anatomy photos', 'adult education', 'spicy chicken videos']) {
      assert.deepEqual((await page(query(text), '<main>Ordinary results</main>')).redirects, [], `ambiguous search without a popup stays available: ${text}`);
      assert.ok((await page(query(text), notice + '<main>Limited results</main>')).redirects.includes(blocked), `ambiguous search plus popup blocks without a name or file links: ${text}`);
    }
    for (const text of ['sensual', 'lingerie', 'underwear', 'bikini', 'cosplay', 'doujinshi', 'furry', 'waifu', 'women', 'models', 'feet', 'breasts', 'nipples', 'penis', 'vagina', 'bdsm', 'bondage', 'masturbation', 'oral', 'anal', 'sexting', 'unfiltered', 'gifs', 'wallpapers', 'livestreams']) {
      assert.deepEqual((await page(query(text), '<main>Ordinary results</main>')).redirects, [], `expanded ambiguous word needs evidence: ${text}`);
      assert.ok((await page(query(text), notice)).redirects.includes(blocked), `expanded word with verified SafeSearch notice blocks: ${text}`);
      for (const html of ['<div role="status">SafeSearch is on</div>', `<div id="rso">${notice}</div>`, notice.replace('id="notice"', 'id="notice" hidden')]) {
        assert.deepEqual((await page(query(text), html)).redirects, [], `expanded word plus settings, snippet or hidden notice stays available: ${text}`);
      }
    }
    for (const text of ['gardening', 'Middlesex', 'sextant', 'photosynthesis']) {
      assert.deepEqual((await page(query(text), notice)).redirects, [], `the popup alone or an embedded substring is insufficient: ${text}`);
    }
    for (const text of ['na\u2060ked', 'na\u00adked', 'na\u202eked', 'náked', 'nak3d']) {
      assert.deepEqual((await page(query(text), '<main>Ordinary results</main>')).redirects, [], `normalizing ambiguous vocabulary does not ban it alone: ${text}`);
      assert.ok((await page(query(text), notice)).redirects.includes(blocked), `normalizing ambiguous vocabulary enforces real notice evidence: ${text}`);
    }
    const name = await page(query('Jane Example'), notice + '<main><a id="photo" href="https://justpaste.it/fixture">Jane Example photos and links</a></main>');
    assert.deepEqual(name.redirects, [], 'the name alone is searchable');
    const stored = Object.fromEntries(Object.values(name.storage).filter(value => value && typeof value.subject === 'string')
      .map(value => [value.subject, value.observedAt]));
    assert.ok(stored['jane example']);
    for (const [url, html, surface] of [
      ['https://www.bing.com/search?q=Jane+Example+photos', '<main>Results</main>', 'non-Google search URL'],
      ['https://www.bing.com/search?q=ordinary', '<input type="search" name="q" value="Jane Example photos"><main>Results</main>', 'populated search control']
    ]) {
      let releaseEvidence;
      const storageReadGate = new Promise(resolve => { releaseEvidence = resolve; });
      const delayed = await page(url, html, stored, undefined, { storageReadGate });
      assert.deepEqual(delayed.redirects, [], `${surface} waits for evidence rather than assuming it`);
      releaseEvidence();
      await new Promise(resolve => setTimeout(resolve, 180));
      assert.ok(delayed.redirects.includes(blocked), `${surface} is rechecked after delayed cached evidence arrives`);
    }
    const click = await name.win.webContents.executeJavaScript(`(() => {
      let siteClicks = 0; document.addEventListener('click', () => siteClicks++);
      const event = new MouseEvent('click', {bubbles:true, cancelable:true});
      document.querySelector('#photo').dispatchEvent(event);
      return {siteClicks, cancelled:event.defaultPrevented};
    })()`);
    assert.deepEqual(JSON.parse(JSON.stringify(click)), { siteClicks: 0, cancelled: true }, 'unsafe link activation is cancelled before site handlers');
    assert.ok((await page(query('Jane Example albums'), '<main>Results</main>', stored)).redirects.includes(blocked), 'same topic retains recent evidence');
    assert.deepEqual((await page(query('Mary Example photos'), '<main>Results</main>', stored)).redirects, [], 'evidence cannot spill into another topic');
    assert.deepEqual((await page(query('Jáne Example photos'), '<main>Results</main>', stored)).redirects, [], 'accents in a real name cannot inherit another subject’s evidence');
    assert.deepEqual((await page(query('Jane Example Foundation photos'), '<main>Results</main>', stored)).redirects, [], 'a longer subject cannot inherit exact-subject query evidence');
    for (const text of ['Ja\u2060ne Example photos', 'Ja\u00adne Example photos', 'Jane Example ph0t0s', 'Jane Example phótos']) {
      assert.ok((await page(query(text), '<main>Results</main>', stored)).redirects.includes(blocked), `invisible name separators cannot bypass cached evidence: ${text}`);
    }
    assert.deepEqual((await page(query('Jane Example news photos'), '<main>Results</main>', stored)).redirects, [], 'unflagged ordinary news context remains searchable');
    assert.ok((await page(query('Jane Example news photos'), notice, stored)).redirects.includes(blocked), 'ordinary wording cannot cancel a real popup plus ambiguous terms');
    assert.deepEqual((await page(query('Jane Example photos'), '<main>Results</main>', { 'jane example': Date.now() - 31 * 60 * 1000 })).redirects, [], 'stale evidence expires');
    for (const [text, saved] of [
      ['Mary Example photos', stored], ['Jane Example news photos', stored],
      ['Jane Example photos', { 'jane example': Date.now() - 31 * 60 * 1000 }]
    ]) {
      assert.deepEqual((await page(`https://www.bing.com/search?q=${encodeURIComponent(text)}`, '<main>Results</main>', saved)).redirects, [], 'non-Google scans retain topic, ordinary-context and expiry boundaries');
    }
    const shared = {};
    const janeSearch = await page(query('Jane Example photos'), '<main>Results</main>', {}, shared);
    const janeReader = await page('https://justpaste.it/already-open', `<main><h1>Jane Example</h1>${files}</main>`, {}, shared);
    const janeBing = await page('https://www.bing.com/search?q=Jane+Example+photos', '<main>Results</main>', {}, shared);
    const janeControl = await page('https://www.bing.com/search?q=ordinary', '<input type="search" name="q" value="Jane Example photos"><main>Results</main>', {}, shared);
    const marySearch = await page(query('Mary Example photos'), '<main>Results</main>', {}, shared);
    assert.deepEqual(janeSearch.redirects, []);
    assert.deepEqual(janeReader.redirects, []);
    assert.deepEqual(janeBing.redirects, []);
    assert.deepEqual(janeControl.redirects, []);
    const janeTab = await page(query('Jane Example'), '<main>Results</main>', {}, shared);
    const maryTab = await page(query('Mary Example'), '<main>Results</main>', {}, shared);
    for (const tab of [janeTab, maryTab]) {
      await tab.win.webContents.executeJavaScript(`document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(notice)});`);
      await new Promise(resolve => setTimeout(resolve, 300));
      if (tab === janeTab) {
        assert.ok(janeSearch.redirects.includes(blocked), 'an already-open search immediately enforces evidence from another tab');
        assert.ok(janeReader.redirects.includes(blocked), 'an already-open reader immediately enforces evidence from another tab');
        assert.ok(janeBing.redirects.includes(blocked), 'an already-open non-Google search enforces evidence from another tab');
        assert.ok(janeControl.redirects.includes(blocked), 'an already-populated search control enforces evidence from another tab');
        assert.deepEqual(marySearch.redirects, [], 'live evidence does not spill into an unrelated open search');
      }
    }
    assert.ok(marySearch.redirects.includes(blocked), 'a second live subject also propagates to open searches');
    assert.ok(Object.values(shared).some(value => value.subject === 'jane example'), 'a second tab preserves the first subject');
    assert.ok(Object.values(shared).some(value => value.subject === 'mary example'), 'the second subject is saved independently');
    for (const subject of ['Jane Example', 'Mary Example']) {
      assert.ok((await page(query(`${subject} photos`), '<main>Results</main>', {}, shared)).redirects.includes(blocked), 'new tabs enforce both independently saved subjects');
    }
    const legacyStorage = {};
    const legacySearch = await page(query('Alex Example clips'), '<main>Results</main>', {}, legacyStorage);
    await legacySearch.win.webContents.executeJavaScript(`chrome.storage.local.set({[${JSON.stringify(evidenceKey)}]: {'alex example': Date.now() - 31 * 60 * 1000}});`);
    await new Promise(resolve => setTimeout(resolve, 180));
    assert.deepEqual(legacySearch.redirects, [], 'live stale legacy evidence remains expired');
    await legacySearch.win.webContents.executeJavaScript(`chrome.storage.local.set({[${JSON.stringify(evidenceKey)}]: {'alex example': Date.now()}});`);
    await new Promise(resolve => setTimeout(resolve, 180));
    assert.ok(legacySearch.redirects.includes(blocked), 'legacy evidence changes also propagate during migration');
    const clock = { now: Date.now() };
    const fullCache = Object.fromEntries(Array.from({ length: 64 }, (_, index) => [
      `person name${String.fromCharCode(97 + Math.floor(index / 26), 97 + index % 26)}`, clock.now
    ]));
    const expiredCacheSearch = await page('https://www.bing.com/search?q=Fresh+Example+photos', '<main>Results</main>', fullCache, undefined, { clock });
    await expiredCacheSearch.win.webContents.executeJavaScript(`chrome.storage.local.set({[${JSON.stringify(evidenceKey)}]: {'fresh example': Date.now()}});`);
    await new Promise(resolve => setTimeout(resolve, 180));
    assert.deepEqual(expiredCacheSearch.redirects, [], 'a full current subject cache applies its capacity limit');
    clock.now += 31 * 60 * 1000;
    await expiredCacheSearch.win.webContents.executeJavaScript(`chrome.storage.local.set({[${JSON.stringify(evidenceKey)}]: {'fresh example': Date.now()}});`);
    await new Promise(resolve => setTimeout(resolve, 180));
    assert.ok(expiredCacheSearch.redirects.includes(blocked), 'fresh evidence is admitted after all 64 previous subjects expire');
    const dynamic = await page(query('Jane Example clips'), '<div role="status" id="notice">SafeSearch on</div>');
    await dynamic.win.webContents.executeJavaScript(`document.querySelector('#notice').textContent = 'Explicit results filtered with SafeSearch';`);
    await new Promise(resolve => setTimeout(resolve, 180));
    assert.ok(dynamic.redirects.includes(blocked), 'a dynamically populated popup is checked');
    assert.deepEqual((await page('https://google.com.example.org/search?q=Jane+Example+photos', notice)).redirects, [], 'only the real search provider can supply evidence');
    assert.deepEqual((await page('https://justpaste.it/cloud', `<main><h1>Jane Example</h1>${files}</main>`)).redirects, [], 'ordinary cloud files do not trigger a block');
    assert.ok((await page('https://justpaste.it/context', `<main><h1>Jane Example</h1>${files}</main>`, stored)).redirects.includes(blocked), 'verified subject plus a link collection blocks its page');
    assert.ok((await page('https://justpaste.it/collection', `<main><h1>Another Person</h1>${files}<a href="https://www.erome.com/a/fixture">Album</a></main>`)).redirects.includes(blocked), 'adult media mixed into a file collection supplies independent evidence');
    assert.deepEqual((await page('https://justpaste.it/sidebar', `<main><h1>Jane Example</h1>${files}<aside><a href="https://www.erome.com/a/fixture">Recommendation</a></aside></main>`)).redirects, [], 'sidebar suggestions cannot contaminate the article');
    assert.deepEqual((await page('https://www.scribd.com/document/123/ordinary', `<div role="document">${files}</div><aside><a href="https://www.erome.com/a/fixture">Suggestion</a></aside>`)).redirects, [], 'Scribd inspects the reader separately');
    assert.ok((await page('https://www.scribd.com/document/123/collection', `<div class="text_layer">https://mega.nz/folder/fixture#key\nhttps://gofile.io/d/fixture\nhttps://www.erome.com/a/fixture</div>`)).redirects.includes(blocked), 'plain-text PDF URLs are classified');
    const driveDropbox = 'https://drive.google.com/file/d/fixture/view\nhttps://www.dropbox.com/s/fixture/file';
    assert.ok((await page('https://justpaste.it/plain-cloud', `<main><h1>Jane Example</h1>${driveDropbox}</main>`, stored)).redirects.includes(blocked), 'verified evidence classifies plain-text Drive and Dropbox collections');
    assert.deepEqual((await page('https://justpaste.it/plain-cloud-benign', `<main><h1>Jane Example</h1>${driveDropbox}</main>`)).redirects, [], 'plain-text cloud files still require subject or adult evidence');
    assert.ok((await page('https://www.scribd.com/document/123/cloud', `<div class="text_layer">${driveDropbox}</div>`, stored)).redirects.includes(blocked), 'plain-text PDF Drive and Dropbox URLs are classified');
    console.log('Offline DOM tests passed: notices, clicks, delayed DOM, topic cache, expiry, paste/PDF collections and benign pages.');
    if (reportPath) await fs.writeFile(reportPath, 'passed\n');
  } finally {
    for (const win of windows) win.destroy();
  }
}
void main().catch(async error => {
  console.error(error);
  if (reportPath) await fs.writeFile(reportPath, String(error));
  process.exitCode = 1;
});
