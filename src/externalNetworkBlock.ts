import { createHash } from "node:crypto";
import { managedBlockDomains } from "./hardening.js";
import type { VigilState, UnknownRecord } from "./types.js";

export type ExternalNetworkBlockProvider = "manual";

export interface ExternalNetworkBlockSummary extends UnknownRecord {
  enabled: boolean;
  provider: ExternalNetworkBlockProvider;
  ready: boolean;
  current: boolean;
  targetDomains: string[];
  targetDomainCount: number;
  signature: string;
  detail: string;
}

export function externalNetworkBlockEnabled(state: VigilState): boolean {
  return state.settings?.externalNetworkBlockEnabled === true;
}

export function externalNetworkBlockProvider(state: VigilState): ExternalNetworkBlockProvider {
  const provider = String(state.settings?.externalNetworkBlockProvider || "manual").trim().toLowerCase();
  return provider === "manual" ? "manual" : "manual";
}

export function externalNetworkBlockSummary(state: VigilState): ExternalNetworkBlockSummary {
  const enabled = externalNetworkBlockEnabled(state);
  const provider = externalNetworkBlockProvider(state);
  const targetDomains = managedBlockDomains(state);
  const signature = domainSignature(targetDomains);
  return {
    enabled,
    provider,
    ready: provider === "manual",
    current: false,
    targetDomains,
    targetDomainCount: targetDomains.length,
    signature,
    detail: externalNetworkBlockDetail(enabled, provider, targetDomains.length)
  };
}

function externalNetworkBlockDetail(enabled: boolean, provider: ExternalNetworkBlockProvider, targetDomainCount: number): string {
  if (!enabled) return "Optional DNS/router sync is disabled.";
  if (provider === "manual") {
    return targetDomainCount
      ? `Manual DNS/router provider is ready with ${targetDomainCount} domain target${targetDomainCount === 1 ? "" : "s"} to copy.`
      : "Manual DNS/router provider is ready; no whole-site domain targets are active right now.";
  }
  return "External network provider is not configured.";
}

function domainSignature(domains: string[]): string {
  return createHash("sha256").update(domains.join("\n")).digest("hex").slice(0, 16);
}
