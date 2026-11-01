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
   condition:allowed?'fixtureAllowed()':'fixtureBlocked()'},
  ...(allowed?[{condition:'fixtureContained()'},
   {action:"document.getElementById('later').srcset='https://example.com/recommendation.jpg 390w'",condition:'fixtureBlocked()'}]:[])
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
 {action:"fixtureLater();document.getElementById('later').srcset+=' , https://example.com/unlisted.jpg 1080w'",condition:'fixtureBlocked()'}
]});
scenarios.push({name:'A different video record cannot inherit carousel permission',path:'/creator/p/Dump123/',
 html:html.replace("fixtureMode='exact'","fixtureMode='wrong-video-record'"),steps:[
 {condition:"document.getElementById('selected').dataset.vigilSingleReelCard==='allowed'"},
 {action:"fixtureLater('video')",condition:'fixtureBlocked()'}
]});
const directory=await mkdtemp(join(tmpdir(),'vigil-instagram-carousel-'));
try{
 await Promise.all([writeFile(join(directory,'guard.js'),"window.__vigilDocumentID='carousel-fixture';window.__vigilInstagramDiagnostics=true;"+start+guard),
  writeFile(join(directory,'stable.js'),stable),writeFile(join(directory,'scenarios.json'),JSON.stringify(scenarios))]);
 const executable=join(directory,'carousel-test');
 await run('xcrun',['swiftc',join(root,'tests/fixtures/instagram-comments-interaction.swift'),'-o',executable],{timeout:60000});
 const marker='VIGIL_INSTAGRAM_CAROUSEL_WEBKIT_COMPLETE';
 const result=await run(executable,[directory,marker],{timeout:120000,maxBuffer:2*1024*1024});
 process.stdout.write(result.stdout);assert.ok(result.stdout.split(/\r?\n/).includes(marker));
 await rm(directory,{recursive:true,force:true});
}catch(error){
 if(error.stdout)process.stderr.write(error.stdout);if(error.stderr)process.stderr.write(error.stderr);
 process.stderr.write(`Carousel artifacts retained at ${directory}\n`);throw error;
}
