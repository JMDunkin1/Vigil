import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function createLocalScriptRunner({ root, launchAgentStatus, processObject = process }) {
  async function runLocalScript(name) {
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
      error.message = String(error.stderr || error.message || error).trim();
      throw error;
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
      error.message = String(error.stderr || error.message || error).trim();
      throw error;
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

  function localScriptCommand(name, options = {}) {
    if (!isElectronRuntime()) {
      const command = options.npmScript ? `npm run ${options.npmScript}` : `${shellQuote(processObject.execPath)} ${shellQuote(join(root, "scripts", name))}`;
      return `cd ${shellQuote(root)} && ${command}`;
    }

    const command = `${localScriptShellEnvPrefix()}${shellQuote(processObject.execPath)} ${shellQuote(resourcePath("scripts", name))}`;
    return `${options.privileged ? "sudo " : ""}${command}`;
  }

  function localScriptEnv() {
    return {
      ...processObject.env,
      ...localScriptEnvOverrides()
    };
  }

  function localScriptEnvOverrides() {
    const overrides = {};
    if (isElectronRuntime()) overrides.ELECTRON_RUN_AS_NODE = "1";
    if (processObject.env.VIGIL_DATA_DIR) overrides.VIGIL_DATA_DIR = processObject.env.VIGIL_DATA_DIR;
    if (processObject.env.VIGIL_PORT) overrides.VIGIL_PORT = processObject.env.VIGIL_PORT;
    if (processObject.env.VIGIL_PORT) overrides.VIGIL_PORT = processObject.env.VIGIL_PORT;
    return overrides;
  }

  function localScriptShellEnvPrefix() {
    const entries = Object.entries(localScriptEnvOverrides());
    return entries.length ? `${entries.map(([key, value]) => `${key}=${shellQuote(value)}`).join(" ")} ` : "";
  }

  function processCwd() {
    return root.includes(".asar") ? dirname(root) : root;
  }

  function resourcePath(...parts) {
    const resourceRoot = root.includes(".asar")
      ? root.replace(/\.asar(?=\/|$)/, ".asar.unpacked")
      : root;
    return join(resourceRoot, ...parts);
  }

  function isElectronRuntime() {
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

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

export function appleScriptString(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
