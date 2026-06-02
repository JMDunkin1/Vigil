import { dateKey } from "./time.js";
import { assertTypingChallenge, attachTypingChallenge } from "./challenge.js";
import { parseBoolean } from "./booleans.js";
import { assertIntentReason } from "./intentReason.js";
import {
  appMatchesAppTargets,
  expandAppTargets,
  expandSiteTargets,
  hostMatchesSiteTargets,
  isStrictEmbeddedBrowserApp,
  isStrictUnsupportedBrowser,
  normalizeLockLevel,
  normalizeHost
} from "./policy.js";
import type { ActivePolicy, AppLockRequest, AppLockRule, AppLockUnlock, VigilState, UnknownRecord, UsageSample } from "./types.js";

type TargetLists = { apps: string[]; sites: string[] };
type UnlockInput = UnknownRecord & { challengeText?: string };

export function activeAppLockPolicy(state: VigilState, sample: UsageSample, now = new Date()): ActivePolicy | null {
  cleanupAppLockState(state, now);
  if (!sample?.app) return null;

  for (const lock of (state.appLocks || []).filter((item) => item.enabled)) {
    if (!appliesToday(lock, now) || !sampleMatchesLock(state, lock, sample)) continue;
    if (hasActiveUnlock(state, lock.id, now)) continue;
    return policyFromLock(lock, now);
  }

  return null;
}

export function activeAppLockUnlockForSample(state: VigilState, sample: UsageSample, now = new Date()): AppLockUnlock | null {
  cleanupAppLockState(state, now);
  if (!sample?.app) return null;

  for (const lock of (state.appLocks || []).filter((item) => item.enabled)) {
    if (!appliesToday(lock, now) || !sampleMatchesLock(state, lock, sample)) continue;
    const unlock = activeUnlockFor(state, lock.id, now);
    if (unlock) return unlock;
  }

  return null;
}

export function appLockSummary(state: VigilState, now = new Date()) {
  cleanupAppLockState(state, now);
  return {
    rules: (state.appLocks || []).map((lock) => ({
      ...lock,
      usedToday: usedToday(state, lock.id, now),
      remainingToday: remainingUnlocks(state, lock, now),
      activeUnlock: activeUnlockFor(state, lock.id, now),
      pendingRequest: pendingRequestFor(state, lock.id, now)
    })),
    activeUnlocks: (state.appLockUnlocks || []).filter((unlock) => new Date(unlock.until) > now),
    pendingRequests: (state.appLockRequests || []).filter((request) => request.status === "pending" && new Date(request.expiresAt) > now)
  };
}

export function normalizeAppLock(body: UnknownRecord, existing: Partial<AppLockRule> | undefined, fallbackId: string): AppLockRule {
  return {
    id: String(body.id || existing?.id || fallbackId),
    name: String(body.name || existing?.name || "App lock").slice(0, 80),
    enabled: body.enabled === undefined ? Boolean(existing?.enabled) : parseBoolean(body.enabled, false),
    lockLevel: normalizeLockLevel(body.lockLevel, existing?.lockLevel || "deep"),
    days: normalizeDays(body.days ?? existing?.days ?? [0, 1, 2, 3, 4, 5, 6]),
    apps: normalizeTargets(body.apps ?? existing?.apps),
    sites: normalizeTargets(body.sites ?? existing?.sites).map(normalizeHost).filter(Boolean),
    unlocksAllowed: clampInteger(body.unlocksAllowed ?? existing?.unlocksAllowed, 0, 200, 2),
    unlockMinutes: clampInteger(body.unlockMinutes ?? existing?.unlockMinutes, 1, 24 * 60, 10),
    delaySeconds: clampInteger(body.delaySeconds ?? existing?.delaySeconds, 0, 3600, 30)
  };
}

export function requestAppLockUnlock(state: VigilState, lockId: string, reason = "", now = new Date()): AppLockRequest {
  cleanupAppLockState(state, now);
  const lock = findLock(state, lockId);
  if (!lock || !lock.enabled) throw new AppLockError("App lock not found or disabled", 404);
  if (remainingUnlocks(state, lock, now) <= 0) throw new AppLockError("No unlocks remain today for this app lock", 429);

  const existing = pendingRequestFor(state, lock.id, now);
  if (existing) return attachTypingChallenge(state, existing, "app-lock", now);

  const request = {
    id: crypto.randomUUID(),
    lockId: lock.id,
    status: "pending",
    reason: assertIntentReason(state, reason, "App Lock unlock"),
    requestedAt: now.toISOString(),
    eligibleAt: new Date(now.getTime() + (lock.delaySeconds || 0) * 1000).toISOString(),
    expiresAt: new Date(now.getTime() + 15 * 60 * 1000).toISOString()
  };
  attachTypingChallenge(state, request, "app-lock", now);
  state.appLockRequests ||= [];
  state.appLockRequests.push(request);
  return request;
}

export function confirmAppLockUnlock(state: VigilState, requestId: string, input: UnlockInput | Date = {}, now = new Date()): AppLockUnlock {
  if (input instanceof Date) {
    now = input;
    input = {};
  }
  cleanupAppLockState(state, now);
  const request = (state.appLockRequests || []).find((item) => item.id === requestId && item.status === "pending");
  if (!request) throw new AppLockError("Unlock request not found or expired", 404);
  if (new Date(request.eligibleAt) > now) throw new AppLockError("Unlock cooldown is still running", 425);
  assertTypingChallenge(state, request, input.challengeText);

  const lock = findLock(state, request.lockId);
  if (!lock || !lock.enabled) throw new AppLockError("App lock not found or disabled", 404);
  if (remainingUnlocks(state, lock, now) <= 0) throw new AppLockError("No unlocks remain today for this app lock", 429);

  request.status = "used";
  bumpLedger(state, lock.id, now);
  const unlock = {
    id: crypto.randomUUID(),
    lockId: lock.id,
    lockName: lock.name,
    createdAt: now.toISOString(),
    until: new Date(now.getTime() + lock.unlockMinutes * 60 * 1000).toISOString(),
    reason: request.reason
  };
  state.appLockUnlocks ||= [];
  state.appLockUnlocks.push(unlock);
  return unlock;
}

export class AppLockError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

function policyFromLock(lock: AppLockRule, now: Date): ActivePolicy {
  return {
    kind: "app-lock",
    appLock: lock,
    session: {
      id: `app-lock:${lock.id}`,
      title: lock.name,
      mode: "app-lock",
      profileId: `app-lock:${lock.id}`,
      lockLevel: lock.lockLevel || "deep",
      startedAt: now.toISOString(),
      endsAt: "the end of today",
      canEndEarly: false,
      source: "app-lock",
      lockId: lock.id
    },
    profile: {
      id: `app-lock:${lock.id}`,
      name: lock.name,
      mode: "blocklist",
      blockedApps: expandAppTargets(lock.apps),
      blockedSites: expandSiteTargets(lock.sites),
      blockedUrlPatterns: [],
      allowedApps: [],
      allowedSites: []
    },
    endsAt: "the end of today"
  };
}

function findLock(state: VigilState, lockId: string): AppLockRule | undefined {
  return (state.appLocks || []).find((lock) => lock.id === lockId);
}

function hasActiveUnlock(state: VigilState, lockId: string, now: Date): boolean {
  return Boolean(activeUnlockFor(state, lockId, now));
}

function activeUnlockFor(state: VigilState, lockId: string, now: Date): AppLockUnlock | null {
  return (state.appLockUnlocks || []).find((unlock) => unlock.lockId === lockId && new Date(unlock.until) > now) || null;
}

function pendingRequestFor(state: VigilState, lockId: string, now: Date): AppLockRequest | null {
  return (state.appLockRequests || []).find((request) => {
    return request.lockId === lockId && request.status === "pending" && new Date(request.expiresAt) > now;
  }) || null;
}

function remainingUnlocks(state: VigilState, lock: AppLockRule, now: Date): number {
  return Math.max(0, (lock.unlocksAllowed || 0) - usedToday(state, lock.id, now));
}

function usedToday(state: VigilState, lockId: string, now: Date): number {
  return state.appLockLedger?.[dateKey(now)]?.[lockId] || 0;
}

function bumpLedger(state: VigilState, lockId: string, now: Date): void {
  const key = dateKey(now);
  state.appLockLedger ||= {};
  state.appLockLedger[key] ||= {};
  state.appLockLedger[key][lockId] = (state.appLockLedger[key][lockId] || 0) + 1;
}

function sampleMatchesLock(state: VigilState, lock: AppLockRule, sample: UsageSample): boolean {
  const lists = targetLists(lock);
  if (shouldGuardSiteBypassApp(state, lock, sample, lists)) return true;
  if (appMatchesAppTargets(sample.app || "", lists.apps)) return true;
  return hostMatchesSiteTargets(sample.hostname || "", lists.sites);
}

function targetLists(lock: AppLockRule): TargetLists {
  return {
    apps: expandAppTargets(lock.apps),
    sites: expandSiteTargets(lock.sites)
  };
}

function appliesToday(lock: AppLockRule, now: Date): boolean {
  const days = new Set(lock.days || []);
  return days.size === 0 || days.has(now.getDay());
}

function shouldGuardSiteBypassApp(state: VigilState, lock: AppLockRule, sample: UsageSample, lists: TargetLists): boolean {
  const app = sample.app || "";
  return Boolean(
    state.settings?.strictBypassProtectionEnabled !== false &&
    (lock.lockLevel || "deep") === "deep" &&
    lists.sites.length &&
    (isStrictUnsupportedBrowser(app) || isStrictEmbeddedBrowserApp(app))
  );
}

function cleanupAppLockState(state: VigilState, now: Date): void {
  state.appLockUnlocks = (state.appLockUnlocks || []).filter((unlock) => new Date(unlock.until) > now);
  state.appLockRequests = (state.appLockRequests || []).filter((request) => {
    return request.status === "pending" && new Date(request.expiresAt) > now;
  });
}

function normalizeTargets(value: unknown): string[] {
  if (Array.isArray(value)) {
    return [...new Set(value.map((item) => String(item).trim()).filter(Boolean))];
  }
  return [...new Set(String(value || "")
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean))];
}

function normalizeDays(value: unknown): number[] {
  const values = Array.isArray(value) ? value : [];
  return [...new Set(values.map(Number).filter((day) => day >= 0 && day <= 6))].sort();
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number.parseInt(String(value), 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}
