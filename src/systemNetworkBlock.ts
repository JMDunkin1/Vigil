import { activePolicy, baselinePolicy, normalizeHost, normalizeUrlPattern } from "./policy.js";
import { contentFilterEnabled } from "./contentFilters.js";
import type { Profile, VigilState, UnknownRecord } from "./types.js";

interface NetworkBlockSummary extends UnknownRecord {
  installed?: boolean;
  partial?: boolean;
  stale?: boolean;
}

export interface BrowserCompanionRequirement {
  required: boolean;
  detail: string;
}

export function systemNetworkBlockingEnabled(state: VigilState): boolean {
  return state.settings?.systemNetworkBlockingEnabled !== false;
}

export function networkBlockCurrent(hosts: NetworkBlockSummary = {}, firewall: NetworkBlockSummary = {}): boolean {
  return Boolean(
    hosts.installed &&
    !hosts.partial &&
    !hosts.stale &&
    firewall.installed &&
    !firewall.partial &&
    !firewall.stale
  );
}

export function browserCompanionRequirement(state: VigilState, now = new Date()): BrowserCompanionRequirement {
  if (state.settings?.browserNoiseBlockingEnabled !== false) {
    return {
      required: true,
      detail: "Browser cleanup is enabled."
    };
  }

  if (contentFilterEnabled(state)) {
    return {
      required: true,
      detail: "Content feature filters are enabled."
    };
  }

  const profile = activePolicy(state, now)?.profile || baselinePolicy(state, now, { device: "computer" })?.profile;
  const profileNeed = browserCompanionRequirementForProfile(profile);
  if (profileNeed.required) return profileNeed;

  return {
    required: false,
    detail: "System network blocking is enough for the current whole-site domain blocks."
  };
}

export function browserCompanionRequirementForProfile(profile: Profile | null | undefined): BrowserCompanionRequirement {
  if (!profile) {
    return {
      required: false,
      detail: "No active browser profile requires precise in-page enforcement."
    };
  }

  if (profile.mode === "allowlist") {
    return {
      required: true,
      detail: "Allowlist browser profiles require precise browser companion rules."
    };
  }

  const urlPatterns = profile.blockedUrlPatterns || [];
  if (urlPatterns.length && profile.hostsUrlPatternBlocking === false) {
    return {
      required: true,
      detail: "Path-specific URL patterns require precise browser companion rules."
    };
  }

  if (urlPatterns.some((pattern) => !urlPatternCanUseSystemNetwork(pattern))) {
    return {
      required: true,
      detail: "Fragment or path-only URL patterns require precise browser companion rules."
    };
  }

  return {
    required: false,
    detail: "Whole-site domain blocking can be enforced by the system network block."
  };
}

function urlPatternCanUseSystemNetwork(value: unknown): boolean {
  const pattern = normalizeUrlPattern(value);
  if (!pattern || pattern.startsWith("/") || !pattern.includes("/")) return false;
  const slash = pattern.indexOf("/");
  const host = normalizeHost(pattern.slice(0, slash));
  const path = pattern.slice(slash).replace(/\/+$/, "");
  return Boolean(path && path !== "/" && isPublicHost(host));
}

function isPublicHost(host: string): boolean {
  return Boolean(
    host &&
    host.includes(".") &&
    /^[a-z0-9.-]+$/.test(host) &&
    !host.startsWith(".") &&
    !host.endsWith(".") &&
    !host.includes("..") &&
    !["localhost", "127.0.0.1", "::1"].includes(host)
  );
}
