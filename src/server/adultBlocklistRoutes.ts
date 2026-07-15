import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  adultBlocklistSource,
  adultBlocklistSummary,
  commitAdultBlocklistRefresh,
  finalizeAdultBlocklistSnapshot,
  invalidateAdultBlocklistIfSourceChanged,
  normalizeAdultDomainList,
  refreshAdultBlocklist,
  syncAdultBlocklistPhoneArtifact,
  writeAdultBlocklistPhoneArtifact,
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
  currentState: () => VigilState;
  afterCommit: (effect: () => void | Promise<void>, descriptor?: DurableEffectDescriptor) => void;
  preparedRefresh?: AdultBlocklistRefreshPreparation;
  recordIosMdmPolicyQueue?: (reason: string) => unknown;
}

export async function handleAdultBlocklistApiRoute(
  request: IncomingMessage,
  response: ServerResponse,
  { state, currentState, afterCommit, preparedRefresh, recordIosMdmPolicyQueue }: AdultBlocklistApiContext
): Promise<boolean> {
  const method = request.method || "GET";
  const path = new URL(request.url || "/", "http://localhost").pathname;

  if (method === "POST" && path === "/api/adult-blocklist/settings") {
    try {
      const body = await readBody(request);
      assertProtectedEditAllowed(state, { kind: "settings" });
      const previousSource = adultBlocklistSource(state);
      const keys = updateSettings(state.settings, body);
      const sourceChanged = invalidateAdultBlocklistIfSourceChanged(state, previousSource);
      if (sourceChanged) keys.push("adultBlocklistSnapshot");
      const allowlistChanged = Object.hasOwn(body, "allowlist");
      if (allowlistChanged) {
        state.adultBlocklist.allowlist = normalizeAdultDomainList(body.allowlist);
        keys.push("adultBlocklistAllowlist");
      }
      addEvent(state, "adult_blocklist_settings_updated", { keys });
      if (keys.length) recordIosMdmPolicyQueue?.("adult-blocklist-settings");
      await saveState(state);
      if (sourceChanged || allowlistChanged) {
        const snapshotHash = state.adultBlocklist.hash || "";
        const snapshotPath = state.adultBlocklist.snapshotPath || "";
        const allowlistHash = adultBlocklistAllowlistHash(state);
        const descriptor = {
          key: `adult-blocklist-phone-sync:${snapshotHash || "empty"}:${adultBlocklistSnapshotPathHash(snapshotPath)}:${allowlistHash}`,
          kind: "adult-blocklist-phone-sync",
          payload: { hash: snapshotHash, snapshotPath, allowlistHash }
        };
        afterCommit(
          async () => { await reconcileAdultBlocklistDurableEffect(currentState(), descriptor); },
          descriptor
        );
      }
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
      recordIosMdmPolicyQueue?.("adult-blocklist-refresh");
      await saveState(state);
      const allowlistHash = adultBlocklistAllowlistHash(state);
      const descriptor = {
        key: `adult-blocklist-finalize:${summary.hash}:${adultBlocklistSnapshotPathHash(summary.snapshotPath)}:${allowlistHash}`,
        kind: "adult-blocklist-finalize",
        payload: { hash: summary.hash, allowlistHash, snapshotPath: summary.snapshotPath, writePhoneArtifact: true }
      };
      afterCommit(
        async () => { await reconcileAdultBlocklistDurableEffect(currentState(), descriptor); },
        descriptor
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

export async function reconcileAdultBlocklistDurableEffect(
  currentState: VigilState,
  effect: Pick<DurableEffectDescriptor, "kind" | "payload">
): Promise<{ ok: true; obsolete?: true }> {
  const payload = effect.payload || {};
  const snapshotMatches = String(payload.hash || "") === String(currentState.adultBlocklist.hash || "");
  const snapshotPathMatches = String(payload.snapshotPath || "") === String(currentState.adultBlocklist.snapshotPath || "");
  const allowlistMatches = String(payload.allowlistHash || "") === adultBlocklistAllowlistHash(currentState);
  if (!snapshotMatches || !snapshotPathMatches || !allowlistMatches) return { ok: true, obsolete: true };

  if (effect.kind === "adult-blocklist-finalize") {
    if (payload.writePhoneArtifact === true) await writeAdultBlocklistPhoneArtifact(currentState);
    await finalizeAdultBlocklistSnapshot(currentState);
    return { ok: true };
  }
  if (effect.kind === "adult-blocklist-phone-sync") {
    await syncAdultBlocklistPhoneArtifact(currentState);
    return { ok: true };
  }
  throw new Error(`Unknown adult blocklist durable effect kind: ${effect.kind}`);
}

function adultBlocklistAllowlistHash(state: VigilState): string {
  return createHash("sha256")
    .update(JSON.stringify(normalizeAdultDomainList(state.adultBlocklist.allowlist)))
    .digest("hex");
}

function adultBlocklistSnapshotPathHash(snapshotPath: string): string {
  return createHash("sha256").update(snapshotPath).digest("hex");
}
