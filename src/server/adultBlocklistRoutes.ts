import type { IncomingMessage, ServerResponse } from "node:http";
import {
  adultBlocklistSource,
  adultBlocklistSummary,
  commitAdultBlocklistRefresh,
  finalizeAdultBlocklistSnapshot,
  invalidateAdultBlocklistIfSourceChanged,
  normalizeAdultDomainList,
  refreshAdultBlocklist,
  type AdultBlocklistRefreshPreparation
} from "../adultBlocklist.js";
import { assertProtectedEditAllowed } from "../protection.js";
import { addEvent, saveState } from "../store.js";
import type { VigilState } from "../types.js";
import { errorStatus, readBody, sendJson, serializeError } from "./http.js";
import type { DurableEffectDescriptor } from "./mutationCoordinator.js";
import { updateSettings } from "./settingsRoutes.js";

interface AdultBlocklistApiContext {
  state: VigilState;
  afterCommit: (effect: () => void | Promise<void>, descriptor?: DurableEffectDescriptor) => void;
  preparedRefresh?: AdultBlocklistRefreshPreparation;
}

export async function handleAdultBlocklistApiRoute(
  request: IncomingMessage,
  response: ServerResponse,
  { state, afterCommit, preparedRefresh }: AdultBlocklistApiContext
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
      const summary = preparedRefresh
        ? await commitAdultBlocklistRefresh(state, preparedRefresh)
        : await refreshAdultBlocklist(state);
      addEvent(state, "adult_blocklist_refreshed", {
        sourceId: summary.selectedSourceId,
        domainCount: summary.domainCount,
        activeDomainCount: summary.activeDomainCount,
        hash: summary.shortHash
      });
      await saveState(state);
      afterCommit(
        () => finalizeAdultBlocklistSnapshot(state),
        {
          key: `adult-blocklist-finalize:${summary.hash}`,
          kind: "adult-blocklist-finalize",
          payload: { hash: summary.hash, snapshotPath: summary.snapshotPath }
        }
      );
      sendJson(response, 200, { ok: true, adultBlocklist: summary });
    } catch (error) {
      addEvent(state, "adult_blocklist_refresh_failed", { error: error instanceof Error ? error.message : String(error) });
      await saveState(state);
      sendJson(response, errorStatus(error), serializeError(error));
    }
    return true;
  }

  return false;
}
