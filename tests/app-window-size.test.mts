import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = await sourceRoot();
const mainSource = await readFile(join(root, "app", "main.ts"), "utf8");

assert.match(
  mainSource,
  /const DEFAULT_WINDOW_WIDTH = 980;\s*const DEFAULT_WINDOW_HEIGHT = 680;\s*const MIN_WINDOW_WIDTH = 680;\s*const MIN_WINDOW_HEIGHT = 520;/,
  "the desktop window should define a landscape default and a compact independent minimum size"
);

assert.match(
  mainSource,
  /width: DEFAULT_WINDOW_WIDTH,\s*height: DEFAULT_WINDOW_HEIGHT,\s*minWidth: MIN_WINDOW_WIDTH,\s*minHeight: MIN_WINDOW_HEIGHT,\s*center: true,/,
  "the desktop window should open centered with a landscape shape"
);

assert.doesNotMatch(mainSource, /setAspectRatio\(/, "manual resizing must allow width and height to change independently");

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
