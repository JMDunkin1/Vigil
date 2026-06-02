import { activePolicy } from "./policy.js";
import { activeLimitBlocks } from "./limits.js";
import { integrityLockdownActive } from "./integrityLockdown.js";
import { assertTypingChallenge, attachTypingChallenge } from "./challenge.js";
import { assertIntentReason } from "./intentReason.js";
import type { AppLockRule, MaintenanceRequest, MaintenanceWindow, VigilState } from "./types.js";

interface ProtectionAction {
  kind: string;
  id?: string;
}

export interface ProtectionBlocker {
  kind: string;
  id: string;
  name: string;
  reason: string;
}

interface MaintenanceConfirmInput {
  challengeText?: unknown;
}

export class ProtectionError extends Error {
  status: number;
  blockers: ProtectionBlocker[];

  constructor(message: string, blockers: ProtectionBlocker[] = []) {
    super(message);
    this.status = 423;
    this.blockers = blockers;
  }
}

export function assertProtectedEditAllowed(state: VigilState, action: Partial<ProtectionAction>, now = new Date()): void {
  const blockers = protectedEditBlockers(state, action, now);
  if (blockers.length) {
    throw new ProtectionError("Protected edits are locked. Open a maintenance window before weakening active protection.", blockers);
  }
}

export function protectedEditBlockers(state: VigilState, action: Partial<ProtectionAction> = {}, now = new Date()): ProtectionBlocker[] {
  cleanupMaintenance(state, now);
  const lockdown = integrityLockdownActive(state);
  if (!state.settings.protectedEditsEnabled && !lockdown) return [];
  if (activeMaintenanceWindow(state, now)) return [];

  const blockers: ProtectionBlocker[] = [];
  const active = activePolicy(state, now);
  if ((active?.session?.lockLevel === "deep" || active?.kind === "integrity") && guardedKind(action.kind)) {
    blockers.push({
      kind: active.kind,
      id: active.session.id,
      name: active.session.title,
      reason: active.kind === "integrity" ? "State tampering triggered integrity lockdown" : "A strict session is active"
    });
  }

  for (const block of activeLimitBlocks(state, now)) {
    if (action.kind === "settings" || (action.kind === "limit" && (!action.id || action.id === block.ruleId))) {
      blockers.push({
        kind: "limit",
        id: block.ruleId,
        name: block.ruleName,
        reason: "A time/open limit block is active"
      });
    }
  }

  for (const lock of enabledStrictAppLocks(state, now)) {
    if (action.kind === "settings" || (action.kind === "app-lock" && (!action.id || action.id === lock.id))) {
      blockers.push({
        kind: "app-lock",
        id: lock.id,
        name: lock.name,
        reason: "A strict App Lock is enabled"
      });
    }
  }

  return dedupeBlockers(blockers);
}

export function protectionSummary(state: VigilState, now = new Date()) {
  cleanupMaintenance(state, now);
  const lockdown = integrityLockdownActive(state);
  return {
    enabled: Boolean(state.settings.protectedEditsEnabled || lockdown),
    delaySeconds: state.settings.protectedEditDelaySeconds,
    windowMinutes: state.settings.protectedEditWindowMinutes,
    activeWindow: activeMaintenanceWindow(state, now),
    pending: (state.maintenance?.pending || []).filter((request) => request.status === "pending"),
    blockers: protectedEditBlockers(state, { kind: "settings" }, now)
  };
}

export function requestMaintenanceWindow(state: VigilState, reason: unknown = "", now = new Date()): { activeWindow?: MaintenanceWindow; pending?: MaintenanceRequest } {
  cleanupMaintenance(state, now);
  state.maintenance ||= { pending: [], windows: [] };

  const active = activeMaintenanceWindow(state, now);
  if (active) return { activeWindow: active };

  const existing = (state.maintenance.pending || []).find((request) => request.status === "pending" && new Date(request.expiresAt) > now);
  if (existing) return { pending: attachTypingChallenge(state, existing, "maintenance", now) };

  const delaySeconds = Math.max(0, Number(state.settings.protectedEditDelaySeconds || 0));
  const pending: MaintenanceRequest = {
    id: crypto.randomUUID(),
    status: "pending",
    reason: assertIntentReason(state, reason, "Maintenance window"),
    requestedAt: now.toISOString(),
    eligibleAt: new Date(now.getTime() + delaySeconds * 1000).toISOString(),
    expiresAt: new Date(now.getTime() + Math.max(delaySeconds + 60, 15 * 60) * 1000).toISOString()
  };
  attachTypingChallenge(state, pending, "maintenance", now);
  state.maintenance.pending.push(pending);
  return { pending };
}

export function confirmMaintenanceWindow(
  state: VigilState,
  requestId: string,
  input: MaintenanceConfirmInput | Date = {},
  now = new Date()
): MaintenanceWindow {
  if (input instanceof Date) {
    now = input;
    input = {};
  }
  cleanupMaintenance(state, now);
  const request = (state.maintenance?.pending || []).find((item) => item.id === requestId && item.status === "pending");
  if (!request) throw new ProtectionError("Maintenance request not found or expired");
  if (new Date(request.eligibleAt) > now) throw new ProtectionError("Maintenance cooldown is still running");
  assertTypingChallenge(state, request, input.challengeText);

  request.status = "used";
  const minutes = Math.max(1, Number(state.settings.protectedEditWindowMinutes || 10));
  const window: MaintenanceWindow = {
    id: crypto.randomUUID(),
    requestId,
    reason: request.reason,
    createdAt: now.toISOString(),
    until: new Date(now.getTime() + minutes * 60 * 1000).toISOString()
  };
  state.maintenance ||= { pending: [], windows: [] };
  state.maintenance.windows.push(window);
  return window;
}

export function activeMaintenanceWindow(state: VigilState, now = new Date()): MaintenanceWindow | null {
  return (state.maintenance?.windows || []).find((window) => new Date(window.until) > now) || null;
}

function cleanupMaintenance(state: VigilState, now: Date): void {
  state.maintenance ||= { pending: [], windows: [] };
  state.maintenance.pending = (state.maintenance.pending || []).filter((request) => {
    return request.status === "pending" && new Date(request.expiresAt) > now;
  });
  state.maintenance.windows = (state.maintenance.windows || []).filter((window) => new Date(window.until) > now);
}

function enabledStrictAppLocks(state: VigilState, now: Date): AppLockRule[] {
  return (state.appLocks || []).filter((lock) => {
    if (!lock.enabled || lock.lockLevel !== "deep") return false;
    const days = new Set(lock.days || []);
    return days.size === 0 || days.has(now.getDay());
  });
}

function guardedKind(kind: unknown): boolean {
  return typeof kind === "string" && ["settings", "profile", "schedule", "limit", "app-lock", "devices"].includes(kind);
}

function dedupeBlockers(blockers: ProtectionBlocker[]): ProtectionBlocker[] {
  const seen = new Set<string>();
  return blockers.filter((blocker) => {
    const key = `${blocker.kind}:${blocker.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
