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
