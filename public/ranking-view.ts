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

export function createRankingView() {
  const avatar = required<HTMLElement>("#knightAvatar");
  const standing = required<HTMLElement>("#knightStanding");
  const rank = required<HTMLElement>("#knightRank");
  const state = required<HTMLElement>("#knightState");
  const progress = required<HTMLElement>("#knightProgressFill");
  const timeline = required<HTMLElement>("#rankTimeline");
  const journeyPath = required<SVGPathElement>("#rankJourneyPath");
  const journeyGround = required<SVGPathElement>("#rankJourneySvg .journey-ground");
  const journeyDays = required<HTMLElement>("#rankJourneyDays");
  const journeyKnight = required<HTMLElement>("#journeyKnight");
  const timelineStatus = required<HTMLElement>("#rankTimelineStatus");
  const totalUsage = required<HTMLElement>("#totalUsageToday");
  const focusScore = required<HTMLElement>("#focusScore");
  const distractionTrend = required<HTMLElement>("#distractionTrend");
  const combinedDevicesStatus = required<HTMLElement>("#combinedDevicesStatus");
  const waveLine = required<SVGPathElement>("#usageWaveLine");
  const waveArea = required<SVGPathElement>("#usageWaveArea");
  const wavePoints = required<SVGGElement>("#usageWavePoints");
  const waveAverage = required<HTMLElement>("#usageWaveAverage");
  const appUsage = required<HTMLElement>("#rankingAppUsage");

  function render(data: DashboardData): void {
    const progression = data.report?.progression;
    const brainHealth = Number(progression?.brainHealth ?? data.usage?.focusScore ?? 0);
    const tier = tierFor(brainHealth);
    avatar.dataset.rankTier = tier.id;
    standing.textContent = tier.title;
    rank.textContent = progression ? `Rank ${progression.level}` : "Rank --";
    state.textContent = progression
      ? `${progression.brainState} · ${progression.cleanDays} clean day${progression.cleanDays === 1 ? "" : "s"}`
      : "Awaiting the first watch";
    progress.style.width = `${clampPercent(progression?.levelProgressPercent)}%`;
    totalUsage.textContent = formatDuration(Number(data.usage?.totalSeconds || 0));
    focusScore.textContent = String(clampPercent(data.usage?.focusScore));
    distractionTrend.textContent = signedPercent(data.report?.comparison?.distractingPercentDelta);
    const devices = data.usage?.devices || {};
    const computerSynced = Boolean(devices.computer);
    const phoneSynced = Boolean(devices.phone);
    combinedDevicesStatus.textContent = phoneSynced && computerSynced
      ? "both devices synced"
      : phoneSynced
        ? "Mac activity pending"
        : "iPhone sync pending";
    const days = data.report?.currentWeek?.days || [];
    renderJourney(days);
    renderWave(days);
    renderApps(data.usage?.topApps || []);
  }

  function renderJourney(days: WeekDaySummary[]): void {
    const tracked = days.filter((day) => day.tracked);
    timelineStatus.textContent = tracked.length
      ? `${tracked.length} of 7 days tracked`
      : "Waiting for usage";

    let carriedScore: number | null = null;
    const points = chartPoints(days, (day) => {
      if (day.tracked) carriedScore = clampPercent(day.focusScore);
      return carriedScore;
    }, 700, 220, 42, 45, 154);
    const activeIndex = Math.max(0, days.reduce((latest, day, index) => day.tracked ? index : latest, -1));
    const activePoints = points.slice(0, activeIndex + 1);
    const path = smoothPath(activePoints.map((point) => ({ x: point.x, y: point.y })));
    journeyPath.setAttribute("d", path);
    journeyGround.setAttribute("d", path ? `${path} L ${activePoints.at(-1)?.x || 42} 198 L 0 198 Z` : "");
    journeyDays.replaceChildren();

    points.forEach((point, index) => {
      const day = days[index];
      const marker = el("div", { className: `journey-day${day?.tracked ? " is-tracked" : ""}` },
        textEl("strong", day?.tracked ? String(clampPercent(day.focusScore)) : "·"),
        textEl("span", day?.label || "--")
      );
      marker.style.left = `${(point.x / 700) * 100}%`;
      marker.style.top = `${(point.y / 220) * 100}%`;
      journeyDays.append(marker);
    });

    const activePoint = points[activeIndex] || { x: 42, y: 154 };
    journeyKnight.style.left = `${(activePoint.x / 700) * 100}%`;
    journeyKnight.style.top = `${(activePoint.y / 220) * 100}%`;
    timeline.setAttribute("aria-label", tracked.length
      ? `Weekly focus path. Latest score ${clampPercent(days[activeIndex]?.focusScore)} on ${days[activeIndex]?.label}.`
      : "Weekly focus path. No tracked days yet.");
  }

  function renderWave(days: WeekDaySummary[]): void {
    const tracked = days.filter((day) => day.tracked);
    const average = tracked.length
      ? tracked.reduce((sum, day) => sum + Number(day.totalSeconds || 0), 0) / tracked.length
      : 0;
    waveAverage.textContent = tracked.length ? `${formatDuration(average)} daily` : "No usage yet";

    const values = days.map((day) => day.tracked ? Number(day.totalSeconds || 0) : 0);
    const max = Math.max(...values, 1);
    const points = chartPoints(days, (day) => day.tracked ? (Number(day.totalSeconds || 0) / max) * 100 : null, 700, 220, 30, 38, 155);
    const activeIndex = days.reduce((latest, day, index) => day.tracked ? index : latest, -1);
    const activePoints = activeIndex >= 0 ? points.slice(0, activeIndex + 1) : [];
    const line = smoothPath(activePoints.map((point) => ({ x: point.x, y: point.y })));
    waveLine.setAttribute("d", line);
    waveArea.setAttribute("d", line ? `${line} L ${activePoints.at(-1)?.x || 30} 178 L 30 178 Z` : "");
    wavePoints.replaceChildren();

    points.forEach((point, index) => {
      const day = days[index];
      const group = svgEl("g", { class: day?.tracked ? "usage-wave-point is-tracked" : "usage-wave-point" });
      group.append(
        svgEl("circle", { cx: point.x, cy: point.y, r: day?.tracked ? 5 : 3 }),
        svgText(point.x, 202, day?.label || "--", "usage-wave-day"),
        svgText(point.x, Math.max(18, point.y - 14), day?.tracked ? formatDuration(day.totalSeconds || 0) : "", "usage-wave-value")
      );
      wavePoints.append(group);
    });
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

interface ChartPoint { x: number; y: number }

function chartPoints(
  days: WeekDaySummary[],
  valueFor: (day: WeekDaySummary) => number | null,
  width: number,
  _height: number,
  side: number,
  top: number,
  bottom: number
): ChartPoint[] {
  const source = days.length ? days.slice(0, 7) : Array.from({ length: 7 }, () => ({ label: "--" }));
  while (source.length < 7) source.push({ label: "--" });
  return source.map((day, index) => {
    const value = valueFor(day);
    return {
      x: side + index * ((width - side * 2) / 6),
      y: value === null ? bottom : bottom - (clampPercent(value) / 100) * (bottom - top)
    };
  });
}

function smoothPath(points: ChartPoint[]): string {
  if (!points.length) return "";
  return points.slice(1).reduce((path, point, index) => {
    const previous = points[index];
    const midpoint = (previous.x + point.x) / 2;
    return `${path} C ${midpoint} ${previous.y}, ${midpoint} ${point.y}, ${point.x} ${point.y}`;
  }, `M ${points[0].x} ${points[0].y}`);
}

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string | number>): SVGElementTagNameMap[K] {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
  return node;
}

function svgText(x: number, y: number, value: string, className: string): SVGTextElement {
  const node = svgEl("text", { x, y, class: className, "text-anchor": "middle" });
  node.textContent = value;
  return node;
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
