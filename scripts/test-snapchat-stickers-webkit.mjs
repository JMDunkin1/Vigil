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
window.fixturePlaybackDiagnostic=()=>Object.fromEntries(['sticker','.vigil-snap-sticker-save','.vigil-snap-sticker-toggle','[contenteditable]'].map(selector=>{
  const node=selector==='sticker'?document.getElementById(selector):document.querySelector(selector);
  return [selector,node&&{...node.getBoundingClientRect().toJSON(),position:getComputedStyle(node).position,text:node.textContent,focused:document.hasFocus(),visible:document.visibilityState,verdict:node.dataset.vigilMediaVerdict,pageVerdict:document.documentElement.dataset.vigilPageVerdict}];
}));
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
  ...[320,390,430].map(width=>({width,condition:`(()=>{
    const image=document.getElementById('sticker'),save=document.querySelector('.vigil-snap-sticker-save'),toggle=document.querySelector('.vigil-snap-sticker-toggle');
    const i=image.getBoundingClientRect(),s=save.getBoundingClientRect(),t=toggle.getBoundingClientRect(),field=document.querySelector('[contenteditable]').getBoundingClientRect();
    return image.nextElementSibling===save && s.top>=i.bottom && s.top-i.bottom<=6 && s.height>=44
      && getComputedStyle(save).position==='static' && !document.querySelector('.sT7ta > .vigil-snap-sticker-toggle')
      && toggle.getAttribute('aria-label')==='Saved stickers' && toggle.textContent.trim()===''
      && Math.abs(t.top-field.top)<=4 && t.left>=field.right-1 && t.width===44;
  })()`,snapshot:width===390?'sticker-inline-controls':undefined})),
  {width:390,action:"document.querySelector('.p8r1z').insertAdjacentHTML('beforeend','<div id=\"fixture-later-controls\">Other message controls</div>');document.getElementById('sticker').after(document.createElement('span'))",
    condition:"document.getElementById('sticker').nextElementSibling?.matches('.vigil-snap-sticker-save')===true"},
  {focus:true,action:"document.querySelector('.vigil-snap-sticker-save').click()",condition:"document.querySelector('.vigil-snap-sticker-save').textContent==='Sticker saved'"},
  {action:"window.fixtureToBlob=HTMLCanvasElement.prototype.toBlob;window.fixtureTainted=true;HTMLCanvasElement.prototype.toBlob=function(...args){if(fixtureTainted){fixtureTainted=false;throw new DOMException('Tainted','SecurityError');}return fixtureToBlob.apply(this,args);};document.querySelector('.vigil-snap-sticker-save').click()",
    condition:"fixtureRequests.length===2 && document.querySelector('.vigil-snap-sticker-save').textContent==='Sticker saved'"},
  {action:"HTMLCanvasElement.prototype.toBlob=fixtureToBlob",condition:"fixtureSaved!==null"},
  {action:"document.querySelector('.vigil-snap-sticker-toggle').click()",condition:"!!document.querySelector('.vigil-snap-sticker-item img')",snapshot:'stickers-phone'},
  {action:"document.querySelector('.vigil-snap-sticker-item img').dataset.vigilMediaVerdict='safe';document.querySelector('.vigil-snap-sticker-item button').click()",
    condition:"window.fixturePaste?.[0].type==='image/png' && fixturePaste[0].size>0 && window.fixtureSent===undefined && document.querySelector('.vigil-snap-sticker-drawer').hidden"},
  {action:"document.querySelector('.vigil-snap-sticker-toggle').click()",condition:"!document.querySelector('.vigil-snap-sticker-drawer').hidden && !!document.querySelector('.vigil-snap-sticker-item')"},
  {action:"document.querySelectorAll('.vigil-snap-sticker-item button')[1].click()",condition:"fixtureSaved===null && document.querySelector('.vigil-snap-sticker-grid').children.length===0"}
]}, {name:'stickers-privacy',html,steps:[
  {focus:true,action:fixture,condition:"!!document.querySelector('.vigil-snap-sticker-save') && document.getElementById('sticker').complete"},
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
]}, {name:'stickers-native-composer',html,steps:[
  {focus:true,action:fixture+`{
    const composer=document.querySelector('.sT7ta');
    composer.innerHTML='<div class="jh13h" style="display:flex;align-items:center;gap:4px"><button aria-label="Camera" style="width:44px">◎</button><div class="shMO3" style="flex:1;min-width:0"><div class="fCmUn" style="display:flex;flex-direction:column"><div class="euyIb" role="textbox" contenteditable="true" aria-label="Send a chat"></div></div></div><button aria-label="Emoji" style="width:44px">☺</button><button aria-label="Attach" style="width:44px">+</button></div>';
    document.querySelector('.p8r1z').innerHTML='<div class="rBYFf" style="width:96px"><img class="pjJv3" id="sticker" width="96" height="96"></div><span>Message details</span>';
    document.getElementById('sticker').src=fixturePNG;document.getElementById('sticker').dataset.vigilMediaVerdict='safe';
  }`,condition:"!!document.querySelector('.shMO3 + .vigil-snap-sticker-toggle') && !!document.querySelector('.rBYFf + .vigil-snap-sticker-save')"},
  ...[320,390,430].map(width=>({width,condition:`(()=>{
    const field=document.querySelector('.shMO3').getBoundingClientRect(),toggle=document.querySelector('.vigil-snap-sticker-toggle').getBoundingClientRect();
    const image=document.getElementById('sticker').getBoundingClientRect(),save=document.querySelector('.vigil-snap-sticker-save').getBoundingClientRect();
    return toggle.top>=field.top-1 && toggle.bottom<=field.bottom+1 && toggle.left>=field.right-1 && toggle.right<=innerWidth
      && toggle.height===44 && save.top>=image.bottom && save.top-image.bottom<=6;
  })()`,snapshot:width===390?'sticker-native-inline-controls':undefined})),
  {focus:true,action:"document.querySelector('.vigil-snap-sticker-toggle').click()",condition:"!document.querySelector('.vigil-snap-sticker-drawer').hidden"}
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
