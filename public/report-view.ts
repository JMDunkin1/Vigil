import type { BarEntry, DashboardItem, ReportSummary, WeekDaySummary } from "./app-model.js";
import { el, textEl } from "./dom.js";
import { daysWithDataText, formatDuration, shortDate, signedDuration, signedNumber } from "./format.js";

type QueryElement = typeof import("./ui-shell.js").$;

interface ReportViewContext {
  $: QueryElement;
  empty(text: string): HTMLElement;
}

export function createReportView({ $, empty }: ReportViewContext) {
  function renderBars(selector: string, entries: BarEntry[]): void {
    const root = $(selector);
    root.replaceChildren();
    if (!entries.length) {
      root.append(empty("No activity yet"));
      return;
    }

    const max = Math.max(...entries.map((item) => item.seconds || 0), 1);
    for (const item of entries) {
      const seconds = item.seconds || 0;
      const fill = el("div", { className: "bar-fill" });
      fill.style.width = `${Math.max(4, Math.round((seconds / max) * 100))}%`;
      const row = el(
        "div",
        { className: "bar-row" },
        textEl("div", item.name || item.label || "", { className: "bar-name" }),
        el("div", { className: "bar-track" }, fill),
        textEl("div", formatDuration(seconds), { className: "bar-time" })
      );
      root.append(row);
    }
  }

  function renderReport(report: ReportSummary): void {
    if (!report) return;
    $("#reportRange").textContent = `${shortDate(report.currentWeek.startsAt)} - ${shortDate(report.currentWeek.endsAt)}`;
    $("#weekFocusScore").textContent = String(report.currentWeek.totals.averageFocusScore);
    $("#weekScoreDelta").textContent = signedNumber(report.comparison?.focusScoreDelta, " pts");
    $("#weekSaved").textContent = formatDuration(report.currentWeek.totals.distractingSeconds);
    $("#weekSavedDelta").textContent = signedDuration(report.comparison?.distractingSecondsDelta);
    $("#focusStreak").textContent = report.streak.label;
    $("#streakGoal").textContent = `${report.streak.goal}+ score goal`;
    const progression = report.progression;
    $("#progressLevelReport").textContent = progression ? `${progression.level}` : "--";
    $("#xpProgress").textContent = progression ? `${progression.title} | ${progression.currentLevelXp}/${progression.nextLevelXp} XP` : "--";
    $("#levelProgressFill").style.width = `${progression?.levelProgressPercent || 0}%`;
    $("#yearPace").textContent = formatDuration(report.currentWeek.totals.averageDailyDistractionSeconds);
    $("#decadePace").textContent = daysWithDataText(report.currentWeek.totals.trackedDays);
    $("#openPressure").textContent = String(report.currentWeek.totals.averageDailyOpens || 0);
    $("#openPressureMeta").textContent = progression ? `${progression.brainState} brain health` : "avg opens / day";
    $("#reportJournalEntries").textContent = String(progression?.journalEntries || 0);
    $("#reportReflectionStreak").textContent = progression ? `${progression.reflectionStreakDays || 0} day streak` : "--";
    $("#reportBehaviorCheckIns").textContent = String(progression?.behaviorCheckIns || 0);
    $("#reportNextUnlock").textContent = progression?.nextUnlock || "--";
    $("#reportRecoveryCheckIns").textContent = String(progression?.recoveryCheckIns || 0);
    $("#reportRecoveryMeta").textContent = progression ? `${progression.sosStarts || 0} SOS | ${progression.setbacks || 0} setbacks` : "--";
    renderWeekStrip(report.currentWeek.days, report.focusScoreGoal);
    renderInsights(report.insights);
    renderMilestones(report.milestones, report.progression?.badges || []);
  }

  function renderWeekStrip(days: WeekDaySummary[], goal: number): void {
    const root = $("#weekStrip");
    root.replaceChildren();
    for (const day of days) {
      const item = document.createElement("div");
      item.className = `week-day ${day.tracked ? "tracked" : ""} ${(day.focusScore || 0) >= goal && day.tracked ? "hit" : ""}`;
      item.append(
        textEl("span", day.label),
        textEl("strong", day.tracked ? String(day.focusScore || 0) : "--"),
        textEl("em", day.tracked ? formatDuration(Number(day.distractingSeconds || 0)) : "no data")
      );
      root.append(item);
    }
  }

  function renderInsights(items: string[]): void {
    const root = $("#reportInsights");
    root.replaceChildren();
    for (const item of items || []) {
      const row = document.createElement("div");
      row.className = "insight";
      row.textContent = item;
      root.append(row);
    }
  }

  function renderMilestones(items: DashboardItem[], badges: Array<{ label: string; earned: boolean }> = []): void {
    const root = $("#milestones");
    root.replaceChildren();
    for (const badge of badges) {
      const row = document.createElement("div");
      row.className = badge.earned ? "milestone achieved" : "milestone";
      row.append(textEl("span", badge.earned ? "Earned" : "Next"), textEl("strong", badge.label));
      root.append(row);
    }
    for (const item of items || []) {
      const row = document.createElement("div");
      row.className = item.achieved ? "milestone achieved" : "milestone";
      row.append(textEl("span", item.achieved ? "Done" : "Next"), textEl("strong", item.label));
      root.append(row);
    }
  }

  return {
    renderBars,
    renderReport
  };
}
