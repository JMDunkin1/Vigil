import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

export const EMBEDDED_SUPERVISOR_LABEL = "tech.caseline.vigil.supervisor";

const execFileAsync = promisify(execFile);
const SUPERVISOR_START_TIMEOUT_MS = 5_000;
const SUPERVISOR_POLL_INTERVAL_MS = 100;

export async function resumeEmbeddedRuntimeSupervisor(userDataDir: string): Promise<void> {
  const uid = process.getuid?.();
  const home = process.env.HOME;
  if (uid === undefined || !home) throw new Error("Vigil could not identify the current user to restore restart supervision.");

  const supervisorDir = join(userDataDir, "supervisor");
  await mkdir(supervisorDir, { recursive: true });
  await writeFile(join(supervisorDir, "enabled"), "enabled\n", { mode: 0o600 });
  const plistPath = join(home, "Library", "LaunchAgents", `${EMBEDDED_SUPERVISOR_LABEL}.plist`);
  await execFileAsync("/bin/launchctl", ["enable", `gui/${uid}/${EMBEDDED_SUPERVISOR_LABEL}`], { timeout: 5_000 });
  if (!(await launchctlServiceLoaded(uid))) {
    await execFileAsync("/bin/launchctl", ["bootstrap", `gui/${uid}`, plistPath], { timeout: 5_000 });
  }
  await execFileAsync("/bin/launchctl", ["kickstart", "-k", `gui/${uid}/${EMBEDDED_SUPERVISOR_LABEL}`], { timeout: 5_000 });
  await waitForLaunchctlServiceRunning(uid);
}

export async function suspendEmbeddedRuntimeSupervisor(userDataDir: string): Promise<void> {
  const uid = process.getuid?.();
  const home = process.env.HOME;
  if (uid === undefined || !home) throw new Error("Vigil could not identify the current user to suspend restart supervision.");

  await rm(join(userDataDir, "supervisor", "enabled"), { force: true });
  const plistPath = join(home, "Library", "LaunchAgents", `${EMBEDDED_SUPERVISOR_LABEL}.plist`);
  for (const args of [
    ["bootout", `gui/${uid}/${EMBEDDED_SUPERVISOR_LABEL}`],
    ["bootout", `gui/${uid}`, plistPath]
  ]) {
    try {
      await execFileAsync("/bin/launchctl", args, { timeout: 5_000 });
    } catch {
      // Missing or already stopped supervisors are an expected recovery state.
    }
  }

  try {
    await execFileAsync("/bin/launchctl", ["print", `gui/${uid}/${EMBEDDED_SUPERVISOR_LABEL}`], { timeout: 5_000 });
  } catch (error) {
    if (launchctlServiceMissing(error)) return;
    throw new Error(`Vigil could not verify that restart supervision stopped: ${commandErrorText(error)}`);
  }
  throw new Error("Vigil's restart supervisor remained loaded, so rollback was stopped before replacing the app.");
}

function launchctlServiceMissing(error: unknown): boolean {
  return /could not find service|service not found|no such process/iu.test(commandErrorText(error));
}

async function launchctlServiceLoaded(uid: number): Promise<boolean> {
  try {
    await execFileAsync("/bin/launchctl", ["print", `gui/${uid}/${EMBEDDED_SUPERVISOR_LABEL}`], { timeout: 5_000 });
    return true;
  } catch (error) {
    if (launchctlServiceMissing(error)) return false;
    throw error;
  }
}

async function waitForLaunchctlServiceRunning(uid: number): Promise<void> {
  const deadline = Date.now() + SUPERVISOR_START_TIMEOUT_MS;
  let observedPid: number | null = null;
  do {
    const pid = await launchctlServiceRunningPid(uid);
    if (pid !== null && pid === observedPid) return;
    observedPid = pid;
    if (Date.now() >= deadline) break;
    await new Promise<void>((resolve) => setTimeout(resolve, SUPERVISOR_POLL_INTERVAL_MS));
  } while (Date.now() < deadline);
  throw new Error("Vigil could not verify that its restored restart supervisor has a running process.");
}

async function launchctlServiceRunningPid(uid: number): Promise<number | null> {
  try {
    const result = await execFileAsync(
      "/bin/launchctl",
      ["print", `gui/${uid}/${EMBEDDED_SUPERVISOR_LABEL}`],
      { timeout: 5_000 }
    );
    const output = String(result.stdout || "");
    if (!/^\s*state = running\s*$/mu.test(output)) return null;
    const pid = Number(output.match(/^\s*pid = ([0-9]+)\s*$/mu)?.[1] || 0);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch (error) {
    if (launchctlServiceMissing(error)) return null;
    throw error;
  }
}

function commandErrorText(error: unknown): string {
  if (!error || typeof error !== "object") return String(error || "Unknown launchctl error.");
  const record = error as { message?: unknown; stderr?: unknown };
  return `${String(record.stderr || "")}\n${String(record.message || "")}`.trim() || "Unknown launchctl error.";
}
