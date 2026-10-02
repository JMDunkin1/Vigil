interface ScheduledEntry {
  enabled: boolean;
  days: number[];
  start: string;
  name: string;
}

export function nextSchedule(entries: ScheduledEntry[], now = new Date()): { name: string; startsAt: Date } | null {
  let next: { name: string; startsAt: Date } | null = null;
  for (const entry of entries) {
    if (!entry.enabled || !/^([01]\d|2[0-3]):[0-5]\d$/.test(entry.start)) continue;
    const [hours, minutes] = entry.start.split(":").map(Number);
    for (let offset = 0; offset <= 7; offset++) {
      const startsAt = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, hours, minutes);
      if (!entry.days.includes(startsAt.getDay()) || startsAt.getTime() <= now.getTime()) continue;
      if (!next || startsAt < next.startsAt) next = { name: entry.name, startsAt };
      break;
    }
  }
  return next;
}

export function nextScheduleLabel(startsAt: Date, now = new Date()): string {
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const day = startsAt.toDateString() === now.toDateString() ? "Today"
    : startsAt.toDateString() === tomorrow.toDateString() ? "Tomorrow"
      : startsAt.toLocaleDateString(undefined, { weekday: "short" });
  return `${day}, ${startsAt.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}

export function protectionStatus(input: {
  policyKind?: string;
  monitorOk?: boolean;
  monitorError?: string;
  phaseKind?: string;
  maintenanceUntil?: string;
}, now = new Date()): { label: string; tone: "good" | "warn" | "bad" } {
  if (input.policyKind === "integrity") return { label: "Integrity lock", tone: "bad" };
  if (input.policyKind === "panic") return { label: "Panic", tone: "bad" };
  if (input.monitorOk === false || input.monitorError) return { label: "Check protection", tone: "warn" };
  if (Date.parse(input.maintenanceUntil || "") > now.getTime()) return { label: "Maintenance", tone: "warn" };
  if (input.phaseKind === "break") return { label: "Break", tone: "warn" };
  if (input.monitorOk !== true) return { label: "Checking", tone: "warn" };
  return { label: "Protected", tone: "good" };
}
