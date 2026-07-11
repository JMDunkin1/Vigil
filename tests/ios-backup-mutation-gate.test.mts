import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const workingRoot = process.cwd();
const root = existsSync(join(workingRoot, "scripts", "apply-ios-usb-profile.mjs"))
  ? workingRoot
  : resolve(workingRoot, "..", "..");
const workspace = await mkdtemp(join(tmpdir(), "vigil-ios-mutation-gate-"));
const udid = "00008150-000954C63628401C";
const backupPath = join(workspace, "checkpoint", udid);
const keybagPath = join(workspace, "supervisor.keybag");
const pymobiledevice3Path = join(workspace, "fake-pymobiledevice3.mjs");
const pythonPath = join(workspace, "fake-python.mjs");
const commandLogPath = join(workspace, "ios-commands.jsonl");
const validationLogPath = join(workspace, "payload-validations.jsonl");

try {
  await createCompleteBackup(backupPath);
  await writeFile(keybagPath, "fixture keybag\n");
  await writeExecutable(pymobiledevice3Path, fakePymobiledevice3Source());
  await writeExecutable(pythonPath, fakePythonSource());

  const env = {
    ...process.env,
    IOS_COMMAND_LOG: commandLogPath,
    IOS_VALIDATION_LOG: validationLogPath,
    PYMOBILEDEVICE3: pymobiledevice3Path,
    PYIOSBACKUP_PYTHON: pythonPath,
    VIGIL_DATA_DIR: join(workspace, "data")
  };

  await resetLogs();
  await expectDeepValidationFailure(join(root, "scripts", "apply-ios-usb-profile.mjs"), [
    "--udid", udid,
    "--require-checkpoint", backupPath,
    "--password", "recovery-pass",
    "--supervisor-keybag", keybagPath
  ], env);
  assert.deepEqual(
    await readJsonLines(commandLogPath),
    [["usbmux", "list", "--usb"]],
    "USB profile apply must stop at failed checkpoint traversal before pairing or profile commands"
  );
  assert.deepEqual(await readJsonLines(validationLogPath), [{ backupPath, password: "recovery-pass" }]);

  await resetLogs();
  await expectDeepValidationFailure(join(root, "scripts", "restore-ios-home-layout.mjs"), [
    "--udid", udid,
    "--backup", backupPath,
    "--password", "recovery-pass",
    "--supervisor-keybag", keybagPath,
    "--yes-restore-layout"
  ], env);
  assert.deepEqual(
    await readJsonLines(commandLogPath),
    [["usbmux", "list", "--usb"]],
    "layout restore must stop at failed pruned-payload traversal before pairing or backup2 restore"
  );
  const restoreValidations = await readJsonLines(validationLogPath) as Array<{ backupPath: string; password: string }>;
  assert.equal(restoreValidations.length, 1);
  assert.equal(restoreValidations[0]?.password, "recovery-pass");
  assert.equal(basename(restoreValidations[0]?.backupPath || ""), udid);
  assert.match(restoreValidations[0]?.backupPath || "", /ios-home-layout-restore/u);
  assert.notEqual(restoreValidations[0]?.backupPath, backupPath, "restore must validate the newly pruned payload, not only its source checkpoint");
} finally {
  await rm(workspace, { recursive: true, force: true });
}

async function expectDeepValidationFailure(script: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  await assert.rejects(
    () => execFileAsync(process.execPath, [script, ...args], {
      env,
      maxBuffer: 1024 * 1024,
      timeout: 20_000
    }),
    (error: unknown) => {
      const stderr = typeof error === "object" && error && "stderr" in error
        ? String(error.stderr)
        : String(error);
      assert.match(stderr, /Deep iPhone backup payload validation failed/u);
      assert.match(stderr, /fixture rejected payload traversal/u);
      return true;
    }
  );
}

async function resetLogs(): Promise<void> {
  await writeFile(commandLogPath, "");
  await writeFile(validationLogPath, "");
}

async function readJsonLines(path: string): Promise<unknown[]> {
  const content = await readFile(path, "utf8");
  return content.trim() ? content.trim().split("\n").map((line) => JSON.parse(line)) : [];
}

async function createCompleteBackup(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "Info.plist"), plist({ "Unique Identifier": udid }));
  await writeFile(join(path, "Manifest.plist"), plist({ Version: "9.1" }));
  await writeFile(join(path, "Manifest.db"), "fixture manifest\n");
  await writeFile(join(path, "Status.plist"), plist({
    Date: "2026-07-10T12:00:00Z",
    SnapshotState: "finished"
  }));
}

function plist(values: Record<string, string>): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    ...Object.entries(values).flatMap(([key, value]) => [
      `<key>${escapeXml(key)}</key>`,
      `<string>${escapeXml(value)}</string>`
    ]),
    "</dict>",
    "</plist>",
    ""
  ].join("\n");
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

async function writeExecutable(path: string, source: string): Promise<void> {
  await writeFile(path, source);
  await chmod(path, 0o755);
}

function fakePymobiledevice3Source(): string {
  return [
    "#!/usr/bin/env node",
    'import { appendFileSync } from "node:fs";',
    "const args = process.argv.slice(2);",
    'appendFileSync(process.env.IOS_COMMAND_LOG, JSON.stringify(args) + "\\n");',
    'if (args.join(" ") === "usbmux list --usb") {',
    `  process.stdout.write(${JSON.stringify(JSON.stringify([{ Identifier: udid, DeviceName: "Fixture iPhone" }]))});`,
    "} else {",
    '  process.stdout.write("{}");',
    "}",
    ""
  ].join("\n");
}

function fakePythonSource(): string {
  return [
    "#!/usr/bin/env node",
    'import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    'const code = process.argv[3] || "";',
    'if (code.includes("issue_counts = {")) {',
    '  appendFileSync(process.env.IOS_VALIDATION_LOG, JSON.stringify({',
    "    backupPath: process.argv[4],",
    '    password: process.env.PYIOSBACKUP_PASSWORD || ""',
    '  }) + "\\n");',
    '  process.stderr.write("fixture rejected payload traversal\\n");',
    "  process.exit(42);",
    "}",
    'if (code.includes("prune_backup_directory")) {',
    "  const payloadBackup = process.argv[5];",
    '  const fileId = "a".repeat(40);',
    "  mkdirSync(join(payloadBackup, fileId.slice(0, 2)), { recursive: true });",
    '  writeFileSync(join(payloadBackup, fileId.slice(0, 2), fileId), "layout");',
    '  process.stdout.write(JSON.stringify({ entries: ["HomeDomain/Library/SpringBoard/IconState.plist"], files: ["HomeDomain/Library/SpringBoard/IconState.plist"] }));',
    "  process.exit(0);",
    "}",
    'process.stdout.write(JSON.stringify(["HomeDomain/Library/SpringBoard/IconState.plist"]));',
    ""
  ].join("\n");
}
