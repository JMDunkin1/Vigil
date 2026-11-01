#!/usr/bin/env node
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
const run=promisify(execFile),root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const source=await readFile(process.argv[2]?resolve(process.argv[2]):join(root,'ios/VigilSocial/VigilSocial/DOMAdapters.swift'),'utf8');
const extract=name=>source.match(new RegExp(`(?:private )?static let ${name} = #"""([\\s\\S]*?)"""#`))?.[1];
const guard=extract('instagramSingleReelGuard'),stable=extract('instagramStable'),start=extract('instagramStableDocumentStartStyle');
assert.ok(guard&&stable&&start);for(const script of [guard,stable,start])assert.doesNotThrow(()=>new Function(script));
const html=await readFile(join(root,'tests/fixtures/instagram-relay-carousel.html'),'utf8');
const scenarios=[];
for(const mode of ['exact','padded','distant','photo-only','legacy','wrong-reference','wrong-parent','wrong-child','missing-module','wrong-track']){
 const allowed=['exact','padded','distant','photo-only','legacy'].includes(mode);
 scenarios.push({name:`Loaded Relay carousel: ${mode}`,path:'/creator/p/Dump123/',
  html:html.replace("fixtureMode='exact'",`fixtureMode='${mode}'`)
   .replace("{code:'Dump123'}",`{code:'${mode==='wrong-reference'?'Other123':'Dump123'}'}`),steps:[
  {condition:"document.getElementById('selected').dataset.vigilSingleReelCard==='allowed'"},
  {action:'fixtureLater()',
   condition:mode==='wrong-track'?"fixturePhotosVisible()&&getComputedStyle(document.getElementById('later')).visibility==='hidden'"
    :allowed?'fixtureAllowed()':'fixtureBlocked()'},
  ...(allowed?[{condition:'fixtureContained()'},
   {action:"document.getElementById('later').srcset='https://example.com/recommendation.jpg 390w'",condition:'fixtureDenied()'}]:[])
 ]});
}
for(const kind of ['image','video'])scenarios.push({name:`Relay ${kind} hydrates after carousel capture`,path:'/creator/p/Dump123/',
 html:html.replace("window.fixtureReady=true","window.fixtureReady=false"),steps:[
  {condition:"document.getElementById('selected').dataset.vigilSingleReelCard==='allowed'"},
  {action:`fixtureLater('${kind}')`,condition:'fixtureBlocked()'},
  {action:"fixtureReady=true;document.getElementById('later').dispatchEvent(new Event('load',{bubbles:true}))",condition:'fixtureAllowed()'},
  {condition:'fixtureContained()'},
  {action:"document.querySelector('#selected a').href='/p/Other123/'",condition:'fixtureBlocked()'}
 ]});
scenarios.push({name:'All srcset alternatives require source proof',path:'/creator/p/Dump123/',html,steps:[
 {condition:"document.getElementById('selected').dataset.vigilSingleReelCard==='allowed'"},
 {action:"fixtureLater();document.getElementById('later').srcset+=' , https://example.com/unlisted.jpg 1080w'",condition:'fixtureDenied()'}
]});
scenarios.push({name:'A different video record cannot inherit carousel permission',path:'/creator/p/Dump123/',
 html:html.replace("fixtureMode='exact'","fixtureMode='wrong-video-record'"),steps:[
 {condition:"document.getElementById('selected').dataset.vigilSingleReelCard==='allowed'"},
 {action:"fixtureLater('video')",condition:'fixtureDenied()'}
]});
for(const kind of ['image','video'])scenarios.push({name:`Unlisted ${kind} outside the carousel cannot gray verified photos`,
 path:'/creator/p/Dump123/',html,documentStart:true,steps:[
  {condition:'fixturePhotosVisible()'},
  {action:`fixtureChrome('${kind}')`,condition:"fixturePhotosVisible()&&getComputedStyle(document.getElementById('chrome')).visibility==='hidden'"},
  {condition:'fixtureContained()'},
  {action:"document.querySelector('#track img').src='https://example.com/recommendation.jpg'",condition:'fixtureFirstDenied()'}
 ]});
for(const kind of ['image','video'])scenarios.push({name:`Verified ${kind} returns from a recycled card without a permanent rejection`,
 path:'/creator/p/Dump123/',html,documentStart:true,steps:[
  {condition:'fixturePhotosVisible()'},
  {action:`fixtureLater('${kind}')`,condition:'fixtureAllowed()'},
  {action:"window.savedSlot=document.getElementById('later').closest('li');document.getElementById('other').append(savedSlot)",
   condition:"getComputedStyle(document.getElementById('later')).visibility==='hidden'"},
  {action:"document.getElementById('track').append(savedSlot)",condition:'fixtureAllowed()'},
  {condition:'fixtureContained()'}
 ]});
for(const known of [true,false]){
 for(const action of ['fixtureRemountTrack','fixtureRewrapPost','fixtureClonePost'])scenarios.push({name:`${action} requires the selected post's source proof (${known})`,
  path:'/creator/p/Dump123/',html,documentStart:true,steps:[
   {condition:'fixturePhotosVisible()'},
   {action:`${action}(${known})`,condition:known?'fixturePhotosVisible()':'fixtureFirstDenied()'},
   ...(known?[{condition:'fixtureContained()'},
    {action:"document.querySelector('#track img').src='https://example.com/recommendation.jpg'",condition:'fixtureFirstDenied()'}]
    :[{action:"document.querySelector('#track img').src='https://example.com/first.jpg'",condition:'fixturePhotosVisible()'},
     {condition:'fixtureContained()'}])
  ]});
}
scenarios.push({name:'A temporary permalink gap recovers only the original verified post',path:'/creator/p/Dump123/',html,documentStart:true,steps:[
 {condition:'fixturePhotosVisible()'},
 {action:"document.querySelector('#selected a').href='/p/Other123/'",condition:'fixtureBlocked()'},
 {action:"document.querySelector('#selected a').href='/creator/p/Dump123/'",condition:'fixturePhotosVisible()'},
 {condition:'fixtureContained()'}
]});
scenarios.push({name:'A replacement track with no proven media stays entirely blocked',path:'/creator/p/Dump123/',html,documentStart:true,steps:[
 {condition:'fixturePhotosVisible()'},
 {action:"fixtureRemountTrack(false);document.querySelectorAll('#track img')[1].src='https://example.com/other-recommendation.jpg'",condition:'fixtureBlocked()'},
 {action:"document.querySelector('#track img').src='https://example.com/first.jpg'",condition:"document.getElementById('selected').dataset.vigilSingleReelCard==='allowed'&&getComputedStyle(document.querySelector('#track img')).visibility==='visible'&&getComputedStyle(document.querySelectorAll('#track img')[1]).visibility==='hidden'"},
 {condition:'fixtureContained()'}
]});
scenarios.push({name:'A new post wrapper cannot inherit an old manifest with a different stored parent',path:'/creator/p/Dump123/',html,documentStart:true,steps:[
 {condition:'fixturePhotosVisible()'},
 {action:"fixtureMode='wrong-parent';fixtureRewrapPost()",condition:'fixtureBlocked()'},
 {action:"fixtureMode='exact';document.querySelector('#track img').dispatchEvent(new Event('load',{bubbles:true}))",condition:'fixturePhotosVisible()'},
 {condition:'fixtureContained()'}
]});
const singleHTML=html.replace(/<div id="viewport"[\s\S]*?<\/ul><\/div><\/div>/,
 '<div id="viewport" role="presentation" style="display:block;overflow-x:visible"><div></div><img id="single" src="https://example.com/first.jpg"></div>');
scenarios.push({name:'A late carousel can rotate a known photo without a frozen single-image source',path:'/creator/p/Dump123/',
 html:singleHTML,documentStart:true,steps:[
  {condition:"document.getElementById('selected').dataset.vigilSingleReelCard==='allowed'"},
  {action:'fixtureMountCarousel()',condition:"fixturePhotosVisible()&&document.getElementById('track').hasAttribute('data-vigil-single-reel-carousel')"},
  {action:"document.getElementById('single').src='https://example.com/third.jpg'",condition:'fixturePhotosVisible()'},
  {condition:'fixtureContained()'},
  {action:"document.getElementById('single').src='https://example.com/recommendation.jpg'",condition:'fixtureFirstDenied()'}
 ]});
scenarios.push({name:'Missing startup records hydrate without replacing the visible photos',path:'/creator/p/Dump123/',
 html:html.replace('window.fixtureReady=true','window.fixtureReady=false'),documentStart:true,steps:[
  {condition:'fixturePhotosVisible()'},
  {action:'fixtureChrome()',condition:'fixtureBlocked()'},
  {action:"fixtureReady=true;document.querySelector('#track img').dispatchEvent(new Event('load',{bubbles:true}))",
   condition:"fixturePhotosVisible()&&getComputedStyle(document.getElementById('chrome')).visibility==='hidden'"},
  {condition:'fixtureContained()'}
 ]});
scenarios.push({name:'An unverified preload inside the track cannot hide known photos',path:'/creator/p/Dump123/',html,documentStart:true,steps:[
 {condition:'fixturePhotosVisible()'},
 {action:"(()=>{fixtureLater();const n=document.getElementById('later');n.srcset='';n.src='about:blank';n.style='width:1px;height:1px'})()",condition:'fixtureDenied()'},
 {action:"(()=>{const n=document.getElementById('later');n.src='https://example.com/third.jpg';n.style='width:390px;height:500px'})()",condition:'fixtureAllowed()'},
 {condition:'fixtureContained()'}
]});
scenarios.push({name:'A late carousel waits for the selected post records and then recovers',path:'/creator/p/Dump123/',
 html:singleHTML.replace('window.fixtureReady=true','window.fixtureReady=false'),documentStart:true,steps:[
  {condition:"document.getElementById('selected').dataset.vigilSingleReelCard==='allowed'"},
  {action:'fixtureMountCarousel()',condition:'fixtureBlocked()'},
  {action:"fixtureReady=true;document.getElementById('single').dispatchEvent(new Event('load',{bubbles:true}))",condition:'fixturePhotosVisible()'},
  {condition:'fixtureContained()'}
 ]});
const directory=await mkdtemp(join(tmpdir(),'vigil-instagram-carousel-'));
try{
 await Promise.all([writeFile(join(directory,'guard.js'),"window.__vigilDocumentID='carousel-fixture';window.__vigilInstagramDiagnostics=true;"+start+guard),
  writeFile(join(directory,'stable.js'),stable),
  writeFile(join(directory,'scenarios.json'),JSON.stringify(scenarios.map(scenario=>({...scenario,documentStart:true}))))]);
 const executable=join(directory,'carousel-test');
 const harness=(await readFile(join(root,'tests/fixtures/instagram-comments-interaction.swift'),'utf8'))
  .replace('import Foundation','import Foundation\nimport Darwin')
  .replace('let app = NSApplication.shared','setbuf(stdout, nil)\nlet app = NSApplication.shared');
 await writeFile(join(directory,'harness.swift'),harness);
 await run('xcrun',['swiftc',join(directory,'harness.swift'),'-o',executable],{timeout:60000});
 const marker='VIGIL_INSTAGRAM_CAROUSEL_WEBKIT_COMPLETE';
 const result=await new Promise((resolve,reject)=>{
  const child=execFile(executable,[directory,marker],{timeout:120000,maxBuffer:2*1024*1024},(error,stdout,stderr)=>{
   if(error)reject(Object.assign(error,{stdout,stderr}));else resolve({stdout,stderr});
  });
  child.stdout.on('data',chunk=>process.stdout.write(chunk));
 });
 assert.ok(result.stdout.split(/\r?\n/).includes(marker));
 await rm(directory,{recursive:true,force:true});
}catch(error){
 if(error.stdout)process.stderr.write(error.stdout);if(error.stderr)process.stderr.write(error.stderr);
 process.stderr.write(`Carousel artifacts retained at ${directory}\n`);throw error;
}
