import type { DashboardData, HardeningCheck, UnknownRecord } from "./app-model.js";
import { el, textEl } from "./dom.js";

interface SetupItem {
  id: string;
  label: string;
  detail: string;
  ok: boolean;
  action: string;
}

export function renderSetupWizard(data: DashboardData): void {
  const items = setupItems(data);
  const ready = items.filter((item) => item.ok).length;
  const total = items.length;
  const progress = document.querySelector<HTMLElement>("#setupProgress");
  const root = document.querySelector<HTMLElement>("#setupChecklist");
  if (!progress || !root) return;

  progress.textContent = `${ready}/${total} ready`;
  progress.className = `pill ${ready === total ? "good" : "warn"}`;
  root.replaceChildren(...items.map(renderSetupItem));
}

function setupItems(data: DashboardData): SetupItem[] {
  const hardening = data.hardening || {};
  const settings = data.state.settings || {};
  const hosts = check(hardening.hosts);
  const firewall = check(hardening.firewall);
  const safariFilter = check(hardening.safariFilter);
  const launchAgent = check(hardening.launchAgent);
  const sourceSeal = check(hardening.sourceSeal);
  const account = record(hardening.account);
  const extension = record(data.state.extension);
  const dynamicRules = record(extension.dynamicRules);
  const ios = data.devices?.ios || {};
  const mdm = record(ios.mdm);
  const networkReady = settings.systemNetworkBlockingEnabled !== false && current(hosts) && current(firewall);
  const safariReady = Boolean(settings.safariUrlFilterEnabled !== false && (!safariFilter.required || safariFilter.current));
  const extensionSeen = Boolean(extension.lastSeenAt);
  const extensionRulesReady = dynamicRules.ok !== false && dynamicRules.status !== "missing";
  const iPhoneReady = Boolean(ios.enabled && (mdm.enrollmentReady || mdm.ready || ios.profile));

  return [
    {
      id: "accessibility",
      label: "Accessibility",
      ok: Boolean(data.monitor?.ok && !data.monitor.accessibilityLikelyMissing),
      detail: data.monitor?.accessibilityLikelyMissing
        ? "Grant Sentinel Accessibility in macOS Privacy & Security."
        : (data.monitor?.ok ? "Foreground app detection looks available." : "Foreground app detection has not reported healthy yet."),
      action: "macOS permission"
    },
    {
      id: "launch-agent",
      label: "LaunchAgent",
      ok: Boolean(launchAgent.loaded && launchAgent.running && !launchAgent.legacyInstalled),
      detail: launchAgent.running ? "Login agent is loaded and running." : "Install the login agent so Sentinel restarts after login.",
      action: "Install Login Agent"
    },
    {
      id: "extension",
      label: "Browser extension",
      ok: extensionSeen && extensionRulesReady,
      detail: extensionSeen
        ? `Last check-in${extension.lastVersion ? ` from v${extension.lastVersion}` : ""}; dynamic rules ${extensionRulesReady ? "look synced" : "need refresh"}.`
        : "Load the companion extension so browser cleanup and path filters can sync.",
      action: "Copy Extension Path"
    },
    {
      id: "safari-filter",
      label: "Safari filter",
      ok: safariReady,
      detail: safariFilter.required
        ? (safariFilter.current ? "Safari path filter profile is current." : "Apply the Safari profile for path-specific blocks.")
        : "No path-specific Safari profile is required for the current rules.",
      action: "Apply Safari Filter"
    },
    {
      id: "network-block",
      label: "Network block",
      ok: networkReady,
      detail: networkReady ? "Hosts and PF firewall blocks are current." : networkDetail(hosts, firewall, settings.systemNetworkBlockingEnabled !== false),
      action: "Apply Network Block"
    },
    {
      id: "source-seal",
      label: "Source seal",
      ok: Boolean(sourceSeal.ok),
      detail: String(sourceSeal.detail || (sourceSeal.ok ? "Source integrity seal is trusted." : "Review local source, then seal it.")),
      action: "Copy Source Seal"
    },
    {
      id: "standard-account",
      label: "Standard account",
      ok: Boolean(account.username && account.isAdmin === false),
      detail: account.username
        ? (account.isAdmin ? "Current user is an admin; use a standard daily account for stronger enforcement." : "Current user is a standard account.")
        : "macOS account type could not be inspected.",
      action: "Account advice"
    },
    {
      id: "iphone",
      label: "iPhone setup",
      ok: iPhoneReady,
      detail: iPhoneReady ? iPhoneReadyDetail(ios, mdm) : "Enable the supervised iPhone profile or finish MDM enrollment in Devices.",
      action: "Devices"
    }
  ];
}

function renderSetupItem(item: SetupItem): HTMLElement {
  return el(
    "div",
    { className: `setup-item ${item.ok ? "good" : "warn"}`, dataset: { setupItem: item.id } },
    textEl("span", item.ok ? "Ready" : "Action", { className: "setup-state" }),
    el(
      "div",
      { className: "setup-copy" },
      textEl("strong", item.label),
      textEl("em", item.detail)
    ),
    textEl("span", item.action, { className: "setup-action" })
  );
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

function iPhoneReadyDetail(ios: NonNullable<DashboardData["devices"]["ios"]>, mdm: UnknownRecord): string {
  if (mdm.ready) return "MDM enrollment and APNs wakeups are configured.";
  if (mdm.enrollmentReady) return "MDM enrollment profile is ready.";
  const profile = ios.profile || {};
  const appCount = Number(profile.appBundleCount || 0);
  const webCount = Number(profile.deniedUrlCount || 0) + Number(profile.allowedUrlCount || 0);
  return `Supervised profile is ready with ${appCount} apps and ${webCount} web rules.`;
}
