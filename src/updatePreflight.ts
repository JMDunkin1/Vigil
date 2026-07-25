export type UpdatePreflightCheckStatus = "pass" | "fail" | "blocked";

export interface UpdatePreflightCheck {
  code: string;
  label: string;
  status: UpdatePreflightCheckStatus;
  message: string;
  detail: string | null;
}

export interface UpdatePreflightReport {
  ok: boolean;
  checkedAt: string;
  checks: UpdatePreflightCheck[];
  failures: UpdatePreflightCheck[];
}

export interface UpdatePreflightCheckResult {
  status?: UpdatePreflightCheckStatus;
  message?: string;
  detail?: string | null;
}

export interface UpdatePreflightCheckDefinition {
  code: string;
  label: string;
  run(): UpdatePreflightCheckResult | Promise<UpdatePreflightCheckResult>;
}

const CHECK_CODE_PATTERN = /^vigil\.update\.[a-z0-9]+(?:[.-][a-z0-9]+)*$/u;
const MAX_DIAGNOSTIC_LENGTH = 2_000;

/**
 * Run every independent preflight check and preserve definition order in the
 * report. A thrown check is a named failure, never a generic updater error.
 */
export async function collectUpdatePreflight(
  definitions: readonly UpdatePreflightCheckDefinition[],
  now = new Date()
): Promise<UpdatePreflightReport> {
  const duplicateCodes = new Set<string>();
  const observedCodes = new Set<string>();
  for (const definition of definitions) {
    validateDefinition(definition);
    if (observedCodes.has(definition.code)) duplicateCodes.add(definition.code);
    observedCodes.add(definition.code);
  }
  if (duplicateCodes.size) {
    throw new Error(`Duplicate Vigil update preflight check code: ${[...duplicateCodes].sort().join(", ")}`);
  }

  const checks = await Promise.all(definitions.map(async (definition): Promise<UpdatePreflightCheck> => {
    try {
      const result = await definition.run();
      const status = result.status || "pass";
      if (!["pass", "fail", "blocked"].includes(status)) {
        throw new Error(`Check returned unsupported status ${String(status)}.`);
      }
      return {
        code: definition.code,
        label: definition.label,
        status,
        message: boundedText(
          result.message
          || (status === "pass" ? `${definition.label} passed.` : `${definition.label} did not pass.`)
        ),
        detail: nullableBoundedText(result.detail)
      };
    } catch (error) {
      return {
        code: definition.code,
        label: definition.label,
        status: "fail",
        message: `${definition.label} failed.`,
        detail: boundedText(errorMessage(error))
      };
    }
  }));
  const failures = checks.filter((check) => check.status !== "pass");
  return {
    ok: failures.length === 0,
    checkedAt: now.toISOString(),
    checks,
    failures
  };
}

export function firstUpdatePreflightFailure(
  report: UpdatePreflightReport
): UpdatePreflightCheck | null {
  return report.failures[0] || null;
}

export function updatePreflightFailureMessage(check: UpdatePreflightCheck): string {
  const detail = check.detail && check.detail !== check.message ? ` ${check.detail}` : "";
  return `${check.message}${detail}`.trim();
}

function validateDefinition(definition: UpdatePreflightCheckDefinition): void {
  if (!CHECK_CODE_PATTERN.test(definition.code)) {
    throw new Error(`Invalid Vigil update preflight check code: ${definition.code}`);
  }
  if (!definition.label.trim()) throw new Error(`Vigil update preflight check ${definition.code} has no label.`);
  if (typeof definition.run !== "function") {
    throw new Error(`Vigil update preflight check ${definition.code} has no implementation.`);
  }
}

function nullableBoundedText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const text = boundedText(String(value));
  return text || null;
}

function boundedText(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length <= MAX_DIAGNOSTIC_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_DIAGNOSTIC_LENGTH - 1)}…`;
}

function errorMessage(error: unknown): string {
  if (!error || typeof error !== "object") return String(error || "Unknown preflight error.");
  const value = error as { message?: unknown; stderr?: unknown; stdout?: unknown };
  return [
    String(value.message || ""),
    String(value.stderr || ""),
    String(value.stdout || "")
  ].map((part) => part.trim()).filter(Boolean).join(" ") || "Unknown preflight error.";
}
