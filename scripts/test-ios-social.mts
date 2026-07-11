#!/usr/bin/env node

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isDirectRun } from "../src/directRun.js";
import type { UnknownRecord } from "../src/types.js";

const execFileAsync = promisify(execFile);

export const SIMCTL_LIST_TIMEOUT_MS = 120_000;

interface SimulatorDevice {
  name?: unknown;
  udid?: unknown;
  isAvailable?: unknown;
}

export function selectIosSimulator(value: unknown): { name: string; udid: string } | null {
  const root = asRecord(value);
  const runtimes = asRecord(root.devices);
  const candidates = Object.entries(runtimes)
    .filter(([runtime]) => runtime.includes("SimRuntime.iOS"))
    .sort(([left], [right]) => runtimeVersion(right) - runtimeVersion(left))
    .flatMap(([, devices]) => Array.isArray(devices) ? devices : [])
    .filter((device): device is SimulatorDevice => Boolean(device && typeof device === "object"))
    .filter((device) => device.isAvailable !== false && String(device.name || "").startsWith("iPhone "));
  const selected = candidates[0];
  const name = String(selected?.name || "");
  const udid = String(selected?.udid || "");
  return name && udid ? { name, udid } : null;
}

async function main(): Promise<void> {
  const { stdout } = await execFileAsync("xcrun", ["simctl", "list", "devices", "available", "-j"], {
    // A freshly provisioned GitHub macOS runner can spend well over 15 seconds
    // starting CoreSimulator before this read-only command returns.
    timeout: SIMCTL_LIST_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024
  });
  const selected = selectIosSimulator(JSON.parse(stdout));
  if (!selected) throw new Error("No available iPhone simulator was found.");
  await runTest(selected.udid);
}

async function runTest(udid: string): Promise<void> {
  const { stdout, stderr } = await execFileAsync("xcodebuild", [
    "-quiet",
    "-project", "ios/SentinelSocial/SentinelSocial.xcodeproj",
    "-scheme", "SentinelSocial",
    "-destination", `id=${udid}`,
    "-derivedDataPath", "/tmp/SentinelSocialDerivedData",
    "test",
    "CODE_SIGNING_ALLOWED=NO"
  ], {
    timeout: 8 * 60_000,
    maxBuffer: 64 * 1024 * 1024
  });
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
}

function runtimeVersion(value: string): number {
  const version = value.match(/iOS-(\d+)(?:-(\d+))?(?:-(\d+))?$/u);
  return Number(version?.[1] || 0) * 1_000_000
    + Number(version?.[2] || 0) * 1_000
    + Number(version?.[3] || 0);
}

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {};
}

if (isDirectRun(import.meta.url)) await main();
