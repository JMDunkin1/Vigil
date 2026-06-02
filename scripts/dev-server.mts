import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const projectRoot = dirname(dirname(runtimeRoot));
let child: ChildProcess | null = null;

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await run("npm", ["run", "build"], { cwd: projectRoot });

child = spawn(process.execPath, [join(runtimeRoot, "src", "server.js")], {
  cwd: projectRoot,
  stdio: "inherit",
  env: process.env
});

const exitCode = await new Promise<number>((resolve) => {
  child?.once("exit", (code, signal) => resolve(signal ? 1 : code || 0));
});
child = null;
process.exit(exitCode);

function run(command: string, args: string[], options: { cwd: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    const running = spawn(command, args, {
      cwd: options.cwd,
      stdio: "inherit",
      env: process.env
    });
    running.once("exit", (code, signal) => {
      if (signal || code) {
        reject(new Error(`${command} ${args.join(" ")} exited with ${signal || code}`));
      } else {
        resolve();
      }
    });
  });
}

function shutdown(): void {
  if (child) child.kill("SIGTERM");
}
