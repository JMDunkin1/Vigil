type WindowResizeEdge = "s" | "e" | "w" | "se" | "sw";

interface VigilWindowResizeBridge {
  begin(edge: WindowResizeEdge, screenX: number, screenY: number): void;
  move(screenX: number, screenY: number): void;
  end(): void;
}

interface VigilResizeWindow extends Window {
  vigilWindowResize?: VigilWindowResizeBridge;
}

const RESIZE_EDGES: WindowResizeEdge[] = ["s", "e", "w", "se", "sw"];
let endActiveResize: (() => void) | null = null;

export function bindWindowResizeHandles(): void {
  const bridge = (window as VigilResizeWindow).vigilWindowResize;
  if (!bridge) return;

  for (const edge of RESIZE_EDGES) {
    const handle = document.createElement("div");
    handle.className = `window-resize-handle window-resize-${edge}`;
    handle.dataset.resizeEdge = edge;
    handle.setAttribute("aria-hidden", "true");
    handle.addEventListener("pointerdown", (event) => beginResize(event, edge, bridge));
    document.body.append(handle);
  }
}

function beginResize(event: PointerEvent, edge: WindowResizeEdge, bridge: VigilWindowResizeBridge): void {
  if (event.button !== 0) return;
  endActiveResize?.();
  const handle = event.currentTarget as HTMLElement;
  event.preventDefault();
  handle.setPointerCapture(event.pointerId);
  document.documentElement.classList.add("is-window-resizing");
  bridge.begin(edge, event.screenX, event.screenY);

  const move = (moveEvent: PointerEvent) => {
    if (moveEvent.pointerId === event.pointerId) bridge.move(moveEvent.screenX, moveEvent.screenY);
  };
  const endPointer = (endEvent: PointerEvent) => {
    if (endEvent.pointerId === event.pointerId) end();
  };
  const end = () => {
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", endPointer);
    handle.removeEventListener("pointercancel", endPointer);
    handle.removeEventListener("lostpointercapture", endPointer);
    window.removeEventListener("blur", end);
    endActiveResize = null;
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    document.documentElement.classList.remove("is-window-resizing");
    bridge.end();
  };
  endActiveResize = end;
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", endPointer);
  handle.addEventListener("pointercancel", endPointer);
  handle.addEventListener("lostpointercapture", endPointer);
  window.addEventListener("blur", end);
}
