import { clamp } from "./format.js";

type ControlElement = HTMLElement & {
  checked: boolean;
  value: string;
};

type QueryElement = (selector: string) => ControlElement;
type PostRequest = (path: string, body: unknown) => Promise<unknown>;

interface FocusSoundData {
  state: {
    settings?: {
      focusSoundEnabled?: unknown;
      focusSoundPreset?: unknown;
      focusSoundVolume?: unknown;
    };
    activePolicy?: unknown;
  };
  limits: {
    activeBlocks?: unknown[];
  };
}

type FocusPreset = "brown-noise" | "rain" | "ocean";

interface FocusAudioState {
  context: AudioContext | null;
  gain: GainNode | null;
  nodes: AudioNode[];
  preset: FocusPreset | "";
  playing: boolean;
  blocked: boolean;
}

interface SyncOptions {
  enabled: boolean;
  preset: FocusPreset;
  volume: number;
  active: boolean;
}

interface WebAudioWindow extends Window {
  webkitAudioContext?: typeof AudioContext;
}

export function createFocusSoundController({ $, post }: { $: QueryElement; post: PostRequest }) {
  const focusAudio: FocusAudioState = {
    context: null,
    gain: null,
    nodes: [],
    preset: "",
    playing: false,
    blocked: false
  };

  function render(data: FocusSoundData) {
    const settings = data.state.settings || {};
    const enabled = Boolean(settings.focusSoundEnabled);
    const preset = focusSoundPreset(settings.focusSoundPreset);
    const volume = clamp(Number(settings.focusSoundVolume || 35), 0, 100);
    const active = Boolean(data.state.activePolicy || data.limits.activeBlocks?.length);

    $("#focusSoundEnabled").checked = enabled;
    if (document.activeElement !== $("#focusSoundPreset")) $("#focusSoundPreset").value = preset;
    if (document.activeElement !== $("#focusSoundVolume")) $("#focusSoundVolume").value = String(volume);

    sync({ enabled, preset, volume, active }).catch((error) => {
      focusAudio.blocked = true;
      stop();
      $("#focusSoundStatus").textContent = error instanceof Error ? error.message : "Audio blocked";
    });
  }

  async function saveSettings() {
    await post("/api/settings", {
      focusSoundEnabled: $("#focusSoundEnabled").checked,
      focusSoundPreset: $("#focusSoundPreset").value,
      focusSoundVolume: $("#focusSoundVolume").value
    });
  }

  async function sync({ enabled, preset, volume, active }: SyncOptions) {
    const status = $("#focusSoundStatus");
    if (!enabled) {
      stop();
      status.textContent = "Off";
      return;
    }

    if (!active) {
      stop();
      status.textContent = "Ready for lock";
      return;
    }

    await prime();
    if (focusAudio.context?.state === "suspended") {
      status.textContent = "Click toggle to start";
      return;
    }

    if (!focusAudio.playing || focusAudio.preset !== preset) start(preset, volume);
    else setVolume(volume);
    status.textContent = `Playing ${presetLabel(preset)}`;
  }

  async function prime(): Promise<AudioContext> {
    const AudioContextConstructor = window.AudioContext || (window as WebAudioWindow).webkitAudioContext;
    if (!AudioContextConstructor) throw new Error("Web Audio is unavailable.");
    focusAudio.context ||= new AudioContextConstructor();
    if (focusAudio.context.state === "suspended") {
      await focusAudio.context.resume();
    }
    return focusAudio.context;
  }

  function start(preset: FocusPreset, volume: number) {
    stop();
    const context = focusAudio.context;
    if (!context) return;

    const master = context.createGain();
    master.gain.value = volumeToGain(volume);
    master.connect(context.destination);
    const nodes: AudioNode[] = [master];
    const noise = createNoiseSource(context, preset === "brown-noise" ? "brown" : "white");
    nodes.push(noise);

    if (preset === "rain") {
      const highpass = context.createBiquadFilter();
      highpass.type = "highpass";
      highpass.frequency.value = 950;
      const bandpass = context.createBiquadFilter();
      bandpass.type = "bandpass";
      bandpass.frequency.value = 1800;
      bandpass.Q.value = 0.9;
      noise.connect(highpass).connect(bandpass).connect(master);
      nodes.push(highpass, bandpass);
    } else if (preset === "ocean") {
      const lowpass = context.createBiquadFilter();
      lowpass.type = "lowpass";
      lowpass.frequency.value = 620;
      const swell = context.createGain();
      swell.gain.value = 0.7;
      const lfo = context.createOscillator();
      lfo.frequency.value = 0.08;
      const lfoGain = context.createGain();
      lfoGain.gain.value = 0.28;
      lfo.connect(lfoGain).connect(swell.gain);
      noise.connect(lowpass).connect(swell).connect(master);
      lfo.start();
      nodes.push(lowpass, swell, lfo, lfoGain);
    } else {
      const lowpass = context.createBiquadFilter();
      lowpass.type = "lowpass";
      lowpass.frequency.value = 520;
      noise.connect(lowpass).connect(master);
      nodes.push(lowpass);
    }

    noise.start();
    Object.assign(focusAudio, {
      gain: master,
      nodes,
      preset,
      playing: true,
      blocked: false
    });
  }

  function stop() {
    for (const node of focusAudio.nodes || []) {
      try {
        if (isStoppableAudioNode(node)) node.stop();
      } catch {}
      try {
        node.disconnect();
      } catch {}
    }
    focusAudio.gain = null;
    focusAudio.nodes = [];
    focusAudio.playing = false;
    focusAudio.preset = "";
  }

  function isStoppableAudioNode(node: AudioNode): node is AudioNode & { stop: () => void } {
    const candidate = node as AudioNode & { stop?: unknown };
    return typeof candidate.stop === "function";
  }

  function setVolume(value: number) {
    const gain = focusAudio.gain;
    const context = focusAudio.context;
    if (!gain || !context) return;
    gain.gain.setTargetAtTime(volumeToGain(value), context.currentTime, 0.04);
  }

  return {
    render,
    saveSettings,
    prime,
    setVolume
  };
}

function createNoiseSource(context: AudioContext, color: "brown" | "white"): AudioBufferSourceNode {
  const length = context.sampleRate * 2;
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);
  let last = 0;
  for (let index = 0; index < length; index += 1) {
    const white = Math.random() * 2 - 1;
    if (color === "brown") {
      last = (last + 0.02 * white) / 1.02;
      data[index] = last * 3.5;
    } else {
      data[index] = white * 0.45;
    }
  }
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  return source;
}

function focusSoundPreset(value: unknown): FocusPreset {
  return typeof value === "string" && ["brown-noise", "rain", "ocean"].includes(value) ? value as FocusPreset : "brown-noise";
}

function presetLabel(value: FocusPreset): string {
  return {
    "brown-noise": "brown noise",
    rain: "rain",
    ocean: "ocean"
  }[value];
}

function volumeToGain(value: number): number {
  return clamp(Number(value || 0), 0, 100) / 100 * 0.28;
}
