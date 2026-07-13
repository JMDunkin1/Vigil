import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = await sourceRoot();
const mainSource = await readFile(join(root, "app", "main.ts"), "utf8");
const beforeQuitStart = mainSource.indexOf('app.on("before-quit"');
const beforeQuitEnd = mainSource.indexOf('\n});', beforeQuitStart);
assert.notEqual(beforeQuitStart, -1, "the app must retain a before-quit cleanup hook");
assert.notEqual(beforeQuitEnd, -1, "the before-quit cleanup hook must be complete");
const beforeQuitSource = mainSource.slice(beforeQuitStart, beforeQuitEnd + 4);

assert.doesNotMatch(
  mainSource,
  /app\.on\("activate", \(\) => \{[^}]*showVigilWindow/,
  "activating the packaged app from Finder or Spotlight must leave its window hidden"
);
assert.doesNotMatch(
  mainSource,
  /app\.on\("second-instance", \(\) => \{[^}]*showVigilWindow/,
  "opening an already resident app must leave its window hidden"
);
assert.match(
  mainSource,
  /function shouldShowWindowOnLaunch\(\): boolean \{\s*if \(process\.argv\.includes\(BACKGROUND_LAUNCH_ARG\)\) return false;\s*return !shouldStayResident\(\);\s*\}/,
  "every fresh packaged launch must remain windowless"
);
assert.match(
  mainSource,
  /label: "Open Vigil",\s*click: \(\) => \{\s*showVigilWindow\(appUrl\);\s*\}/,
  "the menu-bar Open Vigil action must remain the explicit way to reveal the window"
);
assert.match(
  mainSource,
  /function showVigilWindow\(appUrl: string\): void \{[\s\S]*?if \(shouldStayResident\(\)\) \{[\s\S]*?app\.setActivationPolicy\("regular"\);[\s\S]*?app\.show\(\);[\s\S]*?if \(!mainWindow\) createWindow\(appUrl\);[\s\S]*?mainWindow\.show\(\);/,
  "an open resident window must enter regular macOS presentation before its native window is created or shown"
);
const showWindowStart = mainSource.indexOf("function showVigilWindow");
const showWindowEnd = mainSource.indexOf("\n}", showWindowStart);
const showWindowSource = mainSource.slice(showWindowStart, showWindowEnd + 2);
assert.doesNotMatch(showWindowSource, /app\.dock\?\.hide\(\)/, "opening Vigil must not demote the regular app back to accessory presentation");
assert.ok(
  showWindowSource.indexOf('app.setActivationPolicy("regular")') < showWindowSource.indexOf("createWindow(appUrl)"),
  "Vigil must never create native window chrome while the packaged app is still using accessory presentation"
);
assert.match(
  mainSource,
  /app\.on\("window-all-closed", \(\) => \{\s*if \(!shouldStayResident\(\)\) app\.quit\(\);/,
  "closing the last window must leave the packaged menu-bar companion running"
);
assert.match(
  beforeQuitSource,
  /shouldStayResident\(\)[\s\S]*?!quitForUpdate[\s\S]*?event\.preventDefault\(\)[\s\S]*?hideVigilWindow\(\)/,
  "normal quit attempts must hide the window and leave the packaged menu-bar companion running"
);
assert.match(
  mainSource,
  /function hideVigilWindow\(\): void \{\s*mainWindow\?\.hide\(\);\s*if \(shouldStayResident\(\)\) \{\s*app\.hide\(\);\s*enforceMenuBarOnlyPresentation\(\);\s*\}\s*\}/,
  "hiding Vigil must hide the visual app and restore its menu-bar-only presentation"
);
assert.match(
  mainSource,
  /function enforceMenuBarOnlyPresentation\(\): void \{\s*app\.setActivationPolicy\("accessory"\);\s*app\.dock\?\.hide\(\);\s*\}/,
  "the resident macOS app must use accessory activation policy and remain absent from the Dock"
);
assert.match(
  mainSource,
  /label: "Hide Vigil Window",\s*accelerator: "CommandOrControl\+Q"/,
  "Command-Q must hide the Vigil window without terminating its background companion"
);
assert.doesNotMatch(mainSource, /label: "Quit Vigil"/, "the menu-bar menu must not offer a misleading true-quit action");
assert.match(
  mainSource,
  /quitForUpdate: \(\) => \{\s*quitForUpdate = true;\s*app\.exit\(0\);\s*\}/,
  "an app update must exit immediately so the replacement never overlaps the installed app"
);
assert.match(mainSource, /fullscreenable:\s*true/, "Vigil must use the standard native macOS fullscreen path");
assert.match(mainSource, /titleBarStyle:\s*"hiddenInset"/, "Vigil must use the stable inset macOS title bar with native traffic lights");
assert.match(mainSource, /trafficLightPosition:\s*\{ x:\s*18, y:\s*19 \}/, "integrated traffic lights must retain their intended position");
assert.match(mainSource, /acceptFirstMouse:\s*true/, "the first click after Mission Control must reach Vigil's controls");
assert.match(
  mainSource,
  /function restoreNativeWindowControls\(window: BrowserWindow\): void \{[\s\S]*?window\.setWindowButtonPosition\(\{ x: 18, y: 19 \}\);[\s\S]*?window\.setWindowButtonVisibility\(true\);/,
  "showing Vigil must reapply the supported native traffic-light geometry and visibility APIs"
);
assert.match(
  showWindowSource,
  /mainWindow\.show\(\);[\s\S]*?restoreNativeWindowControls\(mainWindow\);[\s\S]*?mainWindow\.focus\(\);/,
  "native controls must be restored after the formerly hidden window becomes visible"
);
for (const event of ["ready-to-show", "show"]) {
  assert.match(
    mainSource,
    new RegExp(`vigilWindow\\.on\\("${event}",[\\s\\S]*?restoreNativeWindowControls\\(vigilWindow\\)`),
    `${event} must repair native controls without rewriting AppKit fullscreen or focus transitions`
  );
}
assert.doesNotMatch(mainSource, /vigilWindow\.on\("(?:focus|maximize|unmaximize|enter-full-screen|leave-full-screen)"/, "native transitions must not rewrite the window while AppKit is animating it");
assert.doesNotMatch(mainSource, /vigil:window-action|maximizedWindowControls/, "Vigil must not imitate native window controls in web content");
assert.match(mainSource, /role:\s*"togglefullscreen"/, "the View menu must expose the standard native macOS fullscreen action");

async function sourceRoot(): Promise<string> {
  for (const candidate of [process.cwd(), resolve(process.cwd(), "..", "..")]) {
    try {
      await access(join(candidate, "tsconfig.json"));
      return candidate;
    } catch {
      // Try the next known build layout.
    }
  }
  throw new Error("Could not locate the Vigil source root.");
}
