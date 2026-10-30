#!/usr/bin/env node
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(process.argv[2] || join(root, 'ios/VigilSocial/VigilSocial/DOMAdapters.swift'), 'utf8');
const tests = await readFile(join(root, 'ios/VigilSocial/VigilSocialTests/VigilSocialTests.swift'), 'utf8');
const extract = (s,n) => s.match(new RegExp(`(?:private )?static let ${n} = #"""([\\s\\S]*?)"""#`))?.[1];
const html = extract(tests,'snapchatMobileShellFixture') + extract(tests,'snapchatCallFixture');
const adapter = extract(source,'snapchatMobileLayout');
assert.ok(adapter && html.includes('fixtureOpenCall'));
const gate=source.match(/static func earlyMediaGate\([\s\S]*?return #"""([\s\S]*?)"""#/u)?.[1];
const registry=extract(source,'rootRegistryFactory');
assert.ok(gate && registry);
const prelude=gate.replaceAll('AUDIO_PREFERENCE','true').replaceAll('PREFER_AUDIBLE_VIDEO','false')
  .replaceAll('ROOT_REGISTRY_FACTORY',registry);
// Exercise the production gate with explicit fixture classification outcomes.
// This does not replace or relax any product eligibility/classification code.
const eligibility=`window.fixtureCallPolicy='safe';
  window.__vigilEarlyMediaGate.setEligibilityResolver(()=>fixtureCallPolicy==='safe');
  window.__vigilEarlyMediaGate.setAudioContextEligibilityResolver(()=>fixtureCallPolicy==='safe');
  // A deterministic fixture classifier supplies the allow() signal normally
  // delivered by the native/common classifier after the early insertion hold.
  new MutationObserver(records=>{
    if(!records.some(r=>r.addedNodes.length))return;
    setTimeout(()=>{if(fixtureCallPolicy==='safe')document.querySelectorAll('audio,video')
      .forEach(media=>__vigilEarlyMediaGate.allow(media,true));},0);
  }).observe(document.documentElement,{childList:true,subtree:true});`;
const steps=[];
for(const width of [320,390,430]) for(const kind of ['hpge3','Rnl06','PvwWu']) {
  steps.push({width,condition:`innerWidth===${width}`}, {action:`fixtureOpenCall('${kind}')`,
    condition:`(()=>{const s=fixtureCallGeometry();return s.width>=${width-1} && s.height>=779 && s.inline && !s.covered && !s.overflow${kind==='hpge3'?'':` && s.remoteWidth>=${width-30} && s.remoteHeight>=600`}})()`});
}
steps.push({action:'fixtureCloseCall();fixtureOpenCall("Rnl06");fixtureStartLoopback().then(()=>fixtureLoopbackResult()).then(r=>window.loopbackResult=r).catch(e=>window.loopbackError=String(e))',
  condition:'window.loopbackResult?.energy>.005 && !loopbackResult.paused && !loopbackResult.muted && loopbackResult.videoWidth===320 && loopbackResult.videoHeight===480',snapshot:'call-phone'});
steps.push({action:'__vigilEarlyMediaGate.setAudioPreference(false)',
  condition:'fixtureLoopback.media.muted && fixtureLoopback.context.state==="suspended"'});
steps.push({action:'__vigilEarlyMediaGate.setAudioPreference(true)',
  condition:'!fixtureLoopback.media.muted && fixtureLoopback.context.state==="running"'});
steps.push({action:'fixtureCallPolicy="blocked";__vigilEarlyMediaGate.hold(fixtureLoopback.media,false,true);__vigilEarlyMediaGate.suspendAudioContexts(true);fixtureLoopback.media.play();fixtureLoopback.context.resume()',
  condition:'fixtureLoopback.media.paused && fixtureLoopback.media.muted && fixtureLoopback.context.state==="suspended"'});
steps.push({action:'fixtureStopLoopback();document.querySelector("._XMCw").style.gridTemplateRows="minmax(0,1fr) minmax(0,1fr)"',condition:'fixtureCallGeometry().height>=779'});
steps.push({width:390,height:420,condition:'innerHeight===420 && fixtureCallGeometry().height>=419 && !fixtureCallGeometry().covered'});
steps.push({width:900,condition:'innerWidth===900 && getComputedStyle(document.querySelector(".ChLAv")).display!=="none"'});
steps.push({width:390,condition:'innerWidth===390 && fixtureCallGeometry().height>=779'});
const scenarios=[{name:'call-phone',html,steps}, {name:'call-external-header',html,steps:[
  {action:'fixtureOpenCall("PvwWu",true)',condition:'fixtureCallGeometry().height>=779 && fixtureHangupReachable()',snapshot:'call-external-header'},
  {action:'fixtureOpenSnap("rows")',condition:'document.querySelector(".ecBYF").getBoundingClientRect().height>=779'},
  {action:'fixtureCloseSnap()',condition:'fixtureCallGeometry().height>=779 && fixtureHangupReachable()'},
  {action:'document.getElementById("fixture-hangup").click()',condition:'!document.getElementById("fixture-call")'}
]}, {name:'loading-snap',html,steps:[
  {action:'fixtureOpenLoadingSnap()',condition:`(()=>{const r=document.querySelector('.ecBYF').getBoundingClientRect();return r.width>=389 && r.height>=779 && getComputedStyle(document.querySelector('.ChLAv')).display==='none'})()`}
]}, {name:'snap-during-call',html,steps:[
  {action:'fixtureOpenCall("Rnl06");fixtureOpenSnap("rows")',
    condition:`(()=>{const r=document.querySelector('.ecBYF').getBoundingClientRect();return r.height>=779 && getComputedStyle(document.getElementById('fixture-call')).display==='none'})()`,snapshot:'snap-during-call'},
  {action:'fixtureCloseSnap()',condition:'fixtureCallGeometry().height>=779'}
]}].filter(s=>!process.argv[3] || s.name===process.argv[3]);
assert.ok(scenarios.length,'Choose a known WebKit scenario');
const directory=await mkdtemp(join(tmpdir(),'vigil-snapchat-calls-webkit-'));
try {
  await Promise.all([writeFile(join(directory,'adapter.js'),eligibility+adapter),writeFile(join(directory,'prelude.js'),prelude),
    writeFile(join(directory,'scenarios.json'),JSON.stringify(scenarios))]);
  const binary=join(directory,'snapchat-calls-test');
  await exec('xcrun',['swiftc',join(root,'tests/fixtures/snapchat-calls-webkit.swift'),'-o',binary],{timeout:60000});
  const result=await exec(binary,[directory],{timeout:120000,maxBuffer:2*1024*1024});
  process.stdout.write(result.stdout);if(result.stderr)process.stderr.write(result.stderr);
  assert.ok(result.stdout.includes('VIGIL_SNAPCHAT_CALLS_WEBKIT_COMPLETE'));
  console.log(`WebKit evidence retained at ${directory}`);
} catch(error) {
  if(error.stdout)process.stderr.write(error.stdout);if(error.stderr)process.stderr.write(error.stderr);
  process.stderr.write(`WebKit evidence retained at ${directory}\n`);throw error;
}
