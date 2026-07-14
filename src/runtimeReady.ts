import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const RUNTIME_READY_FILENAME = "runtime-ready.json";

export interface RuntimeReadyRecord {
  pid: number;
  startedAt: string;
  appPath: string;
  transport: "in-app";
}

export function runtimeReadyPath(dataDir: string): string {
  return join(dataDir, RUNTIME_READY_FILENAME);
}

export async function markRuntimeReady(dataDir: string, appPath: string): Promise<RuntimeReadyRecord> {
  const record: RuntimeReadyRecord = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    appPath,
    transport: "in-app"
  };
  const path = runtimeReadyPath(dataDir);
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await mkdir(dataDir, { recursive: true });
  await writeFile(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, path);
  return record;
}

export async function readRuntimeReady(dataDir: string): Promise<RuntimeReadyRecord | null> {
  try {
    const value = JSON.parse(await readFile(runtimeReadyPath(dataDir), "utf8")) as Partial<RuntimeReadyRecord>;
    if (
      !Number.isInteger(value.pid)
      || Number(value.pid) < 1
      || !Number.isFinite(Date.parse(String(value.startedAt || "")))
      || typeof value.appPath !== "string"
      || value.transport !== "in-app"
    ) return null;
    return value as RuntimeReadyRecord;
  } catch {
    return null;
  }
}

export async function liveRuntimeReady(dataDir: string, startedAfter = 0): Promise<RuntimeReadyRecord | null> {
  const record = await readRuntimeReady(dataDir);
  if (!record || Date.parse(record.startedAt) < startedAfter || !processIsRunning(record.pid)) return null;
  return record;
}

export async function clearRuntimeReady(dataDir: string, pid = process.pid): Promise<void> {
  const record = await readRuntimeReady(dataDir);
  if (record?.pid !== pid) return;
  await rm(runtimeReadyPath(dataDir), { force: true });
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "EPERM");
  }
}
