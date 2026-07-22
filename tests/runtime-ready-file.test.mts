import assert from "node:assert/strict";
import { access, chmod, lstat, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildRuntimeSupervisorScript,
  clearRuntimeInterruption,
  markRuntimeReady,
  quarantineRuntimeInterruption,
  readRuntimeInterruption,
  readRuntimeReady,
  runtimeInterruptionId,
  runtimeInterruptionPath,
  runtimeReadyPath
} from "../src/runtimeReady.js";

const dataDir = await mkdtemp(join(tmpdir(), "vigil-runtime-ready-"));

try {
  const ready = await markRuntimeReady(dataDir, "/Applications/Vigil.app/Contents/MacOS/Vigil");
  assert.deepEqual(await readRuntimeReady(dataDir), ready);
  assert.equal((await stat(runtimeReadyPath(dataDir))).mode & 0o777, 0o600, "runtime readiness must stay private");

  const startedAt = "2026-07-21T15:00:00.000Z";
  const detectedAt = "2026-07-21T15:00:02.000Z";
  const id = runtimeInterruptionId({ pid: 42, startedAt });
  assert.equal(id, `runtime-interruption-v1:42:${startedAt}`, "the interruption id must be deterministic across retries");
  assert.throws(() => runtimeInterruptionId({ pid: 0, startedAt }), /invalid runtime interruption/);
  assert.throws(() => runtimeInterruptionId({ pid: 42, startedAt: "not-a-time" }), /invalid runtime interruption/);

  const interruption = {
    version: 1 as const,
    id,
    pid: 42,
    startedAt,
    appPath: "/Applications/Vigil.app/Contents/MacOS/Vigil",
    transport: "in-app" as const,
    detectedAt,
    reason: "process-missing" as const
  };
  const interruptionPath = runtimeInterruptionPath(dataDir);
  await writeFile(interruptionPath, `${JSON.stringify(interruption)}\n`, { mode: 0o600 });
  await chmod(interruptionPath, 0o600);
  assert.deepEqual(await readRuntimeInterruption(dataDir), { status: "valid", record: interruption });
  assert.equal(await clearRuntimeInterruption(dataDir, "runtime-interruption-v1:999:wrong"), false, "a mismatched acknowledgement must preserve evidence");
  await access(interruptionPath);
  assert.equal(await clearRuntimeInterruption(dataDir, id), true, "the exact acknowledged receipt may be cleared");
  assert.deepEqual(await readRuntimeInterruption(dataDir), { status: "missing" });
  assert.equal(await quarantineRuntimeInterruption(dataDir), null, "a vanished canonical receipt needs no quarantine");

  const invalidReadyReceipt = { ...interruption, reason: "invalid-ready-record" as const };
  await writeFile(interruptionPath, `${JSON.stringify(invalidReadyReceipt)}\n`, { mode: 0o600 });
  assert.deepEqual(await readRuntimeInterruption(dataDir), { status: "valid", record: invalidReadyReceipt },
    "the supervisor's malformed-readiness receipt must remain structurally readable so startup can persist a fail-closed alarm");
  assert.equal(await clearRuntimeInterruption(dataDir, id), true);

  const unsafeContents = `${JSON.stringify(interruption)}\n`;
  await writeFile(interruptionPath, unsafeContents, { mode: 0o600 });
  await chmod(interruptionPath, 0o644);
  assert.deepEqual(await readRuntimeInterruption(dataDir), { status: "invalid", reason: "unsafe-file" }, "group- or world-readable evidence must be rejected");
  assert.equal(await clearRuntimeInterruption(dataDir, id), false, "invalid evidence must not be cleared through the acknowledgement helper");
  const quarantinedRegular = await quarantineRuntimeInterruption(dataDir, new Date("2026-07-21T15:01:00.000Z"));
  if (!quarantinedRegular) throw new Error("Expected invalid regular evidence to be quarantined.");
  assert.ok(quarantinedRegular.includes("runtime-interruption.json.corrupt.1784646060000."));
  assert.equal(await readFile(quarantinedRegular, "utf8"), unsafeContents, "quarantine must preserve invalid regular-file contents");
  assert.equal((await stat(quarantinedRegular)).mode & 0o777, 0o600, "a safely owned regular receipt must become private in quarantine");
  assert.deepEqual(await readRuntimeInterruption(dataDir), { status: "missing" });

  await writeFile(interruptionPath, JSON.stringify({ ...interruption, padding: "x".repeat(9_000) }), { mode: 0o600 });
  await chmod(interruptionPath, 0o600);
  assert.deepEqual(await readRuntimeInterruption(dataDir), { status: "invalid", reason: "oversized-file" }, "oversized evidence must be rejected before it is read");
  await rm(interruptionPath, { force: true });

  await writeFile(interruptionPath, `${JSON.stringify({ ...interruption, id: `${id}:tampered` })}\n`, { mode: 0o600 });
  await chmod(interruptionPath, 0o600);
  assert.deepEqual(await readRuntimeInterruption(dataDir), { status: "invalid", reason: "invalid-record" }, "an interruption with a non-deterministic id must be rejected");
  await rm(interruptionPath, { force: true });

  const reversedTimestamps = {
    ...interruption,
    detectedAt: "2026-07-21T14:59:59.000Z"
  };
  await writeFile(interruptionPath, `${JSON.stringify(reversedTimestamps)}\n`, { mode: 0o600 });
  await chmod(interruptionPath, 0o600);
  assert.deepEqual(await readRuntimeInterruption(dataDir), { status: "invalid", reason: "invalid-record" }, "a receipt detected before its runtime started must fail closed");
  await rm(interruptionPath, { force: true });

  await writeFile(interruptionPath, "{not-json\n", { mode: 0o600 });
  await chmod(interruptionPath, 0o600);
  assert.deepEqual(await readRuntimeInterruption(dataDir), { status: "invalid", reason: "malformed-json" });
  const quarantinedMalformed = await quarantineRuntimeInterruption(dataDir, new Date("2026-07-21T15:01:01.000Z"));
  assert.ok(quarantinedMalformed);
  assert.equal(await readFile(quarantinedMalformed, "utf8"), "{not-json\n");

  const symlinkTarget = join(dataDir, "untrusted-interruption-target.json");
  await writeFile(symlinkTarget, `${JSON.stringify(interruption)}\n`, { mode: 0o600 });
  await chmod(symlinkTarget, 0o644);
  const targetContents = await readFile(symlinkTarget, "utf8");
  const targetMode = (await stat(symlinkTarget)).mode & 0o777;
  await symlink(symlinkTarget, interruptionPath);
  assert.deepEqual(await readRuntimeInterruption(dataDir), { status: "invalid", reason: "unsafe-file" }, "interruption evidence must never be read through a symlink");
  const quarantinedSymlink = await quarantineRuntimeInterruption(dataDir, new Date("2026-07-21T15:01:02.000Z"));
  assert.ok(quarantinedSymlink);
  assert.equal((await lstat(quarantinedSymlink)).isSymbolicLink(), true, "quarantine must move the symlink entry itself");
  assert.equal(await readlink(quarantinedSymlink), symlinkTarget);
  assert.equal(await readFile(symlinkTarget, "utf8"), targetContents, "quarantine must not modify a symlink target");
  assert.equal((await stat(symlinkTarget)).mode & 0o777, targetMode, "quarantine must not chmod a symlink target");
  assert.deepEqual(await readRuntimeInterruption(dataDir), { status: "missing" });

  const script = buildRuntimeSupervisorScript({
    markerPath: "/Users/test/Library/Application Support/Vigil/supervisor/enabled",
    dataDir: "/Users/test/Library/Application Support/Vigil",
    appPath: "/Applications/Vigil.app",
    executablePath: "/Applications/Vigil.app/Contents/MacOS/Vigil",
    backgroundLaunchArg: "--vigil-background",
    safetyBoundaryArg: "--vigil-safety-boundary-do-not-terminate-or-bootout"
  });
  assert.match(script, /runtime-interruption\.json/, "the supervisor must retain interruption evidence outside the readiness file");
  assert.match(script, /\/bin\/chmod 0600 "\$temporary"[\s\S]*?\/bin\/sync[\s\S]*?\/bin\/mv -f "\$temporary" "\$interruption"[\s\S]*?\/bin\/sync/, "evidence must be private and power-loss durable around its atomic rename");
  assert.match(script, /archive_existing_interruption\(\)[\s\S]*?archive_path="\$\{interruption\}\.conflict\.\$\{archived_at\}\.\$\{archive_uuid\}"[\s\S]*?\/bin\/mv "\$interruption" "\$archive_path"/, "a nonmatching receipt must be atomically archived instead of overwritten");
  assert.match(script, /ready_loaded=false[\s\S]*?if \[\[ "\$ready_loaded" == true \]\]; then[\s\S]*?elif \[\[ -e "\$ready" \|\| -L "\$ready" \]\]; then[\s\S]*?ready_loaded=true/, "a healthy runtime must read its immutable readiness identity only once");
  assert.match(script, /\/usr\/bin\/plutil -extract startedAt[\s\S]*?\/usr\/bin\/plutil -extract appPath[\s\S]*?\/usr\/bin\/plutil -extract transport/, "the supervisor must validate the complete runtime identity");
  assert.doesNotMatch(script, /kill -0/, "runtime observation must not send even a probe signal");

  const malformedReadyBranch = script.indexOf('preserve_interruption "$$" "$invalid_started_at" "invalid-ready-record"');
  const malformedReadyArchive = script.indexOf("archive_invalid_ready", malformedReadyBranch);
  const malformedReadyRemoval = script.indexOf('/bin/rm -f "$ready"', malformedReadyArchive);
  const malformedReadyReopen = script.indexOf('/usr/bin/open -g "$app_path"', malformedReadyRemoval);
  assert.ok(
    malformedReadyBranch >= 0
      && malformedReadyArchive > malformedReadyBranch
      && malformedReadyRemoval > malformedReadyArchive
      && malformedReadyReopen > malformedReadyRemoval,
    "a malformed readiness file must produce fail-closed evidence, be archived, and still relaunch Vigil"
  );
  const malformedPreserveFailure = script.indexOf("Vigil could not preserve invalid readiness evidence before recovery.");
  const malformedFailureReopen = script.indexOf('/usr/bin/open -g "$app_path"', malformedPreserveFailure);
  const malformedFailureRetry = script.indexOf('/bin/sleep 2\n        continue', malformedFailureReopen);
  assert.ok(
    malformedPreserveFailure >= 0
      && malformedFailureReopen > malformedPreserveFailure
      && malformedFailureRetry > malformedFailureReopen,
    "an evidence-write failure must retain the marker for retry without leaving Vigil offline"
  );

  const healthyContinue = script.indexOf('/bin/sleep 2\n    continue');
  const preserveCall = script.indexOf('if ! preserve_interruption "$pid" "$started_at" "$reason"');
  const preserveRetry = script.indexOf('/bin/sleep 2\n        continue', preserveCall);
  const readyRemoval = script.indexOf('/bin/rm -f "$ready"', preserveCall);
  const markerRecheck = script.indexOf('if [[ ! -e "$marker" ]]', readyRemoval);
  const reopen = script.indexOf('/usr/bin/open -g "$app_path"', markerRecheck);
  assert.ok(
    healthyContinue >= 0
      && preserveCall > healthyContinue
      && preserveRetry > preserveCall
      && readyRemoval > preserveRetry
      && markerRecheck > readyRemoval
      && reopen > markerRecheck,
    "healthy polls must remain write-free, while stale identity evidence is preserved before removal and recovery"
  );
} finally {
  await rm(dataDir, { recursive: true, force: true });
}
