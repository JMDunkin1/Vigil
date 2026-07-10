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
    void onChange;
  }

  function selectedTargets(): string[] {
    return [...DEVICE_TARGETS];
  }

  function selectedLabel(): string {
    return "Computer + iPhone";
  }

  function render(appState: DeviceTargetState = {}): void {
    const status = document.querySelector("#deviceTargetStatus");
    if (status) status.textContent = selectedLabel();

    for (const target of DEVICE_TARGETS) {
      const session = appState.activeSessions?.[target] || null;
      const label = target === "phone"
        ? document.querySelector("#phoneTargetState")
        : document.querySelector("#computerTargetState");
      if (!label) continue;
      label.textContent = session
        ? `${target === "phone" ? "iPhone" : "Computer"}: ${session.mode === "brick" ? "Brick" : session.title || "Locked"}`
        : `${target === "phone" ? "iPhone" : "Computer"}: Normal`;
    }
  }

  return {
    bind,
    render,
    selectedTargets,
    selectedLabel
  };
}
