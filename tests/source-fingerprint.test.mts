import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitExecutable } from "../scripts/git-executable.mjs";
import { sourceFingerprint } from "../scripts/source-fingerprint.mjs";

const root = await mkdtemp(join(tmpdir(), "vigil-source-fingerprint-"));
try {
  await git(["init", "-q"]);
  await git(["config", "user.email", "vigil-test@example.com"]);
  await git(["config", "user.name", "Vigil Test"]);
  await writeFile(join(root, "tracked.txt"), "initial\n");
  await git(["add", "tracked.txt"]);
  await git(["commit", "-qm", "initial"]);

  const clean = await sourceFingerprint(root);
  assert.ok(clean);
  await writeFile(join(root, "tracked.txt"), "changed\n");
  const tracked = await sourceFingerprint(root);
  assert.notEqual(tracked, clean, "tracked edits must change the source fingerprint");
  assert.equal(await sourceFingerprint(root), tracked, "an unchanged dirty checkout must keep a stable fingerprint");

  await writeFile(join(root, "untracked.txt"), "first\n");
  const untracked = await sourceFingerprint(root);
  assert.notEqual(untracked, tracked, "untracked files must change the source fingerprint");
  await writeFile(join(root, "untracked.txt"), "second\n");
  const internalFingerprint = await sourceFingerprint(root);
  assert.notEqual(internalFingerprint, untracked, "untracked file contents must affect the source fingerprint");

  const externalDiff = join(root, "external-diff.sh");
  const externalDiffMarker = join(root, "external-diff-invoked");
  await writeFile(externalDiff, "#!/bin/sh\nprintf invoked > \"$VIGIL_TEST_DIFF_MARKER\"\nexit 69\n");
  await chmod(externalDiff, 0o755);
  const fingerprintWithHarness = await sourceFingerprint(root);
  const previousExternalDiff = process.env.GIT_EXTERNAL_DIFF;
  const previousDiffMarker = process.env.VIGIL_TEST_DIFF_MARKER;
  process.env.GIT_EXTERNAL_DIFF = externalDiff;
  process.env.VIGIL_TEST_DIFF_MARKER = externalDiffMarker;
  try {
    assert.equal(await sourceFingerprint(root), fingerprintWithHarness,
      "environment-provided diff drivers must not influence the source identity");
    await assert.rejects(lstat(externalDiffMarker), { code: "ENOENT" },
      "the fingerprint must never execute an environment-provided external diff");
  } finally {
    if (previousExternalDiff === undefined) delete process.env.GIT_EXTERNAL_DIFF;
    else process.env.GIT_EXTERNAL_DIFF = previousExternalDiff;
    if (previousDiffMarker === undefined) delete process.env.VIGIL_TEST_DIFF_MARKER;
    else process.env.VIGIL_TEST_DIFF_MARKER = previousDiffMarker;
  }

  await verifyStalledGitProbeIsReaped(root);
} finally {
  await rm(root, { recursive: true, force: true });
}

async function verifyStalledGitProbeIsReaped(repoRoot: string): Promise<void> {
  const stalledGit = join(repoRoot, "stalled-git.sh");
  const stalledPids = join(repoRoot, "stalled-git.pids");
  await writeFile(stalledGit, [
    "#!/bin/sh",
    "if [ \"$1\" = \"--version\" ]; then",
    "  printf 'git version 2.0.0\\n'",
    "  exit 0",
    "fi",
    "printf '%s\\n' \"$$\" >> \"$VIGIL_TEST_GIT_PIDS\"",
    "exec /bin/sleep 60",
    ""
  ].join("\n"));
  await chmod(stalledGit, 0o755);
  const moduleUrl = new URL("../scripts/source-fingerprint.mjs", import.meta.url).href;
  const startedAt = Date.now();
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveChild, rejectChild) => {
    const child = spawn(process.execPath, [
      "--input-type=module",
      "--eval",
      `const { sourceFingerprint } = await import(${JSON.stringify(moduleUrl)}); process.stdout.write(JSON.stringify(await sourceFingerprint(process.argv[1], { gitTimeoutMs: 100 })));`,
      repoRoot
    ], {
      env: {
        ...process.env,
        VIGIL_GIT_EXECUTABLE: stalledGit,
        VIGIL_TEST_GIT_PIDS: stalledPids
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", rejectChild);
    child.once("close", (code) => resolveChild({ code, stdout, stderr }));
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout), null, "a stalled source identity probe must fail closed");
  assert.ok(Date.now() - startedAt < 4_000, "a stalled source identity probe must return within its bounded termination window");
  const pids = (await readFile(stalledPids, "utf8")).trim().split(/\s+/u).map(Number);
  assert.ok(pids.length >= 2, "both Git identity probes must be exercised");
  for (const pid of pids) {
    assert.equal(processExists(pid), false, "every timed-out source identity process group must be reaped");
  }
}

function processExists(pid: number): boolean {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
  }
}

async function git(args: string[]): Promise<void> {
  const command = await gitExecutable(root);
  await new Promise<void>((resolveGit, rejectGit) => {
    const child = spawn(command, args, { cwd: root, stdio: "ignore" });
    child.once("error", rejectGit);
    child.once("close", (code) => code === 0 ? resolveGit() : rejectGit(new Error(`git exited with status ${code}`)));
  });
}
