import type { ServerResponse } from "node:http";
import { firewallStatus } from "../firewall.js";
import { hostsStatus } from "../hardening.js";
import { clearIntegrityTamper } from "../integrityLockdown.js";
import { assertProtectedEditAllowed } from "../protection.js";
import { safariFilterStatus } from "../safariFilter.js";
import { chromeSafeSearchStatus, invalidateChromeSafeSearchProfileInventory } from "../chromeSafeSearch.js";
import { addEvent, saveState } from "../store.js";
import type { VigilState } from "../types.js";
import { errorStatus, sendJson, serializeError } from "./http.js";
import type { createLocalScriptRunner } from "./localScripts.js";
import { invalidateStateDiagnostics } from "./statePayload.js";

type LocalScriptRunner = ReturnType<typeof createLocalScriptRunner>;

interface HardeningApiContext {
  method: string;
  path: string;
  state: VigilState;
  localScripts: LocalScriptRunner;
  recordExternalResult?: (type: string, detail: Record<string, unknown>) => Promise<boolean>;
}

export async function handleHardeningApiRoute(response: ServerResponse, context: HardeningApiContext): Promise<boolean> {
  const { method, path, state, localScripts } = context;

  if (method === "POST" && path === "/api/hardening/launch-agent/install") {
    if (process.env.VIGIL_EMBEDDED_RUNTIME === "1") {
      sendJson(response, 409, { error: "Vigil's background enforcement is built into the Mac app; no localhost login agent is needed." });
      return true;
    }
    try {
      const result = await localScripts.runLocalScript("install-launch-agent.mjs");
      const launchAgent = await localScripts.waitForLaunchAgentRunning();
      const recorded = await context.recordExternalResult?.("launch_agent_installed", { ok: true }) ?? false;
      invalidateStateDiagnostics();
      sendJson(response, recorded ? 200 : 500, externalResultBody({ result, launchAgent }, recorded));
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
      const detail = {
        ok: Boolean(hosts.current && firewall.current),
        current: Boolean(hosts.current && firewall.current),
        hostsEntries: hosts.installedEntries || 0,
        firewallEntries: firewall.installedEntries || 0
      };
      const recorded = await context.recordExternalResult?.("network_block_applied", detail) ?? false;
      invalidateStateDiagnostics();
      sendJson(response, hardeningResultHttpStatus(recorded, detail.ok), externalResultBody({ result, hosts, firewall }, recorded, detail.ok));
    } catch (error) {
      sendJson(response, 500, serializeError(error));
    }
    return true;
  }

  if (method === "POST" && path === "/api/hardening/safari-filter/apply") {
    try {
      const result = await localScripts.runLocalScript("apply-safari-filter.mjs");
      const safariFilter = await safariFilterStatus(state);
      const detail = {
        ok: Boolean(safariFilter.current),
        current: Boolean(safariFilter.current),
        installed: safariFilter.installed,
        stale: safariFilter.stale,
        urlCount: safariFilter.urlCount || 0,
        pathUrlCount: safariFilter.pathUrlCount || 0
      };
      const recorded = await context.recordExternalResult?.("safari_url_filter_opened", detail) ?? false;
      invalidateStateDiagnostics();
      sendJson(response, hardeningResultHttpStatus(recorded, detail.ok), externalResultBody({ result, safariFilter }, recorded, detail.ok));
    } catch (error) {
      sendJson(response, 500, serializeError(error));
    }
    return true;
  }

  if (method === "POST" && path === "/api/hardening/chrome-safe-search/apply") {
    try {
      const result = await localScripts.runLocalScript("apply-chrome-safe-search.mjs");
      invalidateChromeSafeSearchProfileInventory();
      const chromeSafeSearch = await chromeSafeSearchStatus();
      const detail = {
        ok: Boolean(chromeSafeSearch.generated),
        current: Boolean(chromeSafeSearch.current),
        installed: chromeSafeSearch.installed,
        stale: chromeSafeSearch.stale,
        forced: chromeSafeSearch.forced
      };
      const recorded = await context.recordExternalResult?.("chrome_safe_search_profile_exported", detail) ?? false;
      invalidateStateDiagnostics();
      sendJson(response, hardeningResultHttpStatus(recorded, detail.ok), externalResultBody({ result, chromeSafeSearch }, recorded, detail.ok));
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

export function hardeningResultHttpStatus(recorded: boolean, effective: boolean): number {
  return !recorded ? 500 : effective ? 200 : 409;
}

function externalResultBody(result: Record<string, unknown>, recorded: boolean, effective = true): Record<string, unknown> {
  return {
    ok: recorded && effective,
    ...result,
    externalEffectSucceeded: effective,
    stateRecord: recorded ? "committed" : "failed",
    ...(!recorded
      ? { error: "The macOS change succeeded, but Vigil could not durably record its audit result. Verify the change before retrying." }
      : !effective
      ? { error: "The command completed, but the verified effective state is still degraded." }
      : {})
  };
}
