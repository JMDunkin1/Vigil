import { dateKey, weekKey } from "./time.js";
import type { IntentionalBehavior, IntentionalJournalEntry, IntentionalRecoveryCheckIn, SentinelState } from "./types.js";

export function behaviorSummary(state: SentinelState, behavior: IntentionalBehavior, currentWeekKey: string) {
  const checkIns = (state.intentionalUse.behaviorCheckIns || []).filter((entry) => entry.behaviorId === behavior.id);
  const weekly = checkIns.filter((entry) => entry.weekKey === currentWeekKey);
  const weeklyValue = weekly.reduce((total, entry) => total + Number(entry.value || 0), 0);
  const percent = behavior.weeklyTarget ? Math.min(100, Math.round((weeklyValue / behavior.weeklyTarget) * 100)) : 0;
  return {
    ...behavior,
    weeklyValue,
    weeklyCheckIns: weekly.length,
    percent,
    lastCheckInAt: checkIns[0]?.at || null
  };
}

export function plannerSummary(state: SentinelState, now: Date) {
  const nowMs = now.getTime();
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setDate(dayEnd.getDate() + 1);
  const lists = (state.intentionalUse.planLists || []).filter((list) => list.active !== false);
  const items = (state.intentionalUse.planItems || []).filter((item) => item.status !== "archived");
  const openItems = items.filter((item) => item.status === "open");
  const blocks = (state.intentionalUse.planBlocks || []).filter((block) => block.enabled !== false);
  const activeBlocks = blocks.filter((block) => (
    !block.completed
    && Date.parse(block.startsAt || "") <= nowMs
    && Date.parse(block.endsAt || "") > nowMs
  ));
  const todayBlocks = blocks.filter((block) => {
    const starts = Date.parse(block.startsAt || "");
    const ends = Date.parse(block.endsAt || "");
    return Number.isFinite(starts)
      && Number.isFinite(ends)
      && starts < dayEnd.getTime()
      && ends > dayStart.getTime();
  }).sort((a, b) => Date.parse(a.startsAt || "") - Date.parse(b.startsAt || ""));
  const upcomingBlocks = blocks.filter((block) => !block.completed && Date.parse(block.startsAt || "") >= nowMs)
    .sort((a, b) => Date.parse(a.startsAt || "") - Date.parse(b.startsAt || ""))
    .slice(0, 20);
  return {
    lists,
    items,
    recentItems: openItems.slice(0, 40),
    blocks,
    todayBlocks,
    upcomingBlocks,
    activeBlocks,
    openItems: openItems.length,
    completedItems: items.filter((item) => item.status === "done").length
  };
}

export function journalEntriesForWeek(state: SentinelState, currentWeekKey: string): IntentionalJournalEntry[] {
  return (state.intentionalUse.journalEntries || []).filter((entry) => weekKey(new Date(entry.entryDate || entry.createdAt)) === currentWeekKey);
}

export function reflectionStreakDays(state: SentinelState, now: Date): number {
  const days = new Set((state.intentionalUse.journalEntries || []).map((entry) => dateKey(new Date(entry.entryDate || entry.createdAt))));
  let count = 0;
  const cursor = new Date(now);
  cursor.setHours(0, 0, 0, 0);
  while (days.has(dateKey(cursor))) {
    count += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return count;
}

export function recoverySummary(state: SentinelState, now: Date) {
  const day = dateKey(now);
  const week = weekKey(now);
  const checkIns = state.intentionalUse.recoveryCheckIns || [];
  const sosSessions = state.intentionalUse.sosSessions || [];
  const todayCheckIns = checkIns.filter((entry) => entry.dateKey === day);
  const weekCheckIns = checkIns.filter((entry) => entry.weekKey === week);
  const weekSos = sosSessions.filter((session) => session.weekKey === week);
  const cleanDays = cleanRecoveryDays(weekCheckIns);
  return {
    today: {
      checkIns: todayCheckIns.length,
      latest: todayCheckIns[0] || null,
      status: todayCheckIns[0]?.status || "none"
    },
    week: {
      weekKey: week,
      checkIns: weekCheckIns.length,
      cleanDays,
      victories: weekCheckIns.filter((entry) => entry.status === "victory").length,
      setbacks: weekCheckIns.filter((entry) => entry.status === "setback").length,
      urges: weekCheckIns.filter((entry) => entry.status === "urge").length,
      sos: weekSos.length,
      averageUrgeIntensity: average(weekCheckIns.map((entry) => entry.urgeIntensity)),
      averageStress: average(weekCheckIns.map((entry) => entry.stress).filter((value): value is number => value !== null)),
      averageSleepHours: average(weekCheckIns.map((entry) => entry.sleepHours).filter((value): value is number => value !== null)),
      exerciseMinutes: Math.round(weekCheckIns.reduce((total, entry) => total + Number(entry.exerciseMinutes || 0), 0)),
      topTriggers: topRecoveryTriggers(weekCheckIns)
    },
    recentCheckIns: checkIns.slice(0, 12),
    recentSos: sosSessions.slice(0, 5)
  };
}

export function sosPlan(state: SentinelState, { intent, trigger, replacement }: { intent: string; trigger: string; replacement: string }): string[] {
  const reason = state.intentionalUse.goal?.statement || "Use screens on purpose, not by reflex.";
  const values = state.intentionalUse.goal?.values || [];
  const steps = [
    intent === "sleep" ? "Dim the screen, leave the room, and start a short wind-down." : "Take ten slow breaths before touching the browser again.",
    `Remember why: ${reason}`,
    trigger ? `Name the trigger without arguing with it: ${trigger}.` : "Name the trigger in one sentence.",
    `Do this next: ${replacement}.`
  ];
  if (intent === "lift-mood") steps.push("Add a body reset: water, light, or a short walk.");
  if (intent === "distraction") steps.push("Open one planned replacement, then close the tempting tab.");
  if (values.length) steps.push(`Protect: ${values.slice(0, 3).join(", ")}.`);
  steps.push("If the urge is still high, start a strict lock or contact your partner.");
  return steps.slice(0, 8);
}

function cleanRecoveryDays(checkIns: IntentionalRecoveryCheckIn[]): number {
  const byDay = new Map<string, IntentionalRecoveryCheckIn[]>();
  for (const entry of checkIns) {
    const items = byDay.get(entry.dateKey) || [];
    items.push(entry);
    byDay.set(entry.dateKey, items);
  }
  let count = 0;
  for (const entries of byDay.values()) {
    if (entries.some((entry) => entry.status === "setback")) continue;
    if (entries.some((entry) => ["clean", "victory"].includes(entry.status))) count += 1;
  }
  return count;
}

function topRecoveryTriggers(checkIns: IntentionalRecoveryCheckIn[]) {
  const counts = new Map<string, number>();
  for (const checkIn of checkIns) {
    for (const trigger of splitTags(checkIn.trigger)) {
      counts.set(trigger, (counts.get(trigger) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([label, count]) => ({ label, count }));
}

function splitTags(value: string): string[] {
  return String(value || "")
    .split(/[,|]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 10);
}

function average(values: number[]): number | null {
  const safe = values.filter((value) => Number.isFinite(value));
  if (!safe.length) return null;
  return Math.round((safe.reduce((total, value) => total + value, 0) / safe.length) * 10) / 10;
}
