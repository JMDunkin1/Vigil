import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface LocalScriptRunnerOptions {
  root: string;
  launchAgentStatus: () => Promise<{ running?: boolean }>;
  processObject?: NodeJS.Process;
}

interface LocalScriptCommandOptions {
  privileged?: boolean;
  npmScript?: string;
}

export function createLocalScriptRunner({ root, launchAgentStatus, processObject = process }: LocalScriptRunnerOptions) {
  async function runLocalScript(name: string) {
    const scriptPath = resourcePath("scripts", name);
    try {
      const { stdout, stderr } = await execFileAsync(processObject.execPath, [scriptPath], {
        cwd: processCwd(),
        env: localScriptEnv(),
        timeout: 15_000,
        maxBuffer: 1024 * 256
      });
      return { stdout: stdout.trim(), stderr: stderr.trim() };
    } catch (error) {
      throw normalizeExecError(error);
    }
  }

  async function runPrivilegedHostsApply() {
    const scriptPath = resourcePath("scripts", "apply-hosts.mjs");
    const command = `cd ${shellQuote(processCwd())} && ${localScriptShellEnvPrefix()}${shellQuote(processObject.execPath)} ${shellQuote(scriptPath)}`;
    const script = `do shell script ${appleScriptString(command)} with administrator privileges`;
    try {
      const { stdout, stderr } = await execFileAsync("/usr/bin/osascript", ["-e", script], {
        cwd: processCwd(),
        timeout: 120_000,
        maxBuffer: 1024 * 256
      });
      return { stdout: stdout.trim(), stderr: stderr.trim() };
    } catch (error) {
      throw normalizeExecError(error);
    }
  }

  async function waitForLaunchAgentRunning() {
    let latest = await launchAgentStatus();
    for (let attempt = 0; attempt < 10 && !latest.running; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      latest = await launchAgentStatus();
    }
    return latest;
  }

  function localScriptCommand(name: string, options: LocalScriptCommandOptions = {}): string {
    if (!isElectronRuntime()) {
      const command = options.npmScript ? `npm run ${options.npmScript}` : `${shellQuote(processObject.execPath)} ${shellQuote(join(root, "scripts", name))}`;
      return `cd ${shellQuote(root)} && ${command}`;
    }

    const command = `${localScriptShellEnvPrefix()}${shellQuote(processObject.execPath)} ${shellQuote(resourcePath("scripts", name))}`;
    return `${options.privileged ? "sudo " : ""}${command}`;
  }

  function localScriptEnv(): NodeJS.ProcessEnv {
    return {
      ...processObject.env,
      ...localScriptEnvOverrides()
    };
  }

  function localScriptEnvOverrides(): Record<string, string> {
    const overrides: Record<string, string> = {};
    if (isElectronRuntime()) overrides.ELECTRON_RUN_AS_NODE = "1";
    if (processObject.env.VIGIL_DATA_DIR) overrides.VIGIL_DATA_DIR = processObject.env.VIGIL_DATA_DIR;
    if (processObject.env.VIGIL_PORT) overrides.VIGIL_PORT = processObject.env.VIGIL_PORT;
    return overrides;
  }

  function localScriptShellEnvPrefix(): string {
    const entries = Object.entries(localScriptEnvOverrides());
    return entries.length ? `${entries.map(([key, value]) => `${key}=${shellQuote(value)}`).join(" ")} ` : "";
  }

  function processCwd(): string {
    return root.includes(".asar") ? dirname(root) : root;
  }

  function resourcePath(...parts: string[]): string {
    const resourceRoot = root.includes(".asar")
      ? root.replace(/\.asar(?=\/|$)/, ".asar.unpacked")
      : root;
    return join(resourceRoot, ...parts);
  }

  function isElectronRuntime(): boolean {
    return Boolean(processObject.versions.electron);
  }

  return {
    localScriptCommand,
    resourcePath,
    runLocalScript,
    runPrivilegedHostsApply,
    waitForLaunchAgentRunning
  };
}

export function shellQuote(value: unknown): string {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

export function appleScriptString(value: unknown): string {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function normalizeExecError(error: unknown): Error {
  const record = typeof error === "object" && error !== null ? error as { stderr?: unknown; message?: unknown } : {};
  const message = String(record.stderr || record.message || error || "").trim();
  if (error instanceof Error) {
    error.message = message;
    return error;
  }
  return new Error(message);
}
