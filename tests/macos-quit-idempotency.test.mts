import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";
const original = childProcess.execFile;
let output = "";
let processReadFails = false;
let reads = 0;
const fake = Object.assign(() => { throw new Error("Expected promisified execFile"); }, {
  [promisify.custom]: async (command: string) => {
    if (command === "/bin/ps") {
      reads++;
      if (processReadFails) throw new Error("Cannot enumerate processes");
      return { stdout: output, stderr: "" };
    }
    if (command === "/usr/bin/plutil") return { stdout: JSON.stringify({ CFBundleIdentifier: "test.browser" }), stderr: "" };
    if (["/usr/bin/osascript", "/usr/bin/pkill"].includes(command)) throw Object.assign(new Error("Process no longer exists"), { code: 1 });
    throw new Error(`Unexpected external command: ${command}`);
  }
});
try {
  childProcess.execFile = fake as unknown as typeof childProcess.execFile;
  syncBuiltinESMExports();
  const { quitApp } = await import("../src/macos.js");
  for (const force of [false, true]) {
    output = ""; processReadFails = false;
    assert.equal((await quitApp("Test Browser", { force })).ok, true, "a replayed quit succeeds only after observing absence");
    output = "/Applications/Test Browser.app/Contents/MacOS/Test Browser\n";
    assert.equal((await quitApp("Test Browser", { force })).ok, false, "a failed quit is not acknowledged while the target is still running");
    output = ""; processReadFails = true;
    assert.equal((await quitApp("Test Browser", { force })).ok, false, "an enumeration error cannot be treated as absence");
  }
  assert.equal(reads, 6, "every decision requires a new process observation");
} finally {
  childProcess.execFile = original;
  syncBuiltinESMExports();
}
