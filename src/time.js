export function dateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = `${date.getMonth() + 1}`.padStart(2, "0");
  const d = `${date.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function weekKey(date = new Date()) {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  copy.setDate(copy.getDate() + 3 - ((copy.getDay() + 6) % 7));
  const week1 = new Date(copy.getFullYear(), 0, 4);
  const week = 1 + Math.round(((copy - week1) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
  return `${copy.getFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function parseClock(value) {
  const [hour, minute] = String(value || "00:00").split(":").map(Number);
  return hour * 60 + minute;
}

export function formatDuration(seconds) {
  const safe = Math.max(0, Math.round(seconds || 0));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function endOfToday() {
  const date = new Date();
  date.setHours(23, 59, 59, 999);
  return date;
}

export function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}
