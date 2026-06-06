import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { parseBoolean, truthy } from "../booleans.js";
import { assertDistanceKey } from "../distanceKey.js";
import { DEVICE_TARGETS, SOFT_BLOCK_PROFILE_ID } from "../defaults.js";
import { normalizeGrayscaleSchedule, normalizeGrayscaleState } from "../grayscale.js";
import { confirmAppLockUnlock, normalizeAppLock, requestAppLockUnlock } from "../appLocks.js";
import { assertKeyholderPasscode } from "../keyholder.js";
import { normalizeLimitRule } from "../limits.js";
import { normalizeWeekdays as normalizeDays, pathTailId as pathId } from "../normalizers.js";
import { listFromTextarea, normalizeDeviceTargets, normalizeLockLevel } from "../policy.js";
import { assertProtectedEditAllowed } from "../protection.js";
import { addEvent, saveState, sanitizeSoftBlockProfile } from "../store.js";
import type { AppLockRule, GrayscaleSchedule, LimitRule, Profile, ProfileMode, Schedule, SentinelState, UnknownRecord } from "../types.js";
import { errorStatus, readBody, sendJson, serializeError } from "./http.js";

interface PolicyApiContext {
  state: SentinelState;
  recordIosMdmPolicyQueue: (reason: string) => unknown;
}

export async function handlePolicyApiRoute(
  request: IncomingMessage,
  response: ServerResponse,
  { state, recordIosMdmPolicyQueue }: PolicyApiContext
): Promise<boolean> {
  const method = request.method || "GET";
  const path = new URL(request.url || "/", "http://localhost").pathname;

  if (method === "POST" && path === "/api/grayscale/settings") {
    const body = await readBody(request);
    assertProtectedEditAllowed(state, { kind: "settings" });
    state.grayscale = normalizeGrayscaleState(body, state.grayscale);
    addEvent(state, "grayscale_settings_updated", {
      softBlockEnabled: state.grayscale.softBlockEnabled,
      preventManualChanges: state.grayscale.preventManualChanges
    });
    recordIosMdmPolicyQueue("grayscale-settings");
    await saveState(state);
    sendJson(response, 200, { ok: true, grayscale: state.grayscale });
    return true;
  }

  if (method === "POST" && path === "/api/grayscale/schedule") {
    const body = await readBody(request);
    assertProtectedEditAllowed(state, { kind: "schedule", id: typeof body.id === "string" ? body.id : undefined });
    const schedule = upsertGrayscaleSchedule(state, body);
    addEvent(state, "grayscale_schedule_saved", {
      scheduleId: schedule.id,
      name: schedule.name,
      enabled: schedule.enabled,
      deviceTargets: schedule.deviceTargets
    });
    recordIosMdmPolicyQueue("grayscale-schedule");
    await saveState(state);
    sendJson(response, 200, { ok: true, schedule });
    return true;
  }

  if (method === "DELETE" && path.startsWith("/api/grayscale/schedule/")) {
    const id = pathId(path);
    assertProtectedEditAllowed(state, { kind: "schedule", id });
    state.grayscale.schedules = (state.grayscale.schedules || []).filter((schedule) => schedule.id !== id);
    addEvent(state, "grayscale_schedule_deleted", { scheduleId: id });
    recordIosMdmPolicyQueue("grayscale-schedule-deleted");
    await saveState(state);
    sendJson(response, 200, { ok: true });
    return true;
  }

  if (method === "POST" && path === "/api/profile") {
    const body = await readBody(request);
    assertProtectedEditAllowed(state, { kind: "profile", id: typeof body.id === "string" ? body.id : undefined });
    const profile = upsertProfile(state, body);
    addEvent(state, "profile_saved", { profileId: profile.id, name: profile.name });
    recordIosMdmPolicyQueue("profile-saved");
    await saveState(state);
    sendJson(response, 200, { ok: true, profile });
    return true;
  }

  if (method === "POST" && path === "/api/schedule") {
    const body = await readBody(request);
    assertProtectedEditAllowed(state, { kind: "schedule", id: typeof body.id === "string" ? body.id : undefined });
    const schedule = upsertSchedule(state, body);
    addEvent(state, "schedule_saved", { scheduleId: schedule.id, name: schedule.name });
    recordIosMdmPolicyQueue("schedule-saved");
    await saveState(state);
    sendJson(response, 200, { ok: true, schedule });
    return true;
  }

  if (method === "DELETE" && path.startsWith("/api/schedule/")) {
    const id = pathId(path);
    assertProtectedEditAllowed(state, { kind: "schedule", id });
    state.schedules = state.schedules.filter((schedule) => schedule.id !== id);
    addEvent(state, "schedule_deleted", { scheduleId: id });
    recordIosMdmPolicyQueue("schedule-deleted");
    await saveState(state);
    sendJson(response, 200, { ok: true });
    return true;
  }

  if (method === "POST" && path === "/api/limit") {
    const body = await readBody(request);
    assertProtectedEditAllowed(state, { kind: "limit", id: typeof body.id === "string" ? body.id : undefined });
    const rule = upsertLimitRule(state, body);
    addEvent(state, "limit_rule_saved", { ruleId: rule.id, name: rule.name, type: rule.type });
    recordIosMdmPolicyQueue("limit-saved");
    await saveState(state);
    sendJson(response, 200, { ok: true, rule });
    return true;
  }

  if (method === "DELETE" && path.startsWith("/api/limit/")) {
    const id = pathId(path);
    assertProtectedEditAllowed(state, { kind: "limit", id });
    state.limitRules = (state.limitRules || []).filter((rule) => rule.id !== id);
    state.limitBlocks = (state.limitBlocks || []).filter((block) => block.ruleId !== id);
    addEvent(state, "limit_rule_deleted", { ruleId: id });
    recordIosMdmPolicyQueue("limit-deleted");
    await saveState(state);
    sendJson(response, 200, { ok: true });
    return true;
  }

  if (method === "POST" && path === "/api/app-lock") {
    const body = await readBody(request);
    assertProtectedEditAllowed(state, { kind: "app-lock", id: typeof body.id === "string" ? body.id : undefined });
    const lock = upsertAppLock(state, body);
    addEvent(state, "app_lock_saved", { lockId: lock.id, name: lock.name });
    recordIosMdmPolicyQueue("app-lock-saved");
    await saveState(state);
    sendJson(response, 200, { ok: true, lock });
    return true;
  }

  if (method === "DELETE" && path.startsWith("/api/app-lock/")) {
    const id = pathId(path);
    assertProtectedEditAllowed(state, { kind: "app-lock", id });
    state.appLocks = (state.appLocks || []).filter((lock) => lock.id !== id);
    state.appLockUnlocks = (state.appLockUnlocks || []).filter((unlock) => unlock.lockId !== id);
    state.appLockRequests = (state.appLockRequests || []).filter((request) => request.lockId !== id);
    addEvent(state, "app_lock_deleted", { lockId: id });
    recordIosMdmPolicyQueue("app-lock-deleted");
    await saveState(state);
    sendJson(response, 200, { ok: true });
    return true;
  }

  if (method === "POST" && path === "/api/app-lock/unlock/request") {
    try {
      const body = await readBody(request);
      const unlockRequest = requestAppLockUnlock(state, String(body.lockId || ""), String(body.reason || ""));
      addEvent(state, "app_lock_unlock_requested", { lockId: unlockRequest.lockId, requestId: unlockRequest.id });
      await saveState(state);
      sendJson(response, 200, { ok: true, request: unlockRequest });
    } catch (error) {
      sendJson(response, errorStatus(error), serializeError(error));
    }
    return true;
  }

  if (method === "POST" && path === "/api/app-lock/unlock/confirm") {
    try {
      const body = await readBody(request);
      assertKeyholderPasscode(state, body.passcode);
      assertDistanceKey(state, body.distanceKey);
      const unlock = confirmAppLockUnlock(state, String(body.requestId || ""), { challengeText: String(body.challengeText || "") });
      addEvent(state, "app_lock_unlocked", { lockId: unlock.lockId, unlockId: unlock.id, until: unlock.until });
      await saveState(state);
      sendJson(response, 200, { ok: true, unlock });
    } catch (error) {
      sendJson(response, errorStatus(error), serializeError(error));
    }
    return true;
  }

  return false;
}

function upsertProfile(state: SentinelState, body: UnknownRecord): Profile {
  const id = stringValue(body.id, randomUUID());
  const existing = state.profiles.find((item) => item.id === id);
  const profile: Profile = {
    id,
    name: String(body.name || existing?.name || "Focus profile").slice(0, 80),
    mode: profileModeValue(body.mode),
    description: String(body.description || existing?.description || "").slice(0, 240),
    blockedApps: normalizeArray(body.blockedApps ?? existing?.blockedApps),
    blockedSites: normalizeArray(body.blockedSites ?? existing?.blockedSites),
    blockedUrlPatterns: normalizeArray(body.blockedUrlPatterns ?? existing?.blockedUrlPatterns),
    allowedApps: normalizeArray(body.allowedApps ?? existing?.allowedApps),
    allowedSites: normalizeArray(body.allowedSites ?? existing?.allowedSites),
    phoneAppBlocking: optionalDisabledFlag(body.phoneAppBlocking, existing?.phoneAppBlocking),
    hostsUrlPatternBlocking: optionalDisabledFlag(body.hostsUrlPatternBlocking, existing?.hostsUrlPatternBlocking)
  };
  const nextProfile = id === SOFT_BLOCK_PROFILE_ID ? sanitizeSoftBlockProfile(profile) : profile;

  if (existing) Object.assign(existing, nextProfile);
  else state.profiles.push(nextProfile);

  state.settings.activeProfileId = nextProfile.id;
  return nextProfile;
}

function upsertSchedule(state: SentinelState, body: UnknownRecord): Schedule {
  const id = stringValue(body.id, randomUUID());
  const existing = state.schedules.find((item) => item.id === id);
  const schedule: Schedule = {
    id,
    name: String(body.name || existing?.name || "Focus schedule").slice(0, 80),
    enabled: body.enabled === undefined ? Boolean(existing?.enabled) : parseBoolean(body.enabled, false),
    mode: stringValue(body.mode, existing?.mode || "focus"),
    profileId: stringValue(body.profileId, existing?.profileId || state.settings.activeProfileId),
    lockLevel: normalizeLockLevel(body.lockLevel, existing?.lockLevel || "deep"),
    commitmentLock: body.commitmentLock === undefined ? Boolean(existing?.commitmentLock) : truthy(body.commitmentLock),
    deviceTargets: normalizeDeviceTargets(body.deviceTargets ?? existing?.deviceTargets, DEVICE_TARGETS),
    days: normalizeDays(body.days ?? existing?.days ?? [1, 2, 3, 4, 5]),
    start: normalizeClock(body.start ?? existing?.start ?? "09:00"),
    end: normalizeClock(body.end ?? existing?.end ?? "17:00"),
    wifiNetworks: normalizeArray(body.wifiNetworks ?? existing?.wifiNetworks)
  };

  if (existing) Object.assign(existing, schedule);
  else state.schedules.push(schedule);

  return schedule;
}

function upsertGrayscaleSchedule(state: SentinelState, body: UnknownRecord): GrayscaleSchedule {
  state.grayscale ||= {
    softBlockEnabled: false,
    preventManualChanges: true,
    schedules: []
  };
  const id = stringValue(body.id, randomUUID());
  const existing = (state.grayscale.schedules || []).find((item) => item.id === id);
  const schedule = normalizeGrayscaleSchedule({ ...body, id }, existing);

  state.grayscale.schedules ||= [];
  if (existing) Object.assign(existing, schedule);
  else state.grayscale.schedules.push(schedule);

  return schedule;
}

function upsertLimitRule(state: SentinelState, body: UnknownRecord): LimitRule {
  const id = stringValue(body.id, randomUUID());
  const existing = (state.limitRules || []).find((item) => item.id === id);
  const rule = normalizeLimitRule(body, existing, id);

  state.limitRules ||= [];
  if (existing) Object.assign(existing, rule);
  else state.limitRules.push(rule);

  return rule;
}

function upsertAppLock(state: SentinelState, body: UnknownRecord): AppLockRule {
  const id = stringValue(body.id, randomUUID());
  const existing = (state.appLocks || []).find((item) => item.id === id);
  const lock = normalizeAppLock(body, existing, id);

  state.appLocks ||= [];
  if (existing) Object.assign(existing, lock);
  else state.appLocks.push(lock);

  return lock;
}

function profileModeValue(value: unknown): ProfileMode {
  return value === "allowlist" ? "allowlist" : "blocklist";
}

function optionalDisabledFlag(value: unknown, existing: unknown): boolean | undefined {
  if (value === undefined) return existing === false ? false : undefined;
  return value === false || value === "false" ? false : undefined;
}

function normalizeArray(value: unknown): string[] {
  if (Array.isArray(value)) return [...new Set(value.map((item) => String(item).trim()).filter(Boolean))];
  return listFromTextarea(value);
}

function normalizeClock(value: unknown): string {
  const text = String(value || "");
  return /^\d{2}:\d{2}$/.test(text) ? text : "09:00";
}

function stringValue(value: unknown, fallback = ""): string {
  const text = String(value ?? "").trim();
  return text || fallback;
}
