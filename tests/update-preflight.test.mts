import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  collectUpdatePreflight,
  firstUpdatePreflightFailure,
  updatePreflightFailureMessage
} from "../src/updatePreflight.js";

const sourceRoot = existsSync(join(process.cwd(), "app", "updater.ts"))
  ? process.cwd()
  : resolve(process.cwd(), "..", "..");

const completed: string[] = [];
const report = await collectUpdatePreflight([
  {
    code: "vigil.update.repository.verified",
    label: "Repository",
    async run() {
      await Promise.resolve();
      completed.push("repository");
      return { message: "Repository passed." };
    }
  },
  {
    code: "vigil.update.tool.node",
    label: "Node.js",
    run() {
      completed.push("node");
      return {
        status: "fail",
        message: "Node.js was not found.",
        detail: "Install Node.js before updating."
      };
    }
  },
  {
    code: "vigil.update.updater.syntax",
    label: "Updater syntax",
    run() {
      completed.push("syntax");
      return {
        status: "blocked",
        message: "Updater syntax could not be checked.",
        detail: "The Node.js prerequisite failed."
      };
    }
  },
  {
    code: "vigil.update.app.signature",
    label: "App signature",
    run() {
      completed.push("signature");
      throw Object.assign(new Error("Signature verification exited 1."), {
        stderr: "The installed app has an unsupported signing identity."
      });
    }
  }
], new Date("2026-07-25T00:00:00.000Z"));

assert.equal(report.ok, false);
assert.equal(report.checkedAt, "2026-07-25T00:00:00.000Z");
assert.deepEqual(
  completed.sort(),
  ["node", "repository", "signature", "syntax"],
  "all independent checks must run even when earlier checks fail"
);
assert.deepEqual(
  report.checks.map((check) => check.code),
  [
    "vigil.update.repository.verified",
    "vigil.update.tool.node",
    "vigil.update.updater.syntax",
    "vigil.update.app.signature"
  ],
  "parallel collection must preserve the stable definition order"
);
assert.deepEqual(
  report.failures.map((check) => check.status),
  ["fail", "blocked", "fail"],
  "the report must retain every blocker rather than flattening to one generic failure"
);
assert.equal(firstUpdatePreflightFailure(report)?.code, "vigil.update.tool.node");
assert.equal(
  updatePreflightFailureMessage(report.failures[0]!),
  "Node.js was not found. Install Node.js before updating."
);
assert.match(
  report.failures[2]?.detail || "",
  /Signature verification exited 1.*unsupported signing identity/u,
  "a thrown check must retain its exact command diagnostic"
);

await assert.rejects(
  collectUpdatePreflight([
    {
      code: "vigil.update.repository.verified",
      label: "Repository one",
      run: () => ({})
    },
    {
      code: "vigil.update.repository.verified",
      label: "Repository two",
      run: () => ({})
    }
  ]),
  /Duplicate Vigil update preflight check code/u
);
await assert.rejects(
  collectUpdatePreflight([{
    code: "repository",
    label: "Invalid code",
    run: () => ({})
  }]),
  /Invalid Vigil update preflight check code/u
);

const updaterSource = await readFile(join(sourceRoot, "app", "updater.ts"), "utf8");
const remoteRefreshIndex = updaterSource.indexOf(
  "readStatusPayload({ checkRemote: true, ownedLockToken: updateLock.token })"
);
const preflightIndex = updaterSource.indexOf("await collectSourceUpdatePreflight({");
const setupBranchIndex = updaterSource.indexOf("if (setupOnlyRequired)");
const guardianPromptIndex = updaterSource.indexOf("await setupGuardian({");
const setupCompletionIndex = updaterSource.indexOf("setupComplete: true", guardianPromptIndex);
const repositoryGateIndex = updaterSource.indexOf("if (currentStatus.checkOk !== true)", setupCompletionIndex);
const receiptIndex = updaterSource.indexOf(
  "await prepareRemoteUpdateReceipt(statusPath, updateLock.token, currentStatus)",
  preflightIndex
);
assert.ok(
  setupBranchIndex >= 0
    && guardianPromptIndex > setupBranchIndex
    && setupCompletionIndex > guardianPromptIndex
    && repositoryGateIndex > setupCompletionIndex
    && remoteRefreshIndex > repositoryGateIndex
    && preflightIndex > remoteRefreshIndex
    && receiptIndex > preflightIndex,
  "guardian migration must finish as a separate action, while update refresh and preflight still precede the receipt boundary"
);
assert.equal(
  (updaterSource.match(/await setupGuardian\(\{/gu) || []).length,
  1,
  "one update attempt must have exactly one administrator-prompt call site"
);
assert.match(
  updaterSource.slice(setupBranchIndex, setupCompletionIndex),
  /requireNormalUpdateCompatibility: true/u,
  "guardian setup must reject an incompatible foreground parent command during read-only preflight, before requesting a password"
);
assert.doesNotMatch(
  updaterSource.slice(repositoryGateIndex, receiptIndex),
  /await setupGuardian\(\{/u,
  "the source update path must never enter or loop back into an administrator prompt"
);
