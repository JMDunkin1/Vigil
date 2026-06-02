export const days: Array<[string, string]> = [
  ["0", "Sun"],
  ["1", "Mon"],
  ["2", "Tue"],
  ["3", "Wed"],
  ["4", "Thu"],
  ["5", "Fri"],
  ["6", "Sat"]
];

interface RuleLike {
  type?: string;
}

interface PhaseLike {
  kind?: string;
  label: string;
  round: number;
  rounds: number;
}

interface SessionLike {
  title?: string;
}

interface EventLike {
  type: string;
  detail?: Record<string, unknown>;
}

interface EnforcementLike {
  target?: string;
  escalated?: boolean;
  result?: {
    method?: string;
    error?: string;
  };
}

interface SweepLike {
  ok?: boolean;
  blocked?: unknown[];
  checked?: number;
}

interface SystemSleepLockLike {
  ok?: boolean;
  at?: string | number | Date;
}

export function lines(value: unknown): string[] {
  return String(value || "")
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function daysText(values: number[] = []): string {
  if (!values?.length) return "no days";
  if (values.length === 7) return "daily";
  const labels = new Map(days.map(([value, label]) => [Number(value), label]));
  return values.map((day) => labels.get(day)).join(", ");
}

export function daysWithDataText(value: unknown): string {
  const count = Number(value || 0);
  return `${count} ${count === 1 ? "day" : "days"} with data`;
}

export function formatDuration(seconds: unknown): string {
  const safe = Math.max(0, Number(seconds || 0));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const rest = hours % 24;
    return rest ? `${days}d ${rest}h` : `${days}d`;
  }
  if (hours) return `${hours}h ${minutes}m`;
  return `${Math.max(0, minutes)}m`;
}

export function progressText(rule: RuleLike, used: unknown, cap: unknown): string {
  if (rule.type === "open") return `${used}/${cap} opens`;
  return `${formatDuration(used)}/${formatDuration(cap)}`;
}

export function shortDate(value: unknown): string {
  return new Date(String(value || "")).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function shortDateTime(value: unknown): string {
  const date = new Date(String(value || ""));
  if (Number.isNaN(date.getTime())) return "--";
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function signedNumber(value: unknown, suffix = ""): string {
  const safe = Number(value || 0);
  if (!safe) return `0${suffix}`;
  return `${safe > 0 ? "+" : ""}${safe}${suffix}`;
}

export function signedPercent(value: unknown): string {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "No baseline";
  return signedNumber(Math.round(Number(value)), "%");
}

export function signedDuration(seconds: unknown): string {
  const safe = Number(seconds || 0);
  if (!safe) return "0m";
  return `${safe > 0 ? "+" : "-"}${formatDuration(Math.abs(safe))}`;
}

export function phaseText(phase: PhaseLike | null | undefined, fallback = "focus"): string {
  if (!phase) return capitalize(fallback);
  if (phase.kind === "break") return `Break ${phase.round}/${phase.rounds}`;
  if (phase.rounds > 1) return `Focus ${phase.round}/${phase.rounds}`;
  return capitalize(fallback);
}

export function phaseTitle(session: SessionLike | null | undefined, phase: PhaseLike | null | undefined): string {
  if (!phase) return session?.title || "Session running";
  const base = session?.title || "Focus lock";
  if (phase.rounds <= 1) return base;
  return `${base} | ${phase.label} ${phase.round}/${phase.rounds}`;
}

export function capitalize(value: unknown): string {
  return String(value || "").slice(0, 1).toUpperCase() + String(value || "").slice(1);
}

export function eventLabel(event: EventLike): string {
  const type = event.type.replaceAll("_", " ");
  const detail = event.detail || {};
  if (detail.app) return `${type}: ${detail.app}`;
  if (detail.site) return `${type}: ${detail.site}`;
  if (detail.name) return `${type}: ${detail.name}`;
  return type;
}

export function enforcementText(enforcement: EnforcementLike): string {
  const method = enforcement.result?.method || enforcement.result?.error || "";
  const suffix = enforcement.escalated ? " | force kill" : (method ? ` | ${method}` : "");
  return `${enforcement.target || "target"}${suffix}`;
}

export function sweepText(sweep: SweepLike | null | undefined): string {
  if (!sweep) return "--";
  if (!sweep.ok) return "check";
  if (sweep.blocked?.length) return `${sweep.blocked.length} blocked`;
  return `${sweep.checked || 0} checked`;
}

export function systemSleepLockText(lock: SystemSleepLockLike | null | undefined): string {
  if (!lock) return "off";
  if (!lock.ok) return "check";
  if (!lock.at) return "check";
  return `last ${new Date(lock.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}
