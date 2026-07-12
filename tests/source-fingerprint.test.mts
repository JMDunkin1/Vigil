import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  assert.notEqual(await sourceFingerprint(root), untracked, "untracked file contents must affect the source fingerprint");
} finally {
  await rm(root, { recursive: true, force: true });
}

async function git(args: string[]): Promise<void> {
  await new Promise<void>((resolveGit, rejectGit) => {
    const child = spawn("git", args, { cwd: root, stdio: "ignore" });
    child.once("error", rejectGit);
    child.once("close", (code) => code === 0 ? resolveGit() : rejectGit(new Error(`git exited with status ${code}`)));
  });
}
