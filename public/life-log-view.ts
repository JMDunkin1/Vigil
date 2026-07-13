import type { DashboardItem, IntentionalUseSummary } from "./app-model.js";
import { el, progressBlock, textEl } from "./dom.js";
import type { FormController } from "./forms.js";

type QueryElement = typeof import("./ui-shell.js").$;
type DeleteRequest = (path: string) => Promise<unknown>;

interface LifeLogViewContext {
  $: QueryElement;
  del: DeleteRequest;
  refresh(): Promise<void>;
  toast(message: string): void;
  forms: FormController;
  empty(text: string): HTMLElement;
}

export function createLifeLogView(context: LifeLogViewContext) {
  const { $, del, refresh, toast, forms, empty } = context;

  function renderLifeLog(intentionalUse: IntentionalUseSummary): void {
    const lifeLog = intentionalUse?.lifeLog || {};
    const stats = lifeLog.stats || {};
    const behaviors = lifeLog.behaviors || [];
    const activeBehaviors = behaviors.filter((behavior) => behavior.active !== false);
    const rules = intentionalUse?.rules || [];

    $("#lifeLogStatus").textContent = `${activeBehaviors.length} habit${activeBehaviors.length === 1 ? "" : "s"} | ${stats.entriesThisWeek || 0} reflection${stats.entriesThisWeek === 1 ? "" : "s"} this week`;
    $("#lifeLogStatus").className = activeBehaviors.length || stats.entriesThisWeek ? "pill good" : "pill neutral";
    forms.renderMultiSelect($("#behaviorRuleIds"), rules);
    renderBehaviorList(behaviors);
    renderJournalEntries(lifeLog.entries || []);
  }

  function renderBehaviorList(behaviors: DashboardItem[]): void {
    const list = $("#behaviorList");
    list.replaceChildren();
    if (!behaviors.length) {
      list.append(empty("No habits saved"));
      return;
    }

    for (const behavior of behaviors) {
      const row = document.createElement("div");
      row.className = behavior.active === false ? "list-item limit-item muted-item" : "list-item limit-item";
      const percent = Math.max(4, Math.min(100, Number(behavior.percent || 0)));
      const target = behavior.weeklyTarget
        ? `${behavior.weeklyValue || 0}/${behavior.weeklyTarget} ${behavior.unit || "count"}`
        : `${behavior.weeklyCheckIns || 0} check-ins`;
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
        toast("Habit archived");
        await refresh();
      });

      row.append(label, edit, archive);
      list.append(row);
    }
  }

  function renderJournalEntries(entries: DashboardItem[]): void {
    const list = $("#journalEntryList");
    list.replaceChildren();
    if (!entries.length) {
      list.append(empty("No entries yet"));
      return;
    }

    for (const entry of entries.slice(0, 12)) {
      const article = document.createElement("article");
      article.className = "journal-entry";
      const head = el("div", { className: "journal-entry-head" }, textEl("strong", entry.title || "Untitled"));
      const body = textEl("p", entry.body || "", { className: "journal-entry-body" });
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
        toast("Entry deleted");
        await refresh();
      });

      actions.append(edit, remove);
      article.append(head, body, actions);
      list.append(article);
    }
  }

  return { renderLifeLog };
}
