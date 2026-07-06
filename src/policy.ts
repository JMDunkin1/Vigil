import {
  ALWAYS_ALLOWED_APPS,
  DEVICE_TARGETS,
  NORMAL_PROFILE_ID,
  PANIC_LOCK_PROFILE_ID,
  PROCESS_SWEEP_EXEMPT_APPS,
  STRICT_BYPASS_APPS,
  STRICT_EMBEDDED_BROWSER_APPS,
  STRICT_NETWORK_BYPASS_APPS,
  STRICT_UNSUPPORTED_BROWSERS
} from "./defaults.js";
import { integrityLockdownPolicy } from "./integrityLockdown.js";
import { parseClock } from "./time.js";
import type { ActivePolicy, DeviceTarget, DeviceTargetInput, IntentionalPlanBlock, LockLevel, PolicyPhase, PolicyPhaseKind, Profile, Schedule, SentinelState, Session } from "./types.js";

const SITE_ALIAS_GROUPS = [
  ["youtube.com", "youtu.be", "youtube-nocookie.com"],
  ["x.com", "twitter.com"],
  ["reddit.com", "redd.it"],
  ["facebook.com", "fb.com", "messenger.com", "m.me"],
  ["instagram.com", "cdninstagram.com"],
  ["tiktok.com", "tiktokv.com"],
  ["netflix.com", "nflxvideo.net", "nflximg.net", "nflxext.com"],
  ["twitch.tv", "twitch.com", "ttvnw.net"],
  ["discord.com", "discordapp.com", "discord.gg"],
  ["steamcommunity.com", "steampowered.com"],
  ["pinterest.com", "pin.it"],
  ["snapchat.com", "snap.com"]
];

const SITE_ALIAS_LOOKUP = new Map<string, string[]>();
for (const group of SITE_ALIAS_GROUPS) {
  const normalized = [...new Set(group.map(normalizeHost).filter(Boolean))];
  for (const domain of normalized) SITE_ALIAS_LOOKUP.set(domain, normalized);
}

const APP_ALIAS_GROUPS = [
  ["Discord", "Discord Helper", "Discord Canary", "Discord PTB"],
  ["Steam", "Steam Helper", "steam_osx", "steamwebhelper"],
  ["Epic Games Launcher", "Epic Games", "EpicWebHelper"],
  ["Battle.net", "Battle.net Helper", "Blizzard Battle.net"],
  ["Roblox", "Roblox Player", "RobloxPlayer", "Roblox Studio", "RobloxStudio"],
  ["Minecraft", "Minecraft Launcher"],
  ["Music", "Apple Music"],
  ["TV", "Apple TV"],
  ["Podcasts", "Apple Podcasts"],
  ["News", "Apple News"],
  ["Photos", "Photo Booth"],
  ["Telegram", "Telegram Desktop"],
  ["WhatsApp", "WhatsApp Desktop"],
  ["Slack", "Slack Helper", "Slack Helper (GPU)", "Slack Helper (Renderer)", "Slack Helper (Plugin)"],
  ["Microsoft Teams", "Teams", "MSTeams", "Microsoft Teams Helper", "Teams Helper"],
  ["Notion", "Notion Helper", "Notion Helper (GPU)", "Notion Helper (Renderer)"],
  ["Figma", "Figma Helper", "Figma Agent"],
  ["Obsidian", "Obsidian Helper"],
  ["Spotify", "Spotify Helper", "Spotify Helper (Renderer)"],
  ["Electron", "Electron Helper"],
  ["Google Chrome", "Chrome", "Google Chrome Helper"],
  ["Microsoft Edge", "Edge", "Microsoft Edge Helper"],
  ["Brave Browser", "Brave", "Brave Browser Helper"],
  ["Arc", "Arc Helper"],
  ["Safari", "Safari Technology Preview"],
  ["Terminal", "Apple Terminal"],
  ["iTerm2", "iTerm"],
  ["Activity Monitor", "Activity Monitor Helper"],
  ["System Settings", "System Preferences"],
  ["App Store", "Apple App Store"],
  ["Installer", "Package Installer"],
  ["InstallAssistant", "Install Assistant"],
  ["Software Update", "SoftwareUpdateLauncher"],
  ["System Information", "System Profiler"],
  ["Disk Utility", "DiskUtility"],
  ["Migration Assistant", "MigrationAssistant"],
  ["Boot Camp Assistant", "Boot Camp"],
  ["Apple Configurator", "Configurator"],
  ["Self Service", "Jamf Self Service"],
  ["Managed Software Center", "Munki Managed Software Center"],
  ["CleanMyMac X", "CleanMyMac"],
  ["AppCleaner", "App Cleaner"],
  ["AppZapper", "App Zapper"],
  ["LaunchControl", "Launch Control"],
  ["Lingon X", "Lingon"],
  ["Proxyman", "Proxyman Helper"],
  ["Charles", "Charles Proxy"],
  ["HTTP Toolkit", "HTTP Toolkit Helper"],
  ["Wireshark", "Wireshark Helper"],
  ["Burp Suite", "Burp Suite Community Edition", "Burp Suite Professional"],
  ["mitmproxy", "mitmweb"],
  ["Little Snitch Configuration", "Little Snitch", "Little Snitch Network Monitor"],
  ["LuLu", "LuLu Helper"],
  ["Radio Silence", "Radio Silence Helper"],
  ["TripMode", "TripMode Helper"],
  ["AdGuard", "AdGuard for Safari", "AdGuard VPN"],
  ["NextDNS", "NextDNS Helper"],
  ["DNSCrypt-Proxy", "DNSCrypt Proxy"],
  ["Tailscale", "Tailscale IPN"],
  ["Cloudflare WARP", "WARP", "1.1.1.1"],
  ["WireGuard", "WireGuard Helper"],
  ["OpenVPN Connect", "OpenVPN"],
  ["Viscosity", "Viscosity Helper"],
  ["NordVPN", "NordVPN Helper"],
  ["ExpressVPN", "ExpressVPN Helper"],
  ["Surfshark", "Surfshark Helper"],
  ["Proton VPN", "ProtonVPN", "ProtonVPN Helper"],
  ["Mullvad VPN", "Mullvad VPN Helper"],
  ["TunnelBear", "TunnelBear Helper"],
  ["Private Internet Access", "PIA"],
  ["Windscribe", "Windscribe Helper"],
  ["CyberGhost VPN", "CyberGhost"],
  ["Outline Client", "Outline Manager"],
  ["ClashX", "ClashX Pro"],
  ["Clash Verge", "Clash Verge Rev"],
  ["ShadowsocksX-NG", "ShadowsocksX"],
  ["Surge", "Surge Dashboard"],
  ["Privoxy", "PrivoxyHelper"],
  ["Firefox", "Firefox Developer Edition", "Firefox Nightly"],
  ["LibreWolf", "LibreWolf Browser"],
  ["Waterfox", "Waterfox Browser"],
  ["Tor Browser", "Tor"],
  ["Mullvad Browser", "Mullvad"],
  ["DuckDuckGo", "DuckDuckGo Browser"],
  ["Zen", "Zen Browser"],
  ["Chromium", "Chromium Browser", "Ungoogled Chromium"],
  ["SigmaOS", "SigmaOS Browser"],
  ["Dia", "Dia Browser"]
];

const APP_ALIAS_LOOKUP = new Map<string, string[]>();
for (const group of APP_ALIAS_GROUPS) {
  const normalized = [...new Set(group.map(normalizeAppName).filter(Boolean))];
  for (const app of normalized) APP_ALIAS_LOOKUP.set(app, normalized);
}

const STRICT_BROWSER_CONTROL_PROTOCOLS = new Set(["chrome:", "edge:", "brave:", "arc:", "vivaldi:", "opera:", "orion:"]);
const STRICT_BROWSER_CONTROL_AREAS = new Set([
  "extensions",
  "extensions-internals",
  "settings",
  "flags",
  "management",
  "policy",
  "inspect",
  "net-internals",
  "serviceworker-internals",
  "components"
]);

interface PolicyDeviceOptions {
  device?: DeviceTargetInput;
}

interface AppBlockOptions {
  strictBypassApps?: readonly string[];
  respectAlwaysAllowedApps?: boolean;
  policyAllowedAppsOverrideStrict?: boolean;
}

interface ScheduleWindow {
  startsAt: string;
  endsAt: string;
  windowKey: string;
}

interface BlockedUrlMatch {
  pattern: string;
  label: string;
  hostname: string;
  url: string;
}

export function activeProfile(state: SentinelState): Profile {
  return state.profiles.find((profile) => profile.id === state.settings.activeProfileId) || state.profiles[0];
}

export function baselineProfile(state: SentinelState): Profile {
  const id = state.settings?.baselineProfileId || NORMAL_PROFILE_ID;
  return state.profiles.find((profile) => profile.id === id) || profileById(state, NORMAL_PROFILE_ID);
}

export function profileById(state: SentinelState, id: string): Profile {
  return state.profiles.find((profile) => profile.id === id) || activeProfile(state);
}

export function snapshotProfile(profile: Profile): Profile {
  return {
    id: profile.id,
    name: profile.name,
    mode: profile.mode,
    description: profile.description || "",
    blockedApps: [...(profile.blockedApps || [])],
    blockedSites: [...(profile.blockedSites || [])],
    blockedUrlPatterns: [...(profile.blockedUrlPatterns || [])],
    allowedApps: [...(profile.allowedApps || [])],
    allowedSites: [...(profile.allowedSites || [])],
    phoneAppBlocking: profile.phoneAppBlocking === false ? false : undefined,
    hostsUrlPatternBlocking: profile.hostsUrlPatternBlocking === false ? false : undefined
  };
}

export function panicLockProfile(): Profile {
  return {
    id: PANIC_LOCK_PROFILE_ID,
    name: "Panic Lockout",
    mode: "allowlist",
    description: "Locks the Mac session and blocks everything except Sentinel's local lock screen.",
    blockedApps: [],
    blockedSites: [],
    blockedUrlPatterns: [],
    allowedApps: ["Sentinel", "loginwindow"],
    allowedSites: ["localhost", "127.0.0.1"]
  };
}

export function isFullLockoutPolicy(policy: ActivePolicy | null | undefined): boolean {
  return Boolean(policy?.kind === "panic" || policy?.session?.mode === "panic" || policy?.session?.fullLockout);
}

export function baselinePolicy(state: SentinelState, now = new Date(), options: PolicyDeviceOptions = {}): ActivePolicy | null {
  const device = normalizeDeviceTarget(options.device);
  const profile = baselineProfile(state);
  if (!profile) return null;
  return {
    kind: "baseline",
    session: {
      id: `baseline:${device}`,
      title: "Normal",
      mode: "normal",
      profileId: profile.id,
      lockLevel: "light",
      startedAt: state.createdAt || now.toISOString(),
      endsAt: "",
      canEndEarly: true,
      emergencyUnlocksAllowed: true,
      source: "baseline",
      deviceTargets: [device]
    },
    profile,
    endsAt: ""
  };
}

export function activePolicy(state: SentinelState, now = new Date(), options: PolicyDeviceOptions = {}): ActivePolicy | null {
  const device = normalizeDeviceTarget(options.device);
  cleanupExpired(state, now);

  const integrity = integrityLockdownPolicy(state, now) as ActivePolicy | null;
  if (integrity) return integrity;

  if (state.panicLock) {
    const phase = sessionPhase(state.panicLock, now);
    return {
      kind: "panic",
      session: state.panicLock,
      profile: state.panicLock.profileSnapshot || panicLockProfile(),
      endsAt: phase?.endsAt || state.panicLock.endsAt,
      phase
    };
  }

  const manualSession = activeSessionForDevice(state, device);
  if (manualSession) {
    const phase = sessionPhase(manualSession, now);
    if (phase && !phase.blocking) return null;
    return {
      kind: "manual",
      session: manualSession,
      profile: manualSession.profileSnapshot || profileById(state, manualSession.profileId),
      endsAt: phase?.endsAt || manualSession.endsAt,
      phase
    };
  }

  const planned = activePlannerBlock(state, now, { device });
  const scheduled = activeSchedule(state, now, { device });

  if (planned && (!scheduled || lockPriority(planned.session.lockLevel) > lockPriority(scheduled.session.lockLevel))) {
    return {
      kind: "planner",
      session: planned.session,
      profile: profileById(state, planned.block.profileId),
      plannerBlock: planned.block,
      endsAt: planned.session.endsAt
    };
  }

  if (!scheduled) return null;

  return {
    kind: "schedule",
    session: scheduled.session,
    profile: profileById(state, scheduled.schedule.profileId),
    schedule: scheduled.schedule,
    endsAt: scheduled.session.endsAt
  };
}

function lockPriority(lockLevel: LockLevel): number {
  return lockLevel === "deep" ? 2 : 1;
}

export function activeSessionForDevice(state: SentinelState, device: DeviceTargetInput = "computer"): Session | null {
  const target = normalizeDeviceTarget(device);
  const session = state.activeSessions?.[target]
    || (target === "computer" ? state.activeSession : null)
    || (target === "phone" && state.activeSession && !state.activeSession.deviceTargets ? state.activeSession : null)
    || (!state.activeSessions && state.activeSession ? state.activeSession : null);
  if (!session) return null;
  return sessionTargetsDevice(session, target) ? session : null;
}

export function clearSessionsById(state: SentinelState, sessionId: unknown): DeviceTarget[] {
  const id = String(sessionId || "");
  if (!id) return [];

  state.activeSessions ||= { computer: state.activeSession || null, phone: null };
  const cleared: DeviceTarget[] = [];
  for (const target of DEVICE_TARGETS) {
    if (state.activeSessions[target]?.id === id) {
      state.activeSessions[target] = null;
      cleared.push(target);
    }
  }

  if (state.activeSession?.id === id) state.activeSession = null;
  state.activeSession = state.activeSessions.computer || null;
  return cleared;
}

export function normalizeDeviceTargets(value: unknown, fallback: readonly DeviceTarget[] = DEVICE_TARGETS): DeviceTarget[] {
  const source = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/\s*,\s*|\s+/)
      : [];
  const targets = [...new Set(source.map((item) => normalizeDeviceTarget(item, "")).filter(Boolean))];
  return targets.length ? targets as DeviceTarget[] : [...fallback];
}

export function normalizeDeviceTarget(value: unknown): DeviceTarget;
export function normalizeDeviceTarget(value: unknown, fallback: ""): DeviceTarget | "";
export function normalizeDeviceTarget(value: unknown, fallback: DeviceTarget): DeviceTarget;
export function normalizeDeviceTarget(value: unknown, fallback: DeviceTarget | "" = "computer"): DeviceTarget | "" {
  const target = String(value || "").trim().toLowerCase();
  return DEVICE_TARGETS.includes(target as DeviceTarget) ? target as DeviceTarget : fallback;
}

export function normalizeLockLevel(value: unknown, fallback: LockLevel = "deep"): LockLevel {
  const level = String(value || "").trim().toLowerCase();
  return level === "light" || level === "deep" ? level : fallback;
}

export function sessionTargetsDevice(session: Session | Schedule | IntentionalPlanBlock | null | undefined, device: DeviceTargetInput = "computer"): boolean {
  const targets = normalizeDeviceTargets(session?.deviceTargets, DEVICE_TARGETS);
  return targets.includes(normalizeDeviceTarget(device));
}

export function emergencyUnlockAllowedForPolicy(policy: ActivePolicy | null | undefined): boolean {
  if (!policy) return true;
  if (policy.kind === "integrity") return false;
  return policy.session?.emergencyUnlocksAllowed !== false;
}

export function sessionPhase(session: Session | null | undefined, now = new Date()): PolicyPhase | null {
  if (!session) return null;
  const started = Date.parse(session.startedAt || "");
  const ends = Date.parse(session.endsAt || "");
  if (!Number.isFinite(started) || !Number.isFinite(ends)) return null;
  if (now.getTime() >= ends) return null;

  const cycle = session.cycle;
  if (!cycle?.enabled) {
    return {
      kind: "work",
      label: "Focus",
      blocking: true,
      round: 1,
      rounds: 1,
      startsAt: session.startedAt,
      endsAt: session.endsAt
    };
  }

  const workMs = Math.max(1, Number(cycle.workMinutes || 25)) * 60 * 1000;
  const breakMs = Math.max(1, Number(cycle.breakMinutes || 5)) * 60 * 1000;
  const rounds = Math.max(1, Number(cycle.rounds || cycle.cycles || 1));
  let cursor = started;

  for (let round = 1; round <= rounds; round += 1) {
    const workEnd = cursor + workMs;
    if (now.getTime() < workEnd) {
      return phase("work", "Focus", true, round, rounds, cursor, workEnd);
    }
    cursor = workEnd;

    if (round < rounds) {
      const breakEnd = cursor + breakMs;
      if (now.getTime() < breakEnd) {
        return phase("break", "Break", false, round, rounds, cursor, breakEnd);
      }
      cursor = breakEnd;
    }
  }

  return null;
}

export function activeSchedule(
  state: SentinelState,
  now = new Date(),
  options: PolicyDeviceOptions = {}
): { schedule: Schedule; session: Session } | null {
  const device = normalizeDeviceTarget(options.device);
  let selected: { schedule: Schedule; session: Session; priority: number } | null = null;
  for (const schedule of state.schedules.filter((item) => item.enabled)) {
    if (!sessionTargetsDevice(schedule, device)) continue;
    if (!scheduleEnvironmentMatches(state, schedule)) continue;
    const match = scheduleWindow(schedule, now);
    if (!match) continue;
    if (isScheduleOverridden(state, schedule.id, match.endsAt, now)) continue;
    const candidate = {
      schedule,
      session: {
        id: `schedule:${schedule.id}:${match.windowKey}`,
        title: schedule.name,
        mode: schedule.mode,
        profileId: schedule.profileId,
        lockLevel: schedule.lockLevel,
        startedAt: match.startsAt,
        endsAt: match.endsAt,
        canEndEarly: false,
        commitmentLock: Boolean(schedule.commitmentLock),
        emergencyUnlocksAllowed: !schedule.commitmentLock,
        source: "schedule",
        deviceTargets: normalizeDeviceTargets(schedule.deviceTargets, DEVICE_TARGETS)
      }
    };
    const priority = schedulePolicyPriority(candidate.session);
    if (!selected || priority > selected.priority) selected = { ...candidate, priority };
  }
  return selected ? { schedule: selected.schedule, session: selected.session } : null;
}

function schedulePolicyPriority(session: Session): number {
  return lockPriority(session.lockLevel) * 2 + (session.commitmentLock ? 1 : 0);
}

export function activePlannerBlock(
  state: SentinelState,
  now = new Date(),
  options: PolicyDeviceOptions = {}
): { block: IntentionalPlanBlock; session: Session } | null {
  const device = normalizeDeviceTarget(options.device);
  const nowMs = now.getTime();
  const blocks = [...(state.intentionalUse?.planBlocks || [])].sort((a, b) => Date.parse(a.startsAt || "") - Date.parse(b.startsAt || ""));
  for (const block of blocks) {
    if (block.enabled === false || block.completed) continue;
    if (!sessionTargetsDevice(block, device)) continue;
    const startsAt = Date.parse(block.startsAt || "");
    const endsAt = Date.parse(block.endsAt || "");
    if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt)) continue;
    if (nowMs < startsAt || nowMs >= endsAt) continue;
    return {
      block,
      session: {
        id: `planner:${block.id}`,
        title: block.title,
        mode: block.mode,
        profileId: block.profileId,
        lockLevel: block.lockLevel,
        startedAt: new Date(startsAt).toISOString(),
        endsAt: new Date(endsAt).toISOString(),
        canEndEarly: false,
        commitmentLock: Boolean(block.commitmentLock),
        emergencyUnlocksAllowed: !block.commitmentLock,
        source: "planner",
        deviceTargets: normalizeDeviceTargets(block.deviceTargets, DEVICE_TARGETS)
      }
    };
  }
  return null;
}

export function scheduleWindow(schedule: Schedule, now = new Date()): ScheduleWindow | null {
  const start = parseClock(schedule.start);
  const end = parseClock(schedule.end);
  const current = now.getHours() * 60 + now.getMinutes();
  const day = now.getDay();
  const yesterday = (day + 6) % 7;
  const days = new Set(schedule.days || []);
  const overnight = start > end;

  if (!overnight && days.has(day) && current >= start && current < end) {
    return makeWindow(now, start, end, 0);
  }

  if (overnight && days.has(day) && current >= start) {
    return makeWindow(now, start, end, 1);
  }

  if (overnight && days.has(yesterday) && current < end) {
    return makeWindow(now, start, end, 0, -1);
  }

  return null;
}

export function shouldBlockApp(profile: Profile | null | undefined, appName: unknown, options: AppBlockOptions = {}): boolean {
  if (!appName) return false;
  if (!profile) return false;
  const policyAllowsApp = appMatchesAppTargets(appName, profile.allowedApps || []);
  if (options.policyAllowedAppsOverrideStrict && policyAllowsApp) return false;
  if (appMatchesAppTargets(appName, options.strictBypassApps || [])) return true;
  const respectAlwaysAllowedApps = options.respectAlwaysAllowedApps !== false;
  if (respectAlwaysAllowedApps && appMatchesAppTargets(appName, ALWAYS_ALLOWED_APPS)) return false;

  const blocked = profile.blockedApps || [];
  const allowed = respectAlwaysAllowedApps
    ? [...(profile.allowedApps || []), ...ALWAYS_ALLOWED_APPS]
    : profile.allowedApps || [];

  if (profile.mode === "allowlist") return !appMatchesAppTargets(appName, allowed);
  return appMatchesAppTargets(appName, blocked);
}

export function shouldBlockAppForPolicy(state: SentinelState, policy: ActivePolicy | null | undefined, appName: unknown): boolean {
  const strictBypassApps = strictBypassAppsForPolicy(state, policy);
  const fullLockout = isFullLockoutPolicy(policy) || policy?.kind === "integrity";
  return shouldBlockApp(policy?.profile, appName, {
    strictBypassApps,
    respectAlwaysAllowedApps: !fullLockout,
    policyAllowedAppsOverrideStrict: fullLockout
  });
}

export function isStrictBypassAppForPolicy(state: SentinelState, policy: ActivePolicy | null | undefined, appName: unknown): boolean {
  return appMatchesAppTargets(appName, strictBypassAppsForPolicy(state, policy));
}

export function isStrictUnsupportedBrowser(appName: unknown): boolean {
  return appMatchesAppTargets(appName, STRICT_UNSUPPORTED_BROWSERS);
}

export function isStrictEmbeddedBrowserApp(appName: unknown): boolean {
  return appMatchesAppTargets(appName, STRICT_EMBEDDED_BROWSER_APPS);
}

export function shouldBlockSite(profile: Profile, hostname: unknown): boolean {
  if (!hostname) return false;
  const host = normalizeHost(hostname);
  if (!host) return false;

  if (profile.mode === "allowlist") {
    return !hostMatchesSiteTargets(host, profile.allowedSites);
  }

  return hostMatchesSiteTargets(host, profile.blockedSites);
}

export function shouldBlockUrl(profile: Profile, value: unknown): boolean {
  return Boolean(matchBlockedUrlPattern(profile, value));
}

export function matchStrictBrowserControlUrl(state: SentinelState, policy: ActivePolicy | null | undefined, value: unknown): {
  area: string;
  label: string;
  url: string;
} | null {
  if (!shouldApplyStrictBypassProtection(state, policy)) return null;
  const parsed = parseInternalUrl(value);
  if (!parsed || !STRICT_BROWSER_CONTROL_PROTOCOLS.has(parsed.protocol)) return null;
  const area = browserControlArea(parsed);
  if (!area) return null;
  return {
    area,
    label: `Browser controls: ${area}`,
    url: parsed.toString()
  };
}

export function matchBlockedUrlPattern(profile: Profile | null | undefined, value: unknown): BlockedUrlMatch | null {
  if (!profile) return null;
  const parsed = parseHttpUrl(value);
  if (!parsed) return null;
  const candidates = urlPatternCandidates(parsed);
  const compactCandidates = candidates.map(compactUrlPatternText).filter(Boolean);
  for (const raw of profile.blockedUrlPatterns || []) {
    const pattern = normalizeUrlPattern(raw);
    if (!pattern) continue;
    const compactPattern = compactUrlPatternText(pattern);
    const matchesRaw = candidates.some((candidate) => candidate.includes(pattern));
    const matchesCompact = compactPattern.length >= 4
      && compactCandidates.some((candidate) => candidate.includes(compactPattern));
    if (!matchesRaw && !matchesCompact) continue;
    return {
      pattern: raw,
      label: `URL pattern: ${raw}`,
      hostname: normalizeHost(parsed.hostname),
      url: parsed.toString()
    };
  }
  return null;
}

export function expandSiteTargets(values: readonly unknown[] = []): string[] {
  const expanded: string[] = [];
  const domains = (values || []).map(normalizeHost).filter(Boolean);
  for (const domain of domains) {
    expanded.push(domain);
    expanded.push(...(SITE_ALIAS_LOOKUP.get(domain) || []));
  }
  return [...new Set(expanded)].sort();
}

export function expandAppTargets(values: readonly unknown[] = []): string[] {
  const expanded: string[] = [];
  const apps = (values || []).map(normalizeAppName).filter(Boolean);
  for (const app of apps) {
    expanded.push(app);
    expanded.push(...(APP_ALIAS_LOOKUP.get(app) || []));
  }
  return [...new Set(expanded)].sort();
}

export function appMatchesAppTargets(appName: unknown, targets: readonly unknown[]): boolean {
  const app = normalizeAppName(appName);
  if (!app) return false;
  return expandAppTargets(targets).includes(app);
}

export function isProcessSweepExemptApp(appName: unknown): boolean {
  return appMatchesAppTargets(appName, PROCESS_SWEEP_EXEMPT_APPS);
}

export function normalizeAppName(value: unknown): string {
  return String(value || "")
    .trim()
    .replace(/\.app$/i, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

export function hostMatchesSiteTargets(hostname: unknown, targets: readonly unknown[]): boolean {
  const host = normalizeHost(hostname);
  if (!host) return false;
  return expandSiteTargets(targets).some((domain) => host === domain || host.endsWith(`.${domain}`));
}

export function normalizeHost(value: unknown): string {
  try {
    const input = String(value || "").trim().toLowerCase();
    if (!input) return "";
    const parsed = input.includes("://") ? new URL(input) : new URL(`https://${input}`);
    return parsed.hostname.replace(/^www\./, "");
  } catch {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .split("/")[0]
      .split(":")[0];
  }
}

export function normalizeUrlPattern(value: unknown): string {
  const input = String(value || "").trim().toLowerCase();
  if (!input) return "";
  try {
    const parsed = input.includes("://") ? new URL(input) : null;
    if (parsed && ["http:", "https:"].includes(parsed.protocol)) {
      return `${normalizeHost(parsed.hostname)}${parsed.pathname}${parsed.search}${parsed.hash}`.replace(/^\/+$/, "");
    }
  } catch {
    // Treat malformed URLs as plain URL fragments.
  }
  return input
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\s+/g, "")
    .replace(/^\/+$/, "");
}

export function normalizeList(values: readonly unknown[] = []): string[] {
  return [...new Set((values || []).map((item) => String(item).trim()).filter(Boolean).map(normalize))];
}

export function listFromTextarea(value: unknown): string[] {
  return [...new Set(String(value || "")
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean))];
}

function normalize(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

function shouldApplyStrictBypassProtection(state: SentinelState, policy: ActivePolicy | null | undefined): boolean {
  if (policy?.kind === "integrity") return true;
  if (isFullLockoutPolicy(policy)) return true;
  return Boolean(
    state.settings?.strictBypassProtectionEnabled &&
    policy?.session?.lockLevel === "deep" &&
    policy?.session?.mode !== "break"
  );
}

function strictBypassAppsForPolicy(state: SentinelState, policy: ActivePolicy | null | undefined): string[] {
  if (!shouldApplyStrictBypassProtection(state, policy)) return [];
  const apps = [...STRICT_BYPASS_APPS, ...STRICT_NETWORK_BYPASS_APPS];
  if (policyUsesSiteBlocking(policy)) apps.push(...STRICT_UNSUPPORTED_BROWSERS, ...STRICT_EMBEDDED_BROWSER_APPS);
  return apps;
}

function policyUsesSiteBlocking(policy: ActivePolicy | null | undefined): boolean {
  const profile = policy?.profile;
  if (!profile) return false;
  if (profile.mode === "allowlist") return true;
  return Boolean((profile.blockedSites || []).length || (profile.blockedUrlPatterns || []).length);
}

function parseHttpUrl(value: unknown): URL | null {
  try {
    const url = new URL(String(value || ""));
    return ["http:", "https:"].includes(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

function parseInternalUrl(value: unknown): URL | null {
  try {
    return new URL(String(value || ""));
  } catch {
    return null;
  }
}

function browserControlArea(url: URL): string {
  const host = String(url.hostname || "").toLowerCase();
  const pathParts = String(url.pathname || "")
    .split("/")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  if (STRICT_BROWSER_CONTROL_AREAS.has(host)) return host;
  return pathParts.find((part) => STRICT_BROWSER_CONTROL_AREAS.has(part)) || "";
}

function urlPatternCandidates(url: URL): string[] {
  const host = normalizeHost(url.hostname);
  const hostPath = `${host}${url.pathname}${url.search}${url.hash}`.toLowerCase();
  const path = `${url.pathname}${url.search}${url.hash}`.toLowerCase();
  const raw = [
    hostPath,
    hostPath.replace(/^www\./, ""),
    path,
    url.toString().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "")
  ];
  const decoded = raw.flatMap(decodedUrlPatternCandidates);
  return [...new Set([...raw, ...decoded])];
}

function decodedUrlPatternCandidates(value: string): string[] {
  const plusAsSpace = value.replace(/\+/g, " ");
  const decoded = safeDecodeUrlText(plusAsSpace);
  return [plusAsSpace, decoded].map((candidate) => candidate.toLowerCase());
}

function safeDecodeUrlText(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function compactUrlPatternText(value: string): string {
  return safeDecodeUrlText(String(value || "").replace(/\+/g, " "))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function cleanupExpired(state: SentinelState, now: Date): void {
  if (state.panicLock && new Date(state.panicLock.endsAt) <= now) {
    state.panicLock = null;
  }
  state.activeSessions ||= { computer: null, phone: null };
  for (const target of DEVICE_TARGETS) {
    const session = state.activeSessions[target];
    if (session && new Date(session.endsAt) <= now) state.activeSessions[target] = null;
  }
  if (state.activeSession && new Date(state.activeSession.endsAt) <= now) {
    state.activeSession = null;
  }
  state.activeSession = state.activeSessions.computer || state.activeSession || null;
  state.overrides = (state.overrides || []).filter((override) => new Date(override.until) > now);
  state.emergency.pending = (state.emergency.pending || []).filter((request) => {
    const expiresAt = new Date(request.expiresAt || 0);
    return request.status === "pending" && expiresAt > now;
  });
}

function isScheduleOverridden(state: SentinelState, scheduleId: string, endsAt: string, now: Date): boolean {
  return (state.overrides || []).some((override) => {
    return override.scheduleId === scheduleId && new Date(override.until) >= new Date(endsAt) && new Date(override.until) > now;
  });
}

function scheduleEnvironmentMatches(state: SentinelState, schedule: Schedule): boolean {
  const networks = normalizeList(schedule.wifiNetworks || []);
  if (!networks.length) return true;
  const current = normalize(state.environment?.wifiSsid || "");
  return Boolean(current && networks.includes(current));
}

function makeWindow(now: Date, startMinutes: number, endMinutes: number, addEndDays: number, startOffsetDays = 0): ScheduleWindow {
  const starts = new Date(now);
  starts.setDate(starts.getDate() + startOffsetDays);
  starts.setHours(Math.floor(startMinutes / 60), startMinutes % 60, 0, 0);

  const ends = new Date(now);
  ends.setDate(ends.getDate() + addEndDays);
  ends.setHours(Math.floor(endMinutes / 60), endMinutes % 60, 0, 0);

  return {
    startsAt: starts.toISOString(),
    endsAt: ends.toISOString(),
    windowKey: `${starts.toISOString()}-${ends.toISOString()}`
  };
}

function phase(
  kind: PolicyPhaseKind,
  label: string,
  blocking: boolean,
  round: number,
  rounds: number,
  startsAt: number,
  endsAt: number
): PolicyPhase {
  return {
    kind,
    label,
    blocking,
    round,
    rounds,
    startsAt: new Date(startsAt).toISOString(),
    endsAt: new Date(endsAt).toISOString()
  };
}
