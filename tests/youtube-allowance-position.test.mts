import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const root = existsSync(join(runtimeRoot, 'ios')) ? runtimeRoot : resolve(runtimeRoot, '..', '..');
const source = readFileSync(process.env.VIGIL_ALLOWANCE_SOURCE || join(root, 'ios/VigilSocial/VigilYouTubeInteractionExtension/Resources/youtube-limits.js'), 'utf8');
const positioning = source.slice(source.indexOf('  function positionAllowance()'), source.indexOf('  function mount()'));
function fixture() {
  const properties = new Map<string, string>();
  let bottom = '', bottomWrites = 0, customPropertyWrites = 0;
  const listeners = new Map<string, Array<() => void>>();
  const listen = (name: string, callback: () => void) => { listeners.set(name, [...(listeners.get(name) || []), callback]); };
  const attributes = new Set<string>();
  const panel = {
    parentNode: null as unknown, hidden: false,
    toggleAttribute(name: string, value: boolean) { if (value) attributes.add(name); else attributes.delete(name); },
    style: {
      get bottom() { return bottom; },
      set bottom(value: string) { bottom = value; bottomWrites += 1; },
      getPropertyValue: (name: string) => properties.get(name),
      setProperty: (name: string, value: string) => { properties.set(name, value); customPropertyWrites += 1; }
    }
  };
  const body = { append: () => { panel.parentNode = body; } };
  const header = { append: () => { panel.parentNode = header; } };
  let desktopHeader: typeof header | null = null;
  let playerFullscreen = false;
  const media = { webkitDisplayingFullscreen: false };
  let obstacles: { top: number; bottom: number; width: number; height: number }[] = [];
  const document = {
    addEventListener: listen,
    body, documentElement: { clientHeight: 844 }, fullscreenElement: null as unknown, webkitFullscreenElement: null as unknown,
    querySelector(selector: string) {
      if (selector === 'ytd-masthead #start') return desktopHeader;
      if (selector === 'video') return media;
      return playerFullscreen ? {} : null;
    },
    querySelectorAll: () => obstacles.map(rect => ({ getBoundingClientRect: () => rect }))
  };
  const window = { addEventListener: listen, innerWidth: 390, innerHeight: 844, visualViewport: { addEventListener: listen, offsetTop: 0, height: 844 } };
  const location = { hostname: 'm.youtube.com', pathname: '/' };
  const place = runInNewContext(`${positioning}\npositionAllowance`, { panel, document, window, location }) as () => void;
  return { panel, body, header, document, window, location, media, place, attributes,
    bottom: () => bottom, bottomWrites: () => bottomWrites, customPropertyWrites: () => customPropertyWrites,
    dispatch: (name: string) => listeners.get(name)?.forEach(callback => callback()),
    setHeader: (value: boolean) => { desktopHeader = value ? header : null; },
    fullscreenPlayer: (value: boolean) => { playerFullscreen = value; },
    obstacle: (top: number, height: number, width = 390) => { obstacles.push({ top, height, width, bottom: top + height }); }
  };
}
test('mobile allowance remains outside the app shell on home, search, watch, subscriptions and Watch Later', () => {
  const f = fixture();
  for (const pathname of ['/', '/results', '/watch', '/feed/subscriptions', '/playlist']) {
    f.location.pathname = pathname;
    f.panel.parentNode = {};
    f.place();
    assert.equal(f.panel.parentNode, f.body);
    assert.equal(f.panel.hidden, false);
    assert.equal(f.bottom(), 'calc(max(0px, env(safe-area-inset-bottom)) + 8px)');
  }
});
test('mobile strip clears bottom tabs and the higher mini-player without following an inline video', () => {
  const f = fixture();
  f.obstacle(788, 56);
  f.obstacle(700, 88);
  f.obstacle(50, 220);
  f.obstacle(600, 0);
  f.place();
  assert.equal(f.bottom(), 'calc(max(144px, env(safe-area-inset-bottom)) + 8px)');
});
test('keyboard and visual viewport changes keep the strip in the visible area', () => {
  const f = fixture();
  f.window.visualViewport.height = 450;
  f.obstacle(788, 56);
  f.place();
  assert.equal(f.bottom(), 'calc(max(394px, env(safe-area-inset-bottom)) + 8px)');
  f.window.visualViewport.offsetTop = 70;
  f.place();
  assert.equal(f.bottom(), 'calc(max(324px, env(safe-area-inset-bottom)) + 8px)');
});
test('desktop header replacement and narrow window fallback reparent the existing allowance', () => {
  const f = fixture();
  f.location.hostname = 'www.youtube.com';
  f.window.innerWidth = 1280;
  f.setHeader(true);
  f.place();
  assert.equal(f.panel.parentNode, f.header);
  assert.equal(f.attributes.has('data-desktop'), true);
  f.setHeader(false);
  f.place();
  assert.equal(f.panel.parentNode, f.body);
  f.setHeader(true);
  f.window.innerWidth = 390;
  f.place();
  assert.equal(f.panel.parentNode, f.body);
  assert.equal(f.attributes.has('data-desktop'), false);
});
test('rotation on the mobile site retains mobile positioning even with a desktop-shaped header', () => {
  const f = fixture();
  f.setHeader(true);
  f.window.innerWidth = 844;
  f.window.innerHeight = 390;
  f.window.visualViewport.height = 390;
  f.obstacle(342, 48, 844);
  f.place();
  assert.equal(f.panel.parentNode, f.body);
  assert.equal(f.bottom(), 'calc(max(48px, env(safe-area-inset-bottom)) + 8px)');
});
test('standard, WebKit and native video fullscreen hide the allowance and restore it on exit', () => {
  const f = fixture();
  for (const key of ['fullscreenElement', 'webkitFullscreenElement'] as const) {
    f.document[key] = {};
    f.place(); assert.equal(f.panel.hidden, true);
    f.document[key] = null;
    f.place(); assert.equal(f.panel.hidden, false);
  }
  f.media.webkitDisplayingFullscreen = true;
  f.place(); assert.equal(f.panel.hidden, true);
  f.media.webkitDisplayingFullscreen = false;
  f.fullscreenPlayer(true);
  f.place(); assert.equal(f.panel.hidden, true);
  f.fullscreenPlayer(false);
  f.place(); assert.equal(f.panel.hidden, false);
});
test('timer ticks and repeated scroll/resize events write geometry only when its value changes', () => {
  const f = fixture();
  f.place();
  assert.equal(f.bottomWrites(), 1);
  for (let tick = 0; tick < 120; tick += 1) {
    f.place();
    f.dispatch('scroll');
    f.dispatch('resize');
  }
  assert.equal(f.bottomWrites(), 1, 'unchanged ticks and viewport events must not rewrite styles');
  assert.equal(f.customPropertyWrites(), 0, 'the owned strip must not trigger page-wide custom-property invalidation');
  f.window.visualViewport.height = 788;
  f.dispatch('resize');
  assert.equal(f.bottom(), 'calc(max(56px, env(safe-area-inset-bottom)) + 8px)');
  assert.equal(f.bottomWrites(), 2);
  f.window.visualViewport.offsetTop = 12;
  f.dispatch('scroll');
  assert.equal(f.bottom(), 'calc(max(44px, env(safe-area-inset-bottom)) + 8px)');
  assert.equal(f.bottomWrites(), 3);
  f.dispatch('scroll'); f.dispatch('resize'); f.place();
  assert.equal(f.bottomWrites(), 3);
});
test('desktop placement clears mobile bottom once and restores safe-area positioning on return', () => {
  const f = fixture();
  assert.ok(source.includes('bottom:calc(env(safe-area-inset-bottom) + 8px)'), 'initial mobile CSS must retain the safe-area inset');
  f.obstacle(788, 56);
  f.place();
  f.location.hostname = 'www.youtube.com'; f.window.innerWidth = 1280; f.setHeader(true);
  f.place();
  assert.equal(f.bottom(), '', 'inline mobile bottom must not offset the relative desktop strip');
  assert.equal(f.bottomWrites(), 2);
  for (let tick = 0; tick < 40; tick += 1) { f.place(); f.dispatch('resize'); }
  assert.equal(f.bottomWrites(), 2, 'desktop ticks must not repeatedly clear inline styles');
  f.window.innerWidth = 390;
  f.place();
  assert.equal(f.bottom(), 'calc(max(56px, env(safe-area-inset-bottom)) + 8px)');
  assert.equal(f.bottomWrites(), 3);
});
test('fullscreen ticks retain the existing panel without geometry writes', () => {
  const f = fixture();
  f.place();
  f.document.fullscreenElement = {};
  f.window.visualViewport.height = 450;
  for (let tick = 0; tick < 40; tick += 1) { f.place(); f.dispatch('scroll'); f.dispatch('resize'); }
  assert.equal(f.panel.hidden, true);
  assert.equal(f.bottomWrites(), 1);
  f.document.fullscreenElement = null;
  f.dispatch('fullscreenchange');
  assert.equal(f.panel.hidden, false);
  assert.equal(f.bottom(), 'calc(max(394px, env(safe-area-inset-bottom)) + 8px)');
  assert.equal(f.bottomWrites(), 2);
});
