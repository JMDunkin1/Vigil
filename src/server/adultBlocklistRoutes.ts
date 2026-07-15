import type { IncomingMessage, ServerResponse } from "node:http";
import {
  adultBlocklistSource,
  adultBlocklistSummary,
  finalizeAdultBlocklistSnapshot,
  invalidateAdultBlocklistIfSourceChanged,
  normalizeAdultDomainList,
  refreshAdultBlocklist,
  writeAdultBlocklistPhoneArtifact
} from "../adultBlocklist.js";
import { assertProtectedEditAllowed } from "../protection.js";
import { addEvent, saveState } from "../store.js";
import type { VigilState } from "../types.js";
import { errorStatus, readBody, sendJson, serializeError } from "./http.js";
import { updateSettings } from "./settingsRoutes.js";

interface AdultBlocklistApiContext {
  state: VigilState;
  recordIosMdmPolicyQueue?: (reason: string) => unknown;
}

export async function handleAdultBlocklistApiRoute(
  request: IncomingMessage,
  response: ServerResponse,
  { state, recordIosMdmPolicyQueue }: AdultBlocklistApiContext
): Promise<boolean> {
  const method = request.method || "GET";
  const path = new URL(request.url || "/", "http://localhost").pathname;

  if (method === "POST" && path === "/api/adult-blocklist/settings") {
    try {
      const body = await readBody(request);
      assertProtectedEditAllowed(state, { kind: "settings" });
      const previousSource = adultBlocklistSource(state);
      const keys = updateSettings(state.settings, body);
      if (invalidateAdultBlocklistIfSourceChanged(state, previousSource)) {
        keys.push("adultBlocklistSnapshot");
      }
      if (Object.hasOwn(body, "allowlist")) {
        state.adultBlocklist.allowlist = normalizeAdultDomainList(body.allowlist);
        keys.push("adultBlocklistAllowlist");
      }
      addEvent(state, "adult_blocklist_settings_updated", { keys });
      if (keys.length) recordIosMdmPolicyQueue?.("adult-blocklist-settings");
      await saveState(state);
      sendJson(response, 200, { ok: true, keys, adultBlocklist: adultBlocklistSummary(state) });
    } catch (error) {
      sendJson(response, errorStatus(error), serializeError(error));
    }
    return true;
  }

  if (method === "POST" && path === "/api/adult-blocklist/refresh") {
    try {
      assertProtectedEditAllowed(state, { kind: "settings" });
      const summary = await refreshAdultBlocklist(state);
      addEvent(state, "adult_blocklist_refreshed", {
        sourceId: summary.selectedSourceId,
        domainCount: summary.domainCount,
        activeDomainCount: summary.activeDomainCount,
        hash: summary.shortHash
      });
      await saveState(state);
      const phoneArtifact = await writeAdultBlocklistPhoneArtifact(state);
      await finalizeAdultBlocklistSnapshot(state);
      recordIosMdmPolicyQueue?.("adult-blocklist-refresh");
      sendJson(response, 200, { ok: true, adultBlocklist: summary, phoneArtifact });
    } catch (error) {
      addEvent(state, "adult_blocklist_refresh_failed", { error: error instanceof Error ? error.message : String(error) });
      await saveState(state);
      sendJson(response, errorStatus(error), serializeError(error));
    }
    return true;
  }

  return false;
}
