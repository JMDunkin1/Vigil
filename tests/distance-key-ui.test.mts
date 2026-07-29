import assert from "node:assert/strict";
import { createDistanceKeyUi } from "../public/distance-key-ui.js";

const globals = [
  captureGlobal("window"),
  captureGlobal("navigator"),
  captureGlobal("BarcodeDetector"),
  captureGlobal("requestAnimationFrame"),
  captureGlobal("cancelAnimationFrame")
];

let grantCamera!: (stream: MediaStream) => void;
const cameraPermission = new Promise<MediaStream>((resolve) => {
  grantCamera = resolve;
});
const track = {
  stopped: false,
  stop() {
    this.stopped = true;
  }
};
const stream = {
  getTracks: () => [track]
} as unknown as MediaStream;
const scannerClasses = new Set<string>();
const target = fakeElement();
let videoPlayCalls = 0;
const video = {
  ...fakeElement(),
  srcObject: null as MediaStream | null,
  async play() {
    videoPlayCalls += 1;
  }
};
const elements = new Map<string, unknown>([
  ["#target", target],
  ["#distanceScanner", fakeElement(scannerClasses)],
  ["#distanceScannerStatus", fakeElement()],
  ["#distanceScannerVideo", video]
]);
let scheduledFrames = 0;
let detectorInstances = 0;
const toasts: string[] = [];

try {
  class FakeBarcodeDetector {
    constructor() {
      detectorInstances += 1;
    }

    async detect(): Promise<Array<{ rawValue?: string }>> {
      return [];
    }
  }

  setGlobal("window", { BarcodeDetector: FakeBarcodeDetector });
  setGlobal("navigator", {
    mediaDevices: {
      getUserMedia: () => cameraPermission
    }
  });
  setGlobal("BarcodeDetector", FakeBarcodeDetector);
  setGlobal("requestAnimationFrame", () => {
    scheduledFrames += 1;
    return scheduledFrames;
  });
  setGlobal("cancelAnimationFrame", () => {});

  const ui = createDistanceKeyUi({
    $: (selector: string) => elements.get(selector) as never,
    toast: (message: string) => toasts.push(message),
    errorMessage: (error: unknown) => String(error)
  });

  const opening = ui.openScanner("#target");
  ui.closeScanner();
  grantCamera(stream);
  await opening;

  assert.equal(track.stopped, true, "a camera grant completed after close must be stopped immediately");
  assert.equal(video.srcObject, null);
  assert.equal(videoPlayCalls, 0, "a stale camera grant must not restart video playback");
  assert.equal(detectorInstances, 0, "a stale camera grant must not start QR detection");
  assert.equal(scheduledFrames, 0, "a stale camera grant must not start a scan loop");
  assert.equal(scannerClasses.has("hidden"), true);
  assert.deepEqual(toasts, []);
} finally {
  for (const global of globals) restoreGlobal(global);
}

function fakeElement(classes = new Set<string>()) {
  return {
    classList: {
      add: (...names: string[]) => names.forEach((name) => classes.add(name)),
      remove: (...names: string[]) => names.forEach((name) => classes.delete(name)),
      toggle: (name: string, force?: boolean) => {
        const enabled = force ?? !classes.has(name);
        if (enabled) classes.add(name);
        else classes.delete(name);
        return enabled;
      }
    },
    replaceChildren: () => {},
    textContent: "",
    value: ""
  };
}

function captureGlobal(key: string): { key: string; present: boolean; value: unknown } {
  return {
    key,
    present: key in globalThis,
    value: (globalThis as unknown as Record<string, unknown>)[key]
  };
}

function setGlobal(key: string, value: unknown): void {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    value,
    writable: true
  });
}

function restoreGlobal(global: { key: string; present: boolean; value: unknown }): void {
  if (global.present) setGlobal(global.key, global.value);
  else delete (globalThis as unknown as Record<string, unknown>)[global.key];
}
