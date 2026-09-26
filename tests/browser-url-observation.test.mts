import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";

const originalExecFile = childProcess.execFile;
let frontUrl = "https://example.org/loaded";
const backgroundUrl = "https://example.org/background";
let reads = 0;
let failRead = false;
let gate: Promise<void> | undefined;
let release: (() => void) | undefined;
const fakeExecFile = Object.assign(() => {
  throw new Error("Expected promisified execFile");
}, {
  [promisify.custom]: async (command: string, args: string[]) => {
    assert.equal(command, "/usr/bin/osascript", "URL observation must not execute other commands");
    const script = args.at(-1) || "";
    assert.match(script, /URL of current tab of front window/u);
    reads += 1;
    await gate;
    if (failRead) throw new Error("Safari URL observation failed");
    // Model Safari's missing Start Page URL alongside a real background
    // document. The former all-window fallback selected that hidden page.
    const selected = frontUrl || (/repeat with safariWindow in windows/u.test(script) ? backgroundUrl : "");
    return { stdout: selected, stderr: "" };
  }
});

try {
  childProcess.execFile = fakeExecFile as unknown as typeof childProcess.execFile;
  syncBuiltinESMExports();
  const { getActiveBrowserUrl } = await import("../src/macos.js");
  assert.deepEqual(await getActiveBrowserUrl("Safari"), { ok: true, url: frontUrl });

  frontUrl = "";
  assert.deepEqual(await getActiveBrowserUrl("Safari"), { ok: true, url: "" },
    "a Start Page or provisional tab must not reuse the previous URL or another window's URL");

  gate = new Promise<void>((resolve) => { release = resolve; });
  const before = reads;
  const overlapping = [getActiveBrowserUrl("Safari"), getActiveBrowserUrl("Safari")];
  await Promise.resolve();
  assert.equal(reads, before + 1, "concurrent observations can share only their pending read");
  release!();
  for (const result of await Promise.all(overlapping)) assert.deepEqual(result, { ok: true, url: "" });
  gate = undefined;

  frontUrl = "https://example.org/navigation-committed";
  assert.deepEqual(await getActiveBrowserUrl("Safari"), { ok: true, url: frontUrl },
    "a newly committed foreground page must be observed immediately after an empty result");
  failRead = true;
  const failed = await getActiveBrowserUrl("Safari");
  assert.equal(failed.ok, false);
  assert.equal(failed.url, "", "failed observations cannot reuse an older foreground document");
  failRead = false;
  assert.deepEqual(await getActiveBrowserUrl("Safari"), { ok: true, url: frontUrl });
} finally {
  childProcess.execFile = originalExecFile;
  syncBuiltinESMExports();
}
