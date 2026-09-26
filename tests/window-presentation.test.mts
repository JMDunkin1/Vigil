import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

// Exercise the actual compiled handlers with controllable native events and
// Dock promises; importing main directly would start the enforcement runtime.
const source = await readFile(new URL("../app/main.js", import.meta.url), "utf8");
function functionSource(name: string): string {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing ${name}`);
  const end = source.indexOf("\nfunction ", start + 1);
  assert.ok(end > start);
  return source.slice(start, end);
}
const activate = source.match(/app\.on\("activate", \(\) => \{[\s\S]*?\n\}\);/)?.[0];
assert.ok(activate);
const closed = source.match(/vigilWindow\.on\("closed", \(\) => \{[\s\S]*?\n    \}\);/)?.[0];
assert.ok(closed);

let dockVisible = false;
let onActivate = () => {};
let reenterOnHide = false;
let reenterOnShow = false;
let creates = 0;
let now = 10_000;
let nativeLastHideAt = Number.NEGATIVE_INFINITY;
const timers = new Set<{ callback: () => void; due: number; unref(): void }>();
function advance(milliseconds: number): void {
  now += milliseconds;
  for (const timer of [...timers]) {
    if (timer.due <= now) {
      timers.delete(timer);
      timer.callback();
    }
  }
}
const pendingDockShows: Array<() => void> = [];
const context = vm.createContext({
  console,
  Date: { now: () => now },
  setTimeout: (callback: () => void, delay: number) => {
    const timer = { callback, due: now + delay, unref() {} };
    timers.add(timer);
    return timer;
  },
  clearTimeout: (timer: { callback: () => void; due: number; unref(): void }) => timers.delete(timer),
  shouldStayResident: () => true,
  app: {
    on: (_event: string, handler: () => void) => { onActivate = handler; },
    hide: () => { if (reenterOnHide) onActivate(); },
    dock: {
      isVisible: () => dockVisible,
      show: () => {
        if (reenterOnShow) onActivate();
        return new Promise<void>((resolve) => pendingDockShows.push(() => { dockVisible = true; resolve(); }));
      },
      hide: () => {
        if (reenterOnHide) onActivate();
        // Model the native failure rather than treating every hide as reliable.
        if (now - nativeLastHideAt < 1000) return;
        nativeLastHideAt = now;
        dockVisible = false;
      }
    }
  },
  createWindow: () => {
    creates++;
    vm.runInContext(`
      var vigilWindow = {
        destroyed: false, visible: false, minimized: false,
        on(_event, handler) { this.closed = handler; },
        isDestroyed() { return this.destroyed; },
        isMinimized() { return this.minimized; },
        restore() { this.minimized = false; },
        show() { this.visible = true; }, focus() {},
        destroy() { this.destroyed = true; this.visible = false; this.closed(); }
      };
      mainWindow = vigilWindow;
      ${closed}
    `, context);
  }
});
vm.runInContext(`
  let mainWindow = null;
  let changingWindowPresentation = false;
  let windowPresentationGeneration = 0;
  let windowPresentationVisible = false;
  let dockHideTimer = null;
  let lastDockHideAt = Number.NEGATIVE_INFINITY;
  const DOCK_HIDE_INTERVAL_MS = 1_100;
  let revealWindowWhenReady = false;
  let windowResizeSession = null;
  let currentAppUrl = 'vigil-app://app/';
  ${["showVigilWindow", "revealVigilWindow", "hideVigilWindow", "showVigilDock", "hideVigilDock"].map(functionSource).join("\n")}
  ${activate}
`, context);
const run = (code: string): unknown => vm.runInContext(code, context);
async function finishDockShow(): Promise<void> {
  const finish = pendingDockShows.shift();
  assert.ok(finish);
  finish();
  await Promise.resolve();
}

reenterOnShow = true;
onActivate();
assert.equal(creates, 1, "opening while Dock is hidden must create exactly one window, even if Dock.show reenters activate");
assert.equal(run("mainWindow.visible"), true);
reenterOnHide = true;
run("hideVigilWindow()");
assert.equal(run("mainWindow"), null, "hiding must release the renderer without recreating it during native activation");
await finishDockShow();
assert.equal(dockVisible, false, "an older Dock.show completion must not leave a stranded Dock icon after hide");
assert.equal(creates, 1);

onActivate();
assert.equal(creates, 2, "a later explicit reopen must work while Dock is hidden");
run("mainWindow.destroy()");
await finishDockShow();
assert.equal(timers.size, 1, "a rapid second Dock hide must wait out the native cooldown");
advance(1_100);
assert.equal(dockVisible, false, "red close button must also cancel pending Dock restoration");
assert.equal(run("mainWindow"), null);

onActivate();
run("hideVigilWindow()");
onActivate();
assert.equal(creates, 4);
await finishDockShow();
assert.equal(run("mainWindow.visible"), true, "an old completion must not hide a newer open request");
await finishDockShow();
assert.equal(dockVisible, true);
run("mainWindow.minimized = true");
onActivate();
assert.equal(run("mainWindow.minimized"), false, "Dock click must restore a minimized window");
assert.equal(creates, 4);
run("hideVigilWindow(); hideVigilWindow()");
assert.equal(timers.size, 1, "duplicate hides must coalesce into one pending request");
onActivate();
assert.equal(timers.size, 0, "explicit reopening must cancel the delayed hide");
advance(1_100);
assert.equal(dockVisible, true, "an old hide timer must never remove the reopened app from the Dock");
assert.equal(run("mainWindow.visible"), true);
run("hideVigilWindow()");
assert.equal(dockVisible, false);
assert.equal(run("mainWindow"), null);
console.log("window presentation lifecycle tests passed");
