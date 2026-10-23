import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultState } from '../src/defaults.js';
import { youtubeAction } from '../src/youtubeLimits.js';
import { YouTubeSharedLedger, validateYouTubeLedgerSeed } from '../src/youtubeSharedWorker.js';
import { mergeYouTubeLedgers } from '../src/youtubeLedgerMigration.js';
import { sendSharedYouTube, validateYouTubeSharedConnection } from '../src/youtubeSharedConnection.js';
import type { YouTubeDay } from '../src/youtubeLimits.js';
import { protectedStateSnapshot } from '../src/seal.js';
const token='1'.repeat(64);
const ids=Array.from({length:12},(_,i)=>`video${String(i).padStart(6,'0')}`);
function fixture() {
  const seed=defaultState(); youtubeAction(seed,{action:'status'});
  let state: unknown, writes=0, fail=false;
  let queue=Promise.resolve();
  const storage={transaction<T>(fn:(tx:{get<V>(key:string):Promise<V|undefined>;put(key:string,value:unknown):Promise<void>})=>Promise<T>):Promise<T>{
    const next=queue.then(async()=>{
      let staged=state;
      const result=await fn({async get<V>(){return staged===undefined?undefined:structuredClone(staged) as V;},async put(_key,value){if(fail)throw new Error('disk failed');staged=structuredClone(value);writes++;}});
      state=staged; return result;
    });
    queue=next.then(()=>{},()=>{});return next;
  }};
  const env={LEDGER_TOKEN:token,LEDGER_SEED_JSON:JSON.stringify({youtubeLimits:seed.youtubeLimits}),LEDGERS:null as never};
  const ledger=new YouTubeSharedLedger({storage},env);
  const send=(body:unknown,credential=token)=>ledger.fetch(new Request('https://ledger.test/api/youtube',{method:'POST',headers:{Authorization:`Bearer ${credential}`},body:JSON.stringify(body)}));
  return {send,env,ledger,get writes(){return writes;},fail(){fail=true;},restore(){return new YouTubeSharedLedger({storage},env);}};
}
test('simultaneous saves from all three surfaces share exactly four slots through restart',async()=>{
  const f=fixture();
  const replies=await Promise.all(ids.map(async(videoId,i)=>{const response=await f.send({action:'save',videoId,client:['mac','ios-app','ios-safari'][i%3]});return response.json();}));
  assert.equal(replies.filter(reply=>reply.ok).length,4);
  const saved=await(await f.send({action:'status'})).json();assert.equal(saved.slots.filter(Boolean).length,4);
  const restarted=f.restore();
  const status=await(await restarted.fetch(new Request('https://ledger.test/api/youtube',{method:'POST',headers:{Authorization:`Bearer ${token}`},body:JSON.stringify({action:'status'})}))).json();
  assert.deepEqual(status.slots,saved.slots);assert.equal(f.writes,4,'no-op status polling does not spend storage writes');
});
test('a missing seed or failed durable write grants nothing and never creates a blank fallback',async()=>{
  const missing=fixture();missing.env.LEDGER_SEED_JSON='{}';assert.equal((await missing.send({action:'save',videoId:ids[0]})).status,503);
  const disk=fixture();disk.fail();assert.equal((await disk.send({action:'start',videoId:ids[0],client:'phone'})).status,503);
  assert.equal(disk.writes,0);
});
test('shared watch time and lease ownership follow the same authority across surfaces',async()=>{
  const f=fixture();await f.send({action:'save',videoId:ids[0]});
  const started=await(await f.send({action:'start',videoId:ids[0],client:'phone'})).json();assert.ok(started.lease);
  assert.equal((await(await f.send({action:'start',videoId:ids[0],client:'mac'})).json()).ok,false);
  await f.send({action:'settle',leaseId:started.lease.id,playedMs:1500,client:'phone'});
  const other=await(await f.send({action:'status',client:'safari'})).json();assert.equal(other.usedMs,1500);
});
test('credentials, malformed bodies, oversized chunked inputs and redirect recipients are rejected',async()=>{
  const f=fixture();assert.equal((await f.send({action:'status'},'2'.repeat(64))).status,403);
  assert.equal((await f.send([])).status,400);
  assert.equal((await f.send({action:'status',padding:'x'.repeat(17000)})).status,413);
  assert.throws(()=>validateYouTubeSharedConnection({endpoint:'http://ledger.test/api/youtube',token}));
  assert.throws(()=>validateYouTubeSharedConnection({endpoint:'https://ledger.test/api/youtube?token=secret',token}));
  let called=false;
  await assert.rejects(sendSharedYouTube({endpoint:'https://ledger.test/api/youtube',token},{action:'save',videoId:ids[0]},async(_url,options)=>{
    called=true;assert.equal(options?.redirect,'error');return new Response('unavailable',{status:503});
  }));assert.equal(called,true);
});
test('migration retains consumed slots and conservatively combines all three independent clocks',()=>{
  const sources={} as Record<'mac'|'ios-app'|'ios-safari',{youtubeLimits:YouTubeDay}>;
  let i=0;
  for(const name of ['mac','ios-app','ios-safari'] as const){
    const state=defaultState();youtubeAction(state,{action:'save',videoId:ids[i++]});state.youtubeLimits!.usedMs=1000;
    sources[name]={youtubeLimits:state.youtubeLimits!};
  }
  const original=structuredClone(sources);
  const result=mergeYouTubeLedgers(sources);assert.equal(result.seed.youtubeLimits.usedMs,3000);
  assert.equal(result.seed.youtubeLimits.slots.filter(Boolean).length,3);assert.deepEqual(sources,original);
  assert.throws(()=>mergeYouTubeLedgers({...sources,'ios-safari':undefined as never}));
  for(const videoId of ids.slice(3,7))youtubeAction(sources.mac as never,{action:'save',videoId});
  const conflict=mergeYouTubeLedgers(sources);assert.equal(conflict.overflow,true);
  assert.equal(conflict.seed.youtubeLimits.slots.filter(slot=>slot?.locked).length,4);
  assert.equal(youtubeAction(conflict.seed as never,{action:'save',videoId:ids[10]}).ok,false);
});
test('seed corruption and authority removal cannot silently reopen local allowances',()=>{
  const state=defaultState();youtubeAction(state,{action:'status'});
  const seed=structuredClone({youtubeLimits:state.youtubeLimits!});seed.youtubeLimits.slots[0]={videoId:'invalid',title:'bad',locked:false,removed:false};
  assert.throws(()=>validateYouTubeLedgerSeed(seed));
  const before=protectedStateSnapshot(state as never);state.youtubeSharedAuthority={endpoint:'https://ledger.test/api/youtube'};
  assert.notDeepEqual(protectedStateSnapshot(state as never),before);
});
