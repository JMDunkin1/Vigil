// Run with: node_modules/.bin/electron tests/ios-instagram-shared-reel-browser.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const source = fs.readFileSync('ios/VigilSocial/VigilSocial/DOMAdapters.swift', 'utf8');
const guard = source.match(/static let instagramSingleReelGuard = #"""([\s\S]*?)"""#/)[1];

async function main() {
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 390, height: 844, webPreferences: { sandbox: true } });
  win.webContents.session.protocol.handle('https', request => new URL(request.url).pathname.endsWith('.svg')
    ? new Response('<svg xmlns="http://www.w3.org/2000/svg" width="390" height="700"><rect width="390" height="700" fill="purple"/></svg>', {
      headers: { 'content-type': 'image/svg+xml' }
    })
    : new Response('<!doctype html><html><body></body></html>', {
      headers: { 'content-type': 'text/html' }
    }));
  const run = async code => {
    const result = await win.webContents.executeJavaScript(code);
    await win.webContents.executeJavaScript('new Promise(resolve => setTimeout(resolve, 0))');
    return result;
  };
  for (const path of ['/reel/Shared123/', '/p/Shared123/', '/direct/t/123/']) {
    await win.loadURL(`https://www.instagram.com${path}`);
    await run(guard);
    await run(`document.body.innerHTML = ${JSON.stringify(`
      <style>body{margin:0} article,video{display:block;width:390px;height:700px}</style>
      <main ${path.startsWith('/direct/') ? 'role="dialog"' : ''}>
        <article id="shared-card"><a href="${path.startsWith('/p/') ? path : '/reel/Shared123/'}"><video id="shared" src="/original.mp4"></video></a>${path.startsWith('/p/') ? '<img id="poster" src="/poster.svg" style="position:absolute;top:0;width:390px;height:600px">' : ''}</article>
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
    assert.deepEqual(await run(`(() => {
      const media = document.getElementById('shared');
      media.src = '/suggested.mp4';
      media.dispatchEvent(new Event('loadedmetadata'));
      return { allowed: media.dataset.vigilSingleReelMedia,
        visible: getComputedStyle(media).visibility,
        card: document.getElementById('shared-card').dataset.vigilSingleReelCard };
    })()`), { allowed: 'blocked', visible: 'hidden', card: 'blocked' },
    `${path}: a recycled source stays blocked even when the same article contains a poster`);
  }
  // Direct keeps its thread mounted under the viewer and may hide a portal
  // ancestor before removing the dialog. Neither transition may hide messages.
  for (const route of ['/direct/t/123/', '/reel/Shared123/']) {
    await win.loadURL(`https://www.instagram.com${route}`);
    await run(guard);
    await run(`document.body.innerHTML = ${JSON.stringify(`
      <style>body{margin:0} video,img{width:390px;height:700px} #portal{position:fixed;inset:0}</style>
      <main id="thread"><article id="message"><a href="/reel/Shared123/"><img src="/poster.svg"></a></article></main>
      <div id="portal"><div role="dialog" id="viewer"><article id="selected"><a href="/reel/Shared123/"><video id="opened" src="/original.mp4"></video></a></article></div></div>
    `)}; history.pushState({}, '', ${JSON.stringify(route)});`);
    assert.equal(await run(`getComputedStyle(document.getElementById('message')).visibility`), 'visible',
      `${route}: viewer containment must not classify the retained Direct thread`);
    await run(`document.getElementById('portal').style.display = 'none'; history.pushState({}, '', '/direct/t/123/');`);
    assert.deepEqual(await run(`({ pinned: document.documentElement.hasAttribute('data-vigil-single-reel'),
      visible: getComputedStyle(document.getElementById('message')).visibility,
      blocked: document.querySelectorAll('[data-vigil-single-reel-card="blocked"]').length })`),
      { pinned: false, visible: 'visible', blocked: 0 }, 'closing a retained viewer releases all chat classifications');
    await run(`document.getElementById('portal').style.display = '';`);
    assert.equal(await run(`getComputedStyle(document.getElementById('opened')).visibility`), 'visible',
      'the same shared reel can be reopened');
  }
  await win.loadURL('https://www.instagram.com/reel/Shared123/');
  await run(guard);
  await run(`document.body.innerHTML = '<style>video,img{width:390px;height:700px}</style><main><article id="selected"><a href="/reel/Shared123/"><video id="opened" src="/original.mp4"></video></a><img id="poster" src="/poster.svg"></article><article><video src="/suggested.mp4"></video></article></main>'`);
  await run(`document.body.innerHTML = '<style>video,img{width:390px;height:700px}#poster{position:absolute;inset:0}</style><main><div id="selected"><a href="/reel/Shared123/"><video id="opened" src="/original.mp4"></video></a><img id="poster" src="/poster.svg"></div><div id="suggestion"><video id="suggested" src="/suggested.mp4"></video></div></main>'`);
  assert.deepEqual(await run(`({selected:getComputedStyle(document.getElementById('opened')).visibility,
    card:document.getElementById('selected').dataset.vigilSingleReelCard,
    suggestion:getComputedStyle(document.getElementById('suggestion')).visibility})`),
    { selected: 'visible', card: 'allowed', suggestion: 'hidden' },
    'an overlapping poster in an anonymous card cannot hide the shared reel or reveal recommendations');
  await run(`document.getElementById('poster').src='/poster-hydrated.svg'`);
  assert.equal(await run(`getComputedStyle(document.getElementById('opened')).visibility`), 'visible',
    'poster source replacement keeps the anonymous shared reel visible');
  await run(`document.getElementById('poster').src = '/replacement.svg';`);
  assert.equal(await run(`getComputedStyle(document.getElementById('opened')).visibility`), 'visible',
    'a delayed poster refresh must not veto the unchanged selected video');
  await run(`const selected = document.getElementById('selected');
    const wrapper = document.createElement('div'); selected.before(wrapper); wrapper.append(selected);
    selected.removeAttribute('id'); selected.removeAttribute('role'); selected.outerHTML = selected.outerHTML.replaceAll('article', 'div');`);
  assert.equal(await run(`getComputedStyle(document.getElementById('opened')).visibility`), 'visible',
    'a delayed layout wrapper remount preserves the exact selected video source');
  for (const initialSource of ['', 'src="about:blank"']) {
    await win.loadURL('https://www.instagram.com/p/LazyVideo/');
    await run(guard);
    await run(`document.body.innerHTML = ${JSON.stringify(`
      <style>article,video{display:block;width:390px;height:600px}</style>
      <article><a href="/p/LazyVideo/"><video id="lazy" ${initialSource}></video></a></article>`)};`);
    await run(`document.getElementById('lazy').src = '/original.mp4'`);
    assert.equal(await run(`document.getElementById('lazy').dataset.vigilSingleReelMedia`), 'allowed',
      `a selected video hydrates once from ${initialSource || 'missing src'}`);
    await run(`document.getElementById('lazy').src = '/suggested.mp4'`);
    assert.equal(await run(`document.getElementById('lazy').dataset.vigilSingleReelMedia`), 'blocked',
      'a hydrated video freezes its first usable source');
  }
  const mixedCarousel = async (lazy = false) => {
    await win.loadURL('https://www.instagram.com/p/Mixed123/');
    await run(guard);
    // Create real decodable video in Chromium so both original video slides
    // can exercise play(), rather than only dispatching a synthetic play event.
    const videoURLs = await run(`(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 32; canvas.height = 32;
      const context = canvas.getContext('2d');
      const stream = canvas.captureStream(10);
      const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
      const chunks = [];
      recorder.ondataavailable = event => chunks.push(event.data);
      const done = new Promise(resolve => recorder.onstop = resolve);
      recorder.start();
      context.fillStyle = 'purple'; context.fillRect(0, 0, 32, 32);
      await new Promise(resolve => setTimeout(resolve, 200));
      recorder.stop(); await done;
      stream.getTracks().forEach(track => track.stop());
      const blob = new Blob(chunks, { type: recorder.mimeType });
      return [URL.createObjectURL(blob), URL.createObjectURL(blob)];
    })().catch(error => { throw new Error('Video fixture: ' + error.message); })`);
    await run(`document.body.innerHTML = ${JSON.stringify(`
      <style>
        body{margin:0} article{width:390px} #track{display:flex;overflow-x:auto;width:390px;height:600px}
        .slide{position:relative;flex:0 0 390px;width:390px;height:600px}
        .slide video,.slide img{display:block;width:390px;height:600px}
        #poster{position:absolute;inset:0;pointer-events:none}
      </style>
      <main>
        <article id="shared-card"><a href="/p/Mixed123/">Selected post</a>
          <div id="track" aria-roledescription="carousel">
            <div class="slide" id="slide-one"><video id="first" muted loop src="${videoURLs[0]}"></video><img id="poster" src="/poster.svg"></div>
            <div class="slide" id="slide-two"><img id="photo" src="${lazy ? 'about:blank' : '/photo.svg'}"></div>
            <div class="slide" id="slide-three"><video id="third" muted loop ${lazy ? '' : `src="${videoURLs[1]}"`}></video></div>
          </div>
          <button id="next-photo" aria-label="Next photo">Next photo</button>
          <button id="previous-photo" aria-label="Previous photo">Previous photo</button>
        </article>
        <article><a href="/p/Other456/"><video id="suggested" src="/suggested.mp4"></video></a></article>
      </main>`)};
      window.holds = 0; window.nextClicks = 0;
      for (const id of ['first', 'photo', 'third']) {
        for (const type of ['pointerdown', 'touchstart', 'mousedown', 'contextmenu']) {
          document.getElementById(id).addEventListener(type, () => {
            window.holds++;
            document.getElementById('first').src = '/suggested.mp4';
          });
        }
      }
      document.getElementById('next-photo').onclick = () => {
        window.nextClicks++; document.getElementById('track').scrollLeft += 390;
      };
      document.getElementById('previous-photo').onclick = () => {
        document.getElementById('track').scrollLeft -= 390;
      }; void 0;`);
    return videoURLs;
  };
  const carouselState = () => run(`({
    first: document.getElementById('first').dataset.vigilSingleReelMedia,
    third: document.getElementById('third').dataset.vigilSingleReelMedia,
    card: document.getElementById('shared-card').dataset.vigilSingleReelCard,
    holds, nextClicks, path: location.pathname
  })`);
  await mixedCarousel();
  assert.deepEqual(await carouselState(), {
    first: 'allowed', third: 'allowed', card: 'allowed', holds: 0, nextClicks: 0, path: '/p/Mixed123/'
  }, 'distinct original photo/video slides retain their own authorization');
  const gestures = await run(`(() => {
    const media = document.getElementById('first');
    const fire = (type, x = 300, y = 300) => {
      const event = type.startsWith('pointer')
        ? new PointerEvent(type, { bubbles:true, cancelable:true, pointerType:'touch', clientX:x, clientY:y })
        : new Event(type, { bubbles:true, cancelable:true });
      if (type.startsWith('touch')) Object.defineProperty(event, 'touches', {
        value: type === 'touchend' ? [] : [{clientX:x, clientY:y}]
      });
      media.dispatchEvent(event); return event.defaultPrevented;
    };
    fire('pointerdown'); const horizontalPointer = fire('pointermove', 100); fire('pointerup', 100);
    fire('touchstart'); const horizontalTouch = fire('touchmove', 100); fire('touchend', 100);
    fire('mousedown'); fire('mouseup'); const contextmenu = fire('contextmenu');
    fire('pointerdown'); const verticalPointer = fire('pointermove', 300, 100); fire('pointerup', 300, 100);
    fire('touchstart'); const verticalTouch = fire('touchmove', 300, 100); fire('touchend', 300, 100);
    return { horizontalPointer, horizontalTouch, verticalPointer, verticalTouch, contextmenu,
      touchAction: getComputedStyle(media).touchAction, holds };
  })()`);
  assert.deepEqual(gestures, { horizontalPointer: false, horizontalTouch: false,
    verticalPointer: true, verticalTouch: true, contextmenu: true, touchAction: 'pan-x pinch-zoom', holds: 0 },
  'horizontal native panning remains available while holds and vertical advancement are contained');
  // Chromium's trusted input path verifies that propagation containment still
  // leaves the browser's native horizontal carousel scrolling functional.
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Input.synthesizeScrollGesture', {
    x: 200, y: 300, xDistance: -300, yDistance: 0, gestureSourceType: 'touch'
  });
  assert.ok(await run(`document.getElementById('track').scrollLeft > 0`), 'trusted horizontal swipe scrolls the original carousel');
  win.webContents.debugger.detach();
  await run(`document.getElementById('track').scrollLeft = 0`);
  for (const id of ['first', 'third']) {
    if (id === 'third') {
      await run(`document.getElementById('next-photo').click(); document.getElementById('next-photo').click()`);
      assert.equal(await run(`document.getElementById('track').scrollLeft`), 780, 'Next photo reaches the original third slide');
    }
    assert.deepEqual(await run(`(async () => {
      const video = document.getElementById(${JSON.stringify(id)});
      await video.play();
      const state = { playing: !video.paused, allowed: video.dataset.vigilSingleReelMedia,
        visible: getComputedStyle(video).visibility };
      video.pause(); return state;
    })()`), { playing: true, allowed: 'allowed', visible: 'visible' }, `${id}: original carousel video plays`);
  }
  await run(`document.getElementById('previous-photo').click()`);
  assert.equal(await run(`document.getElementById('track').scrollLeft`), 390, 'Previous photo remains usable');
  await run(`document.getElementById('third').src = '/suggested.mp4'`);
  assert.deepEqual(await carouselState(), {
    first: 'allowed', third: 'blocked', card: 'blocked', holds: 0, nextClicks: 2, path: '/p/Mixed123/'
  }, 'a known carousel video node cannot inherit a recommendation source');
  const lazySources = await mixedCarousel(true);
  await run(`document.getElementById('third').src = ${JSON.stringify(lazySources[1])};
    document.getElementById('photo').src = '/photo.svg';`);
  assert.deepEqual(await run(`(async () => {
    const video = document.getElementById('third'); await video.play();
    const state = { allowed: video.dataset.vigilSingleReelMedia, playing: !video.paused,
      card: document.getElementById('shared-card').dataset.vigilSingleReelCard };
    video.pause(); return state;
  })()`), { allowed: 'allowed', playing: true, card: 'allowed' },
  'original empty carousel video and photo shells each acquire their first usable source');
  const recycledSources = await mixedCarousel(true);
  await run(`document.querySelector('#shared-card > a').href = '/p/Other456/'`);
  await run(`document.getElementById('third').src = ${JSON.stringify(recycledSources[1])}`);
  await run(`document.querySelector('#shared-card > a').href = '/p/Mixed123/'`);
  assert.deepEqual(await run(`(async () => {
    const video = document.getElementById('third');
    try { await video.play(); } catch (_) {}
    return { allowed: video.dataset.vigilSingleReelMedia, paused: video.paused };
  })()`), { allowed: 'blocked', paused: true }, 'a recycled post cannot recover permission to hydrate a pending slide');
  await mixedCarousel();
  await run(`document.getElementById('third').outerHTML = document.getElementById('third').outerHTML`);
  assert.deepEqual(await run(`(async () => {
    const video = document.getElementById('third'); await video.play();
    const state = { allowed: video.dataset.vigilSingleReelMedia, playing: !video.paused };
    video.pause(); return state;
  })()`), { allowed: 'allowed', playing: true }, 'an exact-source remount inside its original slide retains playback');
  await run(`document.querySelector('article:last-child').append(document.getElementById('third'))`);
  assert.deepEqual(await run(`(async () => {
    const video = document.getElementById('third');
    try { await video.play(); } catch (_) {}
    return { allowed: video.dataset.vigilSingleReelMedia, paused: video.paused,
      visible: getComputedStyle(video).visibility };
  })()`), { allowed: 'blocked', paused: true, visible: 'hidden' },
  'even an original source cannot play after moving outside the selected post');
  await mixedCarousel();
  await run(`document.getElementById('slide-two').appendChild(document.getElementById('third')); void 0;`);
  assert.deepEqual(await run(`(async () => {
    const video = document.getElementById('third');
    try { await video.play(); } catch (_) {}
    return { allowed: video.dataset.vigilSingleReelMedia, paused: video.paused };
  })()`), { allowed: 'blocked', paused: true }, 'an original source moved into another slide loses playback permission');
  await mixedCarousel();
  await run(`const slide = document.createElement('div'); slide.className = 'slide';
    slide.innerHTML = '<video id="new-slide" src="/suggested.mp4"></video>';
    document.getElementById('track').appendChild(slide); void 0;`);
  assert.equal(await run(`document.getElementById('new-slide').dataset.vigilSingleReelMedia`), 'blocked',
    'a later inserted unknown slide does not acquire carousel permission');
  const photoPage = async initialSource => {
    await win.loadURL('https://www.instagram.com/p/Photo123/');
    await run(guard);
    await run(`document.body.innerHTML = ${JSON.stringify(`
      <style>body{margin:0} article,img{display:block;width:390px;height:700px}</style>
      <main>
        <article id="shared-card"><a id="permalink" href="/p/Photo123/"><img id="shared" ${initialSource}></a></article>
        <article id="other-card"><a href="/p/Other456/"><img id="other" src="/other.svg"></a></article>
      </main>`)};`);
  };
  const loadPhoto = async (attribute, value) => run(`new Promise((resolve, reject) => {
    const image = document.getElementById('shared');
    image.addEventListener('load', () => resolve({ loaded: image.complete, width: image.naturalWidth }), { once: true });
    image.addEventListener('error', () => reject(new Error('Photo fixture failed to load')), { once: true });
    image.setAttribute(${JSON.stringify(attribute)}, ${JSON.stringify(value)});
  })`);
  const photoState = () => run(`({
    shared: getComputedStyle(document.getElementById('shared')).visibility,
    other: getComputedStyle(document.getElementById('other')).visibility,
    card: document.getElementById('shared-card').dataset.vigilSingleReelCard,
    path: location.pathname
  })`);
  for (const [initialSource, attribute, value] of [
    ['', 'src', '/photo.svg'],
    ['src=""', 'srcset', '/photo.svg 1x'],
    ['src="about:blank"', 'src', '/photo.svg'],
    ['src="about:blank"', 'srcset', '/photo.svg 1x']
  ]) {
    await photoPage(initialSource);
    assert.deepEqual(await loadPhoto(attribute, value), { loaded: true, width: 390 });
    assert.deepEqual(await photoState(), {
      shared: 'visible', other: 'hidden', card: 'allowed', path: '/p/Photo123/'
    }, `single photo hydrates from ${initialSource || 'missing src'} through ${attribute}`);
    for (const destination of ['/p/Other456/', '/reel/Other456/', '/stories/other/456/', '/reels/']) {
      await run(`history.pushState({}, '', ${JSON.stringify(destination)})`);
      assert.equal((await photoState()).path, '/p/Photo123/', `photo cannot navigate to ${destination}`);
    }
    await loadPhoto(attribute, attribute === 'srcset' ? '/replacement.svg 1x' : '/replacement.svg');
    assert.deepEqual(await photoState(), {
      shared: 'hidden', other: 'hidden', card: 'blocked', path: '/p/Photo123/'
    }, 'a loaded photo cannot inherit a different source');
  }
  await photoPage('');
  await run(`document.getElementById('permalink').href = '/p/Other456/'`);
  await loadPhoto('src', '/replacement.svg');
  await run(`document.getElementById('permalink').href = '/p/Photo123/'`);
  assert.equal((await photoState()).shared, 'hidden', 'a recycled card cannot acquire its first source after changing post identity');
  const dataPhoto = 'data:image/svg+xml;base64,' + Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="390" height="700"><rect width="390" height="700" fill="blue"/></svg>'
  ).toString('base64');
  await photoPage(`src="${dataPhoto}"`);
  assert.equal((await photoState()).shared, 'visible', 'a substantive data image retains normal initial authorization');
  await loadPhoto('src', '/replacement.svg');
  assert.equal((await photoState()).shared, 'hidden', 'data images are content and retain the source freeze');
  console.log('Shared reel hold regressions passed for reel/post permalinks and Direct modals; playback taps, comments, Like, and Back remain usable.');
  console.log('Single-photo lazy src/srcset hydration passed; source replacement, recycled posts, unrelated media, and feed/story/reel navigation remain blocked.');
  console.log('Mixed photo/video carousel playback, horizontal swipes, photo arrows, hold containment, and source/slide freezes passed.');
  console.log('Poster hydration, retained portal close/reopen, viewer boundaries, and unchanged-source layout remounts passed.');
  console.log('VIGIL_INSTAGRAM_SHARED_REEL_BROWSER_COMPLETE');
  win.destroy();
  app.quit();
}
void main().catch(error => { console.error(error); app.exit(1); });
