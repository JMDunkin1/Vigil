export function dateKey(date = new Date()): string {
  const y = date.getFullYear();
  const m = `${date.getMonth() + 1}`.padStart(2, "0");
  const d = `${date.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export const TRACKING_DAY_ROLLOVER_HOUR = 3;

export function trackingDay(date = new Date()): Date {
  const day = new Date(date);
  if (day.getHours() < TRACKING_DAY_ROLLOVER_HOUR) day.setDate(day.getDate() - 1);
  day.setHours(0, 0, 0, 0);
  return day;
}

export function trackingDateKey(date = new Date()): string {
  return dateKey(trackingDay(date));
}

export function weekKey(date = new Date()): string {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  copy.setDate(copy.getDate() + 3 - ((copy.getDay() + 6) % 7));
  const week1 = new Date(copy.getFullYear(), 0, 4);
  const week = 1 + Math.round(((copy.getTime() - week1.getTime()) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
  return `${copy.getFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function parseClock(value: unknown): number {
  const [hour, minute] = normalizeClock(value, "00:00").split(":").map(Number);
  return hour * 60 + minute;
}

export function normalizeClock(value: unknown, fallback = "00:00"): string {
  const text = String(value || "").trim();
  return isClock(text) ? text : (isClock(fallback) ? fallback : "00:00");
}

export function isClock(value: unknown): boolean {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(String(value || ""));
}

export function formatDuration(seconds: unknown): string {
  const safe = Math.max(0, Math.round(Number(seconds || 0)));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function endOfToday(): Date {
  const date = new Date();
  date.setHours(23, 59, 59, 999);
  return date;
}

export function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}
