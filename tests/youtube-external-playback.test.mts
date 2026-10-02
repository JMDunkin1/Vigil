import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const projectRoot = existsSync(join(runtimeRoot, 'ios')) ? runtimeRoot : resolve(runtimeRoot, '..', '..');
const swift = await readFile(join(projectRoot, 'ios/VigilSocial/VigilSocial/YouTubeExternalPlayback.swift'), 'utf8');
const store = await readFile(join(projectRoot, 'ios/VigilSocial/VigilSocial/SocialWebViewStore.swift'), 'utf8');
const source = swift.match(/static let source = #"""\n([\s\S]*?)\n\s*"""#/)?.[1];
assert.ok(source, 'The installed isolated playback script must be present');

function fixture(path = '/watch', id = 'abcdefghijk') {
  const events = new Map<string, () => void>();
  const documentElement = { dataset: { vigilPageVerdict: 'unknown' } };
  const video = () => ({
    dataset: { vigilMediaVerdict: 'unknown', vigilVideoFrameVerdict: 'unknown', vigilVideoFrameFingerprint: '' },
    currentSrc: 'watch-media', src: 'watch-media',
    getAttribute() { return this.src; }, querySelectorAll() { return []; },
    paused: false, ended: false, seeking: false, readyState: 4,
    currentTime: 0, playbackRate: 1, disablePictureInPicture: false,
    webkitPresentationMode: 'inline', pauseCount: 0,
    pause() { this.paused = true; this.pauseCount++; },
    webkitSupportsPresentationMode(mode: string) { return mode === 'picture-in-picture'; },
    webkitSetPresentationMode(mode: string) { this.webkitPresentationMode = mode; }
  });
  const primary = video(), feed = video();
  const window: Record<string, unknown> = {}; window.top = window;
  const document = {
    documentElement, pictureInPictureElement: null,
    querySelector() { return primary; },
    querySelectorAll() { return [primary, feed]; },
    addEventListener(name: string, callback: () => void) { events.set(name, callback); }
  };
  runInNewContext(source!, { window, document,
    location: { href: `https://m.youtube.com${path}?v=${id}`, pathname: path, search: `?v=${id}` },
    URLSearchParams, MutationObserver: class { observe() {} }
  });
  return {
    primary, feed, documentElement,
    authorize: window.__vigilExternalPlaybackPermission as (videoID: string | null, enabled: boolean) => void,
    request: window.__vigilRequestExternalPictureInPicture as () => boolean,
    stop: window.__vigilStopExternalPlayback as () => void,
    snapshot: window.__vigilExternalPlaybackSnapshot as () => {
      pictureInPicture: boolean; videoID: string | null; permittedUnderPolicy: boolean
    },
    update() { events.get('playing')?.(); },
    markSafe() {
      documentElement.dataset.vigilPageVerdict = 'safe';
      primary.dataset.vigilMediaVerdict = 'safe'; primary.dataset.vigilVideoFrameVerdict = 'safe';
      feed.dataset.vigilMediaVerdict = 'safe'; feed.dataset.vigilVideoFrameVerdict = 'safe';
      primary.dataset.vigilVideoFrameFingerprint = JSON.stringify({ current: primary.currentSrc, declared: primary.src, sources: [] });
      feed.dataset.vigilVideoFrameFingerprint = JSON.stringify({ current: feed.currentSrc, declared: feed.src, sources: [] });
    }
  };
}

test('PiP requires persisted native permission, installed policy verdicts, and the watch player', () => {
  const page = fixture();
  assert.equal(page.primary.disablePictureInPicture, true);
  page.authorize('abcdefghijk', true);
  assert.equal(page.request(), false);
  page.markSafe(); page.update();
  assert.equal(page.primary.disablePictureInPicture, false);
  assert.equal(page.feed.disablePictureInPicture, true);
  assert.equal(page.request(), true);
  assert.equal(page.snapshot().pictureInPicture, true);
  page.primary.dataset.vigilVideoFrameVerdict = 'sensitive'; page.update();
  assert.equal(page.primary.disablePictureInPicture, true);
  assert.equal(page.primary.webkitPresentationMode, 'inline');
  assert.equal(page.primary.paused, true);
});

test('native freshness follows the same installed policy only after a valid completed frame check', () => {
  assert.match(swift, /completedValidFrameCheck && policy\.resolve\(verdict\) == \.safe/);
  assert.match(swift, /CGImageSourceCreateWithData[\s\S]*CGImageSourceCreateImageAtIndex/);
  assert.match(swift, /age >= 0 && age < 12/);
  assert.match(store, /policy: unclassifiedMediaPolicy,[\s\S]*completedValidFrameCheck: completedValidFrameCheck/);
  assert.match(store, /let resolvedVerdict = unclassifiedMediaPolicy\.resolve\(verdict\)/);
  assert.match(store, /let isYouTubeVideoFrame = key\.service == \.youtube && request\.frame\.isMainFrame && request\.kind == "videoFrame"/);
  assert.match(store, /isYouTubeVideoFrame && YouTubeExternalPlaybackFramePolicy\.isValidCapturedFrame\(data\)/);
  assert.match(store, /completedValidFrameCheck: captured\.validFrame/);
  assert.match(store, /guard !wasCancelled,[\s\S]*request\.requestID == requestID/);
  assert.match(store, /latestMediaRequestIDs\[request\.key\] == request\.requestID,[\s\S]*latestMediaTokens\[request\.key\] == request\.token/);
  assert.match(store, /request\.kind == "videoFrame",[\s\S]*request\.key\.documentID == mainDocumentIDs\[\.youtube\]/);
  assert.match(store, /WKUserScript\(source: YouTubeExternalPlaybackScript\.source,[\s\S]*?forMainFrameOnly: true, in: \.defaultClient\)/);
  const expiredCheck = store.match(/private func expireMediaClassification\([\s\S]*?private func resolveCurrentMediaWithoutClassification/)?.[0];
  assert.ok(expiredCheck);
  assert.match(expiredCheck, /recordYouTubeVideoFrameCheck\(request, verdict: \.unknown, completedValidFrameCheck: false\)/);
  assert.doesNotMatch(store, /safeYouTubeVideoFrameTimes/);
});

test('resolved frame permission still requires safe text and rejects sensitive media', () => {
  const page = fixture(); page.markSafe();
  // The same DOM verdict can result from a safe classifier result or an unknown
  // result permitted by the explicit Personal Team install policy. It cannot
  // grant playback without the separate fresh native permission.
  assert.equal(page.snapshot().permittedUnderPolicy, true);
  assert.equal(page.request(), false);
  page.authorize('abcdefghijk', true);
  assert.equal(page.request(), true);
  page.documentElement.dataset.vigilPageVerdict = 'unknown'; page.update();
  assert.equal(page.snapshot().permittedUnderPolicy, false);
  assert.equal(page.request(), false);
  page.documentElement.dataset.vigilPageVerdict = 'safe';
  page.primary.dataset.vigilMediaVerdict = 'sensitive'; page.update();
  assert.equal(page.snapshot().permittedUnderPolicy, false);
  assert.equal(page.request(), false);
});

test('feed routes and another video reservation never enable PiP', () => {
  for (const path of ['/', '/shorts/abcdefghijk', '/feed/subscriptions']) {
    const page = fixture(path); page.markSafe(); page.authorize('abcdefghijk', true);
    assert.equal(page.request(), false, path);
    assert.equal(page.primary.disablePictureInPicture, true, path);
    assert.equal(page.snapshot().videoID, null, path);
  }
  const page = fixture(); page.markSafe(); page.authorize('other000000', true);
  assert.equal(page.request(), false);
  assert.equal(page.primary.disablePictureInPicture, true);
});

test('revoking external playback pauses every media element and exits PiP', () => {
  const page = fixture(); page.markSafe(); page.authorize('abcdefghijk', true);
  assert.equal(page.request(), true);
  page.stop();
  assert.equal(page.primary.paused, true);
  assert.equal(page.feed.paused, true);
  assert.equal(page.primary.webkitPresentationMode, 'inline');
  assert.equal(page.primary.disablePictureInPicture, true);
  assert.equal(page.request(), false);
});

test('a changed video source cannot reuse the old safe frame', () => {
  const page = fixture(); page.markSafe(); page.authorize('abcdefghijk', true);
  assert.equal(page.request(), true);
  page.primary.currentSrc = 'replacement-media'; page.update();
  assert.equal(page.primary.disablePictureInPicture, true);
  assert.equal(page.primary.webkitPresentationMode, 'inline');
  assert.equal(page.primary.paused, true);
});
