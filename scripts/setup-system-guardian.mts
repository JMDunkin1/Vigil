import { realpath } from "node:fs/promises";
import { userInfo } from "node:os";
import { isDirectRun } from "../src/directRun.js";
import { setupSystemGuardian } from "../src/guardianSetup.js";

export async function runSystemGuardianSetup(argv = process.argv.slice(2)): Promise<void> {
  const values = parseOptions(argv);
  const uid = process.getuid?.();
  if (!Number.isInteger(uid) || Number(uid) < 501) {
    throw new Error("Open Vigil guardian setup from the signed-in macOS account, not as root.");
  }
  if (process.env.ELECTRON_RUN_AS_NODE !== "1") {
    throw new Error("Open guardian setup through Vigil's signed setup launcher.");
  }
  const account = userInfo();
  const sourceAppPath = await realpath(required(values, "source-app"));
  const targetAppPath = values.get("target-app") || "/Applications/Vigil.app";
  const result = await setupSystemGuardian({
    sourceAppPath,
    targetAppPath,
    targetHome: account.homedir,
    targetUid: Number(uid),
    targetUser: account.username,
    electronPath: process.execPath
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok && !result.canceled) process.exitCode = 1;
}

function parseOptions(argv: string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = String(argv[index] || "");
    if (!argument.startsWith("--")) continue;
    const equals = argument.indexOf("=");
    if (equals >= 0) values.set(argument.slice(2, equals), argument.slice(equals + 1));
    else values.set(argument.slice(2), String(argv[index + 1] || ""));
  }
  return values;
}

function required(values: Map<string, string>, name: string): string {
  const value = values.get(name);
  if (!value) throw new Error(`Missing --${name}`);
  return value;
}

if (isDirectRun(import.meta.url)) {
  try {
    await runSystemGuardianSetup();
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      canceled: false,
      error: error instanceof Error ? error.message : String(error)
    })}\n`);
    process.exitCode = 1;
  }
}
