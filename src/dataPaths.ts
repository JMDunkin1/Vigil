import { basename, dirname, join, resolve } from "node:path";
import { plistStringForKey } from "./plist.js";

export interface LaunchAgentDataDirSelection {
  dataDir: string;
  source: "environment" | "working-directory" | "missing";
  workingDirectory: string;
}

export function resolveDefaultDataDir(runtimeRoot: string): string {
  const parent = dirname(runtimeRoot);
  const generatedRuntime = basename(runtimeRoot) === "runtime"
    && ["dist", "dist.nosync"].includes(basename(parent))
    && !runtimeRoot.includes(".asar");
  const projectRoot = generatedRuntime
    ? dirname(parent)
    : runtimeRoot;
  return join(projectRoot, "data");
}

export function launchAgentDataDirFromPlist(plist: string): LaunchAgentDataDirSelection {
  const explicit = plistStringForKey(plist, "VIGIL_DATA_DIR");
  const workingDirectory = plistStringForKey(plist, "WorkingDirectory");
  if (explicit) return { dataDir: explicit, source: "environment", workingDirectory };
  if (workingDirectory) {
    return {
      dataDir: resolveDefaultDataDir(workingDirectory),
      source: "working-directory",
      workingDirectory
    };
  }
  return { dataDir: "", source: "missing", workingDirectory: "" };
}

export function launchAgentDataRootsConflict(
  existingDataDir: string,
  currentDataDir: string,
  existingHasState: boolean,
  currentHasState: boolean
): boolean {
  return Boolean(
    existingDataDir
    && currentDataDir
    && resolve(existingDataDir) !== resolve(currentDataDir)
    && existingHasState
    && currentHasState
  );
}
