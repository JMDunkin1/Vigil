import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const root = existsSync(join(runtimeRoot, 'ios')) ? runtimeRoot : resolve(runtimeRoot, '../..');
const source = await readFile(join(root,'ios/VigilSocial/VigilSocial/DOMAdapters.swift'),'utf8');
const begin=source.indexOf('      const healthContentSelector = [');
const end=source.indexOf('      const elementsWithin',begin);
function fixture(pathname='/', playerControlsVisible = false) {
  let now=10000, gated=true, visible=true;
  const reports:{type:string;state?:string;detail?:string;blocksRefresh?:boolean;refreshEligible?:boolean}[]=[];
  const root={dataset:{},hasAttribute:()=>gated,getAttribute:()=>null};
  const screen={};
  const controls={};
  const api=runInNewContext(source.slice(begin,end)+'\n({reportHealth,reportSurface})',{
    document:{documentElement:root,body:{innerText:''},fullscreenElement:null,querySelectorAll:(selector:string)=>{
      if (selector.includes('#vigil-youtube-finished')) return [screen];
      if (selector.includes('.html5-video-player .ytp-large-play-button')) return [controls];
      return [];
    }},
    location:{pathname,search:''},Date:{now:()=>now},
    visibleElement:(element:object)=>element === controls ? playerControlsVisible : visible,mainVideo:()=>null,
    window:{__vigilBridge:(report:typeof reports[number])=>reports.push(report)},
    setTimeout:()=>1,clearTimeout:()=>{}
  });
  return {api,reports,advance:()=>{now+=7000;},hide:()=>{visible=false;},show:()=>{visible=true;},leave:()=>{gated=false;}};
}
test('completed saves are a usable app surface on home, channel and held watch routes',()=>{
  for(const path of ['/','/@channel','/watch']) {
    const f=fixture(path);f.api.reportHealth();f.api.reportSurface();
    assert.equal(f.reports.find(report=>report.type==='health')?.state,'ready');
    assert.equal(f.reports.find(report=>report.type==='surface')?.blocksRefresh,true);
    assert.equal(f.reports.find(report=>report.type==='surface')?.refreshEligible,false);
  }
});
test('a missing or hidden completion screen cannot conceal a real blank page failure',()=>{
  for(const missing of [true,false]) {
    const f=fixture();if(missing)f.leave();else f.hide();
    f.api.reportHealth();f.advance();f.api.reportHealth();
    const health=f.reports.find(report=>report.type==='health');
    assert.equal(health?.state,'degraded');
    assert.match(health?.detail||'',/has not loaded a usable home surface/);
  }
});
test('a completion screen appearing after the blank-page error clears the recovery overlay',()=>{
  const f=fixture();f.hide();f.api.reportHealth();f.advance();f.api.reportHealth();
  assert.equal(f.reports.at(-1)?.state,'degraded');
  f.show();f.api.reportHealth();
  assert.equal(f.reports.at(-1)?.state,'ready');
});

test('visible watch controls are usable while the video is concealed', () => {
  for (const controlsVisible of [true, false]) {
    const f = fixture('/watch', controlsVisible);
    f.leave();
    f.api.reportHealth();
    f.advance();
    f.api.reportHealth();
    assert.equal(f.reports.at(-1)?.state, controlsVisible ? 'ready' : 'degraded');
  }
});
