export const DEVICE_TARGETS = ["computer", "phone"];

export function createDeviceTargetController({ onChange = () => {} } = {}) {
  function bind() {
    for (const button of document.querySelectorAll("[data-device-target]")) {
      button.addEventListener("click", () => toggle(button));
    }
  }

  function toggle(button) {
    const selected = button.classList.contains("is-selected");
    const selectedCount = selectedTargets().length;
    if (selected && selectedCount === 1) return;
    button.classList.toggle("is-selected", !selected);
    button.setAttribute("aria-pressed", String(!selected));
    onChange();
  }

  function selectedTargets() {
    const selected = [...document.querySelectorAll("[data-device-target].is-selected")]
      .map((button) => button.dataset.deviceTarget)
      .filter((target) => DEVICE_TARGETS.includes(target));
    return selected.length ? selected : ["computer"];
  }

  function selectedLabel() {
    const selected = selectedTargets();
    if (selected.length === DEVICE_TARGETS.length) return "Computer + iPhone";
    return selected[0] === "phone" ? "iPhone" : "Computer";
  }

  function render(appState = {}) {
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
