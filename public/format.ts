export const days: Array<[string, string]> = [
  ["0", "Sun"],
  ["1", "Mon"],
  ["2", "Tue"],
  ["3", "Wed"],
  ["4", "Thu"],
  ["5", "Fri"],
  ["6", "Sat"]
];

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
