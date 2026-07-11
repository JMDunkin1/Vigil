import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function isDirectRun(moduleUrl: string, executablePath: string | undefined = process.argv[1]): boolean {
  if (!executablePath) return false;
  const modulePath = fileURLToPath(moduleUrl);
  const resolvedExecutable = resolve(executablePath);
  try {
    return realpathSync(modulePath) === realpathSync(resolvedExecutable);
  } catch {
    return modulePath === resolvedExecutable;
  }
}
