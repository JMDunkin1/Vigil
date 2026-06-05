import type { DashboardItem, IntentionalPlanBlock, IntentionalPlanItem, IntentionalPlanList, IntentionalUseSummary } from "./app-model.js";
import { detailBlock, el, progressBlock, textEl } from "./dom.js";
import { shortDateTime } from "./format.js";
import type { FormController } from "./forms.js";

type QueryElement = typeof import("./ui-shell.js").$;
type PostRequest = <T = unknown>(path: string, body: unknown) => Promise<T>;
type DeleteRequest = (path: string) => Promise<unknown>;

interface LifeLogViewContext {
  $: QueryElement;
  post: PostRequest;
  del: DeleteRequest;
  refresh(): Promise<void>;
  toast(message: string): void;
  forms: FormController;
  deviceTargetsText(targets?: readonly string[]): string;
  profileName(profileId: string): string;
  empty(text: string): HTMLElement;
}

export function createLifeLogView(context: LifeLogViewContext) {
  const { $, post, del, refresh, toast, forms, deviceTargetsText, profileName, empty } = context;

  function renderLifeLog(intentionalUse: IntentionalUseSummary): void {
    const lifeLog = intentionalUse?.lifeLog || {};
    const stats = lifeLog.stats || {};
    const recovery = intentionalUse?.recovery || {};
    const recoveryWeek = recovery.week || {};
    const behaviors = lifeLog.behaviors || [];
    const planner = lifeLog.planner || {};
    const activeBehaviors = behaviors.filter((behavior) => behavior.active !== false);
    const rules = intentionalUse?.rules || [];

    $("#lifeLogStatus").textContent = `${stats.entriesThisWeek || 0} reflections | ${stats.activeBehaviors || 0} behaviors | ${planner.openItems || 0} items | ${(planner.activeBlocks || []).length} blocks`;
    $("#lifeLogStatus").className = (stats.entriesThisWeek || stats.behaviorCheckInsThisWeek || recoveryWeek.checkIns || planner.openItems || (planner.activeBlocks || []).length) ? "pill good" : "pill neutral";
    $("#journalWeekCount").textContent = String(stats.entriesThisWeek || 0);
    $("#behaviorWeekCount").textContent = String(stats.behaviorCheckInsThisWeek || 0);
    $("#reflectionStreak").textContent = `${stats.reflectionStreakDays || 0}d`;
    $("#recoveryWeekCount").textContent = String(recoveryWeek.checkIns || 0);
    $("#recoverySetbacks").textContent = String(recoveryWeek.setbacks || 0);
    $("#recoverySosCount").textContent = String(recoveryWeek.sos || 0);

    forms.renderMultiSelect($("#journalBehaviorIds"), activeBehaviors);
    forms.renderMultiSelect($("#journalRuleIds"), rules);
    forms.renderMultiSelect($("#behaviorRuleIds"), rules);
    forms.renderBehaviorCheckInSelect(activeBehaviors);
    renderBehaviorList(behaviors);
    renderBehaviorCheckIns(lifeLog.recentCheckIns || []);
    renderPlanner(planner);
    renderRecoveryCheckIns(recovery.recentCheckIns || []);
    renderSosPlan((recovery.recentSos || [])[0] || null);
    renderSosSessions(recovery.recentSos || []);
    renderJournalEntries(lifeLog.entries || [], behaviors, rules);
  }

  function renderBehaviorList(behaviors: DashboardItem[]): void {
    const list = $("#behaviorList");
    list.replaceChildren();
    if (!behaviors.length) {
      list.append(empty("No behaviors saved"));
      return;
    }

    for (const behavior of behaviors) {
      const row = document.createElement("div");
      row.className = behavior.active === false ? "list-item limit-item muted-item" : "list-item limit-item";
      const percent = Math.max(4, Math.min(100, Number(behavior.percent || 0)));
      const target = behavior.weeklyTarget ? `${behavior.weeklyValue || 0}/${behavior.weeklyTarget} ${behavior.unit || "count"}` : `${behavior.weeklyCheckIns || 0} check-ins`;
      const label = progressBlock(
        behavior.name,
        `${behavior.direction || "build"} | ${target} this week | ${behavior.active === false ? "archived" : "active"}`,
        percent
      );

      const edit = document.createElement("button");
      edit.className = "secondary";
      edit.type = "button";
      edit.textContent = "Edit";
      edit.addEventListener("click", () => forms.loadBehavior(behavior));

      const archive = document.createElement("button");
      archive.className = "ghost";
      archive.type = "button";
      archive.textContent = behavior.active === false ? "Archived" : "Archive";
      archive.disabled = behavior.active === false;
      archive.addEventListener("click", async () => {
        await del(`/api/intentional-use/behavior/${encodeURIComponent(behavior.id)}`);
        toast("Behavior archived");
        await refresh();
      });

      row.append(label, edit, archive);
      list.append(row);
    }
  }

  function renderBehaviorCheckIns(checkIns: DashboardItem[]): void {
    const list = $("#behaviorCheckInList");
    list.replaceChildren();
    if (!checkIns.length) {
      list.append(empty("No check-ins yet"));
      return;
    }

    for (const checkIn of checkIns.slice(0, 8)) {
      const row = document.createElement("div");
      row.className = "list-item compact-list-item";
      row.append(
        detailBlock(
          checkIn.behaviorName || checkIn.name || "Behavior",
          `${checkIn.value || 0} | ${checkIn.at ? shortDateTime(checkIn.at) : "--"}${checkIn.note ? ` | ${checkIn.note}` : ""}`
        )
      );
      list.append(row);
    }
  }

  function renderPlanner(planner: NonNullable<NonNullable<IntentionalUseSummary["lifeLog"]>["planner"]> = {}): void {
    const lists = planner.lists || [];
    const items = planner.items || [];
    const activeLists = lists.filter((list) => list.active !== false);
    renderPlanSelects(activeLists, items);
    renderPlanItems(planner.recentItems || items.filter((item) => item.status === "open"), activeLists);
    renderPlannerAgenda(planner.todayBlocks || [], planner.activeBlocks || []);
  }

  function renderPlanSelects(lists: IntentionalPlanList[], items: IntentionalPlanItem[]): void {
    const safeLists = lists.length ? lists : [{ id: "todo", name: "To Do" } as IntentionalPlanList];
    forms.fillSelect($("#planItemListId"), safeLists, safeLists[0]?.id || "");
    renderPlanBlockItemSelect(items.filter((item) => item.status !== "archived"));
  }

  function renderPlanBlockItemSelect(items: IntentionalPlanItem[]): void {
    const select = $("#planBlockItemId");
    const current = select.value;
    select.replaceChildren();
    const emptyOption = document.createElement("option");
    emptyOption.value = "";
    emptyOption.textContent = "No linked item";
    select.append(emptyOption);
    for (const item of items.slice(0, 80)) {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = item.title;
      select.append(option);
    }
    select.value = items.some((item) => item.id === current) ? current : "";
  }

  function renderPlanItems(items: IntentionalPlanItem[], lists: IntentionalPlanList[]): void {
    const root = $("#planItemList");
    root.replaceChildren();
    if (!items.length) {
      root.append(empty("No items saved"));
      return;
    }

    const listNames = new Map(lists.map((list) => [list.id, list.name]));
    for (const item of items.slice(0, 12)) {
      const row = document.createElement("div");
      row.className = item.status === "done" ? "list-item limit-item muted-item" : "list-item limit-item";
      const meta = [
        listNames.get(item.listId) || item.listId || "List",
        item.status,
        item.dueAt ? `due ${shortDateTime(item.dueAt)}` : "",
        ...(item.tags || []).slice(0, 3)
      ].filter(Boolean).join(" | ");
      const label = detailBlock(item.title, meta || "--");

      const schedule = compactButton("Schedule", () => forms.loadPlanBlockFromItem(item));
      const done = compactButton(item.status === "done" ? "Open" : "Done", async () => {
        await savePlanItem(item, { status: item.status === "done" ? "open" : "done" });
        toast(item.status === "done" ? "Item reopened" : "Item completed");
        await refresh();
      });
      const edit = compactButton("Edit", () => forms.loadPlanItem(item), "secondary");
      const archive = compactButton("Archive", async () => {
        await del(`/api/intentional-use/plan/item/${encodeURIComponent(item.id)}`);
        toast("Item archived");
        await refresh();
      }, "ghost");

      row.append(label, schedule, done, edit, archive);
      root.append(row);
    }
  }

  function renderPlannerAgenda(blocks: IntentionalPlanBlock[], activeBlocks: IntentionalPlanBlock[]): void {
    const root = $("#plannerAgenda");
    root.replaceChildren();
    if (!blocks.length) {
      root.append(empty("No blocks today"));
      return;
    }

    const activeIds = new Set(activeBlocks.map((block) => block.id));
    for (const block of blocks.slice(0, 12)) {
      const row = document.createElement("div");
      row.className = activeIds.has(block.id) ? "planner-block active" : "planner-block";
      const profile = profileName(block.profileId);
      const time = `${shortDateTime(block.startsAt)} - ${shortTime(block.endsAt)}`;
      const meta = [
        time,
        profile,
        deviceTargetsText(block.deviceTargets || []),
        block.enabled === false ? "off" : "on",
        block.completed ? "done" : ""
      ].filter(Boolean).join(" | ");

      const label = detailBlock(block.title, meta);
      const actions = el("div", { className: "planner-actions" },
        compactButton("Earlier", () => adjustPlanBlock(block, { shiftMinutes: -15 }), "ghost"),
        compactButton("Later", () => adjustPlanBlock(block, { shiftMinutes: 15 }), "ghost"),
        compactButton("Shorter", () => adjustPlanBlock(block, { durationMinutes: -15 }), "ghost"),
        compactButton("Longer", () => adjustPlanBlock(block, { durationMinutes: 15 }), "ghost"),
        compactButton("Edit", () => forms.loadPlanBlock(block), "secondary"),
        compactButton(block.completed ? "Open" : "Done", () => adjustPlanBlock(block, { completed: !block.completed }), "secondary"),
        compactButton("Delete", async () => {
          await del(`/api/intentional-use/plan/block/${encodeURIComponent(block.id)}`);
          toast("Block deleted");
          await refresh();
        }, "ghost")
      );

      row.append(label, actions);
      root.append(row);
    }
  }

  function compactButton(text: string, onClick: () => void | Promise<void>, className = "secondary"): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `${className} compact`;
    button.textContent = text;
    button.addEventListener("click", () => {
      void onClick();
    });
    return button;
  }

  async function savePlanItem(item: IntentionalPlanItem, overrides: Partial<IntentionalPlanItem> = {}): Promise<void> {
    await post("/api/intentional-use/plan/item", { ...item, ...overrides });
  }

  async function adjustPlanBlock(block: IntentionalPlanBlock, options: { shiftMinutes?: number; durationMinutes?: number; completed?: boolean }): Promise<void> {
    const startsAt = new Date(block.startsAt);
    const endsAt = new Date(block.endsAt);
    const shiftMs = Number(options.shiftMinutes || 0) * 60 * 1000;
    startsAt.setTime(startsAt.getTime() + shiftMs);
    endsAt.setTime(endsAt.getTime() + shiftMs + Number(options.durationMinutes || 0) * 60 * 1000);
    if (endsAt.getTime() <= startsAt.getTime() + 15 * 60 * 1000) {
      endsAt.setTime(startsAt.getTime() + 15 * 60 * 1000);
    }
    await post("/api/intentional-use/plan/block", {
      ...block,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      completed: options.completed ?? block.completed
    });
    toast("Block updated");
    await refresh();
  }

  function renderRecoveryCheckIns(checkIns: NonNullable<IntentionalUseSummary["recovery"]>["recentCheckIns"] = []): void {
    const list = $("#recoveryCheckInList");
    list.replaceChildren();
    if (!checkIns.length) {
      list.append(empty("No recovery check-ins yet"));
      return;
    }

    for (const checkIn of checkIns.slice(0, 8)) {
      const row = document.createElement("div");
      row.className = "list-item compact-list-item";
      const meta = [
        checkIn.at ? shortDateTime(checkIn.at) : "",
        checkIn.urgeIntensity !== undefined ? `urge ${checkIn.urgeIntensity}/10` : "",
        checkIn.stress !== null && checkIn.stress !== undefined ? `stress ${checkIn.stress}/10` : "",
        checkIn.trigger ? `trigger: ${checkIn.trigger}` : "",
        checkIn.action ? `action: ${checkIn.action}` : ""
      ].filter(Boolean).join(" | ");
      row.append(detailBlock(recoveryLabel(checkIn.status), `${meta || "--"}${checkIn.note ? ` | ${checkIn.note}` : ""}`));
      list.append(row);
    }
  }

  function renderSosPlan(session: (DashboardItem & { plan?: string[] }) | null): void {
    const list = $("#sosPlan");
    list.replaceChildren();
    const plan = Array.isArray(session?.plan) ? session.plan : [];
    if (!plan.length) {
      list.append(empty("No SOS plan started"));
      return;
    }

    for (const step of plan.slice(0, 8)) {
      const row = document.createElement("div");
      row.className = "list-item compact-list-item";
      row.append(detailBlock("Reset step", step));
      list.append(row);
    }
  }

  function renderSosSessions(sessions: NonNullable<IntentionalUseSummary["recovery"]>["recentSos"] = []): void {
    const list = $("#sosSessionList");
    list.replaceChildren();
    if (!sessions.length) {
      list.append(empty("No SOS starts yet"));
      return;
    }

    for (const session of sessions.slice(0, 5)) {
      const row = document.createElement("div");
      row.className = "list-item compact-list-item";
      const meta = [
        session.startedAt ? shortDateTime(session.startedAt) : "",
        session.urgeIntensity !== undefined ? `urge ${session.urgeIntensity}/10` : "",
        session.trigger ? `trigger: ${session.trigger}` : "",
        session.replacement ? `replacement: ${session.replacement}` : ""
      ].filter(Boolean).join(" | ");
      row.append(detailBlock(recoveryLabel(session.intent || "SOS"), meta || "--"));
      list.append(row);
    }
  }

  function recoveryLabel(value: unknown): string {
    return String(value || "recovery")
      .split("-")
      .filter(Boolean)
      .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
      .join(" ");
  }

  function renderJournalEntries(entries: DashboardItem[], behaviors: DashboardItem[], rules: DashboardItem[]): void {
    const list = $("#journalEntryList");
    list.replaceChildren();
    if (!entries.length) {
      list.append(empty("No reflections saved"));
      return;
    }

    const behaviorNames = new Map(behaviors.map((behavior) => [behavior.id, behavior.name]));
    const ruleNames = new Map(rules.map((rule) => [rule.id, rule.name]));
    for (const entry of entries.slice(0, 12)) {
      const article = document.createElement("article");
      article.className = "journal-entry";
      const metaParts = [
        entry.entryDate ? shortDateTime(entry.entryDate) : "",
        entry.mood,
        entry.energy ? `energy ${entry.energy}/10` : ""
      ].filter(Boolean);
      const linked = [
        ...(entry.behaviorIds || []).map((id) => behaviorNames.get(id) || id),
        ...(entry.ruleIds || []).map((id) => ruleNames.get(id) || id)
      ].filter(Boolean);
      const tagLine = [...(entry.tags || []), ...linked].slice(0, 8);

      const head = el(
        "div",
        { className: "journal-entry-head" },
        textEl("strong", entry.title || "Reflection"),
        textEl("span", metaParts.join(" | ") || "--")
      );
      const body = textEl("p", entry.body || "", { className: "journal-entry-body" });
      const tags = el("div", { className: "tag-row" }, tagLine.map((tag) => textEl("span", tag)));
      const actions = el("div", { className: "journal-entry-actions" });

      const edit = document.createElement("button");
      edit.className = "secondary compact";
      edit.type = "button";
      edit.textContent = "Edit";
      edit.addEventListener("click", () => forms.loadJournalEntry(entry));

      const remove = document.createElement("button");
      remove.className = "ghost compact";
      remove.type = "button";
      remove.textContent = "Delete";
      remove.addEventListener("click", async () => {
        await del(`/api/intentional-use/journal/${encodeURIComponent(entry.id)}`);
        toast("Reflection deleted");
        await refresh();
      });

      actions.append(edit, remove);
      article.append(head, body);
      if (tagLine.length) article.append(tags);
      article.append(actions);
      list.append(article);
    }
  }

  function shortTime(value: unknown): string {
    const date = value ? new Date(String(value)) : null;
    if (!date || Number.isNaN(date.getTime())) return "--";
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  return {
    renderLifeLog,
    renderSosPlan
  };
}
