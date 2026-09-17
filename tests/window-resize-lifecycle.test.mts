import assert from "node:assert/strict";
import { bindWindowResizeHandles } from "../public/window-resize.js";

class Handle extends EventTarget {
  className = "";
  dataset: Record<string, string> = {};
  captured: number | null = null;
  setAttribute() {}
  setPointerCapture(pointerId: number) { this.captured = pointerId; }
  hasPointerCapture(pointerId: number) { return this.captured === pointerId; }
  releasePointerCapture(pointerId: number) {
    if (this.captured === pointerId) this.captured = null;
  }
}
const handles: Handle[] = [];
const classes = new Set<string>();
const calls = { begin: 0, move: 0, end: 0 };
const fakeWindow = Object.assign(new EventTarget(), {
  vigilWindowResize: {
    begin() { calls.begin += 1; },
    move() { calls.move += 1; },
    end() { calls.end += 1; }
  }
});
const fakeDocument = {
  createElement: () => new Handle(),
  body: { append(handle: Handle) { handles.push(handle); } },
  documentElement: { classList: { add: (name: string) => classes.add(name), remove: (name: string) => classes.delete(name) } }
};
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
const pointer = (target: Handle, type: string, pointerId = 1) => {
  target.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), { button: 0, pointerId, screenX: 10, screenY: 20 }));
};
try {
  Object.defineProperty(globalThis, "window", { configurable: true, value: fakeWindow });
  Object.defineProperty(globalThis, "document", { configurable: true, value: fakeDocument });
  bindWindowResizeHandles();
  assert.equal(handles.length, 5);
  const handle = handles[0];
  assert.ok(handle);
  pointer(handle, "pointerdown");
  pointer(handle, "pointermove", 2);
  pointer(handle, "pointerup", 2);
  assert.equal(calls.move, 0, "another pointer cannot move the active resize");
  assert.equal(calls.end, 0, "another pointer cannot end the active resize");
  assert.equal(classes.has("is-window-resizing"), true);
  fakeWindow.dispatchEvent(new Event("blur"));
  assert.equal(calls.end, 1);
  assert.equal(handle.captured, null);
  assert.equal(classes.size, 0, "blur must clear resizing CSS and release capture");
  pointer(handle, "pointermove");
  assert.equal(calls.move, 0, "blur must detach the drag's move listener");
  fakeWindow.dispatchEvent(new Event("blur"));
  assert.equal(calls.end, 1, "a completed drag must detach its blur listener");

  pointer(handle, "pointerdown");
  pointer(handle, "pointermove");
  assert.equal(calls.move, 1, "a new drag must have exactly one move listener");
  pointer(handle, "lostpointercapture");
  assert.equal(calls.end, 2);
  assert.equal(classes.size, 0, "lost pointer capture must terminate the drag");
  pointer(handle, "pointerup");
  assert.equal(calls.end, 2);

  pointer(handle, "pointerdown");
  pointer(handle, "pointerdown");
  assert.equal(calls.end, 3, "a replacement drag must dispose the previous listeners");
  pointer(handle, "pointermove");
  assert.equal(calls.move, 2);
  pointer(handle, "pointercancel");
  assert.equal(calls.end, 4);
  assert.equal(classes.size, 0);
} finally {
  if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
  else Reflect.deleteProperty(globalThis, "window");
  if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
  else Reflect.deleteProperty(globalThis, "document");
}
console.log("Window resize lifecycle tests passed");
