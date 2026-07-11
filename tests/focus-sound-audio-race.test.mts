import assert from "node:assert/strict";
import { createFocusSoundController } from "../public/focus-sound.js";

type Control = {
  checked: boolean;
  textContent: string;
  value: string;
  replaceChildren?: (...children: unknown[]) => void;
};

class FakeAudioNode {
  disconnected = false;

  connect<T>(target: T): T {
    return target;
  }

  disconnect(): void {
    this.disconnected = true;
  }
}

class FakeGainNode extends FakeAudioNode {
  gain = {
    value: 0,
    setTargetAtTime: (value: number) => {
      this.gain.value = value;
    }
  };
}

class FakeBufferSourceNode extends FakeAudioNode {
  buffer: AudioBuffer | null = null;
  loop = false;
  starts = 0;
  stops = 0;

  start(): void {
    this.starts += 1;
  }

  stop(): void {
    this.stops += 1;
  }
}

const sources: FakeBufferSourceNode[] = [];

class FakeAudioContext {
  destination = new FakeAudioNode();
  state = "running";

  createGain(): GainNode {
    return new FakeGainNode() as unknown as GainNode;
  }

  createBufferSource(): AudioBufferSourceNode {
    const source = new FakeBufferSourceNode();
    sources.push(source);
    return source as unknown as AudioBufferSourceNode;
  }

  decodeAudioData(_buffer: ArrayBuffer): Promise<AudioBuffer> {
    return Promise.resolve({ duration: 1 } as AudioBuffer);
  }

  resume(): Promise<void> {
    return Promise.resolve();
  }
}

const controls = new Map<string, Control>();
for (const id of [
  "focusSoundEnabled",
  "focusSoundMode",
  "focusSoundActivity",
  "focusSoundPreset",
  "focusSoundIntensity",
  "focusSoundTimerMode",
  "focusSoundTimerMinutes",
  "focusSoundBreakMinutes",
  "focusSoundVolume",
  "focusSoundStatus"
]) {
  controls.set(`#${id}`, {
    checked: false,
    textContent: "",
    value: "",
    replaceChildren: () => {}
  });
}

const pendingFetches = new Map<string, (response: Response) => void>();
const requestedFetches: string[] = [];
const originalWindow = globalValue("window");
const originalDocument = globalValue("document");
const originalFetch = globalThis.fetch;

try {
  setGlobal("window", { AudioContext: FakeAudioContext });
  setGlobal("document", {
    activeElement: null,
    createElement: () => ({ textContent: "", value: "" }),
    querySelector: (selector: string) => controls.get(selector) || null
  });
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    requestedFetches.push(url);
    return new Promise<Response>((resolve) => {
      pendingFetches.set(url, resolve);
    });
  }) as typeof fetch;

  const focusSound = createFocusSoundController({
    $: (selector: string) => {
      const control = controls.get(selector);
      assert.ok(control, `${selector} should exist`);
      return control as unknown as HTMLElement & { checked: boolean; value: string };
    },
    post: async () => ({})
  });

  focusSound.render(dataForPreset("rain"));
  focusSound.render(dataForPreset("rain"));
  await settle();

  assert.deepEqual(requestedFetches, ["/audio/nature/rain.ogg"]);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].starts, 0);

  resolveFetch("/audio/nature/rain.ogg");
  await settle();

  assert.equal(sources[0].starts, 1);
  assert.equal(sources[0].stops, 0);

  focusSound.render(dataForPreset("ocean"));
  await settle();
  focusSound.render(dataForPreset("storm"));
  await settle();

  assert.equal(requestedFetches.includes("/audio/nature/ocean-waves.ogg"), true);
  assert.equal(requestedFetches.includes("/audio/nature/storm-thunderbolts.ogg"), true);
  assert.equal(sources.length, 3);

  resolveFetch("/audio/nature/ocean-waves.ogg");
  await settle();

  assert.equal(sources[1].starts, 0);
  assert.equal(sources[1].stops, 0);

  resolveFetch("/audio/nature/storm-thunderbolts.ogg");
  await settle();

  assert.equal(sources[2].starts, 1);
  assert.equal(sources[2].stops, 0);

  focusSound.render(dataForPreset("rorate-caeli"));
  await settle();
  assert.equal(requestedFetches.includes("/audio/sacred/advent-rorate-caeli.ogg"), true);
  assert.equal(sources.length, 4);
  resolveFetch("/audio/sacred/advent-rorate-caeli.ogg");
  await settle();
  assert.equal(sources[3].starts, 1);
} finally {
  restoreGlobal("window", originalWindow);
  restoreGlobal("document", originalDocument);
  globalThis.fetch = originalFetch;
}

function dataForPreset(preset: string) {
  return {
    state: {
      settings: {
        focusSoundActivity: "deep-work",
        focusSoundBreakMinutes: 5,
        focusSoundEnabled: true,
        focusSoundIntensity: "medium",
        focusSoundMode: "focus",
        focusSoundPreset: preset,
        focusSoundTimerMinutes: 50,
        focusSoundTimerMode: "infinite",
        focusSoundVolume: 35
      }
    }
  };
}

function resolveFetch(url: string): void {
  const resolve = pendingFetches.get(url);
  assert.ok(resolve, `${url} should be pending`);
  pendingFetches.delete(url);
  resolve(new Response(new Uint8Array([1, 2, 3])));
}

async function settle(): Promise<void> {
  for (let index = 0; index < 3; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function globalValue(key: string): { present: boolean; value: unknown } {
  return {
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

function restoreGlobal(key: string, original: { present: boolean; value: unknown }): void {
  if (original.present) {
    setGlobal(key, original.value);
  } else {
    delete (globalThis as unknown as Record<string, unknown>)[key];
  }
}
