import type { BarEntry, DashboardData, WeekDaySummary } from "./app-model.js";
import { el, textEl } from "./dom.js";
import { formatDuration, signedPercent } from "./format.js";

interface KnightTier {
  id: "penitent" | "pilgrim" | "squire" | "knight" | "banneret";
  title: string;
}

const KNIGHT_TIERS: readonly KnightTier[] = [
  { id: "penitent", title: "Penitent" },
  { id: "pilgrim", title: "Pilgrim" },
  { id: "squire", title: "Squire" },
  { id: "knight", title: "Crusader Knight" },
  { id: "banneret", title: "Knight Banneret" }
] as const;

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

export function createRankingView() {
  const standing = required<HTMLElement>("#knightStanding");
  const rank = required<HTMLElement>("#knightRank");
  const totalUsage = required<HTMLElement>("#totalUsageToday");
  const totalUsageDevices = required<HTMLElement>("#totalUsageDevices");
  const focusScore = required<HTMLElement>("#focusScore");
  const focusScoreLabel = required<HTMLElement>("#focusScoreLabel");
  const distractionTrend = required<HTMLElement>("#distractionTrend");
  const week = required<HTMLElement>("#rankingWeek");
  const appUsage = required<HTMLElement>("#rankingAppUsage");

  function render(data: DashboardData): void {
    const progression = data.report?.progression;
    const score = clampPercent(data.usage?.focusScore);
    const brainHealth = Number(progression?.brainHealth ?? score);
    const tier = tierFor(brainHealth);

    standing.textContent = tier.title;
    rank.textContent = progression ? `Rank ${progression.level}` : "Rank --";
    totalUsage.textContent = formatDuration(Number(data.usage?.totalSeconds || 0));
    totalUsageDevices.textContent = usageDevicesLabel(data.usage?.devices);
    focusScore.textContent = String(score);
    focusScoreLabel.textContent = focusLabel(score, Number(data.usage?.totalSeconds || 0) > 0);
    distractionTrend.textContent = signedPercent(data.report?.comparison?.distractingPercentDelta);

    renderWeek(data.report?.currentWeek?.days || []);
    renderApps(data.usage?.topApps || []);
  }

  function renderWeek(days: WeekDaySummary[]): void {
    const normalizedDays = WEEKDAY_LABELS.map((label, index) => days[index] || ({ label } as WeekDaySummary));
    const trackedDays = normalizedDays.filter((day) => day.tracked);
    const maxSeconds = Math.max(...trackedDays.map((day) => Number(day.totalSeconds || 0)), 1);

    week.replaceChildren();
    normalizedDays.forEach((day, index) => {
      const tracked = Boolean(day.tracked);
      const seconds = Number(day.totalSeconds || 0);
      const height = tracked ? Math.max(5, (seconds / maxSeconds) * 100) : 0;
      const score = tracked ? String(clampPercent(day.focusScore)) : "–";
      const duration = tracked ? formatDuration(seconds) : "";
      const bar = el("i", { className: "ranking-week-bar" });
      week.append(el("div", {
        className: `ranking-week-day${tracked ? " is-tracked" : ""}`,
        attrs: { style: `--bar-height:${height}%` }
      },
        textEl("span", score, { className: "ranking-week-score" }),
        textEl("strong", duration, { className: "ranking-week-duration" }),
        el("div", { className: "ranking-week-bar-stage" }, bar),
        textEl("span", day.label || WEEKDAY_LABELS[index], { className: "ranking-week-label" })
      ));
    });

    week.setAttribute("aria-label", trackedDays.length
      ? `Weekly activity. ${trackedDays.map((day) => `${day.label}: ${formatDuration(day.totalSeconds || 0)} screen time, focus score ${clampPercent(day.focusScore)}`).join(". ")}.`
      : "Weekly activity. No usage recorded yet.");
  }

  function renderApps(entries: BarEntry[]): void {
    appUsage.replaceChildren();
    if (!entries.length) {
      appUsage.append(textEl("p", "No app activity yet.", { className: "ranking-app-empty" }));
      return;
    }

    const max = Math.max(...entries.map((item) => Number(item.seconds || 0)), 1);
    entries.forEach((entry, index) => {
      const name = entry.name || entry.label || "Unknown";
      const seconds = Number(entry.seconds || 0);
      const row = el("div", { className: "ranking-app-row" },
        textEl("span", String(index + 1).padStart(2, "0"), { className: "ranking-app-index" }),
        el("div", { className: "ranking-app-main" },
          textEl("strong", name),
          el("span", { className: "ranking-app-track" }, el("i", { attrs: { style: `width:${Math.max(3, (seconds / max) * 100)}%` } }))
        ),
        textEl("em", formatDuration(seconds))
      );
      appUsage.append(row);
    });
  }

  return { render };
}

function usageDevicesLabel(devices: DashboardData["usage"]["devices"]): string {
  const hasMac = Number(devices?.computer?.totalSeconds || 0) > 0;
  const hasPhone = Number(devices?.phone?.totalSeconds || 0) > 0;
  if (hasMac && hasPhone) return "Mac + iPhone";
  if (hasPhone) return "iPhone";
  return "Mac";
}

function focusLabel(score: number, hasUsage: boolean): string {
  if (!hasUsage) return "No score yet";
  if (score >= 90) return "Excellent";
  if (score >= 75) return "Strong";
  if (score >= 50) return "Mixed";
  return "Needs work";
}

function tierFor(value: number): KnightTier {
  if (value >= 88) return KNIGHT_TIERS[4];
  if (value >= 72) return KNIGHT_TIERS[3];
  if (value >= 55) return KNIGHT_TIERS[2];
  if (value >= 35) return KNIGHT_TIERS[1];
  return KNIGHT_TIERS[0];
}

function clampPercent(value: unknown): number {
  const number = Number(value || 0);
  return Math.max(0, Math.min(100, Number.isFinite(number) ? Math.round(number) : 0));
}

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing ranking element: ${selector}`);
  return element;
}
