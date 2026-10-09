import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { parseBoolean, truthy } from "../booleans.js";
import { DEVICE_TARGETS } from "../defaults.js";
import { normalizeWeekdays as normalizeDays, pathTailId as pathId } from "../normalizers.js";
import { listFromTextarea, normalizeDeviceTargets, normalizeLockLevel } from "../policy.js";
import { assertProtectedEditAllowed } from "../protection.js";
import { addEvent, saveState } from "../store.js";
import { normalizeClock } from "../time.js";
import type { Schedule, VigilState, UnknownRecord } from "../types.js";
import { readBody, sendJson } from "./http.js";

interface PolicyApiContext {
  state: VigilState;
  recordIosMdmPolicyQueue: (reason: string) => unknown;
  schedulePolicyEnforcement?: (reason: string) => unknown;
}

export async function handlePolicyApiRoute(request: IncomingMessage, response: ServerResponse,
  { state, recordIosMdmPolicyQueue, schedulePolicyEnforcement }: PolicyApiContext): Promise<boolean> {
  const method = request.method || "GET";
  const path = new URL(request.url || "/", "http://localhost").pathname;
  if (method === "POST" && path === "/api/schedule") {
    const body = await readBody(request);
    assertProtectedEditAllowed(state, { kind: "schedule", id: typeof body.id === "string" ? body.id : undefined });
    const schedule = upsertSchedule(state, body);
    addEvent(state, "schedule_saved", { scheduleId: schedule.id, name: schedule.name });
    recordIosMdmPolicyQueue("schedule-saved");
    schedulePolicyEnforcement?.("schedule-saved");
    await saveState(state);
    sendJson(response, 200, { ok: true, schedule });
    return true;
  }
  if (method === "DELETE" && path.startsWith("/api/schedule/")) {
    const id = pathId(path);
    assertProtectedEditAllowed(state, { kind: "schedule", id });
    state.schedules = state.schedules.filter(schedule => schedule.id !== id);
    addEvent(state, "schedule_deleted", { scheduleId: id });
    recordIosMdmPolicyQueue("schedule-deleted");
    schedulePolicyEnforcement?.("schedule-deleted");
    await saveState(state);
    sendJson(response, 200, { ok: true });
    return true;
  }
  return false;
}

function upsertSchedule(state: VigilState, body: UnknownRecord): Schedule {
  const id = stringValue(body.id, randomUUID());
  const existing = state.schedules.find((item) => item.id === id);
  if ((body.profileId ?? existing?.profileId) === "soft-block" || (body.mode ?? existing?.mode) === "soft-block") {
    throw Object.assign(new Error("Soft Lock schedules have been retired."), { status: 410 });
  }
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
    start: normalizeClock(body.start ?? existing?.start ?? "09:00", "09:00"),
    end: normalizeClock(body.end ?? existing?.end ?? "17:00", "17:00"),
    wifiNetworks: normalizeArray(body.wifiNetworks ?? existing?.wifiNetworks)
  };

  if (existing) Object.assign(existing, schedule);
  else state.schedules.push(schedule);

  return schedule;
}

function normalizeArray(value: unknown): string[] {
  if (Array.isArray(value)) return [...new Set(value.map((item) => String(item).trim()).filter(Boolean))];
  return listFromTextarea(value);
}

function stringValue(value: unknown, fallback = ""): string {
  const text = String(value ?? "").trim();
  return text || fallback;
}
