import type { DashboardData, HardeningCheck, UnknownRecord } from "./app-model.js";
import { el, textEl } from "./dom.js";

type SetupTier = "core" | "recommended" | "optional" | "advanced";
type NativeSetupDestination = "accessibility" | "accounts" | "extension" | "login-items";

interface SetupItem {
  id: string;
  label: string;
  detail: string;
  ok: boolean;
  action: string;
  tier: SetupTier;
  actionTarget?: string;
  nativeDestination?: NativeSetupDestination;
  explanation?: string;
  privacyNote?: string;
}

interface SetupAssistantOptions {
  refresh(): Promise<void>;
  toast(message: string): void;
}

interface SetupBridgeResponse {
  ok?: boolean;
  error?: string;
}

interface SetupBridgeWindow extends Window {
  vigilSetup?: {
    open(destination: NativeSetupDestination): Promise<unknown>;
  };
}

interface AssistantPage {
  id: string;
  kind: "welcome" | "item" | "summary";
  item?: SetupItem;
}

const SETUP_SCHEMA_VERSION = "2";
const SETUP_SEEN_KEY = `vigil-setup-seen-${SETUP_SCHEMA_VERSION}`;
const SETUP_COMPLETE_KEY = `vigil-setup-complete-${SETUP_SCHEMA_VERSION}`;
const SETUP_SNOOZE_KEY = `vigil-setup-snooze-${SETUP_SCHEMA_VERSION}`;
const SETUP_SNOOZE_MS = 12 * 60 * 60 * 1000;

let assistant: SetupAssistantController | null = null;

export function bindSetupAssistant(options: SetupAssistantOptions): void {
  assistant = new SetupAssistantController(options);
  assistant.bind();
}

export function renderSetupWizard(data: DashboardData): void {
  const items = setupItems(data);
  const required = coreItems(items);
  const ready = required.filter((item) => item.ok).length;
  const total = required.length;
  const progress = document.querySelector<HTMLElement>("#setupProgress");
  const root = document.querySelector<HTMLElement>("#setupChecklist");
  if (progress && root) {
    progress.textContent = `${ready}/${total} core ready`;
    progress.className = `pill ${ready === total ? "good" : "warn"}`;
    updateSetupChecklist(root, items);
  }
  assistant?.render(items);
}

function setupItems(data: DashboardData): SetupItem[] {
  const hardening = data.hardening || {};
  const settings = data.state.settings || {};
  const hosts = check(hardening.hosts);
  const firewall = check(hardening.firewall);
  const safariFilter = check(hardening.safariFilter);
  const chromeSafeSearch = check(hardening.chromeSafeSearch);
  const externalNetworkBlock = check(hardening.externalNetworkBlock);
  const launchAgent = check(hardening.launchAgent);
  const sourceSeal = check(hardening.sourceSeal);
  const account = record(hardening.account);
  const extension = record(data.state.extension);
  const dynamicRules = record(extension.dynamicRules);
  const ios = data.devices?.ios || {};
  const mdm = record(ios.mdm);
  const manageEngine = record(ios.manageEngine);
  const networkEnabled = settings.systemNetworkBlockingEnabled !== false;
  const networkReady = networkEnabled && current(hosts) && current(firewall);
  const safariReady = Boolean(
    !safariFilter.required
    || (safariFilter.appleCurrent && safariFilter.vigilPagesReachable !== false)
  );
  const extensionSeen = Boolean(extension.lastSeenAt);
  const extensionRulesReady = dynamicRules.ok !== false && dynamicRules.status !== "missing";
  const iPhoneReady = Boolean(ios.enabled && (mdm.ready || (manageEngine.preferred && manageEngine.currentGeneration)));
  const launchAgentReady = Boolean(launchAgent.loaded && launchAgent.running && (!launchAgent.embedded || launchAgent.restartHardened === true));

  return [
    {
      id: "launch-agent",
      label: "Background protection",
      ok: launchAgentReady,
      detail: launchAgent.embedded && launchAgent.restartHardened !== true
        ? "Repair automatic restart protection without leaving Vigil."
        : (launchAgent.running ? "Vigil opens at login and its enforcement runtime is online." : "Enable background protection so Vigil returns after login."),
      action: launchAgentReady ? "Open Login Items" : launchAgent.embedded ? "Repair protection" : "Enable at login",
      tier: "core",
      actionTarget: launchAgentReady ? undefined : "installLaunchAgent",
      nativeDestination: launchAgentReady ? "login-items" : undefined,
      explanation: "Background protection keeps your chosen rules active when the window is hidden and restores enforcement after an unexpected interruption.",
      privacyNote: "Closing the visible window hides Vigil; it does not turn off the protection you chose."
    },
    {
      id: "accessibility",
      label: "Foreground app access",
      ok: Boolean(data.monitor?.ok && !data.monitor.accessibilityLikelyMissing),
      detail: data.monitor?.accessibilityLikelyMissing
        ? "Grant Vigil Accessibility in macOS Privacy & Security, then return here to verify it."
        : (data.monitor?.ok ? "Foreground app detection is reporting healthy." : "Vigil is waiting for a healthy foreground-app check."),
      action: "Open Accessibility",
      tier: "core",
      nativeDestination: "accessibility",
      explanation: "Vigil needs this permission to recognize which app is in front and apply the schedule, limit, and usage rules you selected.",
      privacyNote: "Foreground activity and usage history stay in Vigil's local data directory unless you explicitly export diagnostics."
    },
    {
      id: "network-block",
      label: "System network protection",
      ok: networkEnabled ? networkReady : true,
      detail: networkEnabled
        ? (networkReady ? "Hosts and PF firewall blocks are current." : networkDetail(hosts, firewall, true))
        : "System network blocking is off, so this step is not required for the current setup.",
      action: networkEnabled ? "Apply Network Block" : "Not selected",
      tier: networkEnabled ? "core" : "recommended",
      actionTarget: networkEnabled && !networkReady ? "applyHostsBlock" : undefined,
      explanation: "System network protection makes whole-site blocks apply outside the browser companion as well.",
      privacyNote: "macOS asks for an administrator password because this step updates protected network configuration. Vigil verifies the result afterward."
    },
    {
      id: "safari-filter",
      label: "Safari protection",
      ok: safariReady,
      detail: safariFilter.required
        ? (safariFilter.appleCurrent && safariFilter.vigilPagesReachable === false
          ? "Reapply the Safari profile so Apple's filter can show Vigil's block screen."
          : safariFilter.appleCurrent
            ? "Apple's system web-safety policy is active and Vigil's block screen is reachable."
            : "Apply and approve the Safari profile so protected pages cannot bypass the filter.")
        : "No Safari content-filter profile is required for the current rules.",
      action: safariFilter.required ? "Apply Safari Filter" : "Not required",
      tier: safariFilter.required ? "core" : "optional",
      actionTarget: safariFilter.required && !safariReady ? "applySafariFilter" : undefined,
      explanation: "When your current rules need Safari coverage, macOS installs a visible configuration profile and asks you to approve it.",
      privacyNote: "The profile is generated locally from your rules. Approval always happens in macOS System Settings."
    },
    {
      id: "extension",
      label: "Chromium browser companion",
      ok: extensionSeen && extensionRulesReady,
      detail: extensionSeen
        ? `Last check-in${extension.lastVersion ? ` from v${extension.lastVersion}` : ""}; dynamic rules ${extensionRulesReady ? "are synced" : "need refresh"}.`
        : "Install the Vigil Companion for Chrome or another Chromium browser to enable page-level cleanup and path filters.",
      action: "Install Companion",
      tier: "recommended",
      nativeDestination: "extension",
      explanation: "The Vigil Companion adds page-level controls that a whole-site network block cannot provide. It is recommended when you use Chrome, Edge, Brave, or another Chromium browser.",
      privacyNote: "The companion talks only to Vigil on this Mac. Its broad page access is used to evaluate your local rules and clean distracting page elements."
    },
    {
      id: "chrome-safe-search",
      label: "Chrome SafeSearch",
      ok: chromeSafeSearch.current === true,
      detail: chromeSafeSearch.current === true
        ? "Chrome SafeSearch is locked to Filter."
        : "Optional for managed Chrome installations; export the profile and deploy it through device management.",
      action: "Export Chrome MDM Profile",
      tier: "advanced",
      actionTarget: chromeSafeSearch.current === true ? undefined : "applyChromeSafeSearch"
    },
    {
      id: "external-network-block",
      label: "DNS/router sync",
      ok: !externalNetworkBlock.enabled || Boolean(externalNetworkBlock.ready),
      detail: externalNetworkBlockDetail(externalNetworkBlock),
      action: "Optional",
      tier: "optional"
    },
    {
      id: "source-seal",
      label: "Development source seal",
      ok: Boolean(sourceSeal.ok),
      detail: String(sourceSeal.detail || (sourceSeal.ok ? "Source integrity seal is trusted." : "Only source-checkout installations need this developer integrity step.")),
      action: "Copy Source Seal",
      tier: "advanced",
      actionTarget: sourceSeal.ok ? undefined : "copySourceSealCommand"
    },
    {
      id: "standard-account",
      label: "Standard daily account",
      ok: Boolean(account.username && account.isAdmin === false),
      detail: account.username
        ? (account.isAdmin ? "Recommended for the strongest enforcement; this Mac is currently using an administrator account." : "The current macOS user is a standard account.")
        : "macOS account type could not be inspected.",
      action: "Open Users & Groups",
      tier: "recommended",
      nativeDestination: "accounts"
    },
    {
      id: "iphone",
      label: "iPhone coverage",
      ok: iPhoneReady,
      detail: iPhoneReady ? iPhoneReadyDetail(ios, manageEngine, mdm) : "Optional: configure supervised iPhone policy and verify delivery to a real device.",
      action: "Optional",
      tier: "optional"
    }
  ];
}

function updateSetupChecklist(root: HTMLElement, items: SetupItem[]): void {
  const existing = new Map(
    [...root.querySelectorAll<HTMLElement>("[data-setup-item]")]
      .map((node) => [node.dataset.setupItem || "", node])
  );
  let focusReplacement: HTMLButtonElement | null = null;
  const next: HTMLElement[] = [];
  for (const item of items) {
    const currentNode = existing.get(item.id);
    if (currentNode?.dataset.setupSignature === setupSignature(item)) {
      next.push(currentNode);
      continue;
    }
    const replacement = renderSetupItem(item);
    if (currentNode?.contains(document.activeElement)) {
      focusReplacement = replacement.querySelector<HTMLButtonElement>("button");
    }
    next.push(replacement);
  }

  next.forEach((node, index) => {
    const currentNode = root.children.item(index);
    if (currentNode === node) return;
    if (node.parentElement === root) root.insertBefore(node, currentNode);
    else if (currentNode) currentNode.replaceWith(node);
    else root.append(node);
  });
  while (root.children.length > next.length) {
    root.lastElementChild?.remove();
  }
  focusReplacement?.focus();
}

function externalNetworkBlockDetail(externalNetworkBlock: HardeningCheck): string {
  if (externalNetworkBlock.detail) return String(externalNetworkBlock.detail);
  if (!externalNetworkBlock.enabled) return "Optional Apple-network DNS/router sync is disabled.";
  return `Manual provider ready with ${externalNetworkBlock.targetDomainCount || 0} domain targets.`;
}

function renderSetupItem(item: SetupItem): HTMLElement {
  const actionable = Boolean(item.actionTarget || item.nativeDestination);
  const action = actionable
    ? textEl("button", item.action, { className: "setup-action", type: "button" })
    : textEl("span", item.action, { className: "setup-action" });
  if (actionable) {
    action.addEventListener("click", () => {
      void runChecklistItemAction(item).catch((error) => assistant?.showActionError(error));
    });
  }
  const node = el(
    "div",
    {
      className: `setup-item ${item.ok ? "good" : "warn"}`,
      dataset: { setupItem: item.id, setupTier: item.tier, setupSignature: setupSignature(item) }
    },
    textEl("span", item.ok ? "Ready" : item.tier === "core" ? "Action" : "Optional", { className: "setup-state" }),
    el(
      "div",
      { className: "setup-copy" },
      textEl("strong", item.label),
      textEl("em", item.detail)
    ),
    action
  );
  return node;
}

function setupSignature(item: SetupItem): string {
  return JSON.stringify([item.ok, item.label, item.detail, item.action, item.tier, item.actionTarget, item.nativeDestination]);
}

async function runChecklistItemAction(item: SetupItem): Promise<void> {
  if (item.actionTarget) {
    const target = document.querySelector<HTMLButtonElement>(`#${item.actionTarget}`);
    if (!target) throw new Error("The matching setup control is unavailable.");
    if (target.disabled) throw new Error("That setup action is already running or temporarily unavailable.");
    target.click();
    return;
  }
  if (item.nativeDestination) await openNativeSetupDestination(item.nativeDestination);
}

class SetupAssistantController {
  private readonly dialog: HTMLDialogElement;
  private readonly options: SetupAssistantOptions;
  private items: SetupItem[] = [];
  private pages: AssistantPage[] = [];
  private pageIndex = 0;
  private autoOpenEvaluated = false;
  private pageRenderRevision = 0;

  constructor(options: SetupAssistantOptions) {
    const dialog = document.querySelector<HTMLDialogElement>("#setupAssistant");
    if (!dialog) throw new Error("Missing setup assistant dialog.");
    this.dialog = dialog;
    this.options = options;
  }

  bind(): void {
    document.querySelector<HTMLButtonElement>("#openSetupAssistant")?.addEventListener("click", () => this.open(true));
    document.querySelector<HTMLButtonElement>("#closeSetupAssistant")?.addEventListener("click", () => this.finishLater());
    document.querySelector<HTMLButtonElement>("#setupAssistantLater")?.addEventListener("click", () => this.finishLater());
    document.querySelector<HTMLButtonElement>("#setupAssistantBack")?.addEventListener("click", () => this.move(-1));
    document.querySelector<HTMLButtonElement>("#setupAssistantNext")?.addEventListener("click", () => this.next());
    document.querySelector<HTMLButtonElement>("#setupAssistantAction")?.addEventListener("click", () => void this.runAction());
    this.dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      this.finishLater();
    });
  }

  showActionError(error: unknown): void {
    this.options.toast(error instanceof Error ? error.message : String(error));
  }

  render(items: SetupItem[]): void {
    const currentPageId = this.pages[this.pageIndex]?.id;
    this.items = items;
    this.pages = assistantPages(items);
    const preservedIndex = this.pages.findIndex((page) => page.id === currentPageId);
    this.pageIndex = preservedIndex >= 0 ? preservedIndex : Math.min(this.pageIndex, this.pages.length - 1);
    this.syncCompletionState();
    if (this.dialog.open) this.renderPage();
    if (!this.autoOpenEvaluated) {
      this.autoOpenEvaluated = true;
      if (this.shouldAutoOpen()) window.setTimeout(() => this.open(false), 220);
    }
  }

  private open(manual: boolean): void {
    if (!this.pages.length || this.dialog.open) return;
    if (manual) this.pageIndex = 0;
    else this.pageIndex = readStorage(SETUP_SEEN_KEY) === "true" ? firstPendingPageIndex(this.pages) : 0;
    this.renderPage();
    this.dialog.showModal();
  }

  private finishLater(): void {
    writeStorage(SETUP_SEEN_KEY, "true");
    if (!coreReady(this.items)) writeStorage(SETUP_SNOOZE_KEY, String(Date.now() + SETUP_SNOOZE_MS));
    if (this.dialog.open) this.dialog.close();
  }

  private next(): void {
    if (this.pageIndex < this.pages.length - 1) {
      this.pageIndex += 1;
      this.renderPage();
      return;
    }
    writeStorage(SETUP_SEEN_KEY, "true");
    if (coreReady(this.items)) {
      writeStorage(SETUP_COMPLETE_KEY, "true");
      removeStorage(SETUP_SNOOZE_KEY);
      this.options.toast("Vigil's core setup is verified");
    } else {
      writeStorage(SETUP_SNOOZE_KEY, String(Date.now() + SETUP_SNOOZE_MS));
      this.options.toast("Setup saved; Vigil will keep checking the remaining steps");
    }
    this.dialog.close();
  }

  private move(delta: number): void {
    this.pageIndex = Math.max(0, Math.min(this.pages.length - 1, this.pageIndex + delta));
    this.renderPage();
  }

  private async runAction(): Promise<void> {
    const item = this.pages[this.pageIndex]?.item;
    if (!item || item.ok) return;
    const startedOnRenderRevision = this.pageRenderRevision;
    const actionButton = requiredButton("#setupAssistantAction");
    const previousLabel = actionButton.textContent || item.action;
    actionButton.disabled = true;
    actionButton.textContent = item.nativeDestination ? "Opening…" : "Working…";
    try {
      await runChecklistItemAction(item);
      window.setTimeout(() => void this.options.refresh(), 900);
    } catch (error) {
      this.showActionError(error);
    } finally {
      window.setTimeout(() => {
        if (this.pageRenderRevision !== startedOnRenderRevision) return;
        actionButton.disabled = false;
        actionButton.textContent = previousLabel;
      }, 1000);
    }
  }

  private renderPage(): void {
    const page = this.pages[this.pageIndex];
    if (!page) return;
    this.pageRenderRevision += 1;
    const ready = coreReadyCount(this.items);
    const total = coreItems(this.items).length;
    const progress = ((this.pageIndex + 1) / Math.max(1, this.pages.length)) * 100;
    requiredElement("#setupAssistantStep").textContent = `Step ${this.pageIndex + 1} of ${this.pages.length}`;
    requiredElement("#setupAssistantReadiness").textContent = total ? `${ready}/${total} core protections verified` : "No core actions required";
    requiredElement("#setupAssistantProgressBar").style.width = `${progress}%`;
    requiredButton("#setupAssistantBack").hidden = this.pageIndex === 0;
    const nextButton = requiredButton("#setupAssistantNext");
    nextButton.textContent = this.pageIndex === this.pages.length - 1
      ? (coreReady(this.items) ? "Finish" : "Save for later")
      : "Continue";
    const actionButton = requiredButton("#setupAssistantAction");
    actionButton.disabled = false;
    actionButton.hidden = !page.item || page.item.ok || (!page.item.actionTarget && !page.item.nativeDestination);
    actionButton.textContent = page.item?.action || "Open Settings";

    if (page.kind === "welcome") this.renderWelcome();
    else if (page.kind === "summary") this.renderSummary();
    else if (page.item) this.renderItem(page.item);
  }

  private renderWelcome(): void {
    setAssistantHeading(
      "Welcome to Vigil",
      "Set up protection, one clear step at a time",
      "Vigil verifies each permission and protection after you complete it. Nothing is marked ready just because a button was clicked."
    );
    requiredElement("#setupAssistantBody").replaceChildren(el(
      "div",
      { className: "setup-assistant-card is-ready" },
      textEl("span", "1", { className: "setup-assistant-state-icon" }),
      el(
        "div",
        {},
        textEl("h3", "What this setup will do"),
        textEl("p", "We will verify background enforcement, foreground-app access, your selected network protection, and any required Safari coverage. Browser and iPhone enhancements remain clearly optional.")
      ),
      el(
        "div",
        { className: "setup-assistant-note" },
        textEl("strong", "Local first"),
        textEl("span", "Vigil stores rules, usage, and journal data on this Mac. The visible window can be hidden without taking background enforcement offline.")
      )
    ));
  }

  private renderItem(item: SetupItem): void {
    setAssistantHeading(
      item.tier === "core" ? "Core protection" : "Recommended coverage",
      item.label,
      item.explanation || item.detail
    );
    requiredElement("#setupAssistantBody").replaceChildren(el(
      "div",
      { className: `setup-assistant-card ${item.ok ? "is-ready" : ""}` },
      textEl("span", item.ok ? "✓" : "!", { className: "setup-assistant-state-icon" }),
      el(
        "div",
        {},
        textEl("h3", item.ok ? "Verified on this Mac" : "One action is still needed"),
        textEl("p", item.detail)
      ),
      el(
        "div",
        { className: "setup-assistant-note" },
        textEl("strong", item.ok ? "Ready" : "Why"),
        textEl("span", item.privacyNote || (item.ok ? "Vigil will keep checking this protection for drift." : "Complete the action, return to Vigil, and use the live status above to confirm it worked."))
      )
    ));
  }

  private renderSummary(): void {
    const ready = coreReady(this.items);
    setAssistantHeading(
      ready ? "Setup verified" : "Setup saved",
      ready ? "Vigil is ready to protect this Mac" : "Your remaining steps are easy to resume",
      ready
        ? "Core protection is online. Recommended browser, account, and iPhone hardening can be added from the checklist at any time."
        : "Vigil remains online and will reopen this guide on a later launch. The checklist in Settings always shows the live result."
    );
    const rows = this.items
      .filter((item) => item.tier === "core" || item.id === "extension" || item.id === "standard-account" || item.id === "iphone")
      .map((item) => el(
        "div",
        { className: `setup-assistant-summary-row ${item.ok ? "is-ready" : ""}` },
        textEl("i", item.ok ? "✓" : "•"),
        textEl("span", item.label),
        textEl("em", item.ok ? "Ready" : item.tier === "core" ? "Needs action" : "Optional")
      ));
    requiredElement("#setupAssistantBody").replaceChildren(el("div", { className: "setup-assistant-summary" }, ...rows));
  }

  private shouldAutoOpen(): boolean {
    if (readStorage(SETUP_SEEN_KEY) !== "true") return true;
    if (coreReady(this.items) && readStorage(SETUP_COMPLETE_KEY) === "true") return false;
    return Number(readStorage(SETUP_SNOOZE_KEY) || 0) <= Date.now();
  }

  private syncCompletionState(): void {
    if (coreReady(this.items)) {
      writeStorage(SETUP_COMPLETE_KEY, "true");
      removeStorage(SETUP_SNOOZE_KEY);
    } else {
      removeStorage(SETUP_COMPLETE_KEY);
    }
  }
}

function assistantPages(items: SetupItem[]): AssistantPage[] {
  const guidedItems = items.filter((item) => item.tier === "core" || item.id === "extension");
  return [
    { id: "welcome", kind: "welcome" },
    ...guidedItems.map((item) => ({ id: `item:${item.id}`, kind: "item" as const, item })),
    { id: "summary", kind: "summary" }
  ];
}

function firstPendingPageIndex(pages: AssistantPage[]): number {
  const pending = pages.findIndex((page) => page.kind === "item" && page.item?.tier === "core" && !page.item.ok);
  return pending >= 0 ? pending : 0;
}

function coreItems(items: SetupItem[]): SetupItem[] {
  return items.filter((item) => item.tier === "core");
}

function coreReadyCount(items: SetupItem[]): number {
  return coreItems(items).filter((item) => item.ok).length;
}

function coreReady(items: SetupItem[]): boolean {
  const required = coreItems(items);
  return required.length > 0 && required.every((item) => item.ok);
}

async function openNativeSetupDestination(destination: NativeSetupDestination): Promise<void> {
  const bridge = (window as SetupBridgeWindow).vigilSetup;
  if (!bridge) throw new Error("Open this setup step from the packaged Vigil Mac app.");
  const response = await bridge.open(destination) as SetupBridgeResponse;
  if (response?.ok === false) throw new Error(response.error || "The macOS setup page could not be opened.");
}

function setAssistantHeading(kicker: string, title: string, copy: string): void {
  requiredElement("#setupAssistantKicker").textContent = kicker;
  requiredElement("#setupAssistantTitle").textContent = title;
  requiredElement("#setupAssistantCopy").textContent = copy;
}

function requiredElement(selector: string): HTMLElement {
  const node = document.querySelector<HTMLElement>(selector);
  if (!node) throw new Error(`Missing setup assistant element: ${selector}`);
  return node;
}

function requiredButton(selector: string): HTMLButtonElement {
  const node = document.querySelector<HTMLButtonElement>(selector);
  if (!node) throw new Error(`Missing setup assistant button: ${selector}`);
  return node;
}

function readStorage(key: string): string {
  try {
    return localStorage.getItem(key) || "";
  } catch {
    return "";
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // The live readiness checks still work when persistent browser storage is unavailable.
  }
}

function removeStorage(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Nothing to clear when persistent browser storage is unavailable.
  }
}

function current(item: HardeningCheck): boolean {
  return Boolean(item.current || (item.installed && !item.partial && !item.stale));
}

function check(value: unknown): HardeningCheck {
  return record(value) as HardeningCheck;
}

function record(value: unknown): UnknownRecord {
  return typeof value === "object" && value !== null ? value as UnknownRecord : {};
}

function networkDetail(hosts: HardeningCheck, firewall: HardeningCheck, enabled: boolean): string {
  if (!enabled) return "System network blocking is disabled.";
  if (!current(hosts) && !current(firewall)) return "Apply hosts and PF firewall rules for whole-site blocks.";
  if (!current(hosts)) return "Hosts block is missing or stale.";
  return "PF firewall block is missing or stale.";
}

function iPhoneReadyDetail(ios: NonNullable<DashboardData["devices"]["ios"]>, manageEngine: UnknownRecord, mdm: UnknownRecord): string {
  if (mdm.ready) return "Advanced self-hosted MDM is configured.";
  if (manageEngine.currentGeneration) return "A current ManageEngine export generation is ready for assignment.";
  const profile = ios.profile || {};
  const appCount = Number(profile.appBundleCount || 0);
  const webCount = Number(profile.deniedUrlCount || 0) + Number(profile.allowedUrlCount || 0);
  return `Supervised profile is ready with ${appCount} apps and ${webCount} web rules.`;
}
