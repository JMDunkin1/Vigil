import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
const source = await readFile(new URL('../extension/youtube-limits.js', import.meta.url), 'utf8');
const helpers = source.slice(source.indexOf('  // Feed metadata'), source.indexOf('  function feedName()'));
const ids = Array.from({ length: 25 }, (_, i) => `video${String(i).padStart(6, '0')}`);
const renderer = (id: string, i: number) => ({ videoWithContextRenderer: { videoId: id, headline: { runs: [{ text: `Full video title ${i}` }] }, lengthText: { simpleText: '6:15' } } });
const nativeHelpers = source.slice(source.indexOf('  const nativeCardSelector'), source.indexOf('  // Page-world optimizations'));
function nativeFixture(initialCache: unknown = null) {
  const cache = new Map<string, string>();
  if (initialCache) cache.set('vigil-native-feed:home', JSON.stringify(initialCache));
  const api = runInNewContext(`${helpers}\n${nativeHelpers}\n({nativeFeedData,standardFeedItem,domCards,feedModuleSelector})`, {
    state: { day: '2026-10-08' }, feedName: () => 'home',
    document: { querySelectorAll: () => [] },
    localStorage: { getItem: (key: string) => cache.get(key), setItem: (key: string, value: string) => cache.set(key, value) }
  });
  return { api, cache };
}
function fixture() {
  const requests: string[] = [];
  const page = { contents: ids.slice(0, 4).map(renderer), next: { continuationCommand: { token: 'page-two' } } };
  const continuation = { contents: ids.slice(4).map(renderer) };
  const api = runInNewContext(`${helpers}\n({videoCards,jsonAfter})`, {
    document: { querySelectorAll: () => [] }, AbortSignal,
    fetch: async (url: string) => {
      requests.push(url);
      return { ok: true, text: async () => `var ytInitialData = ${JSON.stringify(page)};ytcfg.set(${JSON.stringify({ INNERTUBE_CONTEXT: { client: { clientName: 'MWEB', clientVersion: 'test' } } })});`, json: async () => continuation };
    }
  });
  return { api, requests };
}
test('mobile feed reads full headlines instead of thumbnail durations', () => {
  const { api } = fixture();
  const result = api.videoCards({ contents: ids.slice(0, 4).map(renderer) });
  assert.equal(result.cards[0].title, 'Full video title 0');
  assert.equal(result.cards[0].duration, '6:15');
});
test('JSON extraction handles braces and escaped quotes within video titles without evaluation', () => {
  const { api } = fixture();
  const value = { title: 'A { brace } and "quoted" title' };
  assert.equal(api.jsonAfter(`var ytInitialData = ${JSON.stringify(value)};`, /ytInitialData\s*=\s*/).title, value.title);
});
test('iPhone escaped initial data yields full feed metadata without evaluating JavaScript', () => {
  const { api } = fixture();
  const page = { contents: ids.slice(0, 20).map(renderer) };
  const encoded = JSON.stringify(page).replace(/[^a-zA-Z0-9 ]/g, c => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
  const parsed = api.jsonAfter(`var ytInitialData = '${encoded}'; window.alert('must never run');`, /ytInitialData\s*=\s*/);
  assert.equal(api.videoCards(parsed).cards.length, 20);
  assert.equal(api.videoCards(parsed).cards[0].title, 'Full video title 0');
});
test('native feed retains YouTube renderer models, thumbnails, and a stable twenty-item set', () => {
  const begin = source.indexOf('  const nativeCardSelector');
  const end = source.indexOf('  // Page-world optimizations', begin);
  const cache = new Map<string, string>();
  const api = runInNewContext(`${helpers}\n${source.slice(begin, end)}\n({nativeFeedData})`, {
    state: { day: '2026-09-08' }, feedName: () => 'home', domCards: () => [],
    localStorage: { getItem: (key: string) => cache.get(key), setItem: (key: string, value: string) => cache.set(key, value) }
  });
  const items = ids.map((id, i) => ({ ...renderer(id, i), thumbnail: { source: `original-${i}` } }));
  const first = api.nativeFeedData({ contents: { richGridRenderer: { contents: items } } });
  const firstItems = first.contents.richGridRenderer.contents;
  assert.equal(firstItems.length, 20);
  assert.equal(firstItems[0].thumbnail.source, 'original-0');
  const reopened = api.nativeFeedData({ contents: { richGridRenderer: { contents: items.slice().reverse() } } });
  assert.equal(reopened.contents.richGridRenderer.contents[0].videoWithContextRenderer.videoId, ids[0]);
});

test('desktop and mobile feeds discard whole music, featured, topic, and unknown modules before selecting twenty standard videos', () => {
  for (const kind of ['richGridRenderer', 'itemSectionRenderer']) {
    const { api } = nativeFixture();
    const featured = { richSectionRenderer: { content: { brandVideoSingletonRenderer: { title: { simpleText: 'Are there Angels Among Us?' }, video: renderer('featured001', 0) } } } };
    const music = { richSectionRenderer: { content: { richShelfRenderer: { title: { simpleText: 'Musik entdecken' }, contents: [renderer('music000001', 1)] } } } };
    const items = [featured, music, { feedNudgeRenderer: { title: 'Explore new topics' } },
      { unknownFutureCampaignRenderer: { items: [renderer('campaign001', 2)] } },
      ...ids.map((id, i) => ({ richItemRenderer: { content: renderer(id, i) } })),
      { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: 'more' } } } }];
    const result = api.nativeFeedData({ contents: { [kind]: { contents: items } } }).contents[kind].contents;
    assert.deepEqual(Array.from(result, (item: { richItemRenderer: { content: { videoWithContextRenderer: { videoId: string } } } }) => item.richItemRenderer.content.videoWithContextRenderer.videoId), ids.slice(0, 20));
    assert.equal(api.standardFeedItem(featured), null);
    assert.equal(api.standardFeedItem(music), null);
  }
});

test('ordinary modern video lockups remain usable while playlists and Shorts cannot become standard feed entries', () => {
  const { api } = nativeFixture();
  const video = { richItemRenderer: { content: { lockupViewModel: { contentId: ids[0], contentType: 'LOCKUP_CONTENT_TYPE_VIDEO', metadata: { lockupMetadataViewModel: { title: { content: 'A standard video' } } } } } } };
  assert.equal(api.standardFeedItem(video).videoId, ids[0]);
  const playlist = structuredClone(video);
  playlist.richItemRenderer.content.lockupViewModel.contentType = 'LOCKUP_CONTENT_TYPE_PLAYLIST';
  assert.equal(api.standardFeedItem(playlist), null);
  assert.equal(api.standardFeedItem({ reelShelfRenderer: { items: [renderer('shorts00001', 0)] } }), null);
});

test('a promotion-only feed keeps its continuation so ordinary videos can fill all twenty slots', () => {
  const { api } = nativeFixture();
  const continuation = { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: 'ordinary-page' } } } };
  const page = api.nativeFeedData({ richGridRenderer: { contents: [{ brandVideoShelfRenderer: { items: [renderer('featured001', 0)] } }, continuation] } });
  assert.equal(page.richGridRenderer.contents.length, 1);
  assert.equal(page.richGridRenderer.contents[0], continuation);
  const next = api.nativeFeedData({ onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: ids.map(renderer) } }] }, true);
  assert.equal(next.onResponseReceivedActions[0].appendContinuationItemsAction.continuationItems.length, 20);
});

test('old UI caches cannot reintroduce a featured shelf into the standard feed', () => {
  const item = { richSectionRenderer: { content: { brandVideoShelfRenderer: { items: [renderer('featured001', 0)] } } } };
  const { api, cache } = nativeFixture({ day: '2026-10-08', items: [{ card: { videoId: 'featured001' }, item }] });
  const result = api.nativeFeedData({ richGridRenderer: { contents: ids.map(renderer) } });
  assert.equal(result.richGridRenderer.contents[0].videoWithContextRenderer.videoId, ids[0]);
  assert.equal(JSON.parse(cache.get('vigil-native-feed:home')!).schemaVersion, 2);
});

test('a missing allowance response holds the homepage feed instead of leaving it unrestricted', async () => {
  const attributes = new Map<string, boolean>();
  const begin = source.indexOf('  let lastFilteredFeed');
  const end = source.indexOf('  function clean()', begin);
  const filter = runInNewContext(`${source.slice(begin, end)}; filterNativeFeed`, {
    feedName: () => 'home', state: null,
    document: { documentElement: { toggleAttribute(name: string, value: boolean) { attributes.set(name, value); } } }
  });
  await filter();
  assert.equal(attributes.get('data-vigil-feed-pending'), true);
});

test('websites cap native cards at twenty per page and can choose a fresh twenty after reload', async () => {
  const begin = source.indexOf('  let lastFilteredFeed');
  const end = source.indexOf('  function clean()',begin);
  function page(offset: number) {
    const selected = new Map(); const attributes = new Map(); let moves=0;
    const cards = ids.map((_,i)=>({videoId:`fresh${String(i+offset).padStart(6,'0')}`,title:`Title ${i}`}));
    const nodes=cards.map(card=>({hidden:false,querySelector:()=>({href:`https://m.youtube.com/watch?v=${card.videoId}`}),toggleAttribute(_name:string,hidden:boolean){this.hidden=hidden;},nextElementSibling:null as unknown,after(node:unknown){this.nextElementSibling=node;moves++;}}));
    const filter=runInNewContext(`let feedSync=false,feedSignature='',feedEnd;${source.slice(begin,end)};filterNativeFeed`,{
      state:{day:'2026-09-14',feeds:{home:[{videoId:ids[0]}]}},feedName:()=> 'home',websiteFeed:true,websiteCards:selected,
      nativeCardSelector:'native',standardFeedCard:()=>true,domCards:()=>cards,idFrom:(url:string)=>new URL(url).searchParams.get('v'),
      request:()=>assert.fail('website cards must not replace the protected app feed'),
      document:{documentElement:{toggleAttribute:(name:string,value:boolean)=>attributes.set(name,value)},querySelectorAll:()=>nodes,createElement:()=>({style:{cssText:''}})}
    });
    return {filter,nodes,cards,attributes,get moves(){return moves;}};
  }
  const first=page(0); await first.filter(); await first.filter();
  assert.equal(first.nodes.filter(node=>!node.hidden).length,20);
  assert.equal(first.attributes.get('data-vigil-feed-complete'),true);
  assert.equal(first.moves,1,'an unchanged feed must not keep moving its end marker and retriggering page observers');
  const reload=page(100); await reload.filter();
  assert.equal(reload.nodes.filter(node=>!node.hidden).length,20);
  assert.notEqual(first.cards[0].videoId,reload.cards[0].videoId);
});

test('DOM filtering excludes featured videos from the twenty slots, hides duplicate cards, and removes non-video rich items', async () => {
  const begin = source.indexOf('  let lastFilteredFeed');
  const end = source.indexOf('  function clean()', begin);
  const attributes = new Map<string, boolean>();
  const selected = new Map();
  function card(videoId: string, moduleTag = '', nested = false) {
    const node = {
      hidden: false, parentElement: { closest: () => nested ? {} : null },
      closest: (selector: string) => moduleTag && selector.includes(moduleTag) ? {} : null,
      querySelector: (selector: string) => selector.startsWith('a[') ? videoId ? { href: `https://www.youtube.com/watch?v=${videoId}`, closest: () => node } : null
        : selector.startsWith('h3') ? { textContent: `Title ${videoId}` } : null,
      toggleAttribute(_name: string, hidden: boolean) { this.hidden = hidden; },
      nextElementSibling: null as unknown, after(marker: unknown) { this.nextElementSibling = marker; }
    };
    return node;
  }
  const regular = ids.map(id => card(id));
  const extra = [card('featured001', 'ytd-brand-video-shelf-renderer'), card(ids[0], 'ytm-rich-section-renderer'),
    card('music000001', 'ytm-rich-shelf-renderer'), card(ids[0]), card(''), card(ids[1], '', true)];
  const nodes = [...extra, ...regular];
  const anchors = nodes.flatMap(node => { const anchor = node.querySelector('a[href*="watch?v="]'); return anchor ? [anchor] : []; });
  const filter = runInNewContext(`${helpers}\n${nativeHelpers}\nconst websiteFeed=true,websiteCards=selected;${source.slice(begin, end)};filterNativeFeed`, {
    selected, state: { day: '2026-10-08', feeds: {} }, feedName: () => 'home',
    idFrom: (url: string) => new URL(url).searchParams.get('v'),
    document: {
      documentElement: { toggleAttribute: (name: string, value: boolean) => attributes.set(name, value) },
      querySelectorAll: (selector: string) => selector.startsWith('a[') ? anchors : nodes,
      createElement: () => ({ style: { cssText: '' } })
    }
  });
  await filter();
  assert.equal(attributes.get('data-vigil-standard-feed'), true);
  assert.equal(attributes.get('data-vigil-feed-complete'), true);
  assert.deepEqual(Array.from(selected.get('2026-10-08:home')), ids.slice(0, 20));
  assert.equal(extra[0].hidden, true, 'featured campaign cannot add an extra video');
  assert.equal(extra[1].hidden, true, 'a shelf cannot display even an allowed ordinary ID');
  assert.equal(extra[2].hidden, true, 'mobile music shelf cannot add an extra video');
  assert.equal(extra[4].hidden, true, 'a rich item without a standard video is hidden');
  assert.equal(nodes.filter(node => !node.hidden && !node.parentElement.closest()).length, 20);
  assert.equal(regular[0].hidden, true, 'duplicate video cards do not extend the visible feed');
});


test('standalone desktop and mobile lockup menus reserve the selected video instead of retaining the prior card', () => {
  const api = runInNewContext(`let menuVideo = {videoId: 'previous001', title: 'Previous video'};\n${helpers}\n${nativeHelpers}\n({rememberMenuVideo, menu: () => menuVideo})`, {
    document: { querySelector: () => null }, currentID: () => '',
    idFrom: (url: string) => new URL(url).searchParams.get('v')
  });
  for (const [index, tag] of ['yt-lockup-view-model', 'ytm-lockup-view-model', 'ytd-rich-grid-media', 'ytm-rich-grid-media', 'ytm-playlist-video-renderer'].entries()) {
    const videoId = ids[index];
    const title = `Selected video ${index}`;
    const card = { querySelector: (selector: string) => selector.startsWith('a[') ? { href: `https://www.youtube.com/watch?v=${videoId}` } : { textContent: title } };
    api.rememberMenuVideo({ closest: (selector: string) => selector.split(',').includes(tag) ? card : null });
    assert.deepEqual(JSON.parse(JSON.stringify(api.menu())), { videoId, title }, `${tag} supplies its own video and title`);
    api.rememberMenuVideo({ closest: () => null });
    assert.deepEqual(JSON.parse(JSON.stringify(api.menu())), { videoId, title }, 'opening a detached Save dialog keeps the originating card selection');
  }
  api.rememberMenuVideo({ closest: () => ({ querySelector: () => null }) });
  assert.equal(api.menu(), null, 'a card without a valid video clears stale menu provenance');
});
