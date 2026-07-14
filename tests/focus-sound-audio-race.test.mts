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

  constructor() {
    contexts.push(this);
  }

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
const contexts: FakeAudioContext[] = [];
for (const id of [
  "focusSoundEnabled",
  "focusSoundMode",
  "focusSoundActivity",
  "focusSoundPreset",
  "focusSoundIntensity",
  "focusSoundTimerMode",
  "focusSoundTimerMinutes",
  "focusSoundBreakMinutes",
  "focusSoundVolume"
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
const player = { dataset: { playing: "false" } };
const playLabel = { textContent: "" };
const nowPlaying = { textContent: "" };
const attribution = { hidden: true };
const attributionText = { textContent: "" };
const sourceLink = { href: "" };
const licenseLink = { href: "", textContent: "" };
const playButtonAttributes = new Map<string, string>();
const playButton = {
  setAttribute(name: string, value: string) {
    playButtonAttributes.set(name, value);
  }
};
const originalWindow = globalValue("window");
const originalDocument = globalValue("document");
const originalFetch = globalThis.fetch;
const originalConsoleError = console.error;
const originalDateNow = Date.now;
const toasts: string[] = [];

try {
  setGlobal("window", { AudioContext: FakeAudioContext });
  setGlobal("document", {
    activeElement: null,
    createElement: () => ({ textContent: "", value: "" }),
    querySelector: (selector: string) => ({
      "#audioPlayer": player,
      "#focusSoundPlayButton": playButton,
      "#focusSoundPlayLabel": playLabel,
      "#focusSoundNowPlaying": nowPlaying,
      "#focusSoundAttribution": attribution,
      "#focusSoundAttributionText": attributionText,
      "#focusSoundSourceLink": sourceLink,
      "#focusSoundLicenseLink": licenseLink
    }[selector] || controls.get(selector) || null),
    querySelectorAll: () => []
  });
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    requestedFetches.push(url);
    return new Promise<Response>((resolve) => {
      pendingFetches.set(url, resolve);
    });
  }) as typeof fetch;
  console.error = () => {};

  const focusSound = createFocusSoundController({
    $: (selector: string) => {
      const control = controls.get(selector);
      assert.ok(control, `${selector} should exist`);
      return control as unknown as HTMLElement & { checked: boolean; value: string };
    },
    post: async () => ({}),
    toast: (message: string) => toasts.push(message)
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

  assert.equal(player.dataset.playing, "true");
  assert.equal(playLabel.textContent, "Pause");
  assert.equal(playButtonAttributes.get("aria-pressed"), "true");
  assert.equal(focusSound.isPlaying(), true);

  contexts[0].state = "suspended";
  focusSound.render(dataForPreset("brown-noise"));
  await settle();

  assert.equal(player.dataset.playing, "false", "a suspended audio context must stop the waveform animation");
  assert.equal(playLabel.textContent, "Listen", "silent audio must not offer a misleading Pause action");
  assert.equal(playButtonAttributes.get("aria-pressed"), "false");
  assert.equal(focusSound.isPlaying(), false, "the play control must be able to distinguish enabled-but-silent audio");

  contexts[0].state = "running";
  focusSound.render(dataForPreset("stream"));
  const refreshedStream = dataForPreset("stream");
  refreshedStream.state.settings.focusSoundVolume = 35;
  focusSound.render(refreshedStream);
  await settle();
  assert.equal(player.dataset.playing, "true");

  failFetch("/audio/nature/forest-lawn-creek.ogg");
  await settle();

  assert.equal(player.dataset.playing, "false", "failed playback must stop the waveform animation");
  assert.equal(playLabel.textContent, "Listen", "failed playback must restore the Listen action");
  assert.equal(playButtonAttributes.get("aria-pressed"), "false");
  assert.equal(focusSound.isPlaying(), false, "failed playback must remain retryable without first disabling sound");
  assert.deepEqual(toasts, ["Could not play this sound: Could not load /audio/nature/forest-lawn-creek.ogg"], "the active playback failure must be visible to the user");

  focusSound.render(dataForPreset("bach-goldberg-aria"));
  await settle();
  focusSound.render(dataForPreset("rain"));
  await settle();
  const currentSource = sources.at(-1);
  assert.ok(currentSource);
  assert.equal(currentSource.starts, 1);

  failFetch("/audio/baroque/bach-goldberg-aria-harpsichord.ogg");
  await settle();

  assert.equal(currentSource.stops, 0, "a stale track failure must not stop the newer track");
  assert.equal(focusSound.isPlaying(), true, "a stale track failure must leave current playback active");
  assert.equal(toasts.length, 1, "a stale playback failure must not interrupt the current track with a toast");

  let now = 100_000;
  Date.now = () => now;
  focusSound.render(dataForTimer("rain"));
  await settle();
  assert.equal(focusSound.isPlaying(), true);

  now += 61_000;
  focusSound.render(dataForTimer("rain"));
  await settle();
  assert.equal(focusSound.isPlaying(), false, "an expired one-shot timer must stop playback");

  focusSound.restartTimer();
  focusSound.render(dataForTimer("rain"));
  await settle();
  assert.equal(focusSound.isPlaying(), true, "restarting an expired timer must begin a fresh playback session");

  const interval = dataForTimer("rain");
  interval.state.settings.focusSoundTimerMode = "interval";
  interval.state.settings.focusSoundBreakMinutes = 1;
  focusSound.render(interval);
  await settle();
  assert.equal(nowPlaying.textContent, "Rain");

  now += 61_000;
  focusSound.render(interval);
  await settle();
  assert.equal(nowPlaying.textContent, "Ocean waves", "an interval break must name the track users actually hear");
  assert.equal(attribution.hidden, false, "the active break recording must expose its attribution");
  assert.match(attributionText.textContent, /Shore wave field recording/);
  assert.match(sourceLink.href, /File:Waves\.ogg/);
} finally {
  restoreGlobal("window", originalWindow);
  restoreGlobal("document", originalDocument);
  globalThis.fetch = originalFetch;
  console.error = originalConsoleError;
  Date.now = originalDateNow;
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

function dataForTimer(preset: string) {
  const data = dataForPreset(preset);
  data.state.settings.focusSoundTimerMinutes = 1;
  data.state.settings.focusSoundTimerMode = "timer";
  return data;
}

function resolveFetch(url: string): void {
  const resolve = pendingFetches.get(url);
  assert.ok(resolve, `${url} should be pending`);
  pendingFetches.delete(url);
  resolve(new Response(new Uint8Array([1, 2, 3])));
}

function failFetch(url: string): void {
  const resolve = pendingFetches.get(url);
  assert.ok(resolve, `${url} should be pending`);
  pendingFetches.delete(url);
  resolve(new Response(null, { status: 503 }));
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
