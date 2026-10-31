#!/usr/bin/env node
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const adapter = await readFile(process.argv[2] ? resolve(process.argv[2]) : join(root, 'ios/VigilSocial/VigilSocial/DOMAdapters.swift'), 'utf8');
const extract = name => adapter.match(new RegExp(`(?:private )?static let ${name} = #"""([\\s\\S]*?)"""#`))?.[1];
const guard = extract('instagramSingleReelGuard'), stable = extract('instagramStable'), start = extract('instagramStableDocumentStartStyle');
assert.ok(guard && stable && start);
const html = (await readFile(join(root, 'tests/fixtures/instagram-conversation.html'), 'utf8'))
  .replaceAll('VIGIL_TEST_VIDEO', `data:video/mp4;base64,${(await readFile(join(root, 'tests/fixtures/instagram-chat-reel.mp4'))).toString('base64')}`);
const bootstrap = `window.__vigilDocumentID='conversation-fixture';window.fixtureLocks=[];
Object.defineProperty(window,'webkit',{configurable:true,value:{messageHandlers:{vigil:{postMessage:p=>fixtureLocks.push(p)}}}});`;
const scenarios = ['absolute','fixed','transformed','dialog'].flatMap(layout => ['photo','video'].flatMap(media =>
  ['tap','swipe','text','lazy','rerender','rerender-root','rerender-tap','remount-chat'].map(action => ({name:`Conversation remains usable: ${layout}/${media}/${action}`,html,path:'/direct/t/friend/',steps:[
    {action:`fixtureBegin('${layout}','${media}')`,delay:100},
    {action:`fixtureScroll('${action}')`,delay:100,condition:'fixtureChatUsable()'}
  ]}))));
for (const kind of ['reel','photo']) scenarios.push({name:`Real ${kind} overlay remains contained and releases the conversation`,html,path:'/direct/t/friend/',steps:[
  {action:"fixtureBegin('absolute','photo');document.getElementById('messages').scrollTop=440"},
  {action:`fixtureOpenFromChat('${kind}')`,condition:'fixtureViewerContained()'},
  {action:"document.getElementById('close-viewer').click()",delay:1600,condition:'fixtureChatUsable()'}
]});
const directory = await mkdtemp(join(tmpdir(),'vigil-instagram-conversation-'));
try {
  await Promise.all([writeFile(join(directory,'guard.js'),bootstrap+start+guard),writeFile(join(directory,'stable.js'),stable),writeFile(join(directory,'scenarios.json'),JSON.stringify(scenarios))]);
  const executable=join(directory,'conversation-test');
  await run('xcrun',['swiftc',join(root,'tests/fixtures/instagram-comments-interaction.swift'),'-o',executable],{timeout:60000});
  const marker='VIGIL_INSTAGRAM_CONVERSATION_WEBKIT_COMPLETE';
  const result=await run(executable,[directory,marker],{timeout:180000,maxBuffer:2*1024*1024});
  process.stdout.write(result.stdout);assert.ok(result.stdout.split(/\r?\n/).includes(marker));
  await rm(directory,{recursive:true,force:true});
} catch(error) {
  if(error.stdout)process.stderr.write(error.stdout.split('\n').filter(line=>/^(PASS|FAIL|ERROR)/.test(line)).join('\n')+'\n');if(error.stderr)process.stderr.write(error.stderr);
  process.stderr.write(`Conversation artifacts retained at ${directory}\n`);throw error;
}
