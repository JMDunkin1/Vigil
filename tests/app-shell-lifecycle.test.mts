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
  /function showVigilWindow\(appUrl: string\): void \{[\s\S]*?if \(shouldStayResident\(\)\) app\.show\(\);[\s\S]*?mainWindow\.show\(\);/,
  "opening the resident app must reverse the application-wide hidden state before showing its window"
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
  beforeQuitSource,
  /Promise\.race\([\s\S]*?server\.stop\(\)[\s\S]*?APP_QUIT_CLEANUP_TIMEOUT_MS[\s\S]*?app\.exit\(0\)/,
  "an update handoff must force the Electron process to exit if server cleanup stalls"
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
  /quitForUpdate: \(\) => \{\s*quitForUpdate = true;\s*app\.quit\(\);\s*\}/,
  "an app update must still be able to perform the intentional full quit needed to replace the app"
);
assert.doesNotMatch(
  mainSource,
  /setWindowButtonVisibility\(false\)/,
  "native macOS window controls must remain available in fullscreen"
);

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
