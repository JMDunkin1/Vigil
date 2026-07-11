import type { IncomingMessage, ServerResponse } from "node:http";
import {
  addIntentionalJournalEntry,
  applyPornRecoverySetup,
  confirmIntentionalPause,
  deleteIntentionalBehavior,
  deleteIntentionalJournalEntry,
  deleteIntentionalPlanBlock,
  deleteIntentionalPlanItem,
  deleteIntentionalPlanList,
  recordIntentionalBehaviorCheckIn,
  recordIntentionalRecoveryCheckIn,
  skipIntentionalPause,
  startIntentionalSosSession,
  updateIntentionalUseAccountability,
  updateIntentionalUseGoal,
  upsertIntentionalBehavior,
  upsertIntentionalPlanBlock,
  upsertIntentionalPlanItem,
  upsertIntentionalPlanList,
  upsertIntentionalUseRule
} from "../intentionalUse.js";
import { openApp } from "../macos.js";
import {
  journalVaultSummary,
  requireJournalVaultSession,
  revokeJournalVaultSession,
  setJournalVaultPassword,
  unlockJournalVaultWithPassword,
  unlockJournalVaultWithTouchId
} from "../journalVault.js";
import { assertProtectedEditAllowed } from "../protection.js";
import { addEvent, saveState } from "../store.js";
import type { SentinelState } from "../types.js";
import { pathTailId } from "../normalizers.js";
import { errorStatus, readBody, sendJson, serializeError } from "./http.js";

interface IntentionalUseApiContext {
  state: SentinelState;
  recordIosMdmPolicyQueue: (reason: string) => unknown;
  schedulePolicyEnforcement: (reason: string) => void;
}

export async function handleIntentionalUseApiRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  { state, recordIosMdmPolicyQueue, schedulePolicyEnforcement }: IntentionalUseApiContext
): Promise<boolean> {
  const method = request.method || "GET";
  const path = url.pathname;

  if (method === "GET" && path === "/api/intentional-use/journal/security") {
    sendJson(response, 200, { ok: true, journalVault: journalVaultSummary(state) });
    return true;
  }

  if (method === "POST" && path === "/api/intentional-use/journal/password") {
    try {
      const body = await readBody(request);
      assertProtectedEditAllowed(state, { kind: "settings" });
      const journalVault = setJournalVaultPassword(state, body);
      addEvent(state, "intentional_journal_password_set", { autoLockMinutes: journalVault.autoLockMinutes });
      await saveState(state);
      sendJson(response, 200, { ok: true, journalVault });
    } catch (error) {
      sendJson(response, errorStatus(error), serializeError(error));
    }
    return true;
  }

  if (method === "POST" && path === "/api/intentional-use/journal/unlock") {
    try {
      const body = await readBody(request);
      const session = unlockJournalVaultWithPassword(state, body);
      addEvent(state, "intentional_journal_unlocked", { method: session.method });
      sendJson(response, 200, { ok: true, session });
    } catch (error) {
      sendJson(response, errorStatus(error), serializeError(error));
    }
    return true;
  }

  if (method === "POST" && path === "/api/intentional-use/journal/unlock-touch-id") {
    try {
      const session = await unlockJournalVaultWithTouchId(state, request.headers);
      addEvent(state, "intentional_journal_unlocked", { method: session.method });
      sendJson(response, 200, { ok: true, session });
    } catch (error) {
      sendJson(response, errorStatus(error), serializeError(error));
    }
    return true;
  }

  if (method === "POST" && path === "/api/intentional-use/journal/lock") {
    const locked = revokeJournalVaultSession(request.headers);
    sendJson(response, 200, { ok: true, locked });
    return true;
  }

  if (method === "GET" && path === "/api/intentional-use/journal/entries") {
    try {
      requireJournalVaultSession(state, request.headers);
      sendJson(response, 200, { ok: true, entries: state.intentionalUse.journalEntries || [] });
    } catch (error) {
      sendJson(response, errorStatus(error), serializeError(error));
    }
    return true;
  }

  if (method === "POST" && path === "/api/intentional-use/goal") {
    try {
      const body = await readBody(request);
      assertProtectedEditAllowed(state, { kind: "settings" });
      const goal = updateIntentionalUseGoal(state, body);
      addEvent(state, "intentional_goal_saved", { values: goal.values?.length || 0, replacements: goal.replacements?.length || 0 });
      await saveState(state);
      sendJson(response, 200, { ok: true, goal });
    } catch (error) {
      sendJson(response, errorStatus(error), serializeError(error));
    }
    return true;
  }

  if (method === "POST" && path === "/api/intentional-use/accountability") {
    try {
      const body = await readBody(request);
      assertProtectedEditAllowed(state, { kind: "settings" });
      const accountability = updateIntentionalUseAccountability(state, body);
      addEvent(state, "intentional_accountability_saved", { enabled: accountability.enabled, cadence: accountability.cadence });
      await saveState(state);
      sendJson(response, 200, { ok: true, accountability });
    } catch (error) {
      sendJson(response, errorStatus(error), serializeError(error));
    }
    return true;
  }

  if (method === "POST" && path === "/api/intentional-use/recovery/setup") {
    try {
      const body = await readBody(request);
      assertProtectedEditAllowed(state, { kind: "settings" });
      const setup = applyPornRecoverySetup(state, body);
      addEvent(state, "intentional_recovery_setup_applied", {
        ruleId: setup.rule.id,
        behaviorCount: setup.behaviors.length
      });
      await saveState(state);
      sendJson(response, 200, { ok: true, setup });
    } catch (error) {
      sendJson(response, errorStatus(error), serializeError(error));
    }
    return true;
  }

  if (method === "POST" && path === "/api/intentional-use/rule") {
    try {
      const body = await readBody(request);
      assertProtectedEditAllowed(state, { kind: "settings" });
      const rule = upsertIntentionalUseRule(state, body);
      addEvent(state, "intentional_rule_saved", { ruleId: rule.id, name: rule.name, enabled: rule.enabled });
      await saveState(state);
      sendJson(response, 200, { ok: true, rule });
    } catch (error) {
      sendJson(response, errorStatus(error), serializeError(error));
    }
    return true;
  }

  if (method === "DELETE" && path.startsWith("/api/intentional-use/rule/")) {
    try {
      const id = pathTailId(path);
      assertProtectedEditAllowed(state, { kind: "settings" });
      state.intentionalUse.rules = (state.intentionalUse.rules || []).filter((rule) => rule.id !== id);
      state.intentionalUse.pauses = (state.intentionalUse.pauses || []).filter((pause) => pause.ruleId !== id);
      state.intentionalUse.grants = (state.intentionalUse.grants || []).filter((grant) => grant.ruleId !== id);
      addEvent(state, "intentional_rule_deleted", { ruleId: id });
      await saveState(state);
      sendJson(response, 200, { ok: true });
    } catch (error) {
      sendJson(response, errorStatus(error), serializeError(error));
    }
    return true;
  }

  if (method === "POST" && path === "/api/intentional-use/behavior") {
    try {
      const body = await readBody(request);
      assertProtectedEditAllowed(state, { kind: "settings" });
      const behavior = upsertIntentionalBehavior(state, body);
      addEvent(state, "intentional_behavior_saved", { behaviorId: behavior.id, name: behavior.name, active: behavior.active });
      await saveState(state);
      sendJson(response, 200, { ok: true, behavior });
    } catch (error) {
      sendJson(response, errorStatus(error), serializeError(error));
    }
    return true;
  }

  if (method === "DELETE" && path.startsWith("/api/intentional-use/behavior/")) {
    try {
      const id = pathTailId(path);
      assertProtectedEditAllowed(state, { kind: "settings" });
      const behavior = deleteIntentionalBehavior(state, id);
      addEvent(state, "intentional_behavior_archived", { behaviorId: id, name: behavior?.name || "" });
      await saveState(state);
      sendJson(response, 200, { ok: true, behavior });
    } catch (error) {
      sendJson(response, errorStatus(error), serializeError(error));
    }
    return true;
  }

  if (method === "POST" && path === "/api/intentional-use/behavior/check-in") {
    try {
      const body = await readBody(request);
      const checkIn = recordIntentionalBehaviorCheckIn(state, body);
      addEvent(state, checkIn ? "intentional_behavior_check_in" : "intentional_behavior_check_in_cleared", {
        behaviorId: checkIn?.behaviorId || String(body.behaviorId || ""),
        value: checkIn?.value ?? null,
        dateKey: checkIn?.dateKey || String(body.dateKey || "")
      });
      await saveState(state);
      sendJson(response, 200, { ok: true, checkIn, cleared: !checkIn });
    } catch (error) {
      sendJson(response, errorStatus(error), serializeError(error));
    }
    return true;
  }

  if (method === "POST" && path === "/api/intentional-use/journal") {
    try {
      const body = await readBody(request);
      requireJournalVaultSession(state, request.headers);
      const entry = addIntentionalJournalEntry(state, body);
      addEvent(state, "intentional_journal_saved", {
        entryId: entry.id,
        behaviorCount: entry.behaviorIds.length,
        ruleCount: entry.ruleIds.length
      });
      await saveState(state);
      sendJson(response, 200, { ok: true, entry });
    } catch (error) {
      sendJson(response, errorStatus(error), serializeError(error));
    }
    return true;
  }

  if (method === "DELETE" && path.startsWith("/api/intentional-use/journal/")) {
    try {
      requireJournalVaultSession(state, request.headers);
      const id = pathTailId(path);
      const deleted = deleteIntentionalJournalEntry(state, id);
      addEvent(state, "intentional_journal_deleted", { entryId: id, deleted });
      await saveState(state);
      sendJson(response, 200, { ok: true, deleted });
    } catch (error) {
      sendJson(response, errorStatus(error), serializeError(error));
    }
    return true;
  }

  if (method === "POST" && path === "/api/intentional-use/plan/list") {
    try {
      const body = await readBody(request);
      const list = upsertIntentionalPlanList(state, body);
      addEvent(state, "intentional_plan_list_saved", { listId: list.id, name: list.name, active: list.active });
      await saveState(state);
      sendJson(response, 200, { ok: true, list });
    } catch (error) {
      sendJson(response, errorStatus(error), serializeError(error));
    }
    return true;
  }

  if (method === "DELETE" && path.startsWith("/api/intentional-use/plan/list/")) {
    try {
      const id = pathTailId(path);
      const list = deleteIntentionalPlanList(state, id);
      addEvent(state, "intentional_plan_list_archived", { listId: id, name: list?.name || "" });
      await saveState(state);
      sendJson(response, 200, { ok: true, list });
    } catch (error) {
      sendJson(response, errorStatus(error), serializeError(error));
    }
    return true;
  }

  if (method === "POST" && path === "/api/intentional-use/plan/item") {
    try {
      const body = await readBody(request);
      const item = upsertIntentionalPlanItem(state, body);
      addEvent(state, "intentional_plan_item_saved", { itemId: item.id, listId: item.listId, status: item.status });
      await saveState(state);
      sendJson(response, 200, { ok: true, item });
    } catch (error) {
      sendJson(response, errorStatus(error), serializeError(error));
    }
    return true;
  }

  if (method === "DELETE" && path.startsWith("/api/intentional-use/plan/item/")) {
    try {
      const id = pathTailId(path);
      const item = deleteIntentionalPlanItem(state, id);
      addEvent(state, "intentional_plan_item_archived", { itemId: id, title: item?.title || "" });
      await saveState(state);
      sendJson(response, 200, { ok: true, item });
    } catch (error) {
      sendJson(response, errorStatus(error), serializeError(error));
    }
    return true;
  }

  if (method === "POST" && path === "/api/intentional-use/plan/block") {
    try {
      const body = await readBody(request);
      assertProtectedEditAllowed(state, { kind: "schedule", id: typeof body.id === "string" ? body.id : undefined });
      const block = upsertIntentionalPlanBlock(state, body);
      addEvent(state, "intentional_plan_block_saved", {
        blockId: block.id,
        title: block.title,
        startsAt: block.startsAt,
        endsAt: block.endsAt,
        profileId: block.profileId,
        enabled: block.enabled
      });
      recordIosMdmPolicyQueue("planner-block");
      await saveState(state);
      schedulePolicyEnforcement("planner-block-saved");
      sendJson(response, 200, { ok: true, block });
    } catch (error) {
      sendJson(response, errorStatus(error), serializeError(error));
    }
    return true;
  }

  if (method === "DELETE" && path.startsWith("/api/intentional-use/plan/block/")) {
    try {
      const id = pathTailId(path);
      assertProtectedEditAllowed(state, { kind: "schedule", id });
      const deleted = deleteIntentionalPlanBlock(state, id);
      addEvent(state, "intentional_plan_block_deleted", { blockId: id, deleted });
      recordIosMdmPolicyQueue("planner-block-deleted");
      await saveState(state);
      schedulePolicyEnforcement("planner-block-deleted");
      sendJson(response, 200, { ok: true, deleted });
    } catch (error) {
      sendJson(response, errorStatus(error), serializeError(error));
    }
    return true;
  }

  if (method === "POST" && path === "/api/intentional-use/recovery/check-in") {
    try {
      const body = await readBody(request);
      const checkIn = recordIntentionalRecoveryCheckIn(state, body);
      addEvent(state, "intentional_recovery_check_in", {
        status: checkIn.status,
        kind: checkIn.kind,
        urgeIntensity: checkIn.urgeIntensity
      });
      await saveState(state);
      sendJson(response, 200, { ok: true, checkIn });
    } catch (error) {
      sendJson(response, errorStatus(error), serializeError(error));
    }
    return true;
  }

  if (method === "POST" && path === "/api/intentional-use/recovery/sos") {
    try {
      const body = await readBody(request);
      const result = startIntentionalSosSession(state, body);
      addEvent(state, "intentional_recovery_sos_started", {
        intent: result.session.intent,
        urgeIntensity: result.session.urgeIntensity,
        trigger: result.session.trigger
      });
      await saveState(state);
      sendJson(response, 200, { ok: true, ...result });
    } catch (error) {
      sendJson(response, errorStatus(error), serializeError(error));
    }
    return true;
  }

  if (method === "POST" && path === "/api/intentional-use/pause/continue") {
    try {
      const body = await readBody(request);
      const result = confirmIntentionalPause(state, String(body.requestId || ""), body);
      const launch = result.pause.targetType === "app" && result.pause.app
        ? await openApp(result.pause.app)
        : null;
      addEvent(state, "intentional_pause_continued", {
        pauseId: result.pause.id,
        ruleId: result.pause.ruleId,
        target: result.pause.targetLabel,
        until: result.grant.until,
        launch
      });
      await saveState(state);
      sendJson(response, 200, { ok: true, ...result, launch });
    } catch (error) {
      sendJson(response, errorStatus(error), serializeError(error));
    }
    return true;
  }

  if (method === "POST" && path === "/api/intentional-use/pause/skip") {
    try {
      const body = await readBody(request);
      const result = skipIntentionalPause(state, String(body.requestId || ""), body);
      addEvent(state, "intentional_pause_skipped", {
        pauseId: result.pause.id,
        ruleId: result.pause.ruleId,
        target: result.pause.targetLabel,
        replacement: result.pause.replacement
      });
      await saveState(state);
      sendJson(response, 200, { ok: true, ...result });
    } catch (error) {
      sendJson(response, errorStatus(error), serializeError(error));
    }
    return true;
  }

  return false;
}
