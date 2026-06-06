import { randomUUID } from "node:crypto";
import { BRICK_MODE_PROFILE_ID, DEVICE_TARGETS, PANIC_LOCK_PROFILE_ID, SOFT_BLOCK_PROFILE_ID } from "./defaults.js";
import { activePolicy, isFullLockoutPolicy, normalizeDeviceTarget, normalizeDeviceTargets } from "./policy.js";
import { parseBoolean } from "./booleans.js";
import { normalizeWeekdays } from "./normalizers.js";
import { parseClock } from "./time.js";
import type { ActivePolicy, DeviceTarget, GrayscaleSchedule, GrayscaleState, SentinelState, UnknownRecord } from "./types.js";

export const IOS_GRAYSCALE_GUARD_BUNDLE_IDS = [
  "com.apple.Preferences",
  "com.apple.shortcuts"
];

export const MAC_GRAYSCALE_GUARD_APPS = [
  "System Settings",
  "System Preferences",
  "Shortcuts"
];

export interface GrayscaleDecision {
  device: DeviceTarget;
  desired: boolean;
  reason: string;
  label: string;
  source: "brick" | "soft-block" | "schedule" | "normal";
  schedule: GrayscaleSchedule | null;
  policy: {
    kind: string;
    title: string;
    mode: string;
    profileId: string;
    endsAt: string;
  } | null;
}

export function normalizeGrayscaleState(body: UnknownRecord = {}, existing: Partial<GrayscaleState> = {}): GrayscaleState {
  return {
    softBlockEnabled: body.softBlockEnabled === undefined
      ? Boolean(existing.softBlockEnabled)
      : parseBoolean(body.softBlockEnabled, false),
    preventManualChanges: body.preventManualChanges === undefined
      ? existing.preventManualChanges !== false
      : parseBoolean(body.preventManualChanges, true),
    schedules: Array.isArray(existing.schedules)
      ? existing.schedules.map((schedule) => normalizeGrayscaleSchedule(schedule as unknown as UnknownRecord)).filter((schedule) => schedule.name)
      : []
  };
}

export function normalizeGrayscaleSchedule(body: UnknownRecord = {}, existing: Partial<GrayscaleSchedule> = {}): GrayscaleSchedule {
  return {
    id: stringValue(body.id, existing.id || randomUUID()),
    name: stringValue(body.name, existing.name || "Grayscale schedule").slice(0, 80),
    enabled: body.enabled === undefined ? Boolean(existing.enabled) : parseBoolean(body.enabled, false),
    days: normalizeWeekdays(body.days ?? existing.days ?? [0, 1, 2, 3, 4, 5, 6], { fallback: [0, 1, 2, 3, 4, 5, 6], integersOnly: true, sort: false }),
    start: normalizeClock(body.start ?? existing.start ?? "22:00", "22:00"),
    end: normalizeClock(body.end ?? existing.end ?? "07:00", "07:00"),
    deviceTargets: normalizeDeviceTargets(body.deviceTargets ?? existing.deviceTargets, DEVICE_TARGETS)
  };
}

export function grayscaleDecision(
  state: SentinelState,
  now = new Date(),
  options: { device?: DeviceTarget } = {}
): GrayscaleDecision {
  const device = normalizeDeviceTarget(options.device || "computer");
  const policy = activePolicy(state, now, { device });
  if (policy && isBrickGrayscalePolicy(policy)) {
    return decision(device, true, "brick-mode", "Brick mode", "brick", null, policy);
  }
  if (policy && state.grayscale?.softBlockEnabled && isSoftBlockPolicy(policy)) {
    return decision(device, true, "soft-block", "Soft Block", "soft-block", null, policy);
  }

  const schedule = activeGrayscaleSchedule(state, now, device);
  if (schedule) {
    return decision(device, true, `schedule:${schedule.id}`, schedule.name, "schedule", schedule, policy);
  }

  return decision(device, false, "normal", "Normal", "normal", null, policy);
}

export function grayscaleSummary(state: SentinelState, now = new Date()) {
  const devices = Object.fromEntries(DEVICE_TARGETS.map((device) => [device, publicDecision(grayscaleDecision(state, now, { device }))]));
  return {
    softBlockEnabled: Boolean(state.grayscale?.softBlockEnabled),
    preventManualChanges: state.grayscale?.preventManualChanges !== false,
    schedules: state.grayscale?.schedules || [],
    devices,
    active: Object.values(devices).some((item) => Boolean(item.desired))
  };
}

export function activeGrayscaleSchedule(
  state: SentinelState,
  now = new Date(),
  device: DeviceTarget = "computer"
): GrayscaleSchedule | null {
  for (const schedule of state.grayscale?.schedules || []) {
    if (!schedule.enabled) continue;
    if (!normalizeDeviceTargets(schedule.deviceTargets, DEVICE_TARGETS).includes(device)) continue;
    if (grayscaleScheduleWindow(schedule, now)) return schedule;
  }
  return null;
}

export function grayscaleGuardEnabled(state: SentinelState, decisionValue: GrayscaleDecision): boolean {
  return Boolean(decisionValue.desired && state.grayscale?.preventManualChanges !== false);
}

function decision(
  device: DeviceTarget,
  desired: boolean,
  reason: string,
  label: string,
  source: GrayscaleDecision["source"],
  schedule: GrayscaleSchedule | null,
  policy: ActivePolicy | null
): GrayscaleDecision {
  return {
    device,
    desired,
    reason,
    label,
    source,
    schedule,
    policy: policy ? {
      kind: policy.kind,
      title: policy.session?.title || policy.profile?.name || "",
      mode: policy.session?.mode || "",
      profileId: policy.profile?.id || policy.session?.profileId || "",
      endsAt: policy.endsAt || ""
    } : null
  };
}

function publicDecision(value: GrayscaleDecision) {
  return {
    device: value.device,
    desired: value.desired,
    reason: value.reason,
    label: value.label,
    source: value.source,
    scheduleId: value.schedule?.id || null,
    policy: value.policy
  };
}

function isBrickGrayscalePolicy(policy: ActivePolicy): boolean {
  const profileId = policy.profile?.id || policy.session?.profileId || "";
  return Boolean(
    isFullLockoutPolicy(policy)
    || policy.session?.mode === "brick"
    || profileId === BRICK_MODE_PROFILE_ID
    || profileId === PANIC_LOCK_PROFILE_ID
  );
}

function isSoftBlockPolicy(policy: ActivePolicy): boolean {
  const profileId = policy.profile?.id || policy.session?.profileId || "";
  return profileId === SOFT_BLOCK_PROFILE_ID;
}

function grayscaleScheduleWindow(schedule: GrayscaleSchedule, now: Date): boolean {
  const start = parseClock(schedule.start);
  const end = parseClock(schedule.end);
  const current = now.getHours() * 60 + now.getMinutes();
  const day = now.getDay();
  const yesterday = (day + 6) % 7;
  const days = new Set(schedule.days || []);
  const overnight = start > end;

  if (!overnight && days.has(day) && current >= start && current < end) return true;
  if (overnight && days.has(day) && current >= start) return true;
  if (overnight && days.has(yesterday) && current < end) return true;
  return false;
}

function normalizeClock(value: unknown, fallback: string): string {
  const text = String(value || "");
  return /^\d{2}:\d{2}$/.test(text) ? text : fallback;
}

function stringValue(value: unknown, fallback: string): string {
  const text = String(value || "").trim();
  return text || fallback;
}
