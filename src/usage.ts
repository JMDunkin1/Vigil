import { dateKey, parseClock } from "./time.js";
import { BROWSERS, DEVICE_TARGETS } from "./defaults.js";
import { appMatchesAppTargets, hostMatchesSiteTargets, normalizeList } from "./policy.js";
import type { DeviceTarget, Schedule, VigilState, Session, UsageBucket, UsageDay, UsageSample, UsageSegment, UsageState } from "./types.js";

const BLOCK_EVENT_TYPES = new Set([
  "blocked_app",
  "blocked_browser_control",
  "blocked_content",
  "blocked_site",
  "blocked_url",
  "extension_blocked_site"
]);

const USAGE_TOTALS_MODE = "by-device";
const BROWSER_EXTENSION_APP = "Browser Extension";
type SessionRecord = Partial<Session> & { id: string; active?: boolean };
type RawUsageBucket = Partial<UsageBucket> & {
  appOpens?: Record<string, unknown>;
  siteOpens?: Record<string, unknown>;
  seconds?: unknown;
  durationSeconds?: unknown;
  recordedAt?: unknown;
  segments?: unknown;
};

interface UsageRecordingOptions {
  device?: string;
  segment?: { startedAt: Date; endedAt: Date };
}

interface TimedUsageSegment extends UsageSegment {
  device: DeviceTarget;
  startMs: number;
  endMs: number;
}

interface UsageSegmentEvents {
  starts: TimedUsageSegment[];
  ends: TimedUsageSegment[];
}

export class UsageSnapshotError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "UsageSnapshotError";
    this.status = status;
  }
}

export function recordUsage(
  usage: UsageState,
  sample: UsageSample | null | undefined,
  seconds: number,
  now = new Date(),
  options: UsageRecordingOptions = {}
): void {
  if (!sample?.app || !seconds || seconds < 0.25) return;
  const day = ensureDay(usage, dateKey(now));
  const device = ensureDeviceDay(day, normalizeUsageDevice(options.device || sample.device));
  incrementUsage(device, sample, seconds);
  if (options.segment) recordUsageSegment(device, sample, options.segment);
  recomputeDayTotals(day);
}

export function recordOpen(
  usage: UsageState,
  sample: UsageSample | null | undefined,
  previousSample: UsageSample | null | undefined,
  now = new Date(),
  options: { device?: string } = {}
): void {
  if (!sample?.app) return;
  const day = ensureDay(usage, dateKey(now));
  const device = ensureDeviceDay(day, normalizeUsageDevice(options.device || sample.device));
  recordOpenForBucket(device, sample, previousSample);
  recomputeDayTotals(day);
}

export function syncDeviceUsageSnapshot(
  usage: UsageState,
  input: Record<string, unknown> = {},
  now = new Date(),
  options: { allowedDevices?: readonly string[] } = {}
) {
  input = input && typeof input === "object" ? input : {};
  const device = normalizeUsageSyncDevice(input.device ?? input.deviceTarget, options.allowedDevices);
  const dayKey = usageSnapshotDayKey(input, now);
  const day = ensureDay(usage, dayKey);
  const previous = ensureDeviceDay(day, device);
  const incoming = boundedUsageSnapshot(normalizeUsageBucket(input, now), dayKey);
  if (incoming.contextVersion !== 1 || incoming.openContextVersion !== 1) {
    incoming.legacyTargetAggregation = "sum";
  }
  const incomingTimestamp = snapshotTimestamp(incoming.updatedAt);
  if (incomingTimestamp > now.getTime() + 5 * 60 * 1000) {
    throw new UsageSnapshotError("Usage snapshot timestamp is too far in the future.");
  }
  if ((incoming.segments || []).some((segment) => Date.parse(segment.endedAt) > now.getTime() + 5 * 60 * 1000)) {
    throw new UsageSnapshotError("Usage snapshot contains activity too far in the future.");
  }
  const segmentTimelineRolledOver = usageSegmentTimelineRolledOver(previous.segments, incoming.segments);
  if (segmentTimelineRolledOver) delete incoming.segmentTimelineComplete;
  const stale = hasUsageData(previous) && (
    incomingTimestamp < snapshotTimestamp(previous.updatedAt)
    || incoming.totalSeconds < previous.totalSeconds
    || usageCountersRegressed(previous, incoming)
    || (!segmentTimelineRolledOver && usageSegmentsRegressed(previous.segments, incoming.segments))
  );
  day.devices[device] = stale ? previous : incoming;
  recomputeDayTotals(day);

  const aggregate = normalizeUsageDay(day);
  return {
    ok: true,
    stale,
    device,
    dayKey,
    totalSeconds: aggregate.totalSeconds,
    distractingSeconds: null,
    deviceTotalSeconds: aggregate.devices[device]?.totalSeconds || 0,
    devices: Object.fromEntries(Object.entries(aggregate.devices).map(([key, value]) => [key, {
      totalSeconds: value.totalSeconds || 0,
      appCount: Object.keys(value.apps || {}).length,
      siteCount: Object.keys(value.sites || {}).length,
      openPressure: sumValues(value.opens?.apps) + sumValues(value.opens?.sites)
    }]))
  };
}

const MAX_USAGE_SECONDS_PER_DAY = 24 * 60 * 60;
const MAX_USAGE_ENTRIES_PER_BUCKET = 500;
const MAX_USAGE_ENTRY_NAME_LENGTH = 200;
const MAX_OPEN_COUNT_PER_ENTRY = 100_000;
const MAX_USAGE_SEGMENTS_PER_BUCKET = 5_000;

function boundedUsageSnapshot(bucket: UsageBucket, dayKey: string): UsageBucket {
  const boundedSegments = boundedUsageSegments(bucket.segments, dayKey);
  const bounded: UsageBucket = {
    ...bucket,
    totalSeconds: boundedNumber(bucket.totalSeconds, MAX_USAGE_SECONDS_PER_DAY),
    apps: boundedUsageMap(bucket.apps, MAX_USAGE_SECONDS_PER_DAY),
    sites: boundedUsageMap(bucket.sites, MAX_USAGE_SECONDS_PER_DAY),
    contexts: boundedUsageMap(bucket.contexts || {}, MAX_USAGE_SECONDS_PER_DAY, false, 450),
    openContexts: boundedUsageMap(bucket.openContexts || {}, MAX_OPEN_COUNT_PER_ENTRY, true, 450),
    opens: {
      apps: boundedUsageMap(bucket.opens.apps, MAX_OPEN_COUNT_PER_ENTRY, true),
      sites: boundedUsageMap(bucket.opens.sites, MAX_OPEN_COUNT_PER_ENTRY, true)
    },
    segments: boundedSegments.segments,
    segmentTimelineComplete: bucket.segmentTimelineComplete === true && boundedSegments.complete ? true : undefined
  };
  bounded.contextVersion = bucket.contextVersion === 1 && usageContextsComplete(bounded.contexts || {}, bounded.apps, bounded.sites)
    ? 1
    : undefined;
  bounded.openContextVersion = bucket.openContextVersion === 1 && openContextsComplete(bounded.openContexts || {}, bounded.opens)
    ? 1
    : undefined;
  return bounded;
}

function boundedUsageMap(
  values: Record<string, number>,
  maximum: number,
  integer = false,
  maximumNameLength = MAX_USAGE_ENTRY_NAME_LENGTH
): Record<string, number> {
  return Object.fromEntries(Object.entries(values)
    .filter(([name]) => name.length <= maximumNameLength)
    .slice(0, MAX_USAGE_ENTRIES_PER_BUCKET)
    .map(([name, value]) => [name, boundedNumber(value, maximum, integer)]));
}

function boundedNumber(value: number, maximum: number, integer = false): number {
  const bounded = Math.max(0, Math.min(maximum, Number(value) || 0));
  return integer ? Math.round(bounded) : round(bounded);
}

function snapshotTimestamp(value: string | null | undefined): number {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function normalizeUsageDay(day: Partial<UsageDay> = {}): UsageDay {
  const devices = normalizeDeviceBuckets(day.devices);
  if ((day.deviceTotalsMode === USAGE_TOTALS_MODE || !hasUsageData(day)) && Object.keys(devices).length) {
    return {
      ...aggregateDeviceBuckets(devices),
      devices,
      updatedAt: day.updatedAt || null
    };
  }

  return {
    totalSeconds: day.totalSeconds || 0,
    apps: day.apps || {},
    sites: day.sites || {},
    contexts: day.contexts || {},
    openContexts: day.openContexts || {},
    contextVersion: day.contextVersion === 1 ? 1 : undefined,
    openContextVersion: day.openContextVersion === 1 ? 1 : undefined,
    legacyTargetAggregation: day.legacyTargetAggregation === "sum" ? "sum" : undefined,
    opens: {
      apps: day.opens?.apps || {},
      sites: day.opens?.sites || {}
    },
    devices,
    updatedAt: day.updatedAt || null
  };
}

export function normalizeUsageDevice(value: unknown = "computer"): DeviceTarget {
  const normalized = String(value || "computer").trim().toLowerCase();
  return DEVICE_TARGETS.includes(normalized as DeviceTarget) ? normalized as DeviceTarget : "computer";
}

export function usageDeviceScreenTimeSeconds(day: Partial<UsageDay>, device: DeviceTarget): number | null {
  const devices = normalizeDeviceBuckets(day.devices);
  const bucket = devices[device];
  if (!bucket) return null;
  const timedSegments = completeTimedUsageSegments(bucket, device);
  return Math.round(timedSegments.length
    ? aggregateTimedSegments(timedSegments).totalSeconds
    : bucket.totalSeconds || 0);
}

function normalizeUsageSyncDevice(value: unknown, allowedDevices: readonly string[] = DEVICE_TARGETS): DeviceTarget {
  const device = String(value || "phone").trim().toLowerCase();
  if (!DEVICE_TARGETS.includes(device as DeviceTarget)) {
    throw new UsageSnapshotError(`Unsupported usage device: ${value}.`);
  }

  const allowed = normalizeAllowedUsageDevices(allowedDevices);
  if (!allowed.includes(device as DeviceTarget)) {
    throw new UsageSnapshotError(`Device usage sync is not allowed for ${device}.`, 403);
  }

  return device as DeviceTarget;
}

function normalizeAllowedUsageDevices(value: readonly unknown[] = DEVICE_TARGETS): DeviceTarget[] {
  const source = Array.isArray(value) ? value : DEVICE_TARGETS;
  const devices = [...new Set(source
    .map((item) => String(item || "").trim().toLowerCase())
    .filter((item): item is DeviceTarget => DEVICE_TARGETS.includes(item as DeviceTarget)))];
  return devices.length ? devices : [...DEVICE_TARGETS];
}

function incrementUsage(bucket: UsageBucket, sample: UsageSample, seconds: number): void {
  const app = sample.app;
  if (!app) return;
  bucket.apps[app] = round((bucket.apps[app] || 0) + seconds);

  if (sample.hostname) {
    bucket.sites[sample.hostname] = round((bucket.sites[sample.hostname] || 0) + seconds);
  }
  if (bucket.contextVersion === 1) {
    bucket.contexts ||= {};
    const context = usageContextKey(sample);
    bucket.contexts[context] = round((bucket.contexts[context] || 0) + seconds);
  }

  bucket.totalSeconds = round((bucket.totalSeconds || 0) + seconds);
  bucket.updatedAt = new Date().toISOString();
}

function recordUsageSegment(
  bucket: UsageBucket,
  sample: UsageSample,
  interval: { startedAt: Date; endedAt: Date }
): void {
  const startMs = interval.startedAt.getTime();
  const endMs = interval.endedAt.getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs || !sample.app) return;
  const segment: UsageSegment = {
    startedAt: new Date(startMs).toISOString(),
    endedAt: new Date(endMs).toISOString(),
    app: String(sample.app).slice(0, MAX_USAGE_ENTRY_NAME_LENGTH),
    ...(sample.hostname ? { hostname: String(sample.hostname).slice(0, MAX_USAGE_ENTRY_NAME_LENGTH) } : {})
  };
  bucket.segments ||= [];
  if (!bucket.segments.length) bucket.segmentTimelineComplete = true;
  const previous = bucket.segments.at(-1);
  const previousEnd = Date.parse(previous?.endedAt || "");
  if (previous
    && previous.app === segment.app
    && String(previous.hostname || "") === String(segment.hostname || "")
    && Number.isFinite(previousEnd)
    && startMs <= previousEnd + 5_000) {
    previous.endedAt = new Date(Math.max(previousEnd, endMs)).toISOString();
    return;
  }
  bucket.segments.push(segment);
  if (bucket.segments.length > MAX_USAGE_SEGMENTS_PER_BUCKET) {
    bucket.segments.splice(0, bucket.segments.length - MAX_USAGE_SEGMENTS_PER_BUCKET);
    delete bucket.segmentTimelineComplete;
  }
}

function recordOpenForBucket(bucket: UsageBucket, sample: UsageSample, previousSample: UsageSample | null | undefined): void {
  const app = sample.app;
  const appChanged = Boolean(app && app !== previousSample?.app);
  const siteChanged = Boolean(sample.hostname && sample.hostname !== previousSample?.hostname);
  if (app && appChanged) {
    bucket.opens.apps[app] = (bucket.opens.apps[app] || 0) + 1;
  }
  if (sample.hostname && siteChanged) {
    bucket.opens.sites[sample.hostname] = (bucket.opens.sites[sample.hostname] || 0) + 1;
  }
  if (bucket.openContextVersion === 1 && (appChanged || siteChanged)) {
    bucket.openContexts ||= {};
    const context = usageContextKey(sample);
    bucket.openContexts[context] = (bucket.openContexts[context] || 0) + 1;
  }

  bucket.updatedAt = new Date().toISOString();
}

export function usageSummary(usage: UsageState, state: VigilState, now = new Date()) {
  const todayKey = dateKey(now);
  const today = normalizeUsageDay(ensureDay(usage, todayKey));
  const topApps = topEntries(today.apps);
  const topSites = topEntries(today.sites);
  const distractingSeconds = usageBlockedSeconds(today, state);
  const totalSeconds = today.totalSeconds || 0;
  const focusScore = totalSeconds ? Math.max(0, Math.round(100 - (distractingSeconds / totalSeconds) * 100)) : 100;
  const protectedSeconds = protectedSecondsToday(state, now);
  const blockCount = blockCountToday(state, now);
  const appOpenCount = sumValues(today.opens.apps);
  const siteOpenCount = sumValues(today.opens.sites);

  return {
    todayKey,
    totalSeconds,
    distractingSeconds,
    protectedSeconds,
    blockCount,
    appOpenCount,
    siteOpenCount,
    openPressure: usageOpenCount(today),
    savedSeconds: null,
    focusScore,
    devices: deviceSummaries(today.devices, state),
    topApps,
    topSites,
    topAppOpens: topOpenEntries(today.opens.apps),
    topSiteOpens: topOpenEntries(today.opens.sites)
  };
}

function ensureDay(usage: UsageState, key: string): UsageDay {
  usage[key] ||= {
    totalSeconds: 0,
    apps: {},
    sites: {},
    contexts: {},
    openContexts: {},
    contextVersion: 1,
    openContextVersion: 1,
    opens: { apps: {}, sites: {} },
    devices: {},
    updatedAt: new Date().toISOString()
  };
  usage[key].apps ||= {};
  usage[key].sites ||= {};
  usage[key].opens ||= { apps: {}, sites: {} };
  usage[key].opens.apps ||= {};
  usage[key].opens.sites ||= {};
  usage[key].totalSeconds ||= 0;
  usage[key].devices ||= {};
  return usage[key];
}

function ensureDeviceDay(day: UsageDay, device: DeviceTarget): UsageBucket {
  if (day.deviceTotalsMode !== USAGE_TOTALS_MODE) {
    const legacy = normalizeUsageDay(day);
    day.devices = Object.keys(day.devices || {}).length ? normalizeDeviceBuckets(day.devices) : {};
    if (!Object.keys(day.devices).length && hasUsageData(legacy)) {
      day.devices.computer = normalizeUsageBucket(legacy);
    }
    day.deviceTotalsMode = USAGE_TOTALS_MODE;
  }

  day.devices ||= {};
  day.devices[device] = day.devices[device]
    ? normalizeUsageBucket(day.devices[device])
    : emptyUsageBucket(true);
  return day.devices[device];
}

function recomputeDayTotals(day: UsageDay): void {
  const aggregate = aggregateDeviceBuckets(normalizeDeviceBuckets(day.devices));
  day.totalSeconds = aggregate.totalSeconds;
  day.apps = aggregate.apps;
  day.sites = aggregate.sites;
  day.contexts = aggregate.contexts;
  day.openContexts = aggregate.openContexts;
  day.contextVersion = aggregate.contextVersion;
  day.openContextVersion = aggregate.openContextVersion;
  day.opens = aggregate.opens;
  day.deviceTotalsMode = USAGE_TOTALS_MODE;
  day.updatedAt = new Date().toISOString();
}

function normalizeDeviceBuckets(devices: Record<string, Partial<UsageBucket>> = {}): Record<string, UsageBucket> {
  const output: Record<string, UsageBucket> = {};
  for (const [device, bucket] of Object.entries(devices || {})) {
    const normalized = normalizeUsageBucket(bucket);
    if (hasUsageData(normalized)) output[normalizeUsageDevice(device)] = normalized;
  }
  return output;
}

function normalizeUsageBucket(bucket: RawUsageBucket = {}, now = new Date()): UsageBucket {
  const normalizedSegments = normalizeUsageSegments(bucket.segments);
  const apps = secondsMap(bucket.apps);
  const sites = secondsMap(bucket.sites);
  const contexts = contextMap(bucket.contexts);
  const openContexts = contextMap(bucket.openContexts, true);
  const opens = {
    apps: countMap(bucket.opens?.apps ?? bucket.appOpens),
    sites: countMap(bucket.opens?.sites ?? bucket.siteOpens)
  };
  const explicitTotal = finiteSeconds(bucket.totalSeconds ?? bucket.seconds ?? bucket.durationSeconds);
  const inferredTotal = Math.max(sumValues(apps), sumValues(sites));

  return {
    totalSeconds: explicitTotal ?? round(inferredTotal),
    apps,
    sites,
    contexts,
    openContexts,
    contextVersion: bucket.contextVersion === 1 && usageContextsComplete(contexts, apps, sites) ? 1 : undefined,
    openContextVersion: bucket.openContextVersion === 1 && openContextsComplete(openContexts, opens) ? 1 : undefined,
    legacyTargetAggregation: bucket.legacyTargetAggregation === "sum" ? "sum" : undefined,
    opens,
    segments: normalizedSegments.segments,
    segmentTimelineComplete: bucket.segmentTimelineComplete === true && normalizedSegments.complete ? true : undefined,
    updatedAt: String(bucket.updatedAt || bucket.recordedAt || now.toISOString())
  };
}

function aggregateDeviceBuckets(devices: Record<string, UsageBucket>): UsageBucket {
  const buckets = Object.values(devices);
  const aggregate = emptyUsageBucket(
    buckets.every((bucket) => bucket.contextVersion === 1),
    buckets.every((bucket) => bucket.openContextVersion === 1)
  );

  const timedSegments: TimedUsageSegment[] = [];

  for (const [device, bucket] of Object.entries(devices)) {
    const deviceSegments = completeTimedUsageSegments(bucket, normalizeUsageDevice(device));
    if (deviceSegments.length) {
      timedSegments.push(...deviceSegments);
    } else {
      aggregate.totalSeconds = round(aggregate.totalSeconds + Number(bucket.totalSeconds || 0));
      mergeNumberMap(aggregate.apps, bucket.apps);
      mergeNumberMap(aggregate.sites, bucket.sites);
      mergeNumberMap(aggregate.contexts, bucket.contexts);
    }
    mergeNumberMap(aggregate.openContexts, bucket.openContexts);
    mergeNumberMap(aggregate.opens.apps, bucket.opens?.apps);
    mergeNumberMap(aggregate.opens.sites, bucket.opens?.sites);
  }

  const deduplicated = aggregateTimedSegments(timedSegments);
  aggregate.totalSeconds = round(aggregate.totalSeconds + deduplicated.totalSeconds);
  mergeNumberMap(aggregate.apps, deduplicated.apps);
  mergeNumberMap(aggregate.sites, deduplicated.sites);
  mergeNumberMap(aggregate.contexts, deduplicated.contexts);
  aggregate.segments = deduplicated.segments;
  aggregate.contextVersion = usageContextsComplete(aggregate.contexts, aggregate.apps, aggregate.sites)
    ? 1
    : undefined;

  return aggregate;
}

function aggregateTimedSegments(segments: TimedUsageSegment[]): UsageBucket {
  const aggregate = emptyUsageBucket(true);
  if (!segments.length) return aggregate;
  const events = new Map<number, UsageSegmentEvents>();
  for (const segment of segments) {
    const startEvents = events.get(segment.startMs) || { starts: [], ends: [] };
    startEvents.starts.push(segment);
    events.set(segment.startMs, startEvents);
    const endEvents = events.get(segment.endMs) || { starts: [], ends: [] };
    endEvents.ends.push(segment);
    events.set(segment.endMs, endEvents);
  }
  const boundaries = [...events.keys()].sort((a, b) => a - b);
  const active = new Set<TimedUsageSegment>();
  const attributed: UsageSegment[] = [];
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const startMs = boundaries[index];
    const endMs = boundaries[index + 1];
    if (endMs <= startMs) continue;
    const boundaryEvents = events.get(startMs);
    for (const segment of boundaryEvents?.ends || []) active.delete(segment);
    for (const segment of boundaryEvents?.starts || []) active.add(segment);
    const winner = [...active].sort((left, right) => usageSegmentPriority(right) - usageSegmentPriority(left))[0];
    if (!winner) continue;
    const seconds = (endMs - startMs) / 1000;
    incrementTimedUsage(aggregate, winner, seconds);
    appendAttributedSegment(attributed, winner, startMs, endMs);
  }
  aggregate.segments = attributed;
  return aggregate;
}

function usageSegmentPriority(segment: TimedUsageSegment): number {
  return segment.device === "phone" ? 2 : 1;
}

function incrementTimedUsage(bucket: UsageBucket, segment: TimedUsageSegment, seconds: number): void {
  bucket.totalSeconds = round(bucket.totalSeconds + seconds);
  bucket.apps[segment.app] = round((bucket.apps[segment.app] || 0) + seconds);
  if (segment.hostname) bucket.sites[segment.hostname] = round((bucket.sites[segment.hostname] || 0) + seconds);
  bucket.contexts ||= {};
  const context = usageContextKey(segment);
  bucket.contexts[context] = round((bucket.contexts[context] || 0) + seconds);
}

function appendAttributedSegment(target: UsageSegment[], segment: TimedUsageSegment, startMs: number, endMs: number): void {
  const previous = target.at(-1);
  if (previous
    && previous.app === segment.app
    && String(previous.hostname || "") === String(segment.hostname || "")
    && Date.parse(previous.endedAt) === startMs) {
    previous.endedAt = new Date(endMs).toISOString();
    return;
  }
  target.push({
    startedAt: new Date(startMs).toISOString(),
    endedAt: new Date(endMs).toISOString(),
    app: segment.app,
    ...(segment.hostname ? { hostname: segment.hostname } : {})
  });
}

function timedUsageSegments(segments: UsageSegment[] | undefined, device: DeviceTarget): TimedUsageSegment[] {
  return (segments || []).flatMap((segment) => {
    const startMs = Date.parse(segment.startedAt);
    const endMs = Date.parse(segment.endedAt);
    return Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs && segment.app
      ? [{ ...segment, device, startMs, endMs }]
      : [];
  });
}

function completeTimedUsageSegments(bucket: UsageBucket, device: DeviceTarget): TimedUsageSegment[] {
  const segments = timedUsageSegments(bucket.segments, device);
  if (!segments.length) return [];
  if (bucket.segmentTimelineComplete === true) return attributeBrowserExtensionSites(segments, bucket);
  const coveredSeconds = aggregateTimedSegments(segments).totalSeconds;
  return coveredSeconds + 0.1 >= Number(bucket.totalSeconds || 0)
    ? attributeBrowserExtensionSites(segments, bucket)
    : [];
}

function attributeBrowserExtensionSites(segments: TimedUsageSegment[], bucket: UsageBucket): TimedUsageSegment[] {
  const extensionSites: Record<string, number> = {};
  for (const [context, seconds] of Object.entries(bucket.contexts || {})) {
    const sample = usageContextSample(context);
    if (sample?.app === BROWSER_EXTENSION_APP && sample.hostname) {
      extensionSites[sample.hostname] = round((extensionSites[sample.hostname] || 0) + seconds);
    }
  }
  if (!Object.keys(extensionSites).length) return segments;

  const timedSites = aggregateTimedSegments(segments).sites;
  const pendingSites = Object.entries(extensionSites).flatMap(([hostname, seconds]) => {
    const remaining = round(Math.max(0, seconds - Number(timedSites[hostname] || 0)));
    return remaining > 0 ? [{ hostname, seconds: remaining }] : [];
  });
  if (!pendingSites.length) return segments;

  let siteIndex = 0;
  return segments.flatMap((segment) => {
    if (segment.hostname || !BROWSERS.has(segment.app) || siteIndex >= pendingSites.length) return [segment];
    const attributed: TimedUsageSegment[] = [];
    let startMs = segment.startMs;
    while (startMs < segment.endMs && siteIndex < pendingSites.length) {
      const pending = pendingSites[siteIndex];
      const availableSeconds = (segment.endMs - startMs) / 1000;
      const attributedSeconds = Math.min(availableSeconds, pending.seconds);
      const endMs = startMs + attributedSeconds * 1000;
      attributed.push({
        ...segment,
        hostname: pending.hostname,
        startMs,
        endMs,
        startedAt: new Date(startMs).toISOString(),
        endedAt: new Date(endMs).toISOString()
      });
      pending.seconds = round(pending.seconds - attributedSeconds);
      startMs = endMs;
      if (pending.seconds <= 0.01) siteIndex += 1;
    }
    if (startMs < segment.endMs) {
      attributed.push({
        ...segment,
        startMs,
        startedAt: new Date(startMs).toISOString()
      });
    }
    return attributed;
  });
}

function emptyUsageBucket(contextsComplete = false, openContextsAreComplete = contextsComplete): UsageBucket & {
  contexts: Record<string, number>;
  openContexts: Record<string, number>;
} {
  return {
    totalSeconds: 0,
    apps: {},
    sites: {},
    contexts: {},
    openContexts: {},
    contextVersion: contextsComplete ? 1 : undefined,
    openContextVersion: openContextsAreComplete ? 1 : undefined,
    opens: { apps: {}, sites: {} }
  };
}

function normalizeUsageSegments(value: unknown): { segments: UsageSegment[]; complete: boolean } {
  if (!Array.isArray(value)) return { segments: [], complete: false };
  let complete = value.length <= MAX_USAGE_SEGMENTS_PER_BUCKET;
  const segments = value.slice(-MAX_USAGE_SEGMENTS_PER_BUCKET).flatMap((item) => {
    if (!item || typeof item !== "object") {
      complete = false;
      return [];
    }
    const record = item as Record<string, unknown>;
    const startedAt = new Date(String(record.startedAt || record.start || ""));
    const endedAt = new Date(String(record.endedAt || record.end || ""));
    const rawApp = String(record.app || record.name || "").trim();
    const rawHostname = String(record.hostname || record.site || record.host || "").trim();
    const app = rawApp.slice(0, MAX_USAGE_ENTRY_NAME_LENGTH);
    const hostname = rawHostname.slice(0, MAX_USAGE_ENTRY_NAME_LENGTH);
    if (rawApp.length !== app.length || rawHostname.length !== hostname.length) complete = false;
    if (!app || Number.isNaN(startedAt.getTime()) || Number.isNaN(endedAt.getTime()) || endedAt <= startedAt) {
      complete = false;
      return [];
    }
    return [{
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      app,
      ...(hostname ? { hostname } : {})
    }];
  });
  return { segments, complete };
}

function boundedUsageSegments(
  segments: UsageSegment[] | undefined,
  dayKey: string
): { segments: UsageSegment[]; complete: boolean } {
  const dayStartDate = new Date(`${dayKey}T00:00:00`);
  const dayEndDate = new Date(dayStartDate);
  dayEndDate.setDate(dayEndDate.getDate() + 1);
  const dayStart = dayStartDate.getTime();
  const dayEnd = dayEndDate.getTime();
  let complete = true;
  const bounded = (segments || []).flatMap((segment) => {
    const originalStartMs = Date.parse(segment.startedAt);
    const originalEndMs = Date.parse(segment.endedAt);
    const startMs = Math.max(dayStart, originalStartMs);
    const endMs = Math.min(dayEnd, originalEndMs);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      complete = false;
      return [];
    }
    if (startMs !== originalStartMs || endMs !== originalEndMs) complete = false;
    return [{ ...segment, startedAt: new Date(startMs).toISOString(), endedAt: new Date(endMs).toISOString() }];
  });
  return { segments: bounded, complete };
}

function usageContextsComplete(
  contexts: Record<string, number>,
  apps: Record<string, number>,
  sites: Record<string, number>
): boolean {
  const contextApps: Record<string, number> = {};
  const contextSites: Record<string, number> = {};
  for (const [context, seconds] of Object.entries(contexts)) {
    const sample = usageContextSample(context);
    if (!sample?.app) return false;
    contextApps[sample.app] = round((contextApps[sample.app] || 0) + seconds);
    if (sample.hostname) contextSites[sample.hostname] = round((contextSites[sample.hostname] || 0) + seconds);
  }
  return numberMapsEqual(contextApps, apps) && numberMapsEqual(contextSites, sites);
}

function openContextsComplete(
  contexts: Record<string, number>,
  opens: UsageBucket["opens"]
): boolean {
  const total = sumValues(contexts);
  const appTotal = sumValues(opens.apps);
  const siteTotal = sumValues(opens.sites);
  if (total < Math.max(appTotal, siteTotal) || total > appTotal + siteTotal) return false;
  const byApp: Record<string, number> = {};
  const bySite: Record<string, number> = {};
  for (const [context, count] of Object.entries(contexts)) {
    const sample = usageContextSample(context);
    if (!sample?.app) return false;
    byApp[sample.app] = (byApp[sample.app] || 0) + count;
    if (sample.hostname) bySite[sample.hostname] = (bySite[sample.hostname] || 0) + count;
    if (!(sample.app in opens.apps) && !(sample.hostname && sample.hostname in opens.sites)) return false;
  }
  return Object.entries(opens.apps).every(([app, count]) => (byApp[app] || 0) >= count)
    && Object.entries(opens.sites).every(([site, count]) => (bySite[site] || 0) >= count);
}

function numberMapsEqual(left: Record<string, number>, right: Record<string, number>): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].every((key) => Math.abs(Number(left[key] || 0) - Number(right[key] || 0)) < 0.01);
}

function secondsMap(value: unknown): Record<string, number> {
  return numberMap(value, ["name", "app", "site", "host", "hostname"], ["seconds", "totalSeconds", "durationSeconds"]);
}

function countMap(value: unknown): Record<string, number> {
  return numberMap(value, ["name", "app", "site", "host", "hostname"], ["count", "opens"], { integer: true });
}

function contextMap(value: unknown, integer = false): Record<string, number> {
  const contexts = numberMap(value, [], [], { integer });
  return Object.fromEntries(Object.entries(contexts).filter(([context]) => usageContextSample(context)));
}

function numberMap(
  value: unknown,
  keyFields: string[],
  valueFields: string[],
  options: { integer?: boolean } = {}
): Record<string, number> {
  const output: Record<string, number> = {};
  const entries = Array.isArray(value)
    ? value.map((item) => [firstField(item, keyFields), firstField(item, valueFields)])
    : Object.entries(isObjectRecord(value) ? value : {});

  for (const [rawName, rawValue] of entries) {
    const name = String(rawName || "").trim();
    const number = Number(rawValue);
    if (!name || !Number.isFinite(number) || number <= 0) continue;
    output[name] = options.integer
      ? Math.round((output[name] || 0) + number)
      : round((output[name] || 0) + number);
  }

  return output;
}

function firstField(item: unknown, fields: string[]): unknown {
  if (!item || typeof item !== "object") return "";
  for (const field of fields) {
    const record = item as Record<string, unknown>;
    if (record[field] !== undefined) return record[field];
  }
  return "";
}

function finiteSeconds(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? round(number) : null;
}

function mergeNumberMap(target: Record<string, number>, values: Record<string, number> = {}): void {
  for (const [name, value] of Object.entries(values || {})) {
    target[name] = round((target[name] || 0) + Number(value || 0));
  }
}

export function usageContextKey(sample: UsageSample): string {
  return JSON.stringify([String(sample.app || ""), String(sample.hostname || "")]);
}

export function usageContextSample(value: string): UsageSample | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 2 || parsed.some((item) => typeof item !== "string")) return null;
    const [app, hostname] = parsed;
    return app ? { app, hostname: hostname || undefined } : null;
  } catch {
    return null;
  }
}

function usageSnapshotDayKey(input: Record<string, unknown>, now: Date): string {
  const rawDay = String(input.dayKey || input.date || "").trim();
  let day = rawDay;
  if (day) {
    const parsedDay = new Date(`${day}T12:00:00`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(parsedDay.getTime()) || dateKey(parsedDay) !== day) {
      throw new UsageSnapshotError("Usage snapshot day is invalid.");
    }
  } else {
    const rawTimestamp = input.recordedAt ?? input.updatedAt;
    const parsed = rawTimestamp === undefined ? now : new Date(String(rawTimestamp));
    if (Number.isNaN(parsed.getTime())) throw new UsageSnapshotError("Usage snapshot timestamp is invalid.");
    day = dateKey(parsed);
  }

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (![dateKey(now), dateKey(yesterday)].includes(day)) {
    throw new UsageSnapshotError("Usage snapshots may only update today or yesterday.");
  }
  return day;
}

function usageCountersRegressed(previous: UsageBucket, incoming: UsageBucket): boolean {
  return (previous.contextVersion === 1 && incoming.contextVersion !== 1)
    || (previous.openContextVersion === 1 && incoming.openContextVersion !== 1)
    || numberMapRegressed(previous.apps, incoming.apps)
    || numberMapRegressed(previous.sites, incoming.sites)
    || numberMapRegressed(previous.opens?.apps, incoming.opens?.apps)
    || numberMapRegressed(previous.opens?.sites, incoming.opens?.sites)
    || numberMapRegressed(previous.contexts, incoming.contexts)
    || numberMapRegressed(previous.openContexts, incoming.openContexts);
}

function usageSegmentsRegressed(previous: UsageSegment[] | undefined, incoming: UsageSegment[] | undefined): boolean {
  const previousRanges = usageSegmentRanges(previous);
  if (!previousRanges.length) return false;
  const incomingRanges = usageSegmentRanges(incoming);
  if (!incomingRanges.length) return true;

  return usageRangesRegressed(previousRanges, incomingRanges);
}

function usageSegmentTimelineRolledOver(
  previous: UsageSegment[] | undefined,
  incoming: UsageSegment[] | undefined
): boolean {
  if (previous?.length !== MAX_USAGE_SEGMENTS_PER_BUCKET || incoming?.length !== MAX_USAGE_SEGMENTS_PER_BUCKET) {
    return false;
  }
  const previousRanges = usageSegmentRanges(previous);
  const incomingRanges = usageSegmentRanges(incoming);
  const previousStart = previousRanges[0]?.start;
  const previousEnd = previousRanges.at(-1)?.end;
  const incomingStart = incomingRanges[0]?.start;
  const incomingEnd = incomingRanges.at(-1)?.end;
  if (previousStart === undefined || previousEnd === undefined || incomingStart === undefined || incomingEnd === undefined) {
    return false;
  }
  if (incomingStart <= previousStart || incomingEnd <= previousEnd) return false;

  const retainedPreviousRanges = previousRanges.flatMap(({ start, end }) => end > incomingStart
    ? [{ start: Math.max(start, incomingStart), end }]
    : []);
  return !usageRangesRegressed(retainedPreviousRanges, incomingRanges);
}

function usageRangesRegressed(
  previousRanges: Array<{ start: number; end: number }>,
  incomingRanges: Array<{ start: number; end: number }>
): boolean {
  return previousRanges.some(({ start, end }) => {
    let coveredThrough = start;
    for (const range of incomingRanges) {
      if (range.end <= coveredThrough) continue;
      if (range.start > coveredThrough) return true;
      coveredThrough = Math.max(coveredThrough, range.end);
      if (coveredThrough >= end) return false;
    }
    return true;
  });
}

function usageSegmentRanges(segments: UsageSegment[] | undefined): Array<{ start: number; end: number }> {
  return (segments || []).flatMap((segment) => {
    const start = Date.parse(segment.startedAt);
    const end = Date.parse(segment.endedAt);
    return Number.isFinite(start) && Number.isFinite(end) && end > start ? [{ start, end }] : [];
  }).sort((left, right) => left.start - right.start || left.end - right.end);
}

function numberMapRegressed(previous: Record<string, number> | undefined, incoming: Record<string, number> | undefined): boolean {
  return Object.entries(previous || {}).some(([key, value]) => Number(incoming?.[key] || 0) < Number(value || 0));
}

function hasUsageData(bucket: Partial<UsageBucket> = {}): boolean {
  return Boolean(
    Number(bucket.totalSeconds || 0) > 0 ||
    Object.keys(bucket.apps || {}).length ||
    Object.keys(bucket.sites || {}).length ||
    Object.keys(bucket.opens?.apps || {}).length ||
    Object.keys(bucket.opens?.sites || {}).length
  );
}

function deviceSummaries(devices: Record<string, UsageBucket> = {}, state: VigilState) {
  return Object.fromEntries(Object.entries(devices || {}).map(([device, rawBucket]) => {
    const timedSegments = completeTimedUsageSegments(rawBucket, normalizeUsageDevice(device));
    const bucket = timedSegments.length ? aggregateTimedSegments(timedSegments) : rawBucket;
    return [device, {
      totalSeconds: Math.round(bucket.totalSeconds || 0),
      distractingSeconds: usageBlockedSeconds(bucket, state),
      appOpenCount: sumValues(rawBucket.opens?.apps),
      siteOpenCount: sumValues(rawBucket.opens?.sites),
      topApps: topEntries(bucket.apps),
      topSites: topEntries(bucket.sites)
    }];
  }));
}

function topEntries(values: Record<string, number> = {}) {
  return Object.entries(values || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, seconds]) => ({ name, seconds: Math.round(seconds) }));
}

function topOpenEntries(values: Record<string, number> = {}) {
  return Object.entries(values || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, count]) => ({ name, count }));
}

function sumValues(values: Record<string, number> | undefined): number {
  return Object.values(values || {}).reduce((total, value) => total + Number(value || 0), 0);
}

export function usageBlockedSeconds(day: UsageBucket, state: VigilState): number {
  const devices = Object.entries((day as Partial<UsageDay>).devices || {});
  if (devices.length) {
    const timedSegments: TimedUsageSegment[] = [];
    let total = 0;
    for (const [device, bucket] of devices) {
      const deviceSegments = completeTimedUsageSegments(bucket, normalizeUsageDevice(device));
      if (deviceSegments.length) timedSegments.push(...deviceSegments);
      else total += usageBlockedSeconds(bucket, state);
    }
    if (timedSegments.length) total += usageBlockedSeconds(aggregateTimedSegments(timedSegments), state);
    return Math.round(total);
  }
  return Math.min(Math.round(day.totalSeconds || 0), rawBlockedSeconds(day, state));
}

export function usageOpenCount(day: UsageBucket): number {
  const devices = Object.values((day as Partial<UsageDay>).devices || {});
  if (devices.length) return Math.round(devices.reduce((total, bucket) => total + usageOpenCount(bucket), 0));
  return day.openContextVersion === 1
    ? sumValues(day.openContexts)
    : sumValues(day.opens?.apps) + sumValues(day.opens?.sites);
}

function rawBlockedSeconds(day: UsageBucket, state: VigilState): number {
  const profile = state.profiles.find((item) => item.id === state.settings.activeProfileId) || state.profiles[0];
  if (day.contextVersion === 1) {
    return Math.round(Object.entries(day.contexts || {}).reduce((total, [context, seconds]) => {
      const sample = usageContextSample(context);
      if (!sample) return total;
      const blocked = appMatchesAppTargets(sample.app || "", profile?.blockedApps || [])
        || hostMatchesSiteTargets(sample.hostname || "", profile?.blockedSites || []);
      return total + (blocked ? Number(seconds || 0) : 0);
    }, 0));
  }
  let total = 0;

  for (const [app, seconds] of Object.entries(day.apps || {})) {
    if (appMatchesAppTargets(app, profile?.blockedApps || [])) total += seconds;
  }

  for (const [site, seconds] of Object.entries(day.sites || {})) {
    if (hostMatchesSiteTargets(site, profile?.blockedSites || [])) {
      total += seconds;
    }
  }

  return Math.round(total);
}

function protectedSecondsToday(state: VigilState, now: Date): number {
  const { startMs, endMs } = dayBounds(now);
  const intervals: Array<[number, number]> = [];
  const sessions = sessionRecords(state, now);

  for (const session of sessions.values()) {
    const startedAt = parseTime(session.startedAt);
    if (!Number.isFinite(startedAt)) continue;
    const plannedEnd = parseTime(session.endsAt);
    const endedAt = Number.isFinite(parseTime(session.endedAt)) ? parseTime(session.endedAt) : null;
    const naturalEnd = Number.isFinite(plannedEnd) ? plannedEnd : now.getTime();
    const finishedAt = session.active ? Math.min(naturalEnd, now.getTime()) : (endedAt || Math.min(naturalEnd, now.getTime()));
    const clippedStart = Math.max(startMs, startedAt);
    const clippedEnd = Math.min(endMs, finishedAt);
    if (clippedEnd > clippedStart) intervals.push([clippedStart, clippedEnd]);
  }

  intervals.push(...scheduleIntervalsToday(state, now, startMs, endMs));
  intervals.push(...plannerIntervalsToday(state, now, startMs, endMs));

  return Math.round(mergedIntervalMs(intervals) / 1000);
}

function blockCountToday(state: VigilState, now: Date): number {
  const { startMs, endMs } = dayBounds(now);
  return (state.events || []).filter((event) => {
    if (!BLOCK_EVENT_TYPES.has(event.type)) return false;
    const at = parseTime(event.at);
    return Number.isFinite(at) && at >= startMs && at < endMs;
  }).length;
}

function sessionRecords(state: VigilState, now: Date): Map<string, SessionRecord> {
  const records = new Map<string, SessionRecord>();

  for (const event of state.events || []) {
    const detail = event.detail || {};
    if ((event.type === "session_started" || event.type === "panic_lock_started") && detail.id) {
      upsertSession(records, detail);
    }
    if (event.type === "session_ended" && detail.id) {
      upsertSession(records, { ...detail, endedAt: event.at });
    }
  }

  for (const session of activeSessions(state)) {
    upsertSession(records, session, { active: true });
  }

  if (state.panicLock) upsertSession(records, state.panicLock, { active: true });

  for (const record of records.values()) {
    const plannedEnd = parseTime(record.endsAt);
    if (record.active && Number.isFinite(plannedEnd) && plannedEnd <= now.getTime()) {
      record.active = false;
    }
  }

  return records;
}

function upsertSession(records: Map<string, SessionRecord>, session: Partial<Session> | null | undefined, options: { active?: boolean } = {}): void {
  const id = String(session?.id || "");
  if (!id) return;
  const current = session;
  if (!current) return;
  const existing = records.get(id) || { id };
  records.set(id, {
    ...existing,
    startedAt: existing.startedAt || current.startedAt,
    endsAt: current.endsAt || existing.endsAt,
    endedAt: current.endedAt || existing.endedAt,
    active: Boolean(existing.active || options.active)
  });
}

function activeSessions(state: VigilState): Session[] {
  const sessions = [
    state.activeSession,
    state.activeSessions?.computer,
    state.activeSessions?.phone
  ].filter((session): session is Session => Boolean(session));
  const seen = new Set<string>();
  return sessions.filter((session) => {
    const id = String(session.id || "");
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function scheduleIntervalsToday(state: VigilState, now: Date, startMs: number, endMs: number): Array<[number, number]> {
  const intervals: Array<[number, number]> = [];
  const today = new Date(startMs);
  const yesterday = new Date(startMs);
  yesterday.setDate(yesterday.getDate() - 1);

  for (const schedule of state.schedules || []) {
    if (!schedule.enabled) continue;
    if (!scheduleEnvironmentMatches(state, schedule)) continue;
    const startMinutes = parseClock(schedule.start);
    const endMinutes = parseClock(schedule.end);
    if (!Number.isFinite(startMinutes) || !Number.isFinite(endMinutes) || startMinutes === endMinutes) continue;

    for (const dayStart of [yesterday, today]) {
      if (!(schedule.days || []).includes(dayStart.getDay())) continue;
      const window = scheduleIntervalForDay(dayStart, startMinutes, endMinutes);
      if (!window) continue;
      const overrideStart = scheduleOverrideStart(state, schedule, window[1]);
      const clippedEnd = Math.min(endMs, now.getTime(), overrideStart ?? window[1]);
      const clippedStart = Math.max(startMs, window[0]);
      if (clippedEnd > clippedStart) intervals.push([clippedStart, clippedEnd]);
    }
  }

  return intervals;
}

function plannerIntervalsToday(state: VigilState, now: Date, startMs: number, endMs: number): Array<[number, number]> {
  const intervals: Array<[number, number]> = [];
  for (const block of state.intentionalUse?.planBlocks || []) {
    if (block.enabled === false || block.completed) continue;
    const starts = parseTime(block.startsAt);
    const ends = parseTime(block.endsAt);
    if (!Number.isFinite(starts) || !Number.isFinite(ends)) continue;
    const clippedStart = Math.max(startMs, starts);
    const clippedEnd = Math.min(endMs, now.getTime(), ends);
    if (clippedEnd > clippedStart) intervals.push([clippedStart, clippedEnd]);
  }
  return intervals;
}

function scheduleIntervalForDay(dayStart: Date, startMinutes: number, endMinutes: number): [number, number] | null {
  const starts = new Date(dayStart);
  starts.setHours(Math.floor(startMinutes / 60), startMinutes % 60, 0, 0);

  const ends = new Date(dayStart);
  ends.setHours(Math.floor(endMinutes / 60), endMinutes % 60, 0, 0);
  if (startMinutes > endMinutes) ends.setDate(ends.getDate() + 1);
  if (ends <= starts) return null;
  return [starts.getTime(), ends.getTime()];
}

function scheduleOverrideStart(state: VigilState, schedule: Schedule, windowEndMs: number): number | null {
  const override = (state.overrides || []).find((item) => (
    item.scheduleId === schedule.id
    && parseTime(item.until) >= windowEndMs
  ));
  if (!override) return null;
  const createdAt = parseTime(override.createdAt);
  return Number.isFinite(createdAt) ? createdAt : 0;
}

function scheduleEnvironmentMatches(state: VigilState, schedule: Schedule): boolean {
  const networks = normalizeList(schedule.wifiNetworks || []);
  if (!networks.length) return true;
  const current = normalizeList([state.environment?.wifiSsid || ""])[0];
  return Boolean(current && networks.includes(current));
}

function dayBounds(now: Date): { startMs: number; endMs: number } {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { startMs: start.getTime(), endMs: end.getTime() };
}

function parseTime(value: unknown): number {
  const time = Date.parse(String(value || ""));
  return Number.isFinite(time) ? time : NaN;
}

function mergedIntervalMs(intervals: Array<[number, number]>): number {
  if (!intervals.length) return 0;
  const sorted = intervals.sort((a, b) => a[0] - b[0]);
  let total = 0;
  let [start, end] = sorted[0];

  for (const [nextStart, nextEnd] of sorted.slice(1)) {
    if (nextStart <= end) {
      end = Math.max(end, nextEnd);
    } else {
      total += end - start;
      start = nextStart;
      end = nextEnd;
    }
  }

  return total + end - start;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
