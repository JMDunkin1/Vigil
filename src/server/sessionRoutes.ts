import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { truthy } from "../booleans.js";
import { assertTypingChallenge, attachTypingChallenge } from "../challenge.js";
import { assertDistanceKey } from "../distanceKey.js";
import { BRICK_MODE_PROFILE_ID, DEVICE_TARGETS, PANIC_LOCK_PROFILE_ID } from "../defaults.js";
import { assertIntentReason } from "../intentReason.js";
import { emergencyDelaySeconds, interventionSummary } from "../intervention.js";
import { completeIntentionalPlanBlock } from "../intentionalUse.js";
import { iosMdmSummary } from "../iosMdm.js";
import { iosPolicyTargets } from "../iosProfiles.js";
import { assertKeyholderPasscode } from "../keyholder.js";
import { activeLimitBlocks, overrideLimitRules } from "../limits.js";
import { assertSessionTransitionAllowed } from "../protection.js";
import {
  activePolicy,
  activeSessionForDevice,
  clearSessionsById,
  emergencyUnlockAllowedForPolicy,
  matchStrictBrowserControlUrl,
  normalizeDeviceTarget,
  normalizeDeviceTargets,
  normalizeLockLevel,
  panicLockProfile,
  profileById,
  sessionPhase,
  snapshotProfile
} from "../policy.js";
import { addEvent, saveState } from "../store.js";
import { clampNumber, weekKey } from "../time.js";
import type { ActivePolicy, ActivePolicyContributor, DeviceTarget, EmergencyPolicyContributor, EmergencyRequest, LimitBlock, LockLevel, Profile, VigilState, Session, SessionCycle, UnknownRecord } from "../types.js";
import { commitmentLockError } from "./pages.js";
import { errorStatus, readBody, sendJson, serializeError } from "./http.js";

interface SessionApiContext {
  state: VigilState;
  recordIosMdmPolicyQueue: (reason: string) => unknown;
  scheduleImmediateSessionEnforcement: (sessionId: string) => void;
  assertStrictLockAllowed: (lockLevel: LockLevel, profile: Profile, options?: { mode?: string }) => Promise<void>;
}

interface LimitBlockSummary {
  id: string;
  ruleId: string;
  until: string;
}

interface ManualSessionDraft {
  session: Session;
  profile: Profile;
  deviceTargets: DeviceTarget[];
  durationMinutes: number;
}

interface ManualSessionDraftOptions {
  id?: string;
  now?: Date;
}

export interface SessionPreviewSummary {
  title: string;
  mode: string;
  profileName: string;
  profileMode: string;
  lockLevel: LockLevel;
  durationMinutes: number;
  endsAt: string;
  deviceTargets: DeviceTarget[];
  deviceLabel: string;
  commitmentLock: boolean;
  canEndEarly: boolean;
  blockedApps: string[];
  blockedSites: string[];
  blockedUrlPatterns: string[];
  allowedApps: string[];
  allowedSites: string[];
  protections: string[];
  conflicts: DeviceTarget[];
  phone: {
    targeted: boolean;
    ready: boolean;
    status: string;
    detail: string;
    blockers: string[];
    appCount: number;
    siteCount: number;
    mode: string;
  };
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
    const body = await readBody(request);
    activePolicy(state);
    if (state.panicLock) {
      sendJson(response, 423, { error: "Panic lock is already active and cannot be shortened.", active: state.panicLock });
      return true;
    }
    const durationMinutes = clampNumber(body.durationMinutes, 1, 1440, panicLockDurationMinutes(state));
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
    context.scheduleImmediateSessionEnforcement(state.panicLock.id);
    context.recordIosMdmPolicyQueue("panic-start");
    await saveState(state);
    sendJson(response, 200, { ok: true, session: state.panicLock });
    return true;
  }

  if (method === "POST" && path === "/api/protection/level") {
    const body = await readBody(request);
    activePolicy(state);
    if (state.panicLock) {
      sendJson(response, 423, { error: "Panic stays locked for its full three minutes.", active: state.panicLock });
      return true;
    }

    // Level 3 was Full Brick in older clients. Keep accepting it as a legacy
    // alias while the current UI exposes only Level 1 and Level 2.
    const requestedLevel = Math.round(clampNumber(body.level, 1, 3, 1));
    const level = requestedLevel === 1 ? 1 : 2;
    const deviceTargets = normalizeSessionDeviceTargets(body);
    if (!authorizeSessionTransition(response, state, deviceTargets)) return true;
    if (level === 1) {
      for (const target of deviceTargets) clearDeviceSession(state, target);
      addEvent(state, "protection_level_changed", { level, deviceTargets });
      if (deviceTargets.includes("phone")) context.recordIosMdmPolicyQueue("protection-level-1");
      await saveState(state);
      sendJson(response, 200, { ok: true, level, activeSessions: state.activeSessions });
      return true;
    }

    const profileId = BRICK_MODE_PROFILE_ID;
    const draft = manualSessionDraft(state, {
      title: "Full Brick",
      mode: "brick",
      profileId,
      durationMinutes: 60 * 24 * 45,
      lockLevel: "deep",
      commitmentLock: false,
      deviceTargets
    });
    await context.assertStrictLockAllowed(draft.session.lockLevel, draft.profile, { mode: draft.session.mode });
    const persistentEndsAt = new Date(draft.session.startedAt);
    persistentEndsAt.setUTCFullYear(persistentEndsAt.getUTCFullYear() + 100);
    draft.session.endsAt = persistentEndsAt.toISOString();
    draft.session.source = "protection-level";
    draft.session.canEndEarly = true;
    draft.session.commitmentLock = false;
    draft.session.emergencyUnlocksAllowed = true;
    startDeviceSession(state, deviceTargets, draft.session);
    addEvent(state, "protection_level_changed", { level, deviceTargets, sessionId: draft.session.id });
    context.scheduleImmediateSessionEnforcement(draft.session.id);
    if (deviceTargets.includes("phone")) context.recordIosMdmPolicyQueue(`protection-level-${level}`);
    await saveState(state);
    sendJson(response, 200, { ok: true, level, session: draft.session, activeSessions: state.activeSessions });
    return true;
  }

  if (method === "POST" && path === "/api/session/preview") {
    const body = await readBody(request);
    sendJson(response, 200, { ok: true, preview: await previewManualSessionForRequest(state, body, context) });
    return true;
  }

  if (method === "POST" && path === "/api/session/start") {
    const body = await readBody(request);
    activePolicy(state);
    const draft = manualSessionDraft(state, body);
    const conflicts = activeSessionConflicts(state, draft.deviceTargets);
    if (conflicts.length) {
      sendJson(response, 409, { error: `A session is already active for ${deviceLabel(conflicts)}.`, active: conflicts.map((target) => state.activeSessions?.[target] || state.activeSession) });
      return true;
    }

    await context.assertStrictLockAllowed(draft.session.lockLevel, draft.profile, { mode: draft.session.mode });
    startDeviceSession(state, draft.deviceTargets, draft.session);
    addEvent(state, "session_started", draft.session);
    context.scheduleImmediateSessionEnforcement(draft.session.id);
    if (draft.deviceTargets.includes("phone")) context.recordIosMdmPolicyQueue("session-start");
    await saveState(state);
    sendJson(response, 200, { ok: true, session: draft.session, activeSessions: state.activeSessions });
    return true;
  }

  if (method === "POST" && path === "/api/session/end") {
    const body = await readBody(request);
    activePolicy(state);
    const deviceTargets = normalizeSessionDeviceTargets(body, ["computer"]);
    if (!authorizeSessionTransition(response, state, deviceTargets)) return true;
    const ended: Array<{ target: DeviceTarget; session: Session }> = [];
    for (const target of deviceTargets) {
      const session = activeSessionForDevice(state, target);
      if (!session) continue;
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
    const active = activeEmergencyPolicy(state);
    const activeLimits = activeLimitBlocks(state) as LimitBlockSummary[];
    if (active && !emergencyUnlockAllowedForPolicy(active)) {
      sendJson(response, 423, { error: commitmentLockError(active), active: active.session });
      return true;
    }
    if (!active && !activeLimits.length) {
      sendJson(response, 409, { error: "There is no active locked session." });
      return true;
    }
    const policyContributors = active ? emergencyPolicyContributors(active) : [];
    if (active && !policyContributors.length) {
      sendJson(response, 409, { error: "The active policy cannot be released through an emergency unlock." });
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
      policyContributors,
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
    const pending = state.emergency.pending.find((item) => item.id === body.requestId);
    if (!pending || pending.status !== "pending") {
      sendJson(response, 404, { error: "Emergency request not found or expired." });
      return true;
    }

    const confirmedAt = new Date();
    const expiresAt = Date.parse(pending.expiresAt || "");
    if (!Number.isFinite(expiresAt) || expiresAt <= confirmedAt.getTime()) {
      pending.status = "expired";
      addEvent(state, "emergency_expired", { requestId: pending.id, expiredAt: confirmedAt.toISOString() });
      await saveState(state);
      sendJson(response, 410, { error: "Emergency request expired before confirmation." });
      return true;
    }

    if (new Date(pending.eligibleAt || "") > confirmedAt) {
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

    const requestedContributors = emergencyRequestContributors(pending);
    const currentContributors = currentEmergencyPolicyContributors(state, confirmedAt);
    const matchingContributors = requestedContributors
      .map((requested) => currentContributors.find((current) => emergencyContributorMatches(requested, current)))
      .filter((contributor): contributor is EmergencyPolicyContributor => Boolean(contributor));
    const disallowedContributor = matchingContributors.find((contributor) => contributor.emergencyUnlocksAllowed === false);
    if (disallowedContributor) {
      sendJson(response, 423, { error: "An intended policy contributor no longer allows emergency unlocks." });
      return true;
    }
    const releasableContributors = uniqueEmergencyPolicyContributors(matchingContributors);
    const limitIds = new Set(pending.limitBlockIds || []);
    const releasableLimitBlocks = pending.activeKind === "limit"
      ? (state.limitBlocks || []).filter((block: LimitBlock) => limitIds.has(String(block.id || "")))
      : [];
    if (!releasableContributors.length && !releasableLimitBlocks.length) {
      sendJson(response, 409, { error: "The policy captured by this emergency request is no longer active." });
      return true;
    }

    const manualSessionIds = new Set(
      releasableContributors.filter((contributor) => contributor.kind === "manual").map((contributor) => contributor.sessionId)
    );
    if (manualSessionIds.size) {
      const sessionTargets = DEVICE_TARGETS.filter((target) => manualSessionIds.has(activeSessionForDevice(state, target)?.id || ""));
      if (!authorizeSessionTransition(response, state, sessionTargets, "validated-emergency")) return true;
    }

    spendEmergencyToken(state);
    pending.status = "used";

    for (const sessionId of manualSessionIds) clearSessionsById(state, sessionId);
    for (const contributor of releasableContributors.filter((item) => item.kind === "schedule")) {
      state.overrides.push({
        id: randomUUID(),
        scheduleId: contributor.scheduleId,
        until: contributor.endsAt,
        reason: pending.reason,
        createdAt: confirmedAt.toISOString()
      });
    }
    for (const contributor of releasableContributors.filter((item) => item.kind === "planner")) {
      completeIntentionalPlanBlock(state, String(contributor.plannerBlockId), confirmedAt);
    }
    if (releasableLimitBlocks.length) {
      const releasedLimitIds = new Set(releasableLimitBlocks.map((block) => String(block.id || "")));
      overrideLimitRules(
        state,
        releasableLimitBlocks.map((block) => block.ruleId),
        releasableLimitBlocks.map((block) => block.until).sort().at(-1),
        pending.reason,
        confirmedAt
      );
      state.limitBlocks = (state.limitBlocks || []).filter((block: LimitBlock) => !releasedLimitIds.has(String(block.id || "")));
    }

    addEvent(state, "emergency_used", pending);
    context.recordIosMdmPolicyQueue("emergency-unlock");
    await saveState(state);
    sendJson(response, 200, {
      ok: true,
      remaining: emergencyRemaining(state),
      releasedPolicyContributors: releasableContributors,
      releasedLimitBlockIds: releasableLimitBlocks.map((block) => block.id)
    });
    return true;
  }

  return false;
}

export function previewManualSession(currentState: VigilState, body: UnknownRecord, now = new Date()): SessionPreviewSummary {
  const state = jsonClone(currentState);
  activePolicy(state, now);
  const draft = manualSessionDraft(state, body, { id: "preview", now });
  const conflicts = activeSessionConflicts(state, draft.deviceTargets);
  return buildSessionPreview(state, draft, conflicts, now);
}

async function previewManualSessionForRequest(
  currentState: VigilState,
  body: UnknownRecord,
  context: SessionApiContext,
  now = new Date()
): Promise<SessionPreviewSummary> {
  const state = jsonClone(currentState);
  activePolicy(state, now);
  const draft = manualSessionDraft(state, body, { id: "preview", now });
  const conflicts = activeSessionConflicts(state, draft.deviceTargets);
  if (!conflicts.length) {
    await context.assertStrictLockAllowed(draft.session.lockLevel, draft.profile, { mode: draft.session.mode });
  }
  return buildSessionPreview(state, draft, conflicts, now);
}

function manualSessionDraft(state: VigilState, body: UnknownRecord, options: ManualSessionDraftOptions = {}): ManualSessionDraft {
  const now = options.now || new Date();
  const deviceTargets = normalizeSessionDeviceTargets(body);
  const cycle = normalizeSessionCycle(body);
  const durationMinutes = cycle ? cycleDurationMinutes(cycle) : clampNumber(body.durationMinutes, 1, 60 * 24 * 45, 25);
  const ends = new Date(now.getTime() + durationMinutes * 60 * 1000);
  const lockLevel = normalizeLockLevel(body.lockLevel, state.settings.strictByDefault ? "deep" : "light");
  const mode = stringValue(body.mode, "focus");
  const profile = profileById(state, stringValue(body.profileId, state.settings.activeProfileId));
  const commitmentLock = lockLevel === "deep" && truthy(body.commitmentLock);
  const session: Session = {
    id: options.id || randomUUID(),
    title: stringValue(body.title, sessionTitle(mode)),
    mode,
    profileId: profile.id,
    lockLevel,
    startedAt: now.toISOString(),
    endsAt: ends.toISOString(),
    canEndEarly: lockLevel === "light",
    commitmentLock,
    emergencyUnlocksAllowed: !commitmentLock,
    source: "manual",
    deviceTargets,
    profileSnapshot: snapshotProfile(profile),
    ...(cycle ? { cycle } : {})
  };
  return {
    session,
    profile,
    deviceTargets,
    durationMinutes
  };
}

function buildSessionPreview(state: VigilState, draft: ManualSessionDraft, conflicts: DeviceTarget[], now: Date): SessionPreviewSummary {
  const previewState = jsonClone(state);
  installPreviewSession(previewState, draft);
  const phase = sessionPhase(draft.session, now);
  const policy: ActivePolicy = {
    kind: "manual",
    session: draft.session,
    profile: draft.session.profileSnapshot || snapshotProfile(draft.profile),
    endsAt: phase?.endsAt || draft.session.endsAt,
    phase
  };
  const phone = phonePreview(previewState, draft, now);
  return {
    title: draft.session.title,
    mode: draft.session.mode,
    profileName: policy.profile.name,
    profileMode: policy.profile.mode,
    lockLevel: draft.session.lockLevel,
    durationMinutes: draft.durationMinutes,
    endsAt: policy.endsAt,
    deviceTargets: draft.deviceTargets,
    deviceLabel: previewDeviceLabel(draft.deviceTargets),
    commitmentLock: Boolean(draft.session.commitmentLock),
    canEndEarly: draft.session.canEndEarly !== false,
    blockedApps: uniqueStrings(policy.profile.blockedApps),
    blockedSites: uniqueStrings(policy.profile.blockedSites),
    blockedUrlPatterns: uniqueStrings(policy.profile.blockedUrlPatterns),
    allowedApps: uniqueStrings(policy.profile.allowedApps),
    allowedSites: uniqueStrings(policy.profile.allowedSites),
    protections: browserProtectionPreview(previewState, policy),
    conflicts,
    phone
  };
}

function installPreviewSession(state: VigilState, draft: ManualSessionDraft): void {
  state.panicLock = null;
  state.activeSessions = {
    computer: state.activeSessions?.computer || state.activeSession || null,
    phone: state.activeSessions?.phone || null
  };
  for (const target of draft.deviceTargets) {
    state.activeSessions[target] = draft.session;
  }
  state.activeSession = state.activeSessions.computer || null;
}

function browserProtectionPreview(state: VigilState, policy: ActivePolicy): string[] {
  const protections: string[] = [];
  const browserControlLabels = uniqueStrings([
    "chrome://extensions",
    "chrome://settings",
    "edge://extensions",
    "brave://settings",
    "arc://extensions"
  ].map((url) => matchStrictBrowserControlUrl(state, policy, url)?.label).filter(isString));
  if (browserControlLabels.length) protections.push("Browser settings and extensions controls");
  if (state.settings?.browserNoiseBlockingEnabled !== false) protections.push("Browser cleanup rules");
  if (state.settings?.siteRedirectEnabled) protections.push("Blocked-site redirect fallback");
  if (state.settings?.safariUrlFilterEnabled && policyUsesWebTargets(policy.profile)) protections.push("Safari URL filter");
  if (state.settings?.appQuitEnabled && policyUsesAppTargets(policy.profile)) protections.push("App quit enforcement");
  if (state.settings?.processSweepEnabled && policy.session.lockLevel === "deep") protections.push("Background process sweep");
  return uniqueStrings(protections);
}

function phonePreview(state: VigilState, draft: ManualSessionDraft, now: Date): SessionPreviewSummary["phone"] {
  const targeted = draft.deviceTargets.includes("phone");
  if (!targeted) {
    return {
      targeted: false,
      ready: false,
      status: "Not targeted",
      detail: "This manual lock will only affect the Mac.",
      blockers: [],
      appCount: 0,
      siteCount: 0,
      mode: "off"
    };
  }

  const ios = state.deviceControls?.ios;
  const mdm = iosMdmSummary(state, now);
  const targets = iosPolicyTargets(state, now);
  const ready = Boolean(ios?.enabled || mdm.enrollmentReady);
  const blockers = mdm.blockers?.length ? mdm.blockers.map(String) : [];
  if (mdm.ready && (mdm.enrolledDeviceCount || 0) > 0) {
    return {
      targeted,
      ready: true,
      status: "Advanced MDM ready",
      detail: `${mdm.enrolledDeviceCount || 0} self-hosted enrolled iPhone${mdm.enrolledDeviceCount === 1 ? "" : "s"}; ManageEngine remains the normal free delivery path.`,
      blockers: [],
      appCount: targets.appBundleIds.length,
      siteCount: targets.webMode === "allowlist" ? targets.allowedUrls.length : targets.deniedUrls.length,
      mode: targets.webMode
    };
  }

  if (mdm.enrollmentReady) {
    return {
      targeted,
      ready: true,
      status: "Advanced queue ready",
      detail: mdm.note || "Self-hosted commands can be queued, but ManageEngine is the normal free delivery path.",
      blockers,
      appCount: targets.appBundleIds.length,
      siteCount: targets.webMode === "allowlist" ? targets.allowedUrls.length : targets.deniedUrls.length,
      mode: targets.webMode
    };
  }

  if (ios?.enabled) {
    return {
      targeted,
      ready: true,
      status: "ManageEngine export ready",
      detail: "Vigil will generate the supervised profile; assign it through ManageEngine for normal remote delivery.",
      blockers,
      appCount: targets.appBundleIds.length,
      siteCount: targets.webMode === "allowlist" ? targets.allowedUrls.length : targets.deniedUrls.length,
      mode: targets.webMode
    };
  }

  return {
    targeted,
    ready,
    status: "Setup needed",
    detail: "Enable supervised iPhone policy, export it, then assign it through ManageEngine.",
    blockers,
    appCount: targets.appBundleIds.length,
    siteCount: targets.webMode === "allowlist" ? targets.allowedUrls.length : targets.deniedUrls.length,
    mode: targets.webMode
  };
}

function policyUsesAppTargets(profile: Profile): boolean {
  return profile.mode === "allowlist" || Boolean((profile.blockedApps || []).length);
}

function policyUsesWebTargets(profile: Profile): boolean {
  return profile.mode === "allowlist" || Boolean((profile.blockedSites || []).length || (profile.blockedUrlPatterns || []).length);
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

function emergencyRemaining(state: VigilState): number {
  const used = state.emergency.tokensUsedByWeek[weekKey()] || 0;
  return Math.max(0, state.settings.emergencyTokensPerWeek - used);
}

function panicLockDurationMinutes(state: VigilState): number {
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

function activeSessionConflicts(state: VigilState, targets: DeviceTarget[]): DeviceTarget[] {
  state.activeSessions ||= { computer: state.activeSession || null, phone: null };
  return targets.filter((target) => Boolean(activeSessionForDevice(state, target)));
}

function activeEmergencyPolicy(state: VigilState, now = new Date()): ActivePolicy | null {
  const policies = DEVICE_TARGETS
    .map((target) => activePolicy(state, now, { device: target }))
    .filter((policy): policy is ActivePolicy => Boolean(policy));
  const selected = policies.find((policy) => !emergencyUnlockAllowedForPolicy(policy))
    || policies.find((policy) => !policy.session.canEndEarly)
    || policies[0]
    || null;
  if (!selected) return null;

  const matchingPolicies = policies.filter((policy) => (
    policy.kind === selected.kind && policy.session.id === selected.session.id
  ));
  const contributors = uniqueActivePolicyContributors(
    matchingPolicies.flatMap((policy) => policy.contributors || [])
  );
  return contributors.length ? { ...selected, contributors } : selected;
}

function emergencyPolicyContributors(policy: ActivePolicy): EmergencyPolicyContributor[] {
  const contributors: ActivePolicyContributor[] = policy.contributors?.length
    ? policy.contributors
    : [{
        kind: policy.kind,
        sessionId: policy.session.id,
        profileId: policy.profile.id,
        endsAt: policy.endsAt,
        scheduleId: policy.schedule?.id,
        plannerBlockId: policy.plannerBlock?.id,
        emergencyUnlocksAllowed: emergencyUnlockAllowedForPolicy(policy)
      }];
  const snapshots: EmergencyPolicyContributor[] = [];
  for (const contributor of contributors) {
    if (!isEmergencyPolicyContributorKind(contributor.kind)) continue;
    if (!contributor.sessionId || !contributor.profileId) continue;
    if (contributor.kind === "schedule" && !contributor.scheduleId) continue;
    if (contributor.kind === "planner" && !contributor.plannerBlockId) continue;
    snapshots.push({
      kind: contributor.kind,
      sessionId: contributor.sessionId,
      profileId: contributor.profileId,
      endsAt: contributor.endsAt,
      scheduleId: contributor.scheduleId,
      plannerBlockId: contributor.plannerBlockId,
      emergencyUnlocksAllowed: contributor.emergencyUnlocksAllowed !== false
    });
  }
  return uniqueEmergencyPolicyContributors(snapshots);
}

function currentEmergencyPolicyContributors(state: VigilState, now: Date): EmergencyPolicyContributor[] {
  return uniqueEmergencyPolicyContributors(
    DEVICE_TARGETS.flatMap((target) => {
      const policy = activePolicy(state, now, { device: target });
      return policy ? emergencyPolicyContributors(policy) : [];
    })
  );
}

function emergencyRequestContributors(request: EmergencyRequest): EmergencyPolicyContributor[] {
  const snapshots = Array.isArray(request.policyContributors)
    ? request.policyContributors.map(normalizeEmergencyPolicyContributor).filter((item): item is EmergencyPolicyContributor => Boolean(item))
    : [];
  return uniqueEmergencyPolicyContributors(snapshots);
}

function normalizeEmergencyPolicyContributor(value: unknown): EmergencyPolicyContributor | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as UnknownRecord;
  const kind = record.kind;
  if (!isEmergencyPolicyContributorKind(kind)) return null;
  const sessionId = String(record.sessionId || "").trim();
  const profileId = String(record.profileId || "").trim();
  const endsAt = String(record.endsAt || "").trim();
  const scheduleId = String(record.scheduleId || "").trim() || undefined;
  const plannerBlockId = String(record.plannerBlockId || "").trim() || undefined;
  if (!sessionId || !profileId || !endsAt) return null;
  if (kind === "schedule" && !scheduleId) return null;
  if (kind === "planner" && !plannerBlockId) return null;
  return {
    kind,
    sessionId,
    profileId,
    endsAt,
    scheduleId,
    plannerBlockId,
    emergencyUnlocksAllowed: record.emergencyUnlocksAllowed !== false
  };
}

function emergencyContributorMatches(
  requested: EmergencyPolicyContributor,
  current: EmergencyPolicyContributor
): boolean {
  if (requested.kind !== current.kind || requested.sessionId !== current.sessionId) return false;
  if (requested.profileId !== current.profileId) return false;
  if (requested.kind === "manual") return true;
  if (requested.endsAt !== current.endsAt) return false;
  if (requested.kind === "schedule") return requested.scheduleId === current.scheduleId;
  return requested.plannerBlockId === current.plannerBlockId;
}

function uniqueEmergencyPolicyContributors(values: EmergencyPolicyContributor[]): EmergencyPolicyContributor[] {
  const unique = new Map<string, EmergencyPolicyContributor>();
  for (const value of values) unique.set(emergencyPolicyContributorKey(value), value);
  return [...unique.values()];
}

function emergencyPolicyContributorKey(contributor: EmergencyPolicyContributor): string {
  const boundary = contributor.kind === "manual" ? "" : contributor.endsAt;
  return [
    contributor.kind,
    contributor.sessionId,
    contributor.profileId,
    boundary,
    contributor.scheduleId || "",
    contributor.plannerBlockId || ""
  ].join("\u0000");
}

function uniqueActivePolicyContributors(values: ActivePolicyContributor[]): ActivePolicyContributor[] {
  const unique = new Map<string, ActivePolicyContributor>();
  for (const value of values) {
    const key = [
      value.kind,
      value.sessionId,
      value.profileId,
      value.endsAt,
      value.scheduleId || "",
      value.plannerBlockId || ""
    ].join("\u0000");
    unique.set(key, value);
  }
  return [...unique.values()];
}

function isEmergencyPolicyContributorKind(value: unknown): value is EmergencyPolicyContributor["kind"] {
  return value === "manual" || value === "schedule" || value === "planner";
}

function startDeviceSession(state: VigilState, targets: DeviceTarget[], session: Session): void {
  state.activeSessions ||= { computer: null, phone: null };
  for (const target of targets) {
    state.activeSessions[target] = session;
  }
  state.activeSession = state.activeSessions.computer || null;
}

function clearDeviceSession(state: VigilState, target: unknown): void {
  const device = normalizeDeviceTarget(target);
  state.activeSessions ||= { computer: state.activeSession || null, phone: null };
  state.activeSessions[device] = null;
  state.activeSession = state.activeSessions.computer || null;
}

function authorizeSessionTransition(
  response: ServerResponse,
  state: VigilState,
  targets: readonly DeviceTarget[],
  authorization: "standard" | "validated-emergency" = "standard"
): boolean {
  try {
    assertSessionTransitionAllowed(state, targets, { authorization });
    return true;
  } catch (error) {
    sendJson(response, errorStatus(error), serializeError(error));
    return false;
  }
}

export function sessionIsActive(state: VigilState, sessionId: unknown): boolean {
  if (!sessionId) return false;
  if (state.activeSession?.id === sessionId) return true;
  return DEVICE_TARGETS.some((target) => state.activeSessions?.[target]?.id === sessionId);
}

function deviceLabel(targets: DeviceTarget[]): string {
  return targets.map((target) => target === "phone" ? "phone" : "computer").join(" and ");
}

function previewDeviceLabel(targets: DeviceTarget[]): string {
  if (targets.includes("computer") && targets.includes("phone")) return "Computer + iPhone";
  return targets.includes("phone") ? "iPhone" : "Computer";
}

function spendEmergencyToken(state: VigilState): void {
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

function uniqueStrings(values: readonly unknown[] = []): string[] {
  return [...new Set(values.map((item) => String(item || "").trim()).filter(Boolean))];
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
