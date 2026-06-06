interface WeekdayOptions {
  fallback?: readonly number[];
  integersOnly?: boolean;
  sort?: boolean;
}

export function normalizeTextList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return [...new Set(value.map((item) => String(item).trim()).filter(Boolean))];
  }
  return [...new Set(String(value || "")
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean))];
}

export function normalizeWeekdays(value: unknown, options: WeekdayOptions = {}): number[] {
  const values = Array.isArray(value) ? value : [];
  const days = [...new Set(values
    .map(Number)
    .filter((day) => {
      return Number.isFinite(day)
        && (!options.integersOnly || Number.isInteger(day))
        && day >= 0
        && day <= 6;
    }))];
  if (options.sort !== false) days.sort((left, right) => left - right);
  return days.length ? days : [...(options.fallback || [])];
}

export function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number.parseInt(String(value), 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

export function pathTailId(path: string): string {
  return decodeURIComponent(path.split("/").at(-1) || "");
}
