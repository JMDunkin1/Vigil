#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, normalize, resolve } from "node:path";
import { promisify } from "node:util";
import { isDirectRun } from "../src/directRun.js";
import type { UnknownRecord } from "../src/types.js";

const execFileAsync = promisify(execFile);

export const SIMCTL_LIST_TIMEOUT_MS = 120_000;
const XCODEBUILD_TIMEOUT_MS = 8 * 60_000;
const XCODE_DISCOVERY_TIMEOUT_MS = 30_000;

interface SimulatorDevice {
  name?: unknown;
  udid?: unknown;
  isAvailable?: unknown;
}

export interface IosSimulatorDestination {
  name: string;
  udid: string;
  runtimeVersion: string;
}

export interface IosSimulatorToolchain {
  developerDir: string;
  iosSimulatorSdkVersion: string;
}

interface DeveloperDirectoryCandidateOptions {
  explicitDeveloperDir?: string;
  selectedDeveloperDir?: string;
  installedDeveloperDirectories?: readonly string[];
}

export function selectIosSimulator(value: unknown): { name: string; udid: string } | null {
  const selected = selectIosSimulatorDestination(value);
  return selected ? { name: selected.name, udid: selected.udid } : null;
}

export function selectIosSimulatorDestination(value: unknown): IosSimulatorDestination | null {
  const root = asRecord(value);
  const runtimes = asRecord(root.devices);
  const candidates = Object.entries(runtimes)
    .flatMap(([runtime, devices]) => {
      const version = iosSimulatorRuntimeVersion(runtime);
      if (!version || !Array.isArray(devices)) return [];
      return devices
        .filter((device): device is SimulatorDevice => Boolean(device && typeof device === "object"))
        .filter((device) => device.isAvailable !== false && String(device.name || "").startsWith("iPhone "))
        .map((device) => ({
          name: String(device.name || ""),
          udid: String(device.udid || ""),
          runtimeVersion: version
        }))
        .filter((device) => device.name && device.udid);
    })
    .sort((left, right) => {
      const runtimeOrder = compareAppleVersions(right.runtimeVersion, left.runtimeVersion);
      if (runtimeOrder) return runtimeOrder;
      const nameOrder = left.name.localeCompare(right.name, "en");
      return nameOrder || left.udid.localeCompare(right.udid, "en");
    });
  const selected = candidates[0];
  return selected || null;
}

export function parseIosSimulatorSdkVersion(output: string): string {
  const versions = [...output.matchAll(/-sdk\s+iphonesimulator(\d+(?:\.\d+)*)/gu)]
    .map((match) => match[1])
    .filter((version): version is string => Boolean(version))
    .sort((left, right) => compareAppleVersions(right, left));
  return versions[0] || "";
}

export function developerDirectoryCandidates({
  explicitDeveloperDir = "",
  selectedDeveloperDir = "",
  installedDeveloperDirectories = []
}: DeveloperDirectoryCandidateOptions): string[] {
  const explicit = normalizeDeveloperDirectory(explicitDeveloperDir);
  if (explicit) return [explicit];
  const candidates = [
    normalizeDeveloperDirectory(selectedDeveloperDir),
    ...[...installedDeveloperDirectories]
      .map(normalizeDeveloperDirectory)
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right, "en"))
  ].filter(Boolean);
  return [...new Set(candidates)];
}

export function selectCompatibleIosToolchain(
  candidates: readonly IosSimulatorToolchain[],
  runtimeVersion: string,
  explicitDeveloperDir = ""
): IosSimulatorToolchain | null {
  const explicit = normalizeDeveloperDirectory(explicitDeveloperDir);
  const eligible = candidates
    .filter((candidate) => !explicit || normalizeDeveloperDirectory(candidate.developerDir) === explicit)
    .filter((candidate) => compareAppleVersions(candidate.iosSimulatorSdkVersion, runtimeVersion) >= 0)
    .sort((left, right) => {
      const sdkOrder = compareAppleVersions(right.iosSimulatorSdkVersion, left.iosSimulatorSdkVersion);
      if (sdkOrder) return sdkOrder;
      return normalizeDeveloperDirectory(left.developerDir)
        .localeCompare(normalizeDeveloperDirectory(right.developerDir), "en");
    });
  return eligible[0] || null;
}

async function main(): Promise<void> {
  const explicitDeveloperDir = String(process.env.DEVELOPER_DIR || "").trim();
  const candidates = await discoverDeveloperDirectories(explicitDeveloperDir);
  const toolchains = (await Promise.all(candidates.map(inspectIosToolchain)))
    .filter((candidate): candidate is IosSimulatorToolchain => candidate !== null);
  if (!toolchains.length) {
    const scope = explicitDeveloperDir
      ? `the explicit DEVELOPER_DIR (${explicitDeveloperDir})`
      : "the selected or installed Xcode applications";
    throw new Error(`No usable iOS Simulator SDK was found in ${scope}.`);
  }

  const simulatorProbeToolchain = [...toolchains].sort((left, right) => {
    const sdkOrder = compareAppleVersions(right.iosSimulatorSdkVersion, left.iosSimulatorSdkVersion);
    if (sdkOrder) return sdkOrder;
    return left.developerDir.localeCompare(right.developerDir, "en");
  })[0];
  if (!simulatorProbeToolchain) throw new Error("No usable Xcode toolchain was found.");

  const simulatorData = await listAvailableSimulators(simulatorProbeToolchain.developerDir);
  const simulator = selectIosSimulatorDestination(simulatorData);
  if (!simulator) throw new Error("No available iPhone simulator was found.");

  const toolchain = selectCompatibleIosToolchain(toolchains, simulator.runtimeVersion, explicitDeveloperDir);
  if (!toolchain) {
    const available = toolchains
      .map((candidate) => `${candidate.developerDir} (iOS Simulator SDK ${candidate.iosSimulatorSdkVersion})`)
      .join(", ");
    throw new Error(
      `The newest available iPhone simulator runs iOS ${simulator.runtimeVersion}, `
      + `but no permitted Xcode has a compatible iOS Simulator SDK. Found: ${available}`
    );
  }

  process.stdout.write(
    `Testing with ${toolchain.developerDir} (iOS Simulator SDK ${toolchain.iosSimulatorSdkVersion}) `
    + `on ${simulator.name} (iOS ${simulator.runtimeVersion}).\n`
  );
  await runTest(simulator.udid, toolchain.developerDir);
}

async function discoverDeveloperDirectories(explicitDeveloperDir: string): Promise<string[]> {
  if (explicitDeveloperDir) {
    return developerDirectoryCandidates({ explicitDeveloperDir });
  }
  const [selectedDeveloperDir, installedDeveloperDirectories] = await Promise.all([
    selectedXcodeDeveloperDirectory(),
    installedXcodeDeveloperDirectories()
  ]);
  return developerDirectoryCandidates({ selectedDeveloperDir, installedDeveloperDirectories });
}

async function selectedXcodeDeveloperDirectory(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("/usr/bin/xcode-select", ["-p"], {
      timeout: XCODE_DISCOVERY_TIMEOUT_MS,
      maxBuffer: 1024 * 1024
    });
    return stdout.trim();
  } catch {
    return "";
  }
}

async function installedXcodeDeveloperDirectories(): Promise<string[]> {
  try {
    const entries = await readdir("/Applications", { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && /^Xcode.*\.app$/u.test(entry.name))
      .map((entry) => join("/Applications", entry.name, "Contents", "Developer"));
  } catch {
    return [];
  }
}

async function inspectIosToolchain(developerDir: string): Promise<IosSimulatorToolchain | null> {
  try {
    const { stdout, stderr } = await execFileAsync(join(developerDir, "usr", "bin", "xcodebuild"), ["-showsdks"], {
      timeout: XCODE_DISCOVERY_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024
    });
    const iosSimulatorSdkVersion = parseIosSimulatorSdkVersion(`${stdout}\n${stderr}`);
    return iosSimulatorSdkVersion ? { developerDir, iosSimulatorSdkVersion } : null;
  } catch {
    return null;
  }
}

async function listAvailableSimulators(developerDir: string): Promise<unknown> {
  const { stdout } = await execFileAsync("/usr/bin/xcrun", ["simctl", "list", "devices", "available", "-j"], {
    env: { ...process.env, DEVELOPER_DIR: developerDir },
    // A freshly provisioned GitHub macOS runner can spend well over 15 seconds
    // starting CoreSimulator before this read-only command returns.
    timeout: SIMCTL_LIST_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024
  });
  return JSON.parse(stdout);
}

async function runTest(udid: string, developerDir: string): Promise<void> {
  const artifactRoot = await mkdtemp(join(tmpdir(), "vigil-social-test-"));
  const derivedDataPath = join(artifactRoot, "DerivedData");
  const resultBundlePath = join(artifactRoot, "VigilSocial.xcresult");
  let succeeded = false;
  try {
    const { stdout, stderr } = await execFileAsync(join(developerDir, "usr", "bin", "xcodebuild"), [
      "-quiet",
      "-project", "ios/VigilSocial/VigilSocial.xcodeproj",
      "-scheme", "VigilSocial",
      "-destination", `id=${udid}`,
      "-derivedDataPath", derivedDataPath,
      "-resultBundlePath", resultBundlePath,
      "test",
      "CODE_SIGNING_ALLOWED=NO"
    ], {
      env: { ...process.env, DEVELOPER_DIR: developerDir },
      timeout: XCODEBUILD_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024
    });
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
    succeeded = true;
  } catch (error) {
    writeCapturedOutput(error);
    process.stderr.write(`VigilSocial test artifacts retained at ${artifactRoot}\n`);
    throw error;
  } finally {
    if (succeeded) await rm(artifactRoot, { recursive: true, force: true });
  }
}

function iosSimulatorRuntimeVersion(identifier: string): string {
  const match = identifier.match(/(?:^|\.)SimRuntime\.iOS-(\d+(?:-\d+)*)$/u);
  return match?.[1]?.replaceAll("-", ".") || "";
}

function compareAppleVersions(left: string, right: string): number {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  const count = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < count; index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference) return difference;
  }
  return 0;
}

function versionParts(value: string): number[] {
  const normalizedVersion = String(value || "").trim();
  if (!/^\d+(?:\.\d+)*$/u.test(normalizedVersion)) return [];
  return normalizedVersion.split(".").map(Number);
}

function normalizeDeveloperDirectory(value: string): string {
  const candidate = String(value || "").trim();
  return candidate ? normalize(resolve(candidate)) : "";
}

function writeCapturedOutput(error: unknown): void {
  if (!error || typeof error !== "object") return;
  const captured = error as { stdout?: unknown; stderr?: unknown };
  const stdout = outputText(captured.stdout);
  const stderr = outputText(captured.stderr);
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
}

function outputText(value: unknown): string {
  if (typeof value === "string") return value;
  return Buffer.isBuffer(value) ? value.toString("utf8") : "";
}

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {};
}

if (isDirectRun(import.meta.url)) await main();
