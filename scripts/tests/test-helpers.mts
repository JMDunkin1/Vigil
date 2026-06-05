import assert from "node:assert/strict";
import type { ActivePolicy, Profile, UnknownRecord, UsageBucket, UsageDay, UsageState } from "../../src/types.js";

export const now = new Date("2026-05-28T14:00:00-04:00");
export const TEST_DAYS = [0, 1, 2, 3, 4, 5, 6];

type UsageDayFixture = UsageBucket & Partial<Pick<UsageDay, "devices" | "deviceTotalsMode">>;

export function clockTime(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function must<T>(value: T | null | undefined, label = "value"): T {
  assert.ok(value != null, `${label} should exist`);
  return value;
}

export function mustPolicy(policy: ActivePolicy | null | undefined): ActivePolicy {
  return must(policy, "active policy");
}

export function stringValue(value: unknown, label = "value"): string {
  if (typeof value !== "string") assert.fail(`${label} should be a string`);
  return value;
}

export function recordValue(value: unknown, label = "value"): UnknownRecord {
  assert.equal(typeof value, "object", `${label} should be an object`);
  assert.notEqual(value, null, `${label} should not be null`);
  return value as UnknownRecord;
}

export function stringArrayValue(value: unknown, label = "value"): string[] {
  assert.ok(Array.isArray(value) && value.every((item) => typeof item === "string"), `${label} should be a string array`);
  return value as string[];
}

export function testProfile(input: Partial<Profile>): Profile {
  return {
    id: "test-profile",
    name: "Test profile",
    mode: "blocklist",
    blockedApps: [],
    blockedSites: [],
    blockedUrlPatterns: [],
    allowedApps: [],
    allowedSites: [],
    ...input
  };
}

function usageDay(day: UsageDayFixture): UsageDay {
  return {
    ...day,
    devices: day.devices || {}
  };
}

export function usageFixture(days: Record<string, UsageDayFixture>): UsageState {
  return Object.fromEntries(
    Object.entries(days).map(([date, day]) => [date, usageDay(day)])
  );
}

export function hasStatusError(error: unknown): error is { status: number; message: string } {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { status?: unknown; message?: unknown };
  return typeof candidate.status === "number" && typeof candidate.message === "string";
}
