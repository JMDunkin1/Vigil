import type { BarEntry, DashboardData, WeekDaySummary } from "./app-model.js";
import { el, textEl } from "./dom.js";
import { formatDuration, signedPercent } from "./format.js";

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

export function createActivityView() {
  const totalUsage = required<HTMLElement>("#totalUsageToday");
  const totalUsageDevices = required<HTMLElement>("#totalUsageDevices");
  const focusScore = required<HTMLElement>("#activityFocusScore");
  const focusScoreLabel = required<HTMLElement>("#activityFocusScoreLabel");
  const distractionTrend = required<HTMLElement>("#activityDistractionTrend");
  const week = required<HTMLElement>("#activityWeek");
  const appUsage = required<HTMLElement>("#activityAppUsage");
  const siteUsage = required<HTMLElement>("#activitySiteUsage");

  function render(data: DashboardData): void {
    const totalSeconds = Number(data.usage?.totalSeconds || 0);
    const score = clampPercent(data.usage?.focusScore);

    totalUsage.textContent = formatDuration(totalSeconds);
    totalUsageDevices.textContent = usageDevicesLabel(data.usage?.devices);
    focusScore.textContent = totalSeconds > 0 ? String(score) : "--";
    focusScoreLabel.textContent = focusLabel(score, totalSeconds > 0);
    distractionTrend.textContent = signedPercent(data.report?.comparison?.distractingPercentDelta);

    renderWeek(data.report?.currentWeek?.days || []);
    renderUsageList(appUsage, data.usage?.topApps || [], "No app activity yet.");
    renderUsageList(siteUsage, (data.usage?.topSites || []).slice(0, 5), "No website activity yet.");
  }

  function renderWeek(days: WeekDaySummary[]): void {
    const normalizedDays = WEEKDAY_LABELS.map((label, index) => days[index] || ({ label } as WeekDaySummary));
    const trackedDays = normalizedDays.filter((day) => day.tracked);
    const maxSeconds = Math.max(...trackedDays.map((day) => Number(day.totalSeconds || 0)), 1);

    week.replaceChildren();
    normalizedDays.forEach((day, index) => {
      const tracked = Boolean(day.tracked);
      const seconds = Number(day.totalSeconds || 0);
      const score = tracked ? String(clampPercent(day.focusScore)) : "–";
      const duration = tracked ? formatDuration(seconds) : "";
      week.append(el("div", {
        className: `activity-week-day${tracked ? " is-tracked" : ""}`
      },
      textEl("span", score, { className: "activity-week-score" }),
      textEl("strong", duration, { className: "activity-week-duration" }),
      el("div", { className: "activity-week-bar-stage" }, usageColumn(tracked ? seconds : 0, maxSeconds)),
      textEl("span", day.label || WEEKDAY_LABELS[index], { className: "activity-week-label" })
      ));
    });

    week.setAttribute("aria-label", trackedDays.length
      ? `Weekly activity. ${trackedDays.map((day) => `${day.label}: ${formatDuration(day.totalSeconds || 0)} screen time, focus score ${clampPercent(day.focusScore)}`).join(". ")}.`
      : "Weekly activity. No usage recorded yet.");
  }

  return { render };
}

function renderUsageList(container: HTMLElement, entries: BarEntry[], emptyLabel: string): void {
  container.replaceChildren();
  if (!entries.length) {
    container.append(textEl("p", emptyLabel, { className: "activity-usage-empty" }));
    return;
  }

  const max = Math.max(...entries.map((item) => Number(item.seconds || 0)), 1);
  entries.forEach((entry, index) => {
    const name = entry.name || entry.label || "Unknown";
    const seconds = Number(entry.seconds || 0);
    container.append(el("div", { className: "activity-usage-row" },
      textEl("span", String(index + 1).padStart(2, "0"), { className: "activity-usage-index" }),
      el("div", { className: "activity-usage-main" },
        textEl("strong", name),
        el("progress", {
          className: "activity-usage-track",
          attrs: {
            max: 100,
            value: Math.max(3, (seconds / max) * 100),
            "aria-label": `${name}: ${formatDuration(seconds)}`
          }
        })
      ),
      textEl("em", formatDuration(seconds))
    ));
  });
}

function usageColumn(seconds: number, maxSeconds: number): SVGSVGElement {
  const height = seconds > 0 ? Math.max(5, (seconds / maxSeconds) * 100) : 0;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("activity-week-bar");
  svg.setAttribute("viewBox", "0 0 100 100");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("aria-hidden", "true");

  const fill = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  fill.classList.add("activity-week-bar-fill");
  fill.setAttribute("x", "33");
  fill.setAttribute("y", String(100 - height));
  fill.setAttribute("width", "34");
  fill.setAttribute("height", String(height));
  fill.setAttribute("rx", "5");
  svg.append(fill);
  return svg;
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

function clampPercent(value: unknown): number {
  const number = Number(value || 0);
  return Math.max(0, Math.min(100, Number.isFinite(number) ? Math.round(number) : 0));
}

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing activity element: ${selector}`);
  return element;
}
