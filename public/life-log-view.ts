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
  let journalEntries: DashboardItem[] = [];

  $("#journalEntrySearch").addEventListener("input", () => renderJournalEntries(journalEntries));
  $("#journalEntryForm").addEventListener("input", () => renderJournalEntries(journalEntries));
  $("#journalNewEntry").addEventListener("click", () => {
    forms.resetJournalForm();
    renderJournalEntries(journalEntries);
    $("#journalEntryForm").elements.title.focus();
  });
  renderJournalEntries(journalEntries);

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
    journalEntries = entries;
    const list = $("#journalEntryList");
    list.replaceChildren();
    const query = $("#journalEntrySearch").value.trim().toLocaleLowerCase();
    const visibleEntries = query
      ? entries.filter((entry) => journalEntrySearchText(entry).includes(query))
      : entries;
    const form = $("#journalEntryForm");
    const selectedId = form.elements.id.value;
    if (!visibleEntries.length) {
      if (query) list.append(empty("No matching entries"));
      return;
    }

    for (const entry of visibleEntries) {
      const article = document.createElement("article");
      article.className = "journal-entry";
      article.classList.toggle("is-selected", entry.id === selectedId);

      const date = journalEntryDateText(entry);
      const title = entry.title || "Untitled entry";
      const select = document.createElement("button");
      select.className = "journal-entry-select";
      select.type = "button";
      select.setAttribute("aria-label", `Open ${title} from ${date}`);
      if (entry.id === selectedId) select.setAttribute("aria-current", "true");
      select.append(
        textEl("span", date, { className: "journal-entry-date" }),
        textEl("strong", title, { className: "journal-entry-title" }),
        textEl("span", journalEntryPreview(entry), { className: "journal-entry-preview" }),
        textEl("span", "›", { className: "journal-entry-chevron", attrs: { "aria-hidden": "true" } })
      );
      select.addEventListener("click", () => {
        forms.loadJournalEntry(entry);
        renderJournalEntries(journalEntries);
      });

      const actions = el("div", { className: "journal-entry-actions" });

      const remove = document.createElement("button");
      remove.className = "ghost compact";
      remove.type = "button";
      remove.textContent = "×";
      remove.setAttribute("aria-label", `Delete ${title}`);
      remove.title = "Delete entry";
      remove.addEventListener("click", async () => {
        await del(`/api/intentional-use/journal/${encodeURIComponent(entry.id)}`);
        if ($("#journalEntryForm").elements.id.value === entry.id) forms.resetJournalForm();
        toast("Entry deleted");
        await refresh();
      });

      actions.append(remove);
      article.append(select, actions);
      list.append(article);
    }
  }

  return { renderLifeLog };
}

function journalEntrySearchText(entry: DashboardItem): string {
  return [
    entry.title,
    entry.body,
    journalEntryDateText(entry)
  ].map((value) => String(value || "").toLocaleLowerCase()).join(" ");
}

function journalEntryPreview(entry: DashboardItem): string {
  const body = String(entry.body || "").replace(/\s+/gu, " ").trim();
  return body || "No text yet";
}

function journalEntryDateText(entry: DashboardItem): string {
  const raw = String(entry.entryDate || entry.createdAt || entry.updatedAt || "");
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime())) return "Saved entry";

  const today = new Date();
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const currentDay = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const difference = Math.round((currentDay - day) / 86_400_000);
  if (difference === 0) return "Today";
  if (difference === 1) return "Yesterday";

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === today.getFullYear() ? {} : { year: "numeric" as const })
  }).format(date);
}
