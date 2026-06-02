export const DEVICE_TARGETS = ["computer", "phone"];

interface DeviceSession {
  mode?: string;
  title?: string;
}

interface DeviceTargetState {
  activeSessions?: Partial<Record<string, DeviceSession | null>>;
}

export function createDeviceTargetController({ onChange = () => {} }: { onChange?: () => void } = {}) {
  function bind() {
    for (const button of document.querySelectorAll<HTMLButtonElement>("[data-device-target]")) {
      button.addEventListener("click", () => toggle(button));
    }
  }

  function toggle(button: HTMLButtonElement): void {
    const selected = button.classList.contains("is-selected");
    const selectedCount = selectedTargets().length;
    if (selected && selectedCount === 1) return;
    button.classList.toggle("is-selected", !selected);
    button.setAttribute("aria-pressed", String(!selected));
    onChange();
  }

  function selectedTargets(): string[] {
    const selected = [...document.querySelectorAll<HTMLElement>("[data-device-target].is-selected")]
      .map((button) => button.dataset.deviceTarget)
      .filter((target): target is string => typeof target === "string" && DEVICE_TARGETS.includes(target));
    return selected.length ? selected : ["computer"];
  }

  function selectedLabel(): string {
    const selected = selectedTargets();
    if (selected.length === DEVICE_TARGETS.length) return "Computer + iPhone";
    return selected[0] === "phone" ? "iPhone" : "Computer";
  }

  function render(appState: DeviceTargetState = {}): void {
    const status = document.querySelector("#deviceTargetStatus");
    if (status) status.textContent = selectedLabel();

    for (const target of DEVICE_TARGETS) {
      const button = document.querySelector(`[data-device-target="${target}"]`);
      const session = appState.activeSessions?.[target] || null;
      if (button) {
        button.classList.toggle("has-session", Boolean(session));
        button.setAttribute("aria-pressed", String(button.classList.contains("is-selected")));
      }
      const label = target === "phone"
        ? document.querySelector("#phoneTargetState")
        : document.querySelector("#computerTargetState");
      if (!label) continue;
      label.textContent = session
        ? `${session.mode === "brick" ? "Brick" : session.title || "Locked"}`
        : "Normal";
    }
  }

  return {
    bind,
    render,
    selectedTargets,
    selectedLabel
  };
}
