import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";

const originalExecFile = childProcess.execFile;
const originalNow = Date.now;
let now = 100_000;
let processReads = 0;
let bundleReads = 0;
let processOutput = "/Applications/Test Browser.app/Contents/MacOS/Test Browser\n";
let failProcessRead = false;
let releaseRead: (() => void) | undefined;
let readGate: Promise<void> | undefined;
let bundleGate: Promise<void> | undefined;
let bundleReadStarted: (() => void) | undefined;
const fakeExecFile = Object.assign(() => {
  throw new Error("Expected promisified execFile");
}, {
  [promisify.custom]: async (command: string) => {
    if (command === "/bin/ps") {
      processReads += 1;
      await readGate;
      if (failProcessRead) throw new Error("process read failed");
      return { stdout: processOutput, stderr: "" };
    }
    assert.equal(command, "/usr/bin/plutil", "the test must not run external commands");
    bundleReads += 1;
    bundleReadStarted?.();
    await bundleGate;
    return { stdout: JSON.stringify({ CFBundleIdentifier: "test.browser" }), stderr: "" };
  }
});

try {
  childProcess.execFile = fakeExecFile as unknown as typeof childProcess.execFile;
  syncBuiltinESMExports();
  Date.now = () => now;
  const { listRunningAppNames } = await import("../src/macos.js");

  readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
  const overlapping = Array.from({ length: 10 }, () => listRunningAppNames());
  await Promise.resolve();
  assert.equal(processReads, 1, "overlapping checks must issue exactly one process observation");
  releaseRead!();
  const results = await Promise.all(overlapping);
  for (const result of results) assert.deepEqual(result, { ok: true, apps: ["Test Browser"] });
  assert.equal(bundleReads, 1, "overlapping sweeps must not fan out duplicate bundle inspection commands");
  readGate = undefined;

  await listRunningAppNames();
  assert.equal(processReads, 2, "the next check must still enumerate current processes");
  assert.equal(bundleReads, 1, "successful bundle inspection retains its existing short cache");
  now -= 1;
  await listRunningAppNames();
  assert.equal(bundleReads, 2, "clock rollback cannot indefinitely extend bundle trust");

  processOutput = "";
  await listRunningAppNames();
  processOutput = "/Applications/Test Browser.app/Contents/MacOS/Test Browser\n";
  await listRunningAppNames();
  assert.equal(bundleReads, 3, "a returned application must be inspected after its old cache entry is pruned");

  failProcessRead = true;
  assert.equal((await listRunningAppNames()).ok, false);
  failProcessRead = false;
  assert.equal((await listRunningAppNames()).ok, true, "failed observations must be evicted for immediate recovery");

  now += 30_000;
  let releaseBundle: (() => void) | undefined;
  bundleGate = new Promise<void>((resolve) => { releaseBundle = resolve; });
  const bundleStarted = new Promise<void>((resolve) => { bundleReadStarted = resolve; });
  const slowSweep = listRunningAppNames();
  await bundleStarted;
  const readsBeforeFreshCheck = processReads;
  const overlappingBundleSweep = listRunningAppNames();
  // The second ps completes while the first sweep is still waiting on plutil.
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(processReads, readsBeforeFreshCheck + 1);
  assert.equal(bundleReads, 4, "fresh process checks can still share the in-flight bundle inspection");
  processOutput = "";
  assert.deepEqual(await listRunningAppNames(), { ok: true, apps: [] },
    "a slow bundle inspection must not hide later process-list changes from immediate enforcement");
  releaseBundle!();
  await Promise.all([slowSweep, overlappingBundleSweep]);
} finally {
  childProcess.execFile = originalExecFile;
  syncBuiltinESMExports();
  Date.now = originalNow;
}
