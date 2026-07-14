import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { loadState, saveState } from "../src/store.js";
import {
  MANAGEENGINE_IOS_PROFILE_IDENTIFIER,
  defaultManageEngineOutputPath,
  defaultManageEngineSummaryPath,
  exportManageEngineIosProfile
} from "../src/manageEngineExport.js";
import type { ManageEngineDeploymentObservation } from "../src/manageEngineExport.js";

const VALUE_OPTIONS = new Set(["deployment-observation", "launcher-deployment-observation", "out", "summary"]);
const BOOLEAN_OPTIONS = new Set([
  "allow-profile-install",
  "current-state",
  "disabled",
  "enable",
  "enrollment-window",
  "no-harden-removal"
]);
const KNOWN_OPTIONS = new Set([...VALUE_OPTIONS, ...BOOLEAN_OPTIONS]);
const KNOWN_OPTION_HELP = [...KNOWN_OPTIONS].map((option) => `--${option}`).sort().join(", ");

const args = parseArgs(process.argv.slice(2));
const enrollmentWindow = Boolean(args["enrollment-window"]);
const savedState = await loadState();
const outPath = resolve(String(args.out || defaultManageEngineOutputPath(enrollmentWindow)));
const summaryPath = resolve(String(args.summary || defaultManageEngineSummaryPath(outPath)));
const deploymentObservation = args["deployment-observation"]
  ? await loadDeploymentObservation(resolve(String(args["deployment-observation"])))
  : undefined;
const launcherDeploymentObservation = args["launcher-deployment-observation"]
  ? await loadDeploymentObservation(resolve(String(args["launcher-deployment-observation"])))
  : undefined;
const result = await exportManageEngineIosProfile(savedState, {
  allowProfileInstall: Boolean(args["allow-profile-install"]),
  currentState: Boolean(args["current-state"]),
  deploymentObservation,
  disabled: Boolean(args.disabled),
  enable: Boolean(args.enable),
  enrollmentWindow,
  launcherDeploymentObservation,
  noHardenRemoval: Boolean(args["no-harden-removal"]),
  outPath,
  saveState,
  summaryPath
});

console.log([
  `Wrote ManageEngine iOS profile: ${result.outPath}`,
  `Wrote stable social launcher profile: ${result.launcherOutPath}`,
  ...(result.mirroredOutPath ? [`Mirrored handoff profile: ${result.mirroredOutPath}`] : []),
  `Summary: ${result.summaryPath}`,
  `Launcher summary: ${result.launcherSummaryPath}`,
  `Immutable generation: ${result.generationPath}`,
  `Generation manifest: ${result.generationManifestPath}`,
  ...(result.mirroredSummaryPath ? [`Mirrored handoff summary: ${result.mirroredSummaryPath}`] : []),
  ...(result.mirroredLauncherOutPath ? [`Mirrored launcher profile: ${result.mirroredLauncherOutPath}`] : []),
  ...(result.mirroredLauncherSummaryPath ? [`Mirrored launcher summary: ${result.mirroredLauncherSummaryPath}`] : []),
  `Identifier: ${MANAGEENGINE_IOS_PROFILE_IDENTIFIER}`,
  `Mode: ${result.mode}`,
  `State saved: ${result.stateSaved ? "yes" : "no"}`
].join("\n"));

function parseArgs(values: string[]): Record<string, string | boolean> {
  const parsed: Record<string, string | boolean> = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index] || "";
    if (!value.startsWith("--")) continue;
    const token = value.slice(2);
    const separatorIndex = token.indexOf("=");
    const name = separatorIndex === -1 ? token : token.slice(0, separatorIndex);
    const inline = separatorIndex === -1 ? undefined : token.slice(separatorIndex + 1);
    if (!KNOWN_OPTIONS.has(name)) {
      throw new Error(`Unknown option: --${name}. Known options: ${KNOWN_OPTION_HELP}`);
    }

    if (VALUE_OPTIONS.has(name)) {
      let optionValue = inline;
      if (optionValue === undefined) {
        const nextValue = values[index + 1];
        if (!nextValue || nextValue.startsWith("--")) {
          throw new Error(`Missing value for --${name}.`);
        }
        optionValue = nextValue;
        index += 1;
      }
      if (optionValue === "") {
        throw new Error(`Missing value for --${name}.`);
      }
      parsed[name] = optionValue;
    } else if (inline !== undefined) {
      throw new Error(`Option --${name} does not take a value.`);
    } else {
      parsed[name] = true;
    }
  }
  return parsed;
}

async function loadDeploymentObservation(path: string): Promise<ManageEngineDeploymentObservation> {
  const value = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Deployment observation must be a JSON object: ${path}`);
  }
  const record = value as Record<string, unknown>;
  for (const key of ["effectiveProhibitAppInstall", "effectiveProhibitAppDelete"] as const) {
    if (record[key] !== undefined && typeof record[key] !== "boolean") {
      throw new Error(`Deployment observation ${key} must be a boolean.`);
    }
  }
  for (const key of ["observedAt", "installedProfileIdentifier", "installedProfileHash"] as const) {
    if (record[key] !== undefined && typeof record[key] !== "string") {
      throw new Error(`Deployment observation ${key} must be a string.`);
    }
  }
  return {
    observedAt: record.observedAt as string | undefined,
    installedProfileIdentifier: record.installedProfileIdentifier as string | undefined,
    installedProfileHash: record.installedProfileHash as string | undefined,
    effectiveProhibitAppInstall: record.effectiveProhibitAppInstall as boolean | undefined,
    effectiveProhibitAppDelete: record.effectiveProhibitAppDelete as boolean | undefined
  };
}
