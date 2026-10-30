#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const adapterPath = process.argv[2] ? resolve(process.argv[2]) : join(root, 'ios/VigilSocial/VigilSocial/DOMAdapters.swift');
const [adapter, nativeTests, video] = await Promise.all([
  readFile(adapterPath, 'utf8'), readFile(join(root, 'ios/VigilSocial/VigilSocialTests/VigilSocialTests.swift'), 'utf8'),
  readFile(join(root, 'tests/fixtures/instagram-chat-reel.mp4'))
]);
const extract = name => {
  const match = adapter.match(new RegExp(`(?:private )?static let ${name} = #"""([\\s\\S]*?)"""#`));
  assert.ok(match, `Missing production script: ${name}`);
  return match[1];
};
const compatibility = adapter.match(/private static func instagramStableCompatibilityScript\(audioEnabled: Bool\) -> String \{[\s\S]*?return #"""([\s\S]*?)"""#/)[1]
  .replaceAll('AUDIO_PREFERENCE', 'true');
const template = nativeTests.match(/static let instagramChatMediaRoundtripHTML = #"""([\s\S]*?)"""#/)[1];
const html = template.replaceAll('VIGIL_TEST_VIDEO', `data:video/mp4;base64,${video.toString('base64')}`);
const scenarios = [true, false].flatMap(audio => [true, false].flatMap(dialog => ['route-first', 'portal-first', 'same-url', 'chat-switch'].map(mode => ({
  name: `Real chat Reels survive photo roundtrips: ${mode}, audio=${audio}, dialog=${dialog}`, html, path: '/direct/t/friend/', requiresMediaWindow: true, steps: [
    { action: `${dialog ? '' : "document.getElementById('thread').removeAttribute('role');"}
      ${mode === 'same-url' ? "document.getElementById('photo-link').removeAttribute('href');" : ''}
      window.__vigilSetAudioPreference(${audio})` },
    { action: 'void fixtureStart()', condition: 'fixtureReady' },
    { condition: 'fixtureDecodedFrames()' },
    ...Array.from({ length: 3 }, () => [
      { action: `fixtureMode=${JSON.stringify(mode)};document.getElementById('photo-link').click()`, condition: "!!document.getElementById('opened-photo')" },
      { condition: "getComputedStyle(document.getElementById('opened-photo')).visibility==='visible'" },
      { condition: "getComputedStyle(document.getElementById('suggested-photo')).visibility==='hidden'" },
      { action: `(()=>{window.fixturePinnedPath=location.pathname;history.pushState({},'','/reel/Other456/');
        const wheel=new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:100});
        document.getElementById('opened-photo').dispatchEvent(wheel);window.fixtureWheelBlocked=wheel.defaultPrevented;})()`,
        condition: 'location.pathname===fixturePinnedPath&&fixtureWheelBlocked' },
      { condition: 'fixtureFailures.length===0' },
      { action: "document.getElementById('close-photo').click()", condition: "!document.getElementById('viewer')&&location.pathname===fixtureReturnPath" },
      { condition: "!document.documentElement.hasAttribute('data-vigil-single-reel')" },
      { condition: "(fixtureAudit('closed'),fixtureFailures.length===0)" },
      { condition: 'fixtureDecodedFrames()' },
      { action: 'window.fixtureTimes=fixtureReels().map(video=>video.currentTime)', delay: 100,
        condition: 'fixtureReels().every((video,index)=>video.currentTime!==fixtureTimes[index])' }
    ]).flat()
  ]
}))));
const directory = await mkdtemp(join(tmpdir(), 'vigil-instagram-chat-media-'));
try {
  await Promise.all([
    writeFile(join(directory, 'guard.js'), extract('instagramReferenceSearchGuard') + extract('instagramSingleReelGuard') + extract('instagramStableDocumentStartStyle')),
    writeFile(join(directory, 'stable.js'), compatibility + extract('instagramStable')),
    writeFile(join(directory, 'scenarios.json'), JSON.stringify(scenarios))
  ]);
  const executable = join(directory, 'chat-media-test');
  await execute('xcrun', ['swiftc', join(root, 'tests/fixtures/instagram-send-roundtrip.swift'), '-o', executable], { timeout: 60000, maxBuffer: 2 * 1024 * 1024 });
  const result = await execute(executable, [directory], { timeout: 60000, maxBuffer: 2 * 1024 * 1024 });
  process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  assert.ok(result.stdout.includes('VIGIL_INSTAGRAM_SEND_ROUNDTRIP_WEBKIT_COMPLETE'), 'WebKit fixture did not complete');
  assert.equal(result.stdout.split(/\r?\n/).filter(line => line.startsWith('PASS ')).length, scenarios.length);
  process.stdout.write('VIGIL_INSTAGRAM_CHAT_MEDIA_WEBKIT_COMPLETE\n');
  await rm(directory, { recursive: true, force: true });
} catch (error) {
  if (error.stdout) process.stderr.write(error.stdout.slice(0, 12000));
  if (error.stderr) process.stderr.write(error.stderr);
  process.stderr.write(`Chat media artifacts retained at ${directory}\n`);
  throw error;
}
