#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [source, tests, video] = await Promise.all([
  readFile(process.argv[2] || join(root, 'ios/VigilSocial/VigilSocial/DOMAdapters.swift'), 'utf8'),
  readFile(join(root, 'ios/VigilSocial/VigilSocialTests/VigilSocialTests.swift'), 'utf8'),
  readFile(join(root, 'tests/fixtures/instagram-chat-reel.mp4'))
]);
const script = (name, text = source) => {
  const match = text.match(new RegExp(`(?:private )?static let ${name} = #"""([\\s\\S]*?)"""#`));
  assert.ok(match, `Missing script: ${name}`);
  return match[1];
};
const body = name => {
  const match = source.slice(source.indexOf(`static func ${name}(`))
    .match(/return #"""([\s\S]*?)"""#/u);
  assert.ok(match, `Missing function: ${name}`);
  return match[1];
};
const expand = text => text.replaceAll('AUDIO_PREFERENCE', 'true')
  .replaceAll('PREFER_AUDIBLE_VIDEO', 'false')
  .replaceAll('ROOT_REGISTRY_FACTORY', script('rootRegistryFactory'));
const css = name => {
  const match = source.match(new RegExp(`let ${name} = [^\\n]+ #"""([\\s\\S]*?)"""#`));
  assert.ok(match, `Missing safety CSS: ${name}`);
  return match[1];
};
const safety = expand(body('contentFilterBootstrap'))
  .replaceAll('DOCUMENT_UNCLASSIFIED_MEDIA_CSS', css('unclassifiedMediaCSS'))
  .replaceAll('SHADOW_UNCLASSIFIED_MEDIA_CSS', css('shadowUnclassifiedMediaCSS'))
  .replaceAll('UNCLASSIFIED_MEDIA_POLICY', 'conceal');
// Only the native classifier is simulated. Every reply uses the production
// document/id/token protocol and a real captured frame from the generated clip.
// No fixture calls allow() or replaces the production eligibility resolver.
const fixture = `
  window.fixtureFailures = [];
  window.fixtureCandidates = [];
  window.fixtureMode = 'safe';
  window.fixturePageMode = 'safe';
  window.fixtureNativeStarts = 0;
  const originalPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function(...args) {
    if (this.id === 'fixture-received-video') fixtureNativeStarts++;
    return originalPlay.apply(this, args);
  };
  Object.defineProperty(window, 'webkit', { configurable: true, value: {
    messageHandlers: { vigil: { postMessage(payload) {
      if (payload.type === 'pageText') setTimeout(() =>
        __vigilResolvePageText(payload.documentID, payload.revision, fixturePageMode), 20);
      if (payload.type !== 'mediaCandidate') return;
      fixtureCandidates.push(payload);
      if (fixtureMode === 'defer') return;
      const verdict = payload.captureFailed ? 'unknown' : fixtureMode;
      setTimeout(() => __vigilResolveMedia(payload.documentID, payload.id, payload.token, verdict), 80);
    } } }
  } });
  window.fixtureReply = (payload, verdict) =>
    __vigilResolveMedia(payload.documentID, payload.id, payload.token, verdict);
  window.fixtureVideo = () => document.getElementById('fixture-received-video');
  window.fixtureStart = () => {
    fixtureOpenSnap('rows');
    document.getElementById('fixture-snap-image').remove();
    const media = document.createElement('video');
    media.id = 'fixture-received-video'; media.className = 'nauoE';
    media.autoplay = true; media.loop = true;
    media.src = URL.createObjectURL(new Blob([
      Uint8Array.from(atob('${video.toString('base64')}'), value => value.charCodeAt(0))
    ], { type: 'video/mp4' }));
    document.querySelector('.b2f4R').appendChild(media);
    media.play().catch(error => fixtureFailures.push(error.name));
  };
  window.fixtureSwitch = mode => {
    fixtureMode = mode; fixtureCandidates.length = 0;
    const media = fixtureVideo(); media.pause();
    // A changed blob URL is enough to force a real asynchronous decoder load.
    media.src = media.src.split('#')[0] + '#' + crypto.randomUUID();
    window.fixtureStartsBeforeSwitch = fixtureNativeStarts;
    media.play().catch(error => {
      fixtureFailures.push(error.name);
      // Snapchat's VideoPlayer forwards every play rejection to onError,
      // which closes the received-Snap lightbox and shows its failure toast.
      document.querySelector('.ecBYF')?.remove();
    });
    window.fixtureHeldSynchronously = media.paused && media.muted
      && fixtureNativeStarts === fixtureStartsBeforeSwitch;
  };
  window.fixtureDecoded = () => fixtureVideo()?.dataset.vigilVideoFrameVerdict === 'safe'
    && !fixtureVideo().paused && fixtureVideo().currentTime > .03;
  window.fixturePlaybackDiagnostic = () => {
    const media = fixtureVideo();
    return { failures: fixtureFailures, candidates: fixtureCandidates.length,
      heldSynchronously: window.fixtureHeldSynchronously, nativeStarts: fixtureNativeStarts,
      beforeSwitch: window.fixtureStartsBeforeSwitch, page: document.documentElement.dataset.vigilPageVerdict,
      video: media && { paused: media.paused, muted: media.muted, ready: media.readyState,
        error: media.error?.code, inline: media.playsInline, data: { ...media.dataset } } };
  };
`;
const html = script('snapchatMobileShellFixture', tests);
const initial = { action: 'fixtureStart()', condition: 'fixtureDecoded()' };
const scenarios = [{ name: 'Received videos switch sources without a false playback error', html, steps: [
  initial,
  ...Array.from({ length: 3 }, () => [
    { action: "fixtureSwitch('safe')", condition: 'fixtureHeldSynchronously && fixtureFailures.length === 0' },
    { condition: "fixtureDecoded() && fixtureFailures.length === 0 && !!document.querySelector('.ecBYF')" }
  ]).flat()
] }];
for (const mode of ['unknown', 'sensitive']) scenarios.push({
  name: `A previously safe video cannot authorize a new ${mode} source`, html, steps: [
    initial,
    { action: `fixtureSwitch('${mode}')`, condition: 'fixtureHeldSynchronously' },
    { condition: `fixtureVideo().dataset.vigilVideoFrameVerdict === '${mode}'` },
    { condition: 'fixtureVideo().paused && fixtureVideo().muted && fixtureNativeStarts === fixtureStartsBeforeSwitch && fixtureFailures.length === 0' }
  ]
});
scenarios.push({ name: 'Stale safe replies cannot release a replacement source', html, steps: [
  initial,
  { action: "fixtureSwitch('defer')", condition: 'fixtureCandidates.some(p => p.kind === "videoFrame")' },
  { action: 'window.fixtureStale = fixtureCandidates.find(p => p.kind === "videoFrame"); fixtureSwitch("defer"); fixtureReply(fixtureStale, "safe")',
    condition: 'fixtureCandidates.some(p => p.kind === "videoFrame" && p.token !== fixtureStale.token)' },
  { condition: 'fixtureVideo().paused && fixtureVideo().muted && fixtureVideo().dataset.vigilVideoFrameVerdict !== "safe" && fixtureNativeStarts === fixtureStartsBeforeSwitch' },
  { action: 'fixtureReply(fixtureCandidates.find(p => p.kind === "videoFrame" && p.token !== fixtureStale.token), "safe")',
    condition: 'fixtureDecoded() && fixtureFailures.length === 0' }
] });
scenarios.push({ name: 'A blocked page cannot replay a previously approved source', html, steps: [
  initial,
  { action: 'fixturePageMode="sensitive";fixtureVideo().pause();document.documentElement.dataset.vigilPageVerdict="sensitive";window.fixtureStartsBeforeBlock=fixtureNativeStarts;fixtureVideo().play()',
    condition: 'fixtureVideo().paused && fixtureVideo().muted && fixtureNativeStarts === fixtureStartsBeforeBlock' }
] });

const directory = await mkdtemp(join(tmpdir(), 'vigil-snapchat-video-webkit-'));
try {
  await Promise.all([
    writeFile(join(directory, 'prelude.js'), fixture + safety + expand(body('earlyMediaGate'))),
    writeFile(join(directory, 'adapter.js'), expand(body('common')) + script('snapchatMobileLayout')),
    writeFile(join(directory, 'scenarios.json'), JSON.stringify(scenarios))
  ]);
  const binary = join(directory, 'snapchat-video-test');
  await exec('xcrun', ['swiftc', join(root, 'tests/fixtures/snapchat-calls-webkit.swift'), '-o', binary], { timeout: 60000 });
  const result = await exec(binary, [directory], { timeout: 90000, maxBuffer: 2 * 1024 * 1024 });
  process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  assert.equal(result.stdout.split(/\r?\n/u).filter(line => line.startsWith('PASS ')).length, scenarios.length);
  console.log('VIGIL_SNAPCHAT_VIDEO_WEBKIT_COMPLETE');
  console.log(`WebKit evidence retained at ${directory}`);
} catch (error) {
  if (error.stdout) process.stderr.write(error.stdout);
  if (error.stderr) process.stderr.write(error.stderr);
  process.stderr.write(`WebKit evidence retained at ${directory}\n`);
  throw error;
}
