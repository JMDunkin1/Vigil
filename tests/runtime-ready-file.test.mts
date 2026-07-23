import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { access, chmod, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
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
  assert.match(script, /authenticated_update_active\(\)[\s\S]*?marker_token[\s\S]*?lock_token[\s\S]*?marker_pid[\s\S]*?lock_pid/, "the supervisor must bind update suppression to the exact private lock and maintenance request");
  assert.match(script, /while \[\[ -e "\$marker" \]\]; do[\s\S]*?if authenticated_update_active; then[\s\S]*?\/bin\/sleep 1[\s\S]*?continue/, "restart supervision must stay loaded and resume immediately if the authenticated updater disappears");
  assert.match(
    script,
    /if authenticated_update_active; then[\s\S]*?pid=""[\s\S]*?started_at=""[\s\S]*?ready_app_path=""[\s\S]*?ready_transport=""[\s\S]*?ready_loaded=false[\s\S]*?\/bin\/sleep 1/,
    "authenticated maintenance must invalidate the cached readiness identity before the replacement can publish a new one"
  );
  assert.match(script, /global_update_manifest_path='[^']*\/updater\/update-recovery\.json'/, "the supervisor must watch the fixed global recovery manifest");
  assert.match(script, /global_update_policy_path='[^']*\/updater\/update-recovery-policy\.json'/, "the supervisor must use the fixed private recovery policy");
  assert.match(script, /global_recovery_script_path='[^']*\/updater\/recovery-runtime\/scripts\/recover-update-transaction\.mjs'/, "the supervisor must use the stable recovery bundle outside the replaceable app");
  assert.match(script, /global_update_manifest_present\(\) \{[\s\S]*?\[\[ -e "\$global_update_manifest_path" \|\| -L "\$global_update_manifest_path" \]\]/, "even a broken manifest symlink must block legacy recovery");
  assert.match(script, /private_owned_regular_file\(\)[\s\S]*?stat -f '%u'[\s\S]*?stat -f '%Lp'[\s\S]*?== "600"/, "global recovery bootstrap records must be private, regular, nonsymlink files owned by the current user");
  assert.doesNotMatch(script, /kill -0/, "runtime observation must not send even a probe signal");

  const globalRecoveryDefinition = script.indexOf("recover_global_update_transaction() {");
  const stableRecoveryInvocation = script.indexOf('"$recovery_node_path" "$global_recovery_script_path" --policy-file "$global_update_policy_path"', globalRecoveryDefinition);
  const liveRecoveryInvocation = script.indexOf('"$recovery_node_path" "$global_recovery_script_path" --policy-file "$global_update_policy_path" --live-runtime', stableRecoveryInvocation);
  const manifestRemovalProof = script.indexOf("! global_update_manifest_present", stableRecoveryInvocation);
  assert.ok(
    globalRecoveryDefinition >= 0
      && stableRecoveryInvocation > globalRecoveryDefinition
      && liveRecoveryInvocation > stableRecoveryInvocation
      && manifestRemovalProof > stableRecoveryInvocation,
    "the supervisor must invoke the SHA-bound stable recovery CLI directly, use its no-rollback live mode, and require durable manifest removal"
  );

  const verifiedMarkerDefinition = script.indexOf("mark_running_candidate_verified() {");
  const verifiedGlobalGate = script.indexOf("global_update_manifest_present && return 0", verifiedMarkerDefinition);
  const verifiedLegacyJournal = script.indexOf('[[ -e "$app_transaction_path" || -L "$app_transaction_path" ]]', verifiedMarkerDefinition);
  assert.ok(
    verifiedGlobalGate > verifiedMarkerDefinition && verifiedLegacyJournal > verifiedGlobalGate,
    "a healthy replacement must not independently promote its app-only journal while the global manifest exists"
  );

  const legacyRecoveryDefinition = script.indexOf("reconcile_interrupted_app_update() {");
  const legacyGlobalGate = script.indexOf("global_update_manifest_present && return 1", legacyRecoveryDefinition);
  const legacyJournalRead = script.indexOf('[[ -e "$app_transaction_path" || -L "$app_transaction_path" ]]', legacyRecoveryDefinition);
  assert.ok(
    legacyGlobalGate > legacyRecoveryDefinition && legacyJournalRead > legacyGlobalGate,
    "legacy per-app reconciliation must fail closed before reading its journal while the global manifest exists"
  );

  const verifiedTopologyDefinition = script.indexOf("verified_app_transaction_topology() {");
  const verifiedTargetProof = script.indexOf('path_matches_candidate "$app_path" || return 1', verifiedTopologyDefinition);
  const verifiedSidecarLoop = script.indexOf('for sidecar in "$app_previous_path" "$app_next_path"; do', verifiedTargetProof);
  const verifiedSidecarProof = script.indexOf('path_matches_candidate "$sidecar" || path_matches_initial "$sidecar" || return 1', verifiedSidecarLoop);
  const verifiedPhaseBranch = script.indexOf('if [[ "$phase" == "verified" || "$phase" == "finalizing" ]]; then', legacyRecoveryDefinition);
  const verifiedTopologyGate = script.indexOf("verified_app_transaction_topology || return 1", verifiedPhaseBranch);
  const verifiedCleanup = script.indexOf("clear_app_transaction_residue", verifiedTopologyGate);
  assert.ok(
    verifiedTopologyDefinition >= 0
      && verifiedTargetProof > verifiedTopologyDefinition
      && verifiedSidecarLoop > verifiedTargetProof
      && verifiedSidecarProof > verifiedSidecarLoop
      && verifiedPhaseBranch > legacyRecoveryDefinition
      && verifiedTopologyGate > verifiedPhaseBranch
      && verifiedCleanup > verifiedTopologyGate,
    "verified/finalizing supervisor cleanup must prove the exact candidate and every pinned sidecar before deletion"
  );

  const targetOnlyBranch = script.indexOf('if [[ "$target_exists" == true && "$next_exists" == false ]]; then', legacyRecoveryDefinition);
  const targetOnlyInitialProof = script.indexOf('[[ "$initial_present" == "true" ]] && path_matches_initial "$app_path"', targetOnlyBranch);
  const targetOnlyAbsentProof = script.indexOf('[[ "$initial_present" == "false" ]] && path_matches_candidate "$app_path"', targetOnlyInitialProof);
  const targetOnlyCandidateRemoval = script.indexOf('/bin/rm -rf "$app_path"', targetOnlyAbsentProof);
  assert.ok(
    targetOnlyBranch >= 0
      && targetOnlyInitialProof > targetOnlyBranch
      && targetOnlyAbsentProof > targetOnlyInitialProof
      && targetOnlyCandidateRemoval > targetOnlyAbsentProof,
    "target-only supervisor recovery must prove the exact initial app or an exact candidate installed over prior absence"
  );

  const preparingBranch = script.indexOf('if [[ "$phase" == "preparing"', legacyRecoveryDefinition);
  const partialQuarantine = script.indexOf('local partial_path="${app_next_path}.partial.${partial_uuid}"', preparingBranch);
  const partialMove = script.indexOf('/bin/mv "$app_next_path" "$partial_path"', partialQuarantine);
  const preparingJournalRemoval = script.indexOf('/bin/rm -f "$app_transaction_path"', partialMove);
  assert.ok(
    preparingBranch >= 0
      && partialQuarantine > preparingBranch
      && partialMove > partialQuarantine
      && preparingJournalRemoval > partialMove,
    "an unpinned partial app copy must be quarantined before its preparing journal is removed"
  );

  const reopenDefinition = script.indexOf("reopen_vigil() {");
  const recoverGlobalFirst = script.indexOf("if ! recover_global_update_transaction; then", reopenDefinition);
  const reconcileLegacySecond = script.indexOf("if ! reconcile_interrupted_app_update; then", recoverGlobalFirst);
  const openAfterRecovery = script.indexOf('/usr/bin/open -g "$app_path"', reconcileLegacySecond);
  assert.ok(
    recoverGlobalFirst > reopenDefinition
      && reconcileLegacySecond > recoverGlobalFirst
      && openAfterRecovery > reconcileLegacySecond,
    "relaunch must recover the global transaction first, then legacy residue, and only then open Vigil"
  );

  assert.match(
    script,
    /global_update_can_roll_forward_with_live_runtime\(\)[\s\S]*?transaction_state[\s\S]*?"commit-intent"[\s\S]*?"committed"/,
    "only a durable commit decision may recover the global transaction while its exact replacement process is live"
  );
  const supervisorLoop = script.indexOf('while [[ -e "$marker" ]]; do');
  const runtimeHealthDecision = script.indexOf("runtime_healthy=false", supervisorLoop);
  const liveManifestGate = script.indexOf("if global_update_manifest_present; then", runtimeHealthDecision);
  const unsafeLiveRollbackWait = script.indexOf('if [[ "$runtime_healthy" == true ]] && ! global_update_can_roll_forward_with_live_runtime; then', liveManifestGate);
  const liveRollbackContinue = script.indexOf("continue", unsafeLiveRollbackWait);
  const orphanRecoveryAttempt = script.indexOf('if ! recover_global_update_transaction "$recovery_mode"; then', liveRollbackContinue);
  const healthyReadyAcceptance = script.indexOf('if [[ "$runtime_healthy" == true ]]; then', orphanRecoveryAttempt);
  assert.ok(
    supervisorLoop >= 0
      && runtimeHealthDecision > supervisorLoop
      && liveManifestGate > runtimeHealthDecision
      && unsafeLiveRollbackWait > liveManifestGate
      && liveRollbackContinue > unsafeLiveRollbackWait
      && orphanRecoveryAttempt > liveRollbackContinue
      && healthyReadyAcceptance > orphanRecoveryAttempt,
    "when an updater dies with a live ready candidate, global recovery must be arbitrated before healthy readiness is accepted"
  );

  const previousGenerationBranch = script.indexOf('if [[ "$previous_exists" == true ]]; then');
  const pinnedPrevious = script.indexOf('{ path_matches_initial "$app_previous_path" || path_matches_candidate "$app_previous_path"; } || return 1', previousGenerationBranch);
  const pinnedNext = script.indexOf('{ path_matches_initial "$app_next_path" || path_matches_candidate "$app_next_path"; } || return 1', pinnedPrevious);
  const candidateStillCanonical = script.indexOf('if path_matches_candidate "$app_path" && path_matches_initial "$app_previous_path"; then', pinnedNext);
  const rollbackSwap = script.indexOf('swap_app_paths "$app_path" "$app_previous_path"', candidateStillCanonical);
  const rollbackAlreadyComplete = script.indexOf('elif path_matches_candidate "$app_previous_path" && path_matches_initial "$app_path"; then', rollbackSwap);
  const removeCandidateResidue = script.indexOf('/bin/rm -rf "$app_previous_path"', rollbackAlreadyComplete);
  const endAlreadyCompleteBranch = script.indexOf("\n      else", rollbackAlreadyComplete);
  assert.ok(
    previousGenerationBranch >= 0
      && pinnedPrevious > previousGenerationBranch
      && pinnedNext > pinnedPrevious
      && candidateStillCanonical > pinnedNext
      && rollbackSwap > candidateStillCanonical
      && rollbackAlreadyComplete > rollbackSwap
      && removeCandidateResidue > rollbackAlreadyComplete
      && endAlreadyCompleteBranch > removeCandidateResidue,
    "rollback retries must distinguish a canonical candidate from an already-restored canonical app"
  );
  assert.doesNotMatch(
    script.slice(rollbackAlreadyComplete, endAlreadyCompleteBranch),
    /swap_app_paths/,
    "an already-restored topology must delete candidate residue without ever swapping it back into service"
  );

  const targetAndNextBranch = script.indexOf('if [[ "$target_exists" == true && "$next_exists" == true ]]; then', previousGenerationBranch);
  const nextCandidateInitialTarget = script.indexOf('path_matches_candidate "$app_next_path" && path_matches_initial "$app_path"', targetAndNextBranch);
  const targetCandidateInitialNext = script.indexOf('path_matches_candidate "$app_path" && path_matches_initial "$app_next_path"', nextCandidateInitialTarget);
  const targetAndNextJournalRemoval = script.indexOf('/bin/rm -f "$app_transaction_path"', targetCandidateInitialNext);
  assert.ok(
    targetAndNextBranch > previousGenerationBranch
      && nextCandidateInitialTarget > targetAndNextBranch
      && targetCandidateInitialNext > nextCandidateInitialTarget
      && targetAndNextJournalRemoval > targetCandidateInitialNext,
    "two-path recovery must prove one exact initial and one exact candidate before deleting either path or its journal"
  );

  const malformedReadyBranch = script.indexOf('preserve_interruption "$$" "$invalid_started_at" "invalid-ready-record"');
  const malformedReadyArchive = script.indexOf("archive_invalid_ready", malformedReadyBranch);
  const malformedReadyRemoval = script.indexOf('/bin/rm -f "$ready"', malformedReadyArchive);
  const malformedReadyReopen = script.indexOf("reopen_vigil", malformedReadyRemoval);
  assert.ok(
    malformedReadyBranch >= 0
      && malformedReadyArchive > malformedReadyBranch
      && malformedReadyRemoval > malformedReadyArchive
      && malformedReadyReopen > malformedReadyRemoval,
    "a malformed readiness file must produce fail-closed evidence, be archived, and still relaunch Vigil"
  );
  const malformedPreserveFailure = script.indexOf("Vigil could not preserve invalid readiness evidence before recovery.");
  const malformedFailureReopen = script.indexOf("reopen_vigil", malformedPreserveFailure);
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
  const reopen = script.indexOf("reopen_vigil", markerRecheck);
  assert.ok(
    healthyContinue >= 0
      && preserveCall > healthyContinue
      && preserveRetry > preserveCall
      && readyRemoval > preserveRetry
      && markerRecheck > readyRemoval
      && reopen > markerRecheck,
    "healthy polls must retain the runtime, while stale identity evidence is preserved before removal and transactional recovery"
  );
  if (process.platform === "darwin") {
    await Promise.all([
      verifyOrphanedGlobalRecoveryWithLiveRuntime("pending"),
      verifyOrphanedGlobalRecoveryWithLiveRuntime("commit-intent")
    ]);
  }
} finally {
  await rm(dataDir, { recursive: true, force: true });
}

async function verifyOrphanedGlobalRecoveryWithLiveRuntime(state: "pending" | "commit-intent"): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `vigil-live-global-${state}-`));
  const markerPath = join(root, "supervisor", "enabled");
  const runtimeKeepalivePath = join(root, "runtime.keepalive");
  const dataDir = join(root, "data");
  const updaterDir = join(root, "updater");
  const appPath = join(root, "Vigil.app");
  const manifestPath = join(updaterDir, "update-recovery.json");
  const policyPath = join(updaterDir, "update-recovery-policy.json");
  const recoveryScriptPath = join(updaterDir, "recovery-runtime", "scripts", "recover-update-transaction.mjs");
  const recoveryInvokedPath = join(root, "recovery-invoked.json");
  const nodePath = await realpath(process.execPath);
  let runtime: ChildProcess | null = null;
  let supervisor: ChildProcess | null = null;
  try {
    await mkdir(join(updaterDir, "recovery-runtime", "scripts"), { recursive: true });
    await mkdir(join(root, "supervisor"), { recursive: true });
    await mkdir(dataDir, { recursive: true });
    await writeFile(markerPath, "enabled\n", { mode: 0o600 });
    await writeFile(runtimeKeepalivePath, "running\n", { mode: 0o600 });
    await writeFile(recoveryScriptPath, [
      'import { rmSync, writeFileSync } from "node:fs";',
      `writeFileSync(${JSON.stringify(recoveryInvokedPath)}, JSON.stringify(process.argv.slice(2)));`,
      `rmSync(${JSON.stringify(manifestPath)});`
    ].join("\n"), { mode: 0o600 });
    await chmod(recoveryScriptPath, 0o600);
    const attemptId = `live-runtime-${state}`;
    await writeFile(policyPath, `${JSON.stringify({
      version: 1,
      attemptId,
      updaterDir,
      expectedAppPath: appPath,
      repoRoot: root,
      userDataDir: root,
      expectedDataDir: dataDir,
      expectedRuntimePaths: [],
      recoveryRuntime: {
        root: join(updaterDir, "recovery-runtime"),
        nodePath,
        scriptPath: recoveryScriptPath,
        modulePath: join(updaterDir, "recovery-runtime", "src", "updateTransaction.js"),
        helperPath: join(updaterDir, "recovery-runtime", "bin", "vigil-atomic-swap"),
        scriptSha256: "0".repeat(64),
        moduleSha256: "0".repeat(64),
        helperSha256: "0".repeat(64)
      },
      createdAt: new Date().toISOString()
    })}\n`, { mode: 0o600 });
    await chmod(policyPath, 0o600);
    await writeFile(manifestPath, `${JSON.stringify({
      version: 1,
      attemptId,
      state,
      recovery: {
        policyPath,
        nodePath,
        scriptPath: recoveryScriptPath
      }
    })}\n`, { mode: 0o600 });
    await chmod(manifestPath, 0o600);

    runtime = spawn(nodePath, [
      "-e",
      `const fs=require("node:fs");const path=${JSON.stringify(runtimeKeepalivePath)};const timer=setInterval(()=>{if(!fs.existsSync(path)){clearInterval(timer);}},20);`
    ], { stdio: "ignore" });
    await childSpawned(runtime);
    if (!runtime.pid) throw new Error("The live-runtime fixture did not receive a process id.");
    await writeFile(join(dataDir, "runtime-ready.json"), `${JSON.stringify({
      pid: runtime.pid,
      startedAt: new Date().toISOString(),
      appPath: nodePath,
      transport: "in-app"
    })}\n`, { mode: 0o600 });

    const supervisorScriptPath = join(root, "supervisor.zsh");
    await writeFile(supervisorScriptPath, buildRuntimeSupervisorScript({
      markerPath,
      dataDir,
      appPath,
      executablePath: nodePath,
      backgroundLaunchArg: "--vigil-background",
      safetyBoundaryArg: "--vigil-safety-boundary-do-not-terminate-or-bootout",
      updateLockPath: join(updaterDir, "update.lock")
    }), { mode: 0o700 });
    await chmod(supervisorScriptPath, 0o700);
    supervisor = spawn("/bin/zsh", [supervisorScriptPath], { stdio: ["ignore", "ignore", "pipe"] });
    supervisor.stderr?.setEncoding("utf8");
    let supervisorError = "";
    supervisor.stderr?.on("data", (chunk) => {
      supervisorError += String(chunk);
    });
    await childSpawned(supervisor);

    if (state === "pending") {
      await waitForCondition(
        () => supervisorError.includes("preserved a live replacement"),
        "the supervisor to preserve the live pending replacement"
      );
      await access(manifestPath);
      assert.equal(await pathExistsForTest(recoveryInvokedPath), false, "pending rollback must not swap a live candidate underneath its process");
    } else {
      await waitForCondition(
        async () => await pathExistsForTest(recoveryInvokedPath),
        "the supervisor to roll forward the orphaned commit intent"
      );
      assert.deepEqual(JSON.parse(await readFile(recoveryInvokedPath, "utf8")), ["--policy-file", policyPath, "--live-runtime"]);
      assert.equal(await pathExistsForTest(manifestPath), false, "healthy commit-intent recovery must durably clear the global manifest");
    }
  } finally {
    await rm(markerPath, { force: true });
    await rm(runtimeKeepalivePath, { force: true });
    if (supervisor) await childExited(supervisor, "temporary recovery supervisor");
    if (runtime) await childExited(runtime, "temporary ready runtime");
    await rm(root, { recursive: true, force: true });
  }
}

async function childSpawned(child: ChildProcess): Promise<void> {
  if (child.pid) return;
  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    child.once("spawn", resolveSpawn);
    child.once("error", rejectSpawn);
  });
}

async function childExited(child: ChildProcess, label: string): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveExit, rejectExit) => {
    const timeout = setTimeout(() => rejectExit(new Error(`Timed out waiting for the ${label} to exit naturally.`)), 5_000);
    child.once("close", () => {
      clearTimeout(timeout);
      resolveExit();
    });
  });
}

async function waitForCondition(
  condition: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 4_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function pathExistsForTest(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}
