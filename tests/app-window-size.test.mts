import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = await sourceRoot();
const mainSource = await readFile(join(root, "app", "main.ts"), "utf8");

assert.match(
  mainSource,
  /const DEFAULT_WINDOW_WIDTH = 750;\s*const DEFAULT_WINDOW_HEIGHT = 550;\s*const MIN_WINDOW_WIDTH = 680;\s*const MIN_WINDOW_HEIGHT = 520;/,
  "the desktop window should define the preferred compact landscape default and an independent minimum size"
);

assert.match(
  mainSource,
  /width: DEFAULT_WINDOW_WIDTH,\s*height: DEFAULT_WINDOW_HEIGHT,\s*minWidth: MIN_WINDOW_WIDTH,\s*minHeight: MIN_WINDOW_HEIGHT,\s*center: true,/,
  "the desktop window should open centered with a landscape shape"
);

assert.doesNotMatch(mainSource, /setAspectRatio\(/, "manual resizing must allow width and height to change independently");

assert.match(mainSource, /ipcMain\.on\("vigil:window-resize-begin", handleWindowResizeBegin\)/, "the desktop app must accept resizing from the larger in-window handles");
assert.match(mainSource, /Math\.max\(MIN_WINDOW_HEIGHT, session\.bounds\.height \+ deltaY\)/, "bottom-edge dragging must resize the window while honoring its minimum height");
assert.match(mainSource, /window\.setBounds\(next, false\)/, "custom resize dragging must update the real native window bounds");

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
