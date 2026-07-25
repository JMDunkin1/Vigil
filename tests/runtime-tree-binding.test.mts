import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  captureRuntimeTreeDigest,
  runtimeTreeDigestContentsMatch
} from "../src/runtimeTreeDigest.js";

const root = await realpath(await mkdtemp(join(tmpdir(), "vigil-runtime-tree-binding-")));
try {
  const runtime = join(root, "runtime");
  const copiedRuntime = join(root, "runtime-copy");
  await mkdir(join(runtime, "scripts"), { recursive: true });
  await Promise.all([
    writeFile(join(runtime, "build-info.json"), "{\"commit\":\"abc\"}\n"),
    writeFile(join(runtime, "scripts", "worker.mjs"), "export const worker = true;\n")
  ]);
  await chmod(join(runtime, "scripts", "worker.mjs"), 0o755);

  const first = await captureRuntimeTreeDigest(runtime);
  const repeated = await captureRuntimeTreeDigest(runtime);
  assert.equal(runtimeTreeDigestContentsMatch(first, repeated), true);
  assert.match(first.sha256, /^[a-f0-9]{64}$/u);
  assert.equal(first.entryCount, 4);

  await cp(runtime, copiedRuntime, { recursive: true, preserveTimestamps: true });
  const copied = await captureRuntimeTreeDigest(copiedRuntime);
  assert.equal(runtimeTreeDigestContentsMatch(first, copied), true,
    "a separately staged runtime must reproduce the signed source tree despite a different root inode");
  assert.notEqual(first.rootIno, copied.rootIno);

  await writeFile(join(copiedRuntime, "scripts", "worker.mjs"), "export const worker = false;\n");
  const changedContent = await captureRuntimeTreeDigest(copiedRuntime);
  assert.equal(runtimeTreeDigestContentsMatch(first, changedContent), false,
    "regular-file byte changes must alter the runtime identity");

  await cp(runtime, copiedRuntime, { recursive: true, force: true, preserveTimestamps: true });
  await chmod(join(copiedRuntime, "scripts", "worker.mjs"), 0o700);
  const changedMode = await captureRuntimeTreeDigest(copiedRuntime);
  assert.equal(runtimeTreeDigestContentsMatch(first, changedMode), false,
    "executable permission changes must alter the runtime identity");

  await rm(copiedRuntime, { recursive: true, force: true });
  await cp(runtime, copiedRuntime, { recursive: true, preserveTimestamps: true });
  await symlink("../build-info.json", join(copiedRuntime, "scripts", "linked-build-info"));
  await assert.rejects(
    captureRuntimeTreeDigest(copiedRuntime),
    /symbolic link/u,
    "even an in-tree symlink must be rejected instead of followed"
  );

  await rm(copiedRuntime, { recursive: true, force: true });
  await cp(runtime, copiedRuntime, { recursive: true, preserveTimestamps: true });
  let mutationInjected = false;
  await assert.rejects(
    captureRuntimeTreeDigest(copiedRuntime, {
      async afterFilePinned(path) {
        if (mutationInjected || !path.endsWith("worker.mjs")) return;
        mutationInjected = true;
        await writeFile(path, "same-user mutation during digest\n");
      }
    }),
    /changed/u,
    "a same-user in-place mutation after O_NOFOLLOW descriptor pinning must fail closed"
  );
} finally {
  await rm(root, { recursive: true, force: true });
}

const sourceRoot = existsSync(join(process.cwd(), "scripts", "update-packaged-app.mts"))
  ? process.cwd()
  : resolve(process.cwd(), "..", "..");
const [prebuiltSource, transactionSource, updaterSource] = await Promise.all([
  readFile(join(sourceRoot, "src", "prebuiltRelease.ts"), "utf8"),
  readFile(join(sourceRoot, "src", "updateTransaction.ts"), "utf8"),
  readFile(join(sourceRoot, "scripts", "update-packaged-app.mts"), "utf8")
]);

assert.match(
  prebuiltSource,
  /verifiedSignatureIdentity\(staged\.realPath\)[\s\S]*?captureRuntimeTreeDigest\(runtimePath\)[\s\S]*?verifiedSignatureIdentity\(staged\.realPath\)/u,
  "the trusted tree digest must be bracketed by signed-app verification"
);
for (const field of [
  "treeSha256",
  "initialTreeSha256",
  "targetTreeSha256",
  "candidateTreeSha256"
]) {
  assert.ok(transactionSource.includes(field), `durable runtime identity must carry ${field}`);
}
assert.match(
  transactionSource,
  /const next = await operations\.identifyArtifact\(artifact\.nextPath, kind\)[\s\S]*?exactIdentityMatches\(expectedTarget, next\)/u,
  "activation must freshly identify .vigil-next, including its tree digest"
);
assert.match(
  transactionSource,
  /const installed = await operations\.identifyArtifact\(artifact\.targetPath, kind\)[\s\S]*?exactIdentityMatches\(expectedTarget, installed\)/u,
  "activation must freshly identify the activated canonical target"
);
const finalBindingIndex = updaterSource.lastIndexOf(
  "await assertPrebuiltRuntimeTreeBinding(stagedBuild, runtimePlan);"
);
const guardianMaintenanceIndex = updaterSource.indexOf(
  "guardianMaintenance = await beginGuardianMaintenance"
);
assert.ok(
  finalBindingIndex > 0 && finalBindingIndex < guardianMaintenanceIndex,
  "the detached updater must re-hash .vigil-next immediately before guardian maintenance"
);
assert.ok(
  updaterSource.indexOf("prebuiltCleanupRoot = options.prebuiltRelease?.root || null;")
    < updaterSource.indexOf("await assertPrivatePrebuiltReleasePaths(options.prebuiltRelease)"),
  "an untrusted prebuilt attempt root must be retained for constrained cleanup before validation can fail"
);
