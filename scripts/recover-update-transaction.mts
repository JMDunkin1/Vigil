import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readUpdateRecoveryPolicyFile,
  recoverUpdateTransaction
} from "../src/updateTransaction.js";
import type {
  UpdateRecoveryOperations
} from "../src/updateTransaction.js";

export async function runUpdateRecoveryCli(args: readonly string[]): Promise<number> {
  const liveRuntime = args[2] === "--live-runtime";
  if (args[0] !== "--policy-file"
    || (args.length !== 2 && !(args.length === 3 && liveRuntime))
    || !args[1]) {
    throw new Error("The Vigil recovery policy invocation is invalid.");
  }
  const loaded = await readUpdateRecoveryPolicyFile(exactPath(args[1], "policy file"));
  const outcome = await recoverUpdateTransaction(loaded.policy, {
    operations: { swapPaths: swapWithHelper(loaded.record.recoveryRuntime.helperPath) },
    allowRollback: !liveRuntime
  });
  return writeOutcome(outcome);
}

function writeOutcome(outcome: Awaited<ReturnType<typeof recoverUpdateTransaction>>): number {
  if (!outcome) {
    process.stdout.write("No interrupted Vigil update transaction requires recovery.\n");
    return 0;
  }
  process.stdout.write(`${JSON.stringify(outcome)}\n`);
  return outcome.status === "recovery-failed" ? 1 : 0;
}

function swapWithHelper(helperPath: string): UpdateRecoveryOperations["swapPaths"] {
  return async (left, right) => {
    const helper = await lstat(helperPath);
    if (!helper.isFile() || helper.isSymbolicLink() || (helper.mode & 0o111) === 0) {
      throw new Error("The stable Vigil update recovery swap helper is missing or unsafe.");
    }
    await new Promise<void>((resolveSwap, rejectSwap) => {
      const child = spawn(helperPath, [left, right], { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.once("error", rejectSwap);
      child.once("close", (code) => {
        if (code === 0) resolveSwap();
        else rejectSwap(new Error(stderr.trim() || `The stable Vigil swap helper exited with status ${code}.`));
      });
    });
  };
}

function exactPath(value: string, label: string): string {
  if (!isAbsolute(value) || resolve(value) !== value || value.includes("\u0000")) {
    throw new Error(`The Vigil update recovery ${label} must be an exact absolute path.`);
  }
  return value;
}

async function isDirectRecoveryRun(argvPath: string | undefined): Promise<boolean> {
  if (!argvPath) return false;
  try {
    return await realpath(resolve(argvPath)) === await realpath(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (await isDirectRecoveryRun(process.argv[1])) {
  try {
    process.exitCode = await runUpdateRecoveryCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
