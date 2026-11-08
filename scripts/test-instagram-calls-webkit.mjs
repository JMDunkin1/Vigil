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
const tests = await readFile(join(root, 'ios/VigilSocial/VigilSocialTests/VigilSocialTests.swift'), 'utf8');
const raw = (text, name) => text.match(new RegExp(`(?:private )?static let ${name} = #"""([\\s\\S]*?)"""#`))?.[1];
const declarations = [...source.matchAll(/^ {4}(?:private )?static (?:let|var|func) (\w+)/gm)];
const declaration = name => {
  const index = declarations.findIndex(entry => entry[1] === name);
  assert.ok(index >= 0, `Missing production declaration: ${name}`);
  return source.slice(declarations[index].index, declarations[index + 1]?.index ?? source.length);
};
const directory = await mkdtemp(join(tmpdir(), 'vigil-instagram-calls-webkit-'));
try {
  // Compile the actual Swift composition, including its substitutions, rather
  // than recreating production script assembly in this test.
  const generator = `import Foundation\nenum DOMAdapters {\n${[
    'rootRegistryFactory', 'snapchatCallBootstrap', 'instagramCallAudioBootstrap',
    'instagramCallPresentation', 'instagramCallMediaControls', 'earlyMediaGate'
  ].map(declaration).join('\n')}\n}
  print(DOMAdapters.instagramCallAudioBootstrap + DOMAdapters.instagramCallPresentation
    + DOMAdapters.instagramCallMediaControls(audioEnabled: true))`;
  await writeFile(join(directory, 'scripts.swift'), generator);
  const {stdout: prelude} = await exec('xcrun', ['swift', join(directory, 'scripts.swift')], {timeout:60000});
  assert.ok(prelude.includes('__vigilInstagramCallsInstalled'));
  // Reuse the real local WebRTC transport fixture; never route generated tone
  // to speakers. Receiver PCM is still measured before output volume.
  const html = (raw(tests, 'snapchatMobileShellFixture') + raw(tests, 'snapchatCallFixture'))
    .replace('media.autoplay=true;', 'media.autoplay=true;media.volume=0;')
    .replace('video.srcObject=stream;await video.play()', 'video.volume=0;video.srcObject=stream;await video.play()');
  const scenarios = [{name:'instagram-call-media',baseURL:'https://www.instagram.com/call/?has_video=true',html,steps:[
    {action:'fixtureOpenCall("Rnl06");fixtureStartLoopback().then(()=>fixtureLoopbackResult()).then(r=>window.loopbackResult=r).catch(e=>window.loopbackError=String(e))',
      condition:'window.loopbackResult?.energy>.005 && !loopbackResult.paused && !loopbackResult.muted && loopbackResult.videoWidth===320 && loopbackResult.videoHeight===480 && fixtureLoopback.video.playsInline'},
    {action:'fixtureLoopback.video.muted=true;__vigilSetAudioPreference(false)',
      condition:'fixtureLoopback.media.muted && fixtureLoopback.context.state==="suspended"'},
    {action:'__vigilSetAudioPreference(true)',
      condition:'!fixtureLoopback.media.muted && fixtureLoopback.video.muted && fixtureLoopback.context.state==="running"'},
    {action:`window.fixturePauses=0;fixtureLoopback.media.addEventListener('pause',()=>fixturePauses++);
      document.body.append(fixtureLoopback.media);window.fixtureMoved=false;setTimeout(()=>fixtureMoved=true,250)`,
      condition:'fixtureMoved && fixturePauses===0 && !fixtureLoopback.media.paused'},
    {action:'__vigilSuspendAllMedia();fixtureLoopback.media.play();fixtureLoopback.context.resume()',
      condition:'fixtureLoopback.media.paused && fixtureLoopback.media.muted && fixtureLoopback.context.state==="suspended"'},
    {action:'__vigilResumeSuspendedMedia()',
      condition:'!fixtureLoopback.media.paused && !fixtureLoopback.media.muted && fixtureLoopback.context.state==="running"'},
    {action:`window.fixtureNavigationRejected=0;
      for(const path of ['/explore/','/direct/inbox/','https://example.com/call/','/%63all/']){
        for(const method of ['pushState','replaceState']){
          try{history[method]({},'',path)}catch(error){if(error.name==='SecurityError')fixtureNavigationRejected++}
        }
      }history.replaceState({},'','/call/?has_video=false#controls')`,
      condition:'fixtureNavigationRejected===8 && location.pathname==="/call/" && !fixtureLoopback.media.paused'},
    {action:'fixtureStopLoopback()',condition:'fixtureLoopback.context.state==="closed"'}
  ]}];
  await Promise.all([
    writeFile(join(directory,'prelude.js'),prelude), writeFile(join(directory,'adapter.js'),''),
    writeFile(join(directory,'scenarios.json'),JSON.stringify(scenarios))
  ]);
  const binary = join(directory,'instagram-calls-test');
  await exec('xcrun',['swiftc',join(root,'tests/fixtures/snapchat-calls-webkit.swift'),'-o',binary],{timeout:60000});
  const result = await exec(binary,[directory],{timeout:90000,maxBuffer:1024*1024});
  process.stdout.write(result.stdout);
  assert.ok(result.stdout.includes('PASS instagram-call-media'));
  console.log(`Silent, offscreen Instagram WebKit evidence retained at ${directory}`);
} catch (error) {
  if(error.stdout)process.stderr.write(error.stdout);
  if(error.stderr)process.stderr.write(error.stderr);
  process.stderr.write(`WebKit evidence retained at ${directory}\n`);
  throw error;
}
