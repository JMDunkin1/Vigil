import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = await sourceRoot();
const mainSource = await readFile(join(root, "app", "main.ts"), "utf8");

assert.match(
  mainSource,
  /const DEFAULT_WINDOW_SIZE = 680;\s*const MIN_WINDOW_SIZE = 680;\s*const WINDOW_ASPECT_RATIO = 1;/,
  "the desktop window should define a square default and matching minimum size"
);

assert.match(
  mainSource,
  /width: DEFAULT_WINDOW_SIZE,\s*height: DEFAULT_WINDOW_SIZE,\s*minWidth: MIN_WINDOW_SIZE,\s*minHeight: MIN_WINDOW_SIZE,\s*center: true,/,
  "the desktop window should open centered at the compact square size"
);

assert.match(
  mainSource,
  /mainWindow\.setAspectRatio\(WINDOW_ASPECT_RATIO\);/,
  "manual resizing should preserve the square desktop window shape"
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
