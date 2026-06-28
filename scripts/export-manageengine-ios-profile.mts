import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { buildIosConfigurationProfile, ensureIosRemovalPassword, iosProfileSummary } from "../src/iosProfiles.js";
import { loadState, saveState } from "../src/store.js";
import type { SentinelState } from "../src/types.js";

const IOS_PROFILE_IDENTIFIER = "com.local-screen-time.ios-lock";
const VALUE_OPTIONS = new Set(["out", "summary"]);
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
const outPath = resolve(String(args.out || defaultOutputPath(enrollmentWindow)));
const summaryPath = resolve(String(args.summary || defaultSummaryPath(outPath)));
if (summaryPath === outPath) {
  throw new Error(`Summary output path must differ from profile output path: ${summaryPath}`);
}

const savedState = await loadState();
const state = structuredClone(savedState) as SentinelState;
prepareManageEngineState(state, args, enrollmentWindow);

const stateSaved = await persistRemovalPasswordForHardenedExport(savedState, state);
const profile = buildIosConfigurationProfile(state);
await mkdir(dirname(outPath), { recursive: true });
await mkdir(dirname(summaryPath), { recursive: true });
await writeFile(outPath, profile);
await writeFile(summaryPath, `${JSON.stringify(buildSummary(state, enrollmentWindow, outPath, stateSaved), null, 2)}\n`);

console.log([
  `Wrote ManageEngine iOS profile: ${outPath}`,
  `Summary: ${summaryPath}`,
  `Identifier: ${IOS_PROFILE_IDENTIFIER}`,
  `Mode: ${enrollmentWindow ? "enrollment-window" : "managed-policy"}`,
  `State saved: ${stateSaved ? "yes" : "no"}`
].join("\n"));

async function persistRemovalPasswordForHardenedExport(savedState: SentinelState, exportState: SentinelState): Promise<boolean> {
  const ios = exportState.deviceControls.ios;
  if (!ios.enabled || ios.hardenRemoval === false || ios.removalPassword) return false;

  const changed = ensureIosRemovalPassword(savedState);
  if (!savedState.deviceControls.ios.removalPassword) {
    throw new Error("Hardened ManageEngine export requires a saved iOS removal password.");
  }
  if (changed) await saveState(savedState);
  exportState.deviceControls.ios.removalPassword = savedState.deviceControls.ios.removalPassword;
  return changed;
}

function prepareManageEngineState(state: SentinelState, parsed: Record<string, string | boolean>, windowMode: boolean): void {
  const ios = state.deviceControls.ios;
  if (!parsed["current-state"]) ios.enabled = true;
  if (parsed.disabled) ios.enabled = false;
  if (parsed.enable) ios.enabled = true;
  if (parsed["allow-profile-install"]) ios.restrictInstallAndErase = false;
  if (parsed["no-harden-removal"]) ios.hardenRemoval = false;

  if (windowMode) {
    ios.enabled = true;
    ios.restrictInstallAndErase = false;
    ios.hardenRemoval = false;
  }
}

function buildSummary(state: SentinelState, windowMode: boolean, outputPath: string, stateSaved: boolean) {
  const ios = state.deviceControls.ios;
  const summary = iosProfileSummary(state);
  return {
    generatedAt: new Date().toISOString(),
    mode: windowMode ? "enrollment-window" : "managed-policy",
    deliveryProvider: "manageengine",
    normalFreeDeliveryPath: true,
    outputPath,
    stateSaved,
    uploadToManageEngineAsCustomConfigurationProfile: true,
    profileIdentifier: IOS_PROFILE_IDENTIFIER,
    enabled: ios.enabled,
    hardenRemoval: ios.hardenRemoval,
    removalPasswordStoredInSentinelState: Boolean(ios.hardenRemoval && ios.removalPassword),
    restrictInstallAndErase: ios.restrictInstallAndErase,
    profileInstallAllowedByThisProfile: !ios.restrictInstallAndErase,
    warning: windowMode
      ? "Temporary profile for enrolling in ManageEngine. Replace it with the managed-policy profile after enrollment."
      : "Final Sentinel policy profile for ManageEngine assignment and remote delivery.",
    generatedFrom: summary.profile.generatedFrom,
    appBundleCount: summary.profile.appBundleCount,
    deniedUrlCount: summary.profile.deniedUrlCount,
    allowedUrlCount: summary.profile.allowedUrlCount,
    webClipCount: summary.profile.webClipCount,
    grayscale: summary.profile.grayscale
  };
}

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

function defaultOutputPath(windowMode: boolean): string {
  return windowMode
    ? "data/manageengine/sentinel-manageengine-enrollment-window.mobileconfig"
    : "data/manageengine/sentinel-manageengine-policy.mobileconfig";
}

function defaultSummaryPath(outputPath: string): string {
  return outputPath.toLowerCase().endsWith(".mobileconfig")
    ? `${outputPath.slice(0, -".mobileconfig".length)}.summary.json`
    : `${outputPath}.summary.json`;
}
