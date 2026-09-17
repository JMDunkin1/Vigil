import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
const source = await readFile(new URL('../extension/youtube-limits.js', import.meta.url), 'utf8');
const helpers = source.slice(source.indexOf('  // Feed metadata'), source.indexOf('  function feedName()'));
const ids = Array.from({ length: 25 }, (_, i) => `video${String(i).padStart(6, '0')}`);
const renderer = (id: string, i: number) => ({ videoWithContextRenderer: { videoId: id, headline: { runs: [{ text: `Full video title ${i}` }] }, lengthText: { simpleText: '6:15' } } });
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
      nativeCardSelector:'native',domCards:()=>cards,idFrom:(url:string)=>new URL(url).searchParams.get('v'),
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
