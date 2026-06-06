import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { truthy } from "../booleans.js";
import { assertTypingChallenge, attachTypingChallenge } from "../challenge.js";
import { assertDistanceKey } from "../distanceKey.js";
import { DEVICE_TARGETS, PANIC_LOCK_PROFILE_ID } from "../defaults.js";
import { assertIntentReason } from "../intentReason.js";
import { emergencyDelaySeconds, interventionSummary } from "../intervention.js";
import { completeIntentionalPlanBlock } from "../intentionalUse.js";
import { assertKeyholderPasscode } from "../keyholder.js";
import { activeLimitBlocks, overrideLimitRules } from "../limits.js";
import {
  activePolicy,
  activeSessionForDevice,
  clearSessionsById,
  emergencyUnlockAllowedForPolicy,
  normalizeDeviceTarget,
  normalizeDeviceTargets,
  normalizeLockLevel,
  panicLockProfile,
  profileById,
  snapshotProfile
} from "../policy.js";
import { addEvent, saveState } from "../store.js";
import { clampNumber, weekKey } from "../time.js";
import type { DeviceTarget, LimitBlock, LockLevel, Profile, SentinelState, Session, SessionCycle, UnknownRecord } from "../types.js";
import { commitmentLockError } from "./pages.js";
import { errorStatus, readBody, sendJson, serializeError } from "./http.js";

interface SessionApiContext {
  state: SentinelState;
  recordIosMdmPolicyQueue: (reason: string) => unknown;
  scheduleImmediateSessionEnforcement: (sessionId: string) => void;
  assertStrictLockAllowed: (lockLevel: LockLevel, profile: Profile, options?: { mode?: string }) => Promise<void>;
}

interface LimitBlockSummary {
  id: string;
  ruleId: string;
  until: string;
}

export async function handleSessionApiRoute(
  request: IncomingMessage,
  response: ServerResponse,
  context: SessionApiContext
): Promise<boolean> {
  const method = request.method || "GET";
  const path = new URL(request.url || "/", "http://localhost").pathname;
  const { state } = context;

  if (method === "POST" && path === "/api/panic/start") {
    activePolicy(state);
    const durationMinutes = panicLockDurationMinutes(state);
    const started = new Date();
    const ends = new Date(started.getTime() + durationMinutes * 60 * 1000);
    const profile = panicLockProfile();
    state.panicLock = {
      id: randomUUID(),
      title: "Panic Lockout",
      mode: "panic",
      profileId: PANIC_LOCK_PROFILE_ID,
      lockLevel: "deep",
      startedAt: started.toISOString(),
      endsAt: ends.toISOString(),
      canEndEarly: false,
      commitmentLock: true,
      emergencyUnlocksAllowed: false,
      source: "panic",
      fullLockout: true,
      profileSnapshot: snapshotProfile(profile)
    };
    addEvent(state, "panic_lock_started", { ...state.panicLock, durationMinutes });
    context.recordIosMdmPolicyQueue("panic-start");
    await saveState(state);
    context.scheduleImmediateSessionEnforcement(state.panicLock.id);
    sendJson(response, 200, { ok: true, session: state.panicLock });
    return true;
  }

  if (method === "POST" && path === "/api/session/start") {
    const body = await readBody(request);
    activePolicy(state);
    const deviceTargets = normalizeSessionDeviceTargets(body);
    const conflicts = activeSessionConflicts(state, deviceTargets);
    if (conflicts.length) {
      sendJson(response, 409, { error: `A session is already active for ${deviceLabel(conflicts)}.`, active: conflicts.map((target) => state.activeSessions?.[target] || state.activeSession) });
      return true;
    }

    const cycle = normalizeSessionCycle(body);
    const durationMinutes = cycle ? cycleDurationMinutes(cycle) : clampNumber(body.durationMinutes, 1, 60 * 24 * 45, 25);
    const started = new Date();
    const ends = new Date(started.getTime() + durationMinutes * 60 * 1000);
    const lockLevel = normalizeLockLevel(body.lockLevel, state.settings.strictByDefault ? "deep" : "light");
    const mode = stringValue(body.mode, "focus");
    const profile = profileById(state, stringValue(body.profileId, state.settings.activeProfileId));
    await context.assertStrictLockAllowed(lockLevel, profile, { mode });
    const commitmentLock = lockLevel === "deep" && truthy(body.commitmentLock);

    const session: Session = {
      id: randomUUID(),
      title: stringValue(body.title, sessionTitle(mode)),
      mode,
      profileId: profile.id,
      lockLevel,
      startedAt: started.toISOString(),
      endsAt: ends.toISOString(),
      canEndEarly: lockLevel === "light",
      commitmentLock,
      emergencyUnlocksAllowed: !commitmentLock,
      source: "manual",
      deviceTargets,
      profileSnapshot: snapshotProfile(profile),
      ...(cycle ? { cycle } : {})
    };
    startDeviceSession(state, deviceTargets, session);
    addEvent(state, "session_started", session);
    if (deviceTargets.includes("phone")) context.recordIosMdmPolicyQueue("session-start");
    await saveState(state);
    context.scheduleImmediateSessionEnforcement(session.id);
    sendJson(response, 200, { ok: true, session, activeSessions: state.activeSessions });
    return true;
  }

  if (method === "POST" && path === "/api/session/end") {
    const body = await readBody(request);
    activePolicy(state);
    const deviceTargets = normalizeSessionDeviceTargets(body, ["computer"]);
    const ended: Array<{ target: DeviceTarget; session: Session }> = [];
    for (const target of deviceTargets) {
      const session = activeSessionForDevice(state, target);
      if (!session) continue;
      if (!session.canEndEarly) {
        sendJson(response, 423, { error: `The ${target} session is locked. Use an emergency unlock if you really need to end it.`, active: session });
        return true;
      }

      clearDeviceSession(state, target);
      ended.push({ target, session });
      addEvent(state, "session_ended", { ...session, endedTarget: target });
    }

    if (ended.some((item) => item.target === "phone")) {
      context.recordIosMdmPolicyQueue("session-end");
    }

    await saveState(state);
    sendJson(response, 200, { ok: true, ended: Boolean(ended.length), endedTargets: ended.map((item) => item.target), activeSessions: state.activeSessions });
    return true;
  }

  if (method === "POST" && path === "/api/emergency/request") {
    const body = await readBody(request);
    const active = activePolicy(state);
    const activeLimits = activeLimitBlocks(state) as LimitBlockSummary[];
    if (active && !emergencyUnlockAllowedForPolicy(active)) {
      sendJson(response, 423, { error: commitmentLockError(active), active: active.session });
      return true;
    }
    if (!active && !activeLimits.length) {
      sendJson(response, 409, { error: "There is no active locked session." });
      return true;
    }
    const remaining = emergencyRemaining(state);
    if (remaining <= 0) {
      sendJson(response, 429, { error: "No emergency unlocks remain this week." });
      return true;
    }

    const now = Date.now();
    const delaySeconds = emergencyDelaySeconds(state, new Date(now));
    const pending = {
      id: randomUUID(),
      status: "pending",
      reason: assertIntentReason(state, body.reason, "Emergency unlock"),
      requestedAt: new Date(now).toISOString(),
      eligibleAt: new Date(now + delaySeconds * 1000).toISOString(),
      expiresAt: new Date(now + 15 * 60 * 1000).toISOString(),
      delaySeconds,
      intervention: interventionSummary(state, new Date(now)),
      activeKind: active?.kind || "limit",
      sessionId: active?.session.id || null,
      scheduleId: active?.schedule?.id || null,
      plannerBlockId: active?.plannerBlock?.id || null,
      limitBlockIds: active ? [] : activeLimits.map((block) => block.id),
      limitRuleIds: active ? [] : [...new Set(activeLimits.map((block) => block.ruleId).filter((ruleId): ruleId is string => Boolean(ruleId)))],
      until: active?.endsAt || activeLimits.map((block) => block.until).sort().at(-1)
    };
    attachTypingChallenge(state, pending, "emergency", new Date(now));
    state.emergency.pending.push(pending);
    addEvent(state, "emergency_requested", pending);
    await saveState(state);
    sendJson(response, 200, { ok: true, pending, remaining });
    return true;
  }

  if (method === "POST" && path === "/api/emergency/confirm") {
    const body = await readBody(request);
    const pending = state.emergency.pending.find((item) => item.id === body.requestId && item.status === "pending");
    if (!pending) {
      sendJson(response, 404, { error: "Emergency request not found or expired." });
      return true;
    }

    if (new Date(pending.eligibleAt || "") > new Date()) {
      sendJson(response, 425, { error: "Emergency unlock cooldown is still running.", pending });
      return true;
    }

    try {
      assertTypingChallenge(state, pending, body.challengeText);
      assertKeyholderPasscode(state, body.passcode);
      assertDistanceKey(state, body.distanceKey);
    } catch (error) {
      sendJson(response, errorStatus(error), serializeError(error));
      return true;
    }

    const remaining = emergencyRemaining(state);
    if (remaining <= 0) {
      sendJson(response, 429, { error: "No emergency unlocks remain this week." });
      return true;
    }

    spendEmergencyToken(state);
    pending.status = "used";

    if (pending.activeKind === "manual") {
      clearSessionsById(state, pending.sessionId);
    } else if (pending.scheduleId) {
      state.overrides.push({
        id: randomUUID(),
        scheduleId: pending.scheduleId,
        until: pending.until || "",
        reason: pending.reason,
        createdAt: new Date().toISOString()
      });
    } else if (pending.activeKind === "planner" && pending.plannerBlockId) {
      completeIntentionalPlanBlock(state, String(pending.plannerBlockId));
    } else if (pending.activeKind === "limit") {
      const ids = new Set(pending.limitBlockIds || []);
      const blocks = (state.limitBlocks || []).filter((block: LimitBlock) => ids.has(String(block.id || "")));
      const ruleIds = pending.limitRuleIds?.length
        ? pending.limitRuleIds
        : blocks.map((block) => block.ruleId);
      overrideLimitRules(state, ruleIds, pending.until || blocks.map((block) => block.until).sort().at(-1), pending.reason, new Date());
      state.limitBlocks = (state.limitBlocks || []).filter((block: LimitBlock) => !ids.has(String(block.id || "")));
    }

    addEvent(state, "emergency_used", pending);
    context.recordIosMdmPolicyQueue("emergency-unlock");
    await saveState(state);
    sendJson(response, 200, { ok: true, remaining: emergencyRemaining(state) });
    return true;
  }

  return false;
}

function normalizeSessionCycle(body: UnknownRecord): (SessionCycle & { enabled: true; workMinutes: number; breakMinutes: number; rounds: number }) | null {
  if (!truthy(body.cycleEnabled)) return null;
  const workMinutes = clampNumber(body.cycleWorkMinutes, 1, 240, 25);
  const breakMinutes = clampNumber(body.cycleBreakMinutes, 1, 120, 5);
  const rounds = clampNumber(body.cycleRounds, 1, 24, 4);
  return {
    enabled: true,
    workMinutes,
    breakMinutes,
    rounds
  };
}

function cycleDurationMinutes(cycle: SessionCycle & { workMinutes: number; breakMinutes: number; rounds: number }): number {
  return cycle.workMinutes * cycle.rounds + cycle.breakMinutes * Math.max(0, cycle.rounds - 1);
}

function emergencyRemaining(state: SentinelState): number {
  const used = state.emergency.tokensUsedByWeek[weekKey()] || 0;
  return Math.max(0, state.settings.emergencyTokensPerWeek - used);
}

function panicLockDurationMinutes(state: SentinelState): number {
  return clampNumber(state.settings?.panicLockDurationMinutes, 1, 1440, 3);
}

function normalizeSessionDeviceTargets(body: UnknownRecord, fallback: readonly DeviceTarget[] = DEVICE_TARGETS): DeviceTarget[] {
  if (Array.isArray(body?.deviceTargets) || typeof body?.deviceTargets === "string") {
    return normalizeDeviceTargets(body.deviceTargets, fallback);
  }

  const selected: DeviceTarget[] = [];
  if (truthy(body?.targetComputer) || truthy(body?.computer)) selected.push("computer");
  if (truthy(body?.targetPhone) || truthy(body?.phone)) selected.push("phone");
  return normalizeDeviceTargets(selected, fallback);
}

function activeSessionConflicts(state: SentinelState, targets: DeviceTarget[]): DeviceTarget[] {
  state.activeSessions ||= { computer: state.activeSession || null, phone: null };
  return targets.filter((target) => Boolean(activeSessionForDevice(state, target)));
}

function startDeviceSession(state: SentinelState, targets: DeviceTarget[], session: Session): void {
  state.activeSessions ||= { computer: null, phone: null };
  for (const target of targets) {
    state.activeSessions[target] = session;
  }
  state.activeSession = state.activeSessions.computer || null;
}

function clearDeviceSession(state: SentinelState, target: unknown): void {
  const device = normalizeDeviceTarget(target);
  state.activeSessions ||= { computer: state.activeSession || null, phone: null };
  state.activeSessions[device] = null;
  state.activeSession = state.activeSessions.computer || null;
}

export function sessionIsActive(state: SentinelState, sessionId: unknown): boolean {
  if (!sessionId) return false;
  if (state.activeSession?.id === sessionId) return true;
  return DEVICE_TARGETS.some((target) => state.activeSessions?.[target]?.id === sessionId);
}

function deviceLabel(targets: DeviceTarget[]): string {
  return targets.map((target) => target === "phone" ? "phone" : "computer").join(" and ");
}

function spendEmergencyToken(state: SentinelState): void {
  const key = weekKey();
  state.emergency.tokensUsedByWeek[key] = (state.emergency.tokensUsedByWeek[key] || 0) + 1;
}

function sessionTitle(mode: unknown): string {
  if (mode === "sleep") return "Sleep lock";
  if (mode === "rehab") return "Rehab lock";
  if (mode === "brick") return "Brick Mode";
  return "Focus lock";
}

function stringValue(value: unknown, fallback = ""): string {
  const text = String(value ?? "").trim();
  return text || fallback;
}
