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
const script=name=>{const s=source.match(new RegExp(`(?:private )?static let ${name} = #"""([\\s\\S]*?)"""#`))?.[1];assert.ok(s);return s;};
const html=await readFile(join(root,'tests/fixtures/instagram-mobile-direct.html'),'utf8');
const bootstrap=`window.__vigilDocumentID='mobile-direct-fixture';window.fixtureLocks=[];Object.defineProperty(window,'webkit',{configurable:true,value:{messageHandlers:{vigil:{postMessage:p=>fixtureLocks.push(p)}}}});`;
const make=(name,steps)=>({name,html,path:'/direct/t/friend/',steps});
const scenarios=['shared','untracked','nonzero','caption','editable'].map(mode=>make(`Mobile Direct snap rail: ${mode}`,[
 {action:`fixtureOpen('${mode}')`,condition:'fixtureContained()'},
 {condition:"!fixtureLocks.some(p=>p.type==='instagramSuggestedReels')"},
 {action:"document.getElementById('viewer').remove()",delay:1700,condition:"!document.documentElement.hasAttribute('data-vigil-single-reel')"}
]));
scenarios.push(make('Native button exceptions stay confined to foreground controls',[
 {action:"fixtureOpen('shared')",condition:"fixtureContained()&&fixtureNativeAllows('send-current',true)&&fixtureNativeAllows('comments-current',true)&&fixtureNativeAllows('viewer-back',true)&&window.__vigilInstagramSharedItem.containmentState().nativeGestureState.scrollingRegions.length===0"}
]));
scenarios.push(make('Immediate Back outside the rail releases the retained chat',[
 {action:"fixtureOpen('shared')",condition:'fixtureContained()'},
 {action:"document.getElementById('viewer-back').click()",condition:"!document.documentElement.hasAttribute('data-vigil-single-reel')"}
]));
scenarios.push(make('Mobile Direct Suggested badge on a static deep rail',[
 {action:"fixtureOpen('suggested')",condition:"document.getElementById('rail').hasAttribute('data-vigil-instagram-suggested-reels')&&fixtureLocks.some(p=>p.type==='instagramSuggestedReels'&&p.returnPath==='/direct/t/friend/')"}
]));
scenarios.push(make('Suggested badge appearing after the shared item is pinned',[
 {action:"fixtureOpen('shared')",condition:'fixtureContained()'},
 {action:"document.querySelector('#card-0 .label').textContent='Suggested'",condition:"document.getElementById('rail').hasAttribute('data-vigil-instagram-suggested-reels')"}
]));
scenarios.push(make('Comments remain scrollable through a heading remount',[
 {action:"fixtureOpen('shared')",condition:'fixtureContained()'},
 {action:"document.querySelector('#card-0 .comments').click()",condition:"document.getElementById('comments-sheet').getAttribute('data-vigil-instagram-comments-sheet')==='true'&&fixtureNativeAllows('comment-list')"},
 {condition:"fixtureScrollSheet('comment-list')"},
 {action:"document.getElementById('comment-heading').remove()",delay:100,condition:"fixtureNativeAllows('comment-list')&&fixtureScrollSheet('comment-list')"}
]));
scenarios.push(make('Full visual Send picker inside a forty-pixel dialog host',[
 {action:"fixtureOpen('shared')",condition:'fixtureContained()'},
 {action:"document.querySelector('#card-0 .send').click()",condition:"document.getElementById('picker').getAttribute('data-vigil-instagram-recipient-sheet')==='true'&&!document.getElementById('dialog-host').hasAttribute('data-vigil-instagram-recipient-sheet')&&fixtureNativeAllows('people')"},
 {action:"document.getElementById('search').focus();Object.defineProperty(window,'visualViewport',{configurable:true,value:{width:innerWidth,height:396,offsetTop:0,offsetLeft:0}});window.dispatchEvent(new Event('resize'))",delay:100,condition:"document.activeElement===document.getElementById('search')&&fixtureNativeAllows('search')&&fixtureScrollSheet('people')"}
]));
const directory=await mkdtemp(join(tmpdir(),'vigil-instagram-mobile-direct-'));
try{
 await Promise.all([writeFile(join(directory,'guard.js'),bootstrap+script('instagramStableDocumentStartStyle')+script('instagramSingleReelGuard')),writeFile(join(directory,'stable.js'),script('instagramStable')),writeFile(join(directory,'scenarios.json'),JSON.stringify(scenarios))]);
 const executable=join(directory,'mobile-direct-test');await run('xcrun',['swiftc',join(root,'tests/fixtures/instagram-comments-interaction.swift'),'-o',executable],{timeout:60000});
 const marker='VIGIL_INSTAGRAM_MOBILE_DIRECT_WEBKIT_COMPLETE';const result=await run(executable,[directory,marker],{timeout:120000,maxBuffer:2*1024*1024});process.stdout.write(result.stdout);assert.ok(result.stdout.split(/\r?\n/).includes(marker));await rm(directory,{recursive:true,force:true});
}catch(error){if(error.stdout)process.stderr.write(error.stdout.split('\n').filter(s=>/^(PASS|FAIL|ERROR)/.test(s)).join('\n')+'\n');if(error.stderr)process.stderr.write(error.stderr);process.stderr.write(`Mobile Direct artifacts retained at ${directory}\n`);throw error;}
