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
const source = await readFile(join(root, 'ios/VigilSocial/VigilSocial/DOMAdapters.swift'), 'utf8');
const extract = name => source.match(new RegExp(`private static let ${name} = #"""([\\s\\S]*?)"""#`))?.[1];
const layout = extract('snapchatMobileLayout'), stickers = extract('snapchatStickers');
assert.ok(layout && stickers);
const html = await readFile(join(root, 'tests/fixtures/snapchat-desktop-shell.html'), 'utf8');
// A deterministic bridge stand-in checks actual WebKit DOM, image encoding and
// ClipboardEvent behavior. The iOS tests separately cover native persistence
// and the production classifier/access bridge.
const fixture = `
openChat('Alex'); document.documentElement.dataset.vigilPageVerdict='safe';
const c=document.createElement('canvas');c.width=96;c.height=96;
c.getContext('2d').fillStyle='#ff0000';c.getContext('2d').fillRect(32,32,32,32);
window.fixturePNG=c.toDataURL('image/png');window.fixtureRequests=[];window.fixtureSaved=null;
document.querySelector('.messages').innerHTML='<div class="KB4Aq"><div class="p8r1z"><img class="qHVR1" id="sticker" width="96" height="96"></div></div><img id="avatar" class="qHVR1" width="48" height="48">';
document.getElementById('sticker').src=fixturePNG;document.getElementById('sticker').dataset.vigilMediaVerdict='safe';
document.getElementById('avatar').src=fixturePNG;
window.__vigilBridge=p=>{if(p.type!=='snapchatSticker')return;fixtureRequests.push(p);setTimeout(()=>{
  if(!__vigilValidateSnapchatSticker(p.requestID))return __vigilCompleteSnapchatSticker(p.requestID,{error:'Stopped'});
  if(p.action==='save'){fixtureSaved=p.base64;__vigilCompleteSnapchatSticker(p.requestID,{id:'a'.repeat(64)});}
  if(p.action==='list')__vigilCompleteSnapchatSticker(p.requestID,{entries:fixtureSaved?[{id:'a'.repeat(64),thumbnail:'data:image/png;base64,'+fixtureSaved}]:[]});
  if(p.action==='use')__vigilCompleteSnapchatSticker(p.requestID,{base64:fixtureSaved});
  if(p.action==='remove'){fixtureSaved=null;__vigilCompleteSnapchatSticker(p.requestID,{removed:true});}
},window.fixtureDelay||20);};
document.querySelector('[contenteditable]').addEventListener('paste',e=>{e.preventDefault();window.fixturePaste=[...e.clipboardData.files].map(f=>({type:f.type,size:f.size}));});
`;
const scenarios = [{name:'stickers-phone', html, steps:[
  {action:fixture,condition:"!!document.querySelector('.vigil-snap-sticker-save') && document.getElementById('sticker').complete"},
  {action:"document.querySelector('.vigil-snap-sticker-save').click()",condition:"document.querySelector('.vigil-snap-sticker-save').textContent==='Sticker saved'"},
  {action:"window.fixtureToBlob=HTMLCanvasElement.prototype.toBlob;window.fixtureTainted=true;HTMLCanvasElement.prototype.toBlob=function(...args){if(fixtureTainted){fixtureTainted=false;throw new DOMException('Tainted','SecurityError');}return fixtureToBlob.apply(this,args);};document.querySelector('.vigil-snap-sticker-save').click()",
    condition:"fixtureRequests.length===2 && document.querySelector('.vigil-snap-sticker-save').textContent==='Sticker saved'"},
  {action:"HTMLCanvasElement.prototype.toBlob=fixtureToBlob",condition:"fixtureSaved!==null"},
  {action:"document.querySelector('.vigil-snap-sticker-toggle').click()",condition:"!!document.querySelector('.vigil-snap-sticker-item img')",snapshot:'stickers-phone'},
  {action:"document.querySelector('.vigil-snap-sticker-item img').dataset.vigilMediaVerdict='safe';document.querySelector('.vigil-snap-sticker-item button').click()",
    condition:"window.fixturePaste?.[0].type==='image/png' && fixturePaste[0].size>0 && window.fixtureSent===undefined && document.querySelector('.vigil-snap-sticker-drawer').hidden"},
  {action:"document.querySelector('.vigil-snap-sticker-toggle').click()",condition:"!document.querySelector('.vigil-snap-sticker-drawer').hidden && !!document.querySelector('.vigil-snap-sticker-item')"},
  {action:"document.querySelectorAll('.vigil-snap-sticker-item button')[1].click()",condition:"fixtureSaved===null && document.querySelector('.vigil-snap-sticker-grid').children.length===0"}
]}, {name:'stickers-privacy',html,steps:[
  {action:fixture,condition:"!!document.querySelector('.vigil-snap-sticker-save') && document.getElementById('sticker').complete"},
  ...['sensitive','unknown','blur','shield','page'].map(kind=>({action:`{
    const i=document.getElementById('sticker');i.dataset.vigilMediaVerdict='safe';i.style.filter='none';
    document.querySelector('.fixture-shield')?.remove();document.documentElement.dataset.vigilPageVerdict='safe';
    if('${kind}'==='sensitive'||'${kind}'==='unknown')i.dataset.vigilMediaVerdict='${kind}';
    if('${kind}'==='blur')i.style.filter='blur(10px)';
    if('${kind}'==='page')document.documentElement.dataset.vigilPageVerdict='sensitive';
    if('${kind}'==='shield'){const s=document.createElement('div');s.className='ejVI4 fixture-shield';s.style.cssText='position:absolute;inset:0;background:gray';document.querySelector('.aXEpU').append(s);}
    document.querySelector('.vigil-snap-sticker-save').click();}`,condition:"fixtureRequests.length===0 && document.querySelector('.vigil-snap-sticker-save').textContent==='Sticker unavailable or blocked'"})),
  {action:"window.fixtureDelay=250;document.querySelector('.fixture-shield')?.remove();document.documentElement.dataset.vigilPageVerdict='safe';document.getElementById('sticker').dataset.vigilMediaVerdict='safe';document.getElementById('sticker').style.filter='none';document.querySelector('.vigil-snap-sticker-save').click()",
    condition:"fixtureRequests.length===1"},
  {action:"document.getElementById('sticker').src=fixtureMediaImage(96,96)",
    condition:"fixtureSaved===null && !document.querySelector('.vigil-snap-sticker-save').disabled"},
  {condition:"document.querySelectorAll('.vigil-snap-sticker-save').length===1 && !document.getElementById('avatar').parentElement.querySelector(':scope > .vigil-snap-sticker-save')"}
]}];
const directory = await mkdtemp(join(tmpdir(),'vigil-snapchat-stickers-webkit-'));
await Promise.all([writeFile(join(directory,'adapter.js'),layout+stickers),writeFile(join(directory,'prelude.js'),''),
  writeFile(join(directory,'scenarios.json'),JSON.stringify(scenarios))]);
const binary=join(directory,'stickers-test');
await exec('xcrun',['swiftc',join(root,'tests/fixtures/snapchat-calls-webkit.swift'),'-o',binary],{timeout:60000});
try {
  const result=await exec(binary,[directory],{timeout:120000,maxBuffer:2*1024*1024});
  process.stdout.write(result.stdout);if(result.stderr)process.stderr.write(result.stderr);
  assert.ok(result.stdout.includes('VIGIL_SNAPCHAT_CALLS_WEBKIT_COMPLETE'));
} catch(error) {
  if(error.stdout)process.stderr.write(error.stdout);if(error.stderr)process.stderr.write(error.stderr);throw error;
} finally { console.log(`Sticker WebKit evidence: ${directory}`); }
