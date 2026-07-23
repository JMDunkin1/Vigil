import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDirectRun } from "../src/directRun.js";
import { acquireUpdaterLock } from "../app/updater.js";
import { setupSystemGuardian } from "../src/guardianSetup.js";
import { defaultUpdaterLockPath, waitForBootstrapWorkerAuthorization } from "../src/updateMaintenance.js";
import type { UpdateProtocolBootstrapResult } from "./bootstrap-update-protocol.mjs";
import { updateProtocolBridgePayloadModulePath } from "./package-update-protocol-bridge.mjs";

const DEFAULT_TARGET_APP_PATH = "/Applications/Vigil.app";
const LAUNCHER_RELATIVE_PATH = join("Contents", "MacOS", "Vigil");
const SETUP_SCRIPT_RELATIVE_PATH = join(
  "Contents", "Resources", "app.asar.unpacked", "dist", "runtime", "scripts", "setup-system-guardian.mjs"
);
const BOOTSTRAP_SCRIPT_RELATIVE_PATH = join(
  "Contents", "Resources", "app.asar.unpacked", "dist", "runtime", "scripts", "bootstrap-update-protocol.mjs"
);
const WORKER_HANDSHAKE_KIND = "vigil-bootstrap-worker-ready-v1";
const MAX_RELAY_OUTPUT_BYTES = 1024 * 1024;

export async function runSystemGuardianSetup(argv = process.argv.slice(2)): Promise<void> {
  const values = parseOptions(argv);
  if (values.get("bootstrap-worker-relay") === "true") {
    await runBootstrapWorkerRelay(values);
    return;
  }
  const uid = process.getuid?.();
  if (!Number.isInteger(uid) || Number(uid) < 501) {
    throw new Error("Open Vigil guardian setup from the signed-in macOS account, not as root.");
  }
  if (process.env.ELECTRON_RUN_AS_NODE !== "1") {
    throw new Error("Open guardian setup through Vigil's signed setup launcher.");
  }
  const account = userInfo();
  const sourceAppPath = await realpath(required(values, "source-app"));
  const targetAppPath = values.get("target-app") || DEFAULT_TARGET_APP_PATH;
  const bridgeRequested = values.get("bootstrap-update-protocol") === "true";
  const expectedUpdateCommit = bridgeRequested ? required(values, "expected-update-commit") : "";
  const bootstrapToken = bridgeRequested ? randomUUID() : "";
  const heldLock = bridgeRequested
    ? await acquireUpdaterLock(defaultUpdaterLockPath(account.homedir))
    : null;
  try {
    const result = await setupSystemGuardian({
      sourceAppPath,
      targetAppPath,
      targetHome: account.homedir,
      targetUid: Number(uid),
      targetUser: account.username,
      electronPath: process.execPath,
      protocolBootstrap: bridgeRequested ? { token: bootstrapToken, expectedUpdateCommit } : undefined
    });
    const bootstrap = result.ok && bridgeRequested
      ? await runBootstrapViaInstalledRelay({
        sourceAppPath,
        targetAppPath,
        targetHome: account.homedir,
        targetUid: Number(uid),
        targetUser: account.username,
        bootstrapToken,
        expectedUpdateCommit
      }, heldLock!)
      : null;
    process.stdout.write(`${JSON.stringify({ ...result, bootstrap })}\n`);
    if (!result.ok && !result.canceled) process.exitCode = 1;
  } finally {
    await heldLock?.release();
  }
}

interface BootstrapRelayRequest {
  sourceAppPath: string;
  targetAppPath: string;
  targetHome: string;
  targetUid: number;
  targetUser: string;
  bootstrapToken: string;
  expectedUpdateCommit: string;
}

interface TransferableUpdaterLock {
  path: string;
  token: string;
  transferTo(pid: number): Promise<void>;
}

async function runBootstrapViaInstalledRelay(
  request: BootstrapRelayRequest,
  lock: TransferableUpdaterLock
): Promise<UpdateProtocolBootstrapResult> {
  const relayExecutable = join(request.targetAppPath, LAUNCHER_RELATIVE_PATH);
  const relayScript = join(request.sourceAppPath, SETUP_SCRIPT_RELATIVE_PATH);
  const relay = spawn(relayExecutable, [
    relayScript,
    "--bootstrap-worker-relay", "true",
    "--source-app", request.sourceAppPath,
    "--target-app", request.targetAppPath,
    "--bootstrap-token", request.bootstrapToken,
    "--expected-update-commit", request.expectedUpdateCommit,
    "--lock-path", lock.path,
    "--lock-token", lock.token
  ], {
    cwd: request.sourceAppPath,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  let outputOverflow = false;
  let handshakeSettled = false;
  let resolveHandshake!: (pid: number) => void;
  let rejectHandshake!: (error: Error) => void;
  const handshake = new Promise<number>((resolvePid, rejectPid) => {
    resolveHandshake = resolvePid;
    rejectHandshake = rejectPid;
  });
  const inspectHandshake = (): void => {
    if (handshakeSettled) return;
    const firstLine = stdout.split("\n", 1)[0]?.trim();
    if (!firstLine) return;
    try {
      const payload = JSON.parse(firstLine) as { kind?: unknown; pid?: unknown };
      const pid = Number(payload.pid);
      if (payload.kind !== WORKER_HANDSHAKE_KIND || !Number.isSafeInteger(pid) || pid < 1) {
        throw new Error("Vigil's bootstrap relay returned an invalid worker identity.");
      }
      handshakeSettled = true;
      resolveHandshake(pid);
    } catch (error) {
      handshakeSettled = true;
      rejectHandshake(error instanceof Error ? error : new Error(String(error)));
    }
  };
  relay.stdout.setEncoding("utf8");
  relay.stderr.setEncoding("utf8");
  relay.stdout.on("data", (chunk) => {
    const next = boundedOutput(stdout, String(chunk));
    if (next === null) outputOverflow = true;
    else stdout = next;
    inspectHandshake();
  });
  relay.stderr.on("data", (chunk) => {
    const next = boundedOutput(stderr, String(chunk));
    if (next === null) outputOverflow = true;
    else stderr = next;
  });
  let spawnError: Error | null = null;
  relay.once("error", (error) => {
    spawnError = error;
    if (!handshakeSettled) {
      handshakeSettled = true;
      rejectHandshake(error);
    }
  });
  const completion = new Promise<number | null>((resolveClose) => {
    relay.once("close", (code) => {
      if (!handshakeSettled) {
        handshakeSettled = true;
        rejectHandshake(new Error(stderr.trim() || "Vigil's bootstrap relay exited before identifying its worker."));
      }
      resolveClose(code);
    });
  });

  let transferError: unknown = null;
  try {
    const workerPid = await handshake;
    if (!relay.pid) throw new Error("Vigil's bootstrap relay process identity is unavailable.");
    await waitForBootstrapWorkerAuthorization({
      bootstrapToken: request.bootstrapToken,
      lockPath: lock.path,
      lockToken: lock.token,
      sourceAppPath: request.sourceAppPath,
      targetAppPath: request.targetAppPath,
      expectedUpdateCommit: request.expectedUpdateCommit,
      workerPid,
      relayPid: relay.pid
    }, 30_000);
    await lock.transferTo(workerPid);
  } catch (error) {
    transferError = error;
  }
  const code = await completion;
  if (transferError) {
    throw new Error(`Vigil could not transfer its updater lock to the signed bootstrap worker: ${errorMessage(transferError)}`);
  }
  if (outputOverflow) {
    throw new Error("Vigil's bootstrap relay produced too much output.");
  }
  if (spawnError || code !== 0) {
    throw new Error(stderr.trim() || (spawnError as Error | null)?.message || `Vigil's bootstrap relay exited with status ${code}.`);
  }
  const lines = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  const resultLine = lines.at(-1);
  if (lines.length < 2 || !resultLine) {
    throw new Error("Vigil's bootstrap relay did not return a verified result.");
  }
  const result = JSON.parse(resultLine) as Partial<UpdateProtocolBootstrapResult>;
  if (result.ok !== true
    || !/^[a-f0-9]{40,64}$/u.test(String(result.sourceCdHash || ""))
    || !/^[a-f0-9]{40,64}$/u.test(String(result.previousCdHash || ""))
    || !/^[a-f0-9]{40}$/u.test(String(result.installedCommit || ""))
    || !/^[a-f0-9]{64}$/u.test(String(result.installedFingerprint || ""))
    || !Number.isSafeInteger(result.appPid)
    || !Number.isSafeInteger(result.supervisorPid)) {
    throw new Error("Vigil's bootstrap relay returned malformed verification evidence.");
  }
  return result as UpdateProtocolBootstrapResult;
}

async function runBootstrapWorkerRelay(values: Map<string, string>): Promise<void> {
  if (process.env.ELECTRON_RUN_AS_NODE !== "1") {
    throw new Error("Open Vigil's bootstrap relay through its signed installed launcher.");
  }
  const sourceAppPath = await realpath(required(values, "source-app"));
  const targetAppPath = await realpath(values.get("target-app") || DEFAULT_TARGET_APP_PATH);
  if (targetAppPath !== DEFAULT_TARGET_APP_PATH) {
    throw new Error("Vigil refused an unexpected installed-app bootstrap relay.");
  }
  const directScript = process.argv[1];
  if (!directScript) {
    throw new Error("Vigil refused a bootstrap relay without its direct signed wrapper.");
  }
  const [relayExecutable, relayWrapper, relayPayload, expectedPayload] = await Promise.all([
    realpath(process.execPath),
    realpath(directScript),
    realpath(fileURLToPath(import.meta.url)),
    updateProtocolBridgePayloadModulePath(sourceAppPath, "scripts/setup-system-guardian.mjs")
  ]);
  if (relayExecutable !== join(targetAppPath, LAUNCHER_RELATIVE_PATH)
    || relayWrapper !== join(sourceAppPath, SETUP_SCRIPT_RELATIVE_PATH)
    || relayPayload !== expectedPayload) {
    throw new Error("Vigil refused a bootstrap relay outside its exact installed and signed bridge bundles.");
  }
  const worker = spawn(join(sourceAppPath, LAUNCHER_RELATIVE_PATH), [
    join(sourceAppPath, BOOTSTRAP_SCRIPT_RELATIVE_PATH),
    "--source-app", sourceAppPath,
    "--target-app", targetAppPath,
    "--bootstrap-token", required(values, "bootstrap-token"),
    "--expected-update-commit", required(values, "expected-update-commit"),
    "--lock-path", required(values, "lock-path"),
    "--lock-token", required(values, "lock-token"),
    "--transferred-lock", "true"
  ], {
    cwd: sourceAppPath,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (!worker.pid) {
    throw new Error("Vigil's installed relay could not identify its signed bootstrap worker.");
  }
  process.stdout.write(`${JSON.stringify({ kind: WORKER_HANDSHAKE_KIND, pid: worker.pid })}\n`);
  const { code, stdout, stderr, spawnError, outputOverflow } = await captureChild(worker);
  if (outputOverflow) {
    throw new Error("Vigil's signed bootstrap worker produced too much output.");
  }
  if (spawnError || code !== 0) {
    throw new Error(stderr.trim() || spawnError?.message || `Vigil's signed bootstrap worker exited with status ${code}.`);
  }
  process.stdout.write(stdout.endsWith("\n") ? stdout : `${stdout}\n`);
}

async function captureChild(child: ReturnType<typeof spawn>): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
  spawnError: Error | null;
  outputOverflow: boolean;
}> {
  let stdout = "";
  let stderr = "";
  let spawnError: Error | null = null;
  let outputOverflow = false;
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => {
    const next = boundedOutput(stdout, String(chunk));
    if (next === null) outputOverflow = true;
    else stdout = next;
  });
  child.stderr?.on("data", (chunk) => {
    const next = boundedOutput(stderr, String(chunk));
    if (next === null) outputOverflow = true;
    else stderr = next;
  });
  child.once("error", (error) => { spawnError = error; });
  const code = await new Promise<number | null>((resolveClose) => child.once("close", resolveClose));
  return { code, stdout, stderr, spawnError, outputOverflow };
}

function boundedOutput(current: string, chunk: string): string | null {
  const next = current + chunk;
  if (Buffer.byteLength(next, "utf8") > MAX_RELAY_OUTPUT_BYTES) return null;
  return next;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "Unknown bootstrap relay error.");
}

function parseOptions(argv: string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = String(argv[index] || "");
    if (!argument.startsWith("--")) continue;
    const equals = argument.indexOf("=");
    if (equals >= 0) values.set(argument.slice(2, equals), argument.slice(equals + 1));
    else if (argument === "--bootstrap-update-protocol") values.set("bootstrap-update-protocol", "true");
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
