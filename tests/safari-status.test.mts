import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { test } from 'node:test';
const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const root = existsSync(join(runtimeRoot, 'ios')) ? runtimeRoot : resolve(runtimeRoot, '..', '..');
const source = await readFile(join(root, 'ios/VigilSocial/VigilYouTubeInteractionExtension/Resources/status.js'), 'utf8');
for (const scenario of [
  { granted:false, health:null, expected:'needs permission' },
  { granted:true, health:null, expected:'has not started' },
  { granted:true, health:{loaded:true,allowanceLoaded:false}, expected:'allowance is unavailable' },
  { granted:true, health:{loaded:true,allowanceLoaded:true}, expected:'is running' }
]) test(`Safari status: ${scenario.expected}`, async () => {
  const nodes = Object.fromEntries(['status','details','allow','check'].map(id=>[id,{textContent:'',hidden:false,addEventListener(){}}]));
  vm.runInNewContext(source, {
    document:{getElementById:(id:string)=>nodes[id]}, setTimeout, clearTimeout,
    browser:{
      permissions:{contains:async()=>scenario.granted},
      tabs:{query:async()=>[{id:1,url:'https://m.youtube.com/'}],sendMessage:async()=>{if(!scenario.health)throw Error('No receiver');return scenario.health;}}
    }
  });
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.ok(nodes.status.textContent.includes(scenario.expected),nodes.status.textContent);
});
