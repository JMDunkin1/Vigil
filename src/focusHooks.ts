import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ActivePolicy, VigilState, UnknownRecord } from "./types.js";

const execFileAsync = promisify(execFile);

export function focusShortcutSummary(state: VigilState) {
  const settings = state.settings;
  const status = state.focusShortcut;
  return {
    enabled: Boolean(settings.focusShortcutEnabled),
    onShortcutName: settings.focusShortcutOnName || "",
    offShortcutName: settings.focusShortcutOffName || "",
    active: Boolean(status.active),
    desiredActive: Boolean(status.desiredActive),
    lastAction: status.lastAction || "",
    lastShortcutName: status.lastShortcutName || "",
    lastAppliedAt: status.lastAppliedAt || null,
    lastCheckedAt: status.lastCheckedAt || null,
    lastError: status.lastError || "",
    lastPolicy: status.lastPolicy || ""
  };
}

export async function reconcileFocusShortcut(state: VigilState, policy: ActivePolicy | null, now = new Date()) {
  const settings = state.settings;
  const status = state.focusShortcut;
  const enabled = Boolean(settings.focusShortcutEnabled);
  const desiredActive = Boolean(enabled && policy);
  const active = Boolean(status.active);

  status.desiredActive = desiredActive;
  status.lastCheckedAt = now.toISOString();
  status.lastPolicy = policy?.session?.title || policy?.kind || "";

  if (active === desiredActive) {
    return { ...focusShortcutSummary(state), ok: true, changed: false };
  }

  const shortcutName = desiredActive
    ? String(settings.focusShortcutOnName || "").trim()
    : String(settings.focusShortcutOffName || "").trim();

  if (!shortcutName) {
    status.lastError = desiredActive
      ? "Focus On shortcut name is required."
      : "Focus Off shortcut name is required.";
    return { ...focusShortcutSummary(state), ok: false, changed: false };
  }

  try {
    await runShortcut(shortcutName);
    status.active = desiredActive;
    status.lastAction = desiredActive ? "on" : "off";
    status.lastShortcutName = shortcutName;
    status.lastAppliedAt = now.toISOString();
    status.lastError = "";
    return { ...focusShortcutSummary(state), ok: true, changed: true };
  } catch (error) {
    status.lastError = simplifyError(error) || `Could not run shortcut "${shortcutName}".`;
    return { ...focusShortcutSummary(state), ok: false, changed: false };
  }
}

export function focusShortcutDetail(summary: ReturnType<typeof focusShortcutSummary>): string {
  if (!summary.enabled && !summary.active) return "macOS Focus shortcut hooks are disabled.";
  if (summary.lastError) return summary.lastError;
  if (summary.active) {
    return summary.lastShortcutName
      ? `Focus hook is active via "${summary.lastShortcutName}".`
      : "Focus hook is active.";
  }
  if (summary.enabled) return "Focus hooks are ready for the next active lock.";
  return "Focus hook was cleared.";
}

async function runShortcut(name: string): Promise<void> {
  await execFileAsync("/usr/bin/shortcuts", ["run", name], {
    timeout: 10_000,
    maxBuffer: 1024 * 64
  });
}

function simplifyError(error: unknown): string {
  const record = typeof error === "object" && error !== null ? error as UnknownRecord : {};
  return String(record.stderr || record.message || error || "").trim().split("\n").at(-1) || "";
}
