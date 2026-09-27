import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const runtime = dirname(dirname(fileURLToPath(import.meta.url)));
const root = resolve(runtime, '../..');
const content = await readFile(join(runtime, 'extension/content.js'), 'utf8');
const background = await readFile(join(runtime, 'extension/background.js'), 'utf8');
const safari = await readFile(join(root, 'ios/VigilSocial/VigilYouTubeInteractionExtension/Resources/youtube-background.js'), 'utf8');
const popup = await readFile(join(root, 'ios/VigilSocial/VigilYouTubeInteractionExtension/Resources/status.js'), 'utf8');
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const video = 'abcdefghijk';

test('external clicks wait for the allowance write and preserve timestamps', async () => {
  for (const destination of [`https://youtu.be/${video}?t=40`, `https://www.youtube.com/live/${video}?t=40`,
    `https://www.google.com/url?q=${encodeURIComponent(`https://www.youtube.com/watch?v=${video}&t=40`)}`]) {
    let click: (event: unknown) => void = () => {};
    let navigated = '', prevented = false;
    let finish: (value: unknown) => void = () => {};
    const messages: unknown[] = [];
    class Anchor {
      href = destination; target = '';
      closest() { return this; }
      hasAttribute() { return false; }
    }
    vm.runInNewContext(content.slice(content.indexOf('// Capture actual external-link clicks')), {
      document: { addEventListener(_type: string, callback: typeof click) { click = callback; } },
      isYoutubeHost: () => false, Element: Anchor, HTMLAnchorElement: Anchor, URL,
      location: { assign(url: string) { navigated = url; } },
      chrome: { runtime: { sendMessage(message: unknown) { messages.push(message); return new Promise(resolve => { finish = resolve; }); } } }
    });
    click({ isTrusted: true, target: new Anchor(), preventDefault() { prevented = true; }, stopImmediatePropagation() {} });
    assert.equal(prevented, true);
    assert.equal(navigated, '');
    assert.equal((messages[0] as {youtube:{videoId:string}}).youtube.videoId, video);
    finish({ ok: true }); await tick();
    assert.equal(navigated, destination);
  }
});

test('Chrome incoming links get time-only access; recommendations, new-tab recommendations, reloads and Shorts do not', async () => {
  const start = background.indexOf('async function authorizeDirectYouTubeNavigation(');
  const end = background.indexOf('chrome.webNavigation.onHistoryStateUpdated', start);
  for (const scenario of [
    { previous: 'https://www.google.com/search?q=econ', transitionType: 'link', allowed: true },
    { transitionType: 'link', allowed: true },
    { previous: 'https://www.youtube.com/', transitionType: 'link', allowed: false },
    { opener: 'https://www.youtube.com/', transitionType: 'link', allowed: false },
    { opener: 'https://example.com/homework', transitionType: 'link', allowed: true },
    { previous: 'https://www.youtube.com/', transitionType: 'typed', allowed: true },
    { transitionType: 'reload', allowed: false },
    { transitionType: 'link', shorts: true, allowed: false }
  ]) {
    const values: Record<string, unknown> = { 'youtube-navigation:1': scenario.previous, 'youtube-navigation:2': scenario.opener };
    const requests: unknown[] = [];
    const context = vm.createContext({ URL,
      chrome: { storage: { session: { async get(key:string) { return { [key]:values[key] }; }, async set(next:Record<string,unknown>) { Object.assign(values,next); } } } },
      getTab: async () => scenario.opener ? { openerTabId:2 } : {},
      fetchVigil: async (_url:string, options:{body:string}) => { requests.push(JSON.parse(options.body)); }
    });
    vm.runInContext(background.slice(start, end), context);
    context.details = { tabId:1, url:scenario.shorts ? `https://www.youtube.com/shorts/${video}?v=${video}` : `https://www.youtube.com/watch?v=${video}`,
      transitionType:scenario.transitionType, transitionQualifiers:[] };
    await vm.runInContext('authorizeDirectYouTubeNavigation(details)', context);
    assert.equal(requests.length, scenario.allowed ? 1 : 0, JSON.stringify(scenario));
  }
});

test('Safari keeps search/shared-link eligibility separate from discovery during handoff', async () => {
  const listeners: Record<string,(event:unknown, sender?:unknown)=>unknown> = {};
  const values: Record<string,unknown> = {};
  const requests: {action:string}[] = [];
  const event = (name:string) => ({ addListener(callback: typeof listeners[string]) { listeners[name]=callback; } });
  const storage = { async get(keys:string|string[]) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key,values[key]])); },
    async set(next:Record<string,unknown>) { Object.assign(values,next); }, async remove() {} };
  vm.runInNewContext(safari, { URL, browser:{
    runtime:{onMessage:event('message'),async sendNativeMessage(_app:string, body:{action:string}) { requests.push(body); return {ok:true}; }},
    storage:{local:storage},tabs:{onRemoved:event('removed')},
    webNavigation:{onCommitted:event('committed'),onHistoryStateUpdated:event('history'),onCreatedNavigationTarget:event('created')}
  }});
  const commit = async (url:string, transitionType='link', tabId=1) => {
    listeners.committed({frameId:0,tabId,url,transitionType}); await tick();
  };
  await commit('https://www.google.com/search?q=homework');
  await commit(`https://www.youtube.com/live/${video}?t=40`);
  assert.equal((values['youtube-handoff:1'] as {eligible:boolean}).eligible,true);
  assert.ok(requests.some(request=>request.action==='external'));
  await commit('https://www.youtube.com/watch?v=zyxwvutsrqp');
  assert.equal((values['youtube-handoff:1'] as {eligible:boolean}).eligible,false);
  listeners.created({sourceTabId:1,tabId:2,url:`https://www.youtube.com/watch?v=${video}`}); await tick();
  await commit(`https://www.youtube.com/watch?v=${video}`, 'link', 2);
  assert.equal((values['youtube-handoff:2'] as {eligible:boolean}).eligible,false);
  await listeners.message({type:'VIGIL_YOUTUBE',youtube:{action:'search',videoId:video,client:'test'}},{url:'https://www.youtube.com/results?search_query=econ',tab:{id:1}});
  listeners.history({frameId:0,tabId:1,url:`https://www.youtube.com/watch?v=${video}`}); await tick();
  assert.equal((values['youtube-handoff:1'] as {eligible:boolean}).eligible,true);
  listeners.history({frameId:0,tabId:1,url:'https://www.youtube.com/watch?v=zyxwvutsrqp'}); await tick();
  assert.equal((values['youtube-handoff:1'] as {eligible:boolean}).eligible,false);
});

test('Safari handoff opens the original URL and retains discovery limits; desktop does not offer an iPhone app', async () => {
  for (const eligible of [true,false]) for (const phone of [true,false]) {
    const node = { hidden:false,style:{display:''},href:'' };
    const context = vm.createContext({ URL, document:{getElementById:()=>node},
      navigator:{userAgent:phone?'iPhone':'Macintosh',platform:phone?'iPhone':'MacIntel',maxTouchPoints:phone?5:0},
      browser:{storage:{local:{async get(key:string) { return {[key]:{id:video,eligible}}; }}}}
    });
    vm.runInContext(popup.slice(popup.indexOf('async function prepareHandoff')),context);
    await vm.runInContext(`prepareHandoff({id:1,url:'https://www.youtube.com/watch?v=${video}&t=40'})`,context);
    assert.equal(node.hidden,!phone);
    if (phone) {
      const url = new URL(node.href);
      assert.equal(url.searchParams.get('url'),`https://www.youtube.com/watch?v=${video}&t=40`);
      assert.equal(url.searchParams.get('source'),eligible?null:'discovery');
    }
  }
});

test('Safari grants an external embed before starting playback and rejects a changed video in that frame', async () => {
  const events: Record<string, Array<(value: unknown) => void>> = {};
  const listeners: Array<(message: unknown, sender: unknown) => unknown> = [];
  const values: Record<string, unknown> = {};
  const actions: string[] = [];
  const frames = [{ frameId: 0, parentFrameId: -1, url: 'https://example.edu/econ' },
    { frameId: 1, parentFrameId: 0, url: `https://www.youtube-nocookie.com/embed/${video}` }];
  const event = (key: string) => ({ addListener(callback: (value: unknown) => void) { (events[key] ||= []).push(callback); } });
  vm.runInNewContext(safari, { URL, browser: {
    storage: { local: {
      async get(keys: string | string[]) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, values[key]])); },
      async set(items: Record<string, unknown>) { Object.assign(values, items); }, async remove() {}
    } },
    runtime: { onMessage: { addListener(callback: typeof listeners[number]) { listeners.push(callback); } },
      async sendNativeMessage(_app: string, body: { action: string }) { actions.push(body.action); return { ok: true }; } },
    tabs: { onRemoved: event('removed') },
    webNavigation: { onCommitted: event('committed'), onHistoryStateUpdated: event('history'),
      onCreatedNavigationTarget: event('created'), async getAllFrames() { return frames; } }
  } });
  for (const callback of events.committed) callback({ tabId: 5, ...frames[0] });
  for (const callback of events.committed) callback({ tabId: 5, ...frames[1] });
  await tick();
  const start = async (videoId: string) => listeners[0]({ type: 'VIGIL_YOUTUBE', youtube: { action: 'start', videoId } }, { tab: { id: 5 }, ...frames[1] });
  await start(video);
  assert.deepEqual(actions, ['external', 'start']);
  for (const callback of events.created) callback({ sourceTabId: 5, sourceFrameId: 1, tabId: 6, url: 'https://www.youtube.com/watch?v=zyxwvutsrqp' });
  await tick();
  assert.equal(values['youtube-source:6'], false, 'new-tab embed recommendations remain discovery');
  assert.deepEqual(actions, ['external', 'start']);
  actions.length = 0;
  frames[1].url = 'https://www.youtube-nocookie.com/embed/zyxwvutsrqp';
  for (const callback of events.committed) callback({ tabId: 5, ...frames[1] });
  await tick();
  await start('zyxwvutsrqp');
  assert.deepEqual(actions, ['start'], 'recommendation retains the ordinary save-first check');
});

const bridge = await readFile(join(root, 'ios/VigilSocial/VigilYouTubeInteractionExtension/Resources/youtube-bridge.js'), 'utf8');
function safariExternalClickFixture(destination: string, source = 'https://www.google.com/search?q=econ', subframe = false) {
  const handlers: Record<string, (event: unknown) => void> = {};
  const messages: Array<{type: string; url: string}> = [];
  let navigated = '', prevented = false, resolveReply: (value: unknown) => void = () => {};
  class Anchor {
    href = destination; target = '';
    closest() { return this; }
    hasAttribute() { return false; }
  }
  const window: Record<string, unknown> = { addEventListener() {} };
  window.top = subframe ? {} : window;
  vm.runInNewContext(bridge, { URL, Promise, window, Element: Anchor, HTMLAnchorElement: Anchor,
    location: { hostname: new URL(source).hostname, assign(url: string) { navigated = url; } },
    document: { addEventListener(name: string, callback: typeof handlers[string]) { handlers[name] = callback; } },
    browser: { runtime: { sendMessage(message: typeof messages[number]) { messages.push(message); return new Promise(resolve => { resolveReply = resolve; }); } } }
  });
  return { messages, handlers, fire(type = 'click', trusted = true, newTab = false) {
    const anchor = new Anchor(); if (newTab) anchor.target = '_blank';
    handlers[type]?.({ type, button: type === 'auxclick' ? 1 : 0, isTrusted: trusted, target: anchor,
      preventDefault() { prevented = true; }, stopImmediatePropagation() {} });
  }, finish: () => resolveReply({ ok: true }), navigated: () => navigated, prevented: () => prevented };
}

test('Safari captures Google clicks before navigation, preserving timestamps and wrapped links', async () => {
  for (const destination of [`https://www.youtube.com/watch?v=${video}&t=40`, `https://youtu.be/${video}?t=40`,
    `https://www.google.com/url?q=${encodeURIComponent(`https://www.youtube.com/watch?v=${video}&t=40`)}`]) {
    const f = safariExternalClickFixture(destination);
    f.fire();
    assert.equal(f.prevented(), true);
    assert.equal(f.navigated(), '', 'source stays alive until the native allowance is persisted');
    assert.equal(f.messages[0].type, 'VIGIL_YOUTUBE_EXTERNAL_LINK');
    assert.ok(f.messages[0].url.includes(video));
    f.finish(); await tick();
    assert.equal(f.navigated(), destination);
  }
});

test('Safari new-tab and middle-click results request allowance without hijacking navigation', () => {
  for (const type of ['click', 'auxclick']) {
    const f = safariExternalClickFixture(`https://www.youtube.com/watch?v=${video}`);
    f.fire(type, true, true);
    assert.equal(f.messages.length, 1);
    assert.equal(f.prevented(), false);
    assert.equal(f.navigated(), '');
  }
});

test('Safari never treats synthetic clicks, YouTube discovery, Shorts or external subframes as direct result clicks', () => {
  const destination = `https://www.youtube.com/watch?v=${video}`;
  for (const source of ['https://www.youtube.com/', 'https://www.youtube-nocookie.com/embed/abcdefghijk', 'https://music.youtube.com/', 'https://youtu.be/abcdefghijk']) {
    const f = safariExternalClickFixture(destination, source); f.fire(); assert.equal(f.messages.length, 0);
  }
  const synthetic = safariExternalClickFixture(destination); synthetic.fire('click', false); assert.equal(synthetic.messages.length, 0);
  const subframe = safariExternalClickFixture(destination, 'https://www.google.com/', true); subframe.fire(); assert.equal(subframe.messages.length, 0);
  const shorts = safariExternalClickFixture(`https://www.youtube.com/shorts/${video}`); shorts.fire(); assert.equal(shorts.messages.length, 0);
});

test('Safari external-click handler verifies sender provenance and awaits the native grant', async () => {
  let receive: (message: unknown, sender: unknown) => Promise<unknown> = async () => undefined;
  let finish: (value: unknown) => void = () => {};
  const requests: Array<{action: string; videoId: string}> = [];
  const values: Record<string, unknown> = {};
  const event = { addListener() {} };
  vm.runInNewContext(safari, { URL, browser: {
    runtime: { onMessage: { addListener(fn: typeof receive) { receive = fn; } },
      sendNativeMessage(_app: string, body: typeof requests[number]) { requests.push(body); return new Promise(resolve => { finish = resolve; }); } },
    storage: { local: { async get() { return {}; }, async set(items: Record<string, unknown>) { Object.assign(values, items); } } },
    tabs: { onRemoved: event }, webNavigation: { onCommitted: event, onHistoryStateUpdated: event, onCreatedNavigationTarget: event }
  } });
  const message = { type: 'VIGIL_YOUTUBE_EXTERNAL_LINK', url: `https://www.youtube.com/watch?v=${video}&t=40` };
  for (const sender of [
    { url: 'https://www.youtube.com/', frameId: 0, tab: { id: 1 } },
    { url: 'https://www.youtube-nocookie.com/', frameId: 0, tab: { id: 1 } },
    { url: 'https://www.google.com/', frameId: 1, tab: { id: 1 } },
    { url: 'about:blank', frameId: 0, tab: { id: 1 } }
  ]) assert.equal((await receive(message, sender) as {ok:boolean}).ok, false);
  assert.equal(requests.length, 0);
  let done = false;
  const reply = receive(message, { url: 'https://www.google.com/search?q=econ', frameId: 0, tab: { id: 1 } }).then(() => { done = true; });
  await tick(); assert.equal(done, false);
  assert.equal(requests[0].action, 'external'); assert.equal(requests[0].videoId, video);
  finish({ ok: true }); await reply;
  assert.equal((values['youtube-handoff:1'] as {eligible: boolean}).eligible, true);
});
