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
  /app\.on\("activate"/,
  "incidental macOS activation must never create or reveal a Sentinel window"
);
assert.match(
  mainSource,
  /app\.on\("second-instance", \(_event, commandLine\) => \{\s*if \(commandLine\.includes\(BACKGROUND_LAUNCH_ARG\)\) return;/,
  "background verification launches must not reveal the running app"
);
assert.match(
  mainSource,
  /if \(process\.argv\.includes\(BACKGROUND_LAUNCH_ARG\)\) return false;/,
  "a fresh background verification launch must remain windowless"
);
assert.match(
  mainSource,
  /app\.on\("window-all-closed", \(\) => \{\s*if \(!shouldStayResident\(\)\) app\.quit\(\);/,
  "closing the last window must leave the packaged menu-bar companion running"
);
assert.match(
  beforeQuitSource,
  /shouldStayResident\(\)[\s\S]*?!quitForUpdate[\s\S]*?event\.preventDefault\(\)[\s\S]*?hideSentinelWindow\(\)/,
  "normal quit attempts must hide the window and leave the packaged menu-bar companion running"
);
assert.match(
  mainSource,
  /label: "Hide Sentinel Window",\s*accelerator: "CommandOrControl\+Q"/,
  "Command-Q must hide the Sentinel window without terminating its background companion"
);
assert.doesNotMatch(mainSource, /label: "Quit Sentinel"/, "the menu-bar menu must not offer a misleading true-quit action");
assert.match(
  mainSource,
  /quitForUpdate: \(\) => \{\s*quitForUpdate = true;\s*app\.quit\(\);\s*\}/,
  "an app update must still be able to perform the intentional full quit needed to replace the app"
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
  throw new Error("Could not locate the Sentinel source root.");
}
