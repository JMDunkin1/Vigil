import type { ServerResponse } from "node:http";
import { firewallStatus } from "../firewall.js";
import { hostsStatus } from "../hardening.js";
import { clearIntegrityTamper } from "../integrityLockdown.js";
import { assertProtectedEditAllowed } from "../protection.js";
import { safariFilterStatus } from "../safariFilter.js";
import { addEvent, saveState } from "../store.js";
import type { VigilState, UnknownRecord } from "../types.js";
import { sendJson } from "./http.js";
import type { createLocalScriptRunner } from "./localScripts.js";

type LocalScriptRunner = ReturnType<typeof createLocalScriptRunner>;

interface HardeningApiContext {
  method: string;
  path: string;
  state: VigilState;
  localScripts: LocalScriptRunner;
}

export async function handleHardeningApiRoute(response: ServerResponse, context: HardeningApiContext): Promise<boolean> {
  const { method, path, state, localScripts } = context;

  if (method === "POST" && path === "/api/hardening/launch-agent/install") {
    try {
      const result = await localScripts.runLocalScript("install-launch-agent.mjs");
      addEvent(state, "launch_agent_installed", { ok: true });
      await saveState(state);
      const launchAgent = await localScripts.waitForLaunchAgentRunning();
      sendJson(response, 200, { ok: true, result, launchAgent });
    } catch (error) {
      sendJson(response, 500, serializeError(error));
    }
    return true;
  }

  if (method === "POST" && path === "/api/hardening/hosts/apply") {
    try {
      const result = await localScripts.runPrivilegedHostsApply();
      const hosts = await hostsStatus(state);
      const firewall = await firewallStatus(state);
      addEvent(state, "network_block_applied", {
        ok: hosts.installed && !hosts.stale && firewall.installed && !firewall.stale,
        hostsEntries: hosts.installedEntries || 0,
        firewallEntries: firewall.installedEntries || 0
      });
      await saveState(state);
      sendJson(response, 200, { ok: true, result, hosts, firewall });
    } catch (error) {
      sendJson(response, 500, serializeError(error));
    }
    return true;
  }

  if (method === "POST" && path === "/api/hardening/safari-filter/apply") {
    try {
      const result = await localScripts.runLocalScript("apply-safari-filter.mjs");
      const safariFilter = await safariFilterStatus(state);
      addEvent(state, "safari_url_filter_opened", {
        ok: true,
        current: safariFilter.current,
        installed: safariFilter.installed,
        stale: safariFilter.stale,
        urlCount: safariFilter.urlCount || 0,
        pathUrlCount: safariFilter.pathUrlCount || 0
      });
      await saveState(state);
      sendJson(response, 200, { ok: true, result, safariFilter });
    } catch (error) {
      sendJson(response, 500, serializeError(error));
    }
    return true;
  }

  if (method === "POST" && path === "/api/integrity/clear-tamper") {
    try {
      assertProtectedEditAllowed(state, { kind: "settings" });
      const cleared = clearIntegrityTamper(state);
      addEvent(state, "state_tamper_cleared", { cleared });
      await saveState(state);
      sendJson(response, 200, { ok: true, cleared });
    } catch (error) {
      sendJson(response, errorStatus(error), serializeError(error));
    }
    return true;
  }

  return false;
}

function serializeError(error: unknown): { error: string; blockers?: unknown } {
  return {
    error: errorMessage(error),
    blockers: objectValue(error, "blockers")
  };
}

function errorStatus(error: unknown): number {
  const status = Number(objectValue(error, "status"));
  return Number.isInteger(status) ? status : 500;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function objectValue(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && key in value
    ? (value as UnknownRecord)[key]
    : undefined;
}
