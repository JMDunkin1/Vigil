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
      focusSoundMode?: unknown;
      focusSoundActivity?: unknown;
      focusSoundPreset?: unknown;
      focusSoundIntensity?: unknown;
      focusSoundTimerMode?: unknown;
      focusSoundTimerMinutes?: unknown;
      focusSoundBreakMinutes?: unknown;
      focusSoundVolume?: unknown;
    };
  };
}

type FocusMode = "focus" | "relax" | "sleep" | "meditate";
type FocusActivity = "deep-work" | "creative-flow" | "learning" | "light-work" | "motivation" | "recharge" | "destress" | "wind-down" | "power-nap" | "guided" | "unguided";
type FocusPreset = "brown-noise" | "pink-noise" | "white-noise" | "rain" | "ocean" | "storm" | "stream";
type FocusIntensity = "low" | "medium" | "high";
type FocusTimerMode = "infinite" | "timer" | "interval";

interface FocusAudioState {
  context: AudioContext | null;
  gain: GainNode | null;
  nodes: AudioNode[];
  preset: FocusPreset | "";
  signature: string;
  playing: boolean;
  blocked: boolean;
}

interface SyncOptions {
  enabled: boolean;
  mode: FocusMode;
  activity: FocusActivity;
  preset: FocusPreset;
  intensity: FocusIntensity;
  timerMode: FocusTimerMode;
  timerMinutes: number;
  breakMinutes: number;
  volume: number;
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
    signature: "",
    playing: false,
    blocked: false
  };

  function render(data: FocusSoundData) {
    const settings = data.state.settings || {};
    const options = focusOptions(settings);

    $("#focusSoundEnabled").checked = options.enabled;
    setFieldValue("#focusSoundMode", options.mode);
    setActivityOptions(options.mode, options.activity);
    setFieldValue("#focusSoundActivity", options.activity);
    setFieldValue("#focusSoundPreset", options.preset);
    setFieldValue("#focusSoundIntensity", options.intensity);
    setFieldValue("#focusSoundTimerMode", options.timerMode);
    setFieldValue("#focusSoundTimerMinutes", String(options.timerMinutes));
    setFieldValue("#focusSoundBreakMinutes", String(options.breakMinutes));
    setFieldValue("#focusSoundVolume", String(options.volume));

    sync(options).catch((error) => {
      focusAudio.blocked = true;
      stop();
      $("#focusSoundStatus").textContent = error instanceof Error ? error.message : "Audio blocked";
    });
  }

  async function saveSettings() {
    const mode = focusMode($("#focusSoundMode").value);
    await post("/api/settings", {
      focusSoundEnabled: $("#focusSoundEnabled").checked,
      focusSoundMode: mode,
      focusSoundActivity: focusActivity($("#focusSoundActivity").value, mode),
      focusSoundPreset: $("#focusSoundPreset").value,
      focusSoundIntensity: $("#focusSoundIntensity").value,
      focusSoundTimerMode: $("#focusSoundTimerMode").value,
      focusSoundTimerMinutes: $("#focusSoundTimerMinutes").value,
      focusSoundBreakMinutes: $("#focusSoundBreakMinutes").value,
      focusSoundVolume: $("#focusSoundVolume").value
    });
  }

  async function sync(options: SyncOptions) {
    const status = $("#focusSoundStatus");
    if (!options.enabled) {
      stop();
      resetTimer();
      status.textContent = "Off";
      return;
    }

    const timer = timerState(options);
    if (timer.done) {
      stop();
      status.textContent = "Timer complete";
      return;
    }

    await prime();
    if (focusAudio.context?.state === "suspended") {
      status.textContent = "Click toggle to start";
      return;
    }

    const signature = soundSignature(options, timer.phase);
    if (!focusAudio.playing || focusAudio.signature !== signature) start(options, timer.phase, signature);
    else setMasterVolume(options.volume, modeVolumeMultiplier(options.mode));
    status.textContent = statusText(options, timer);
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

  function start(options: SyncOptions, phase: "work" | "break", signature: string) {
    stop();
    const context = focusAudio.context;
    if (!context) return;

    const master = context.createGain();
    master.gain.value = volumeToGain(options.volume, modeVolumeMultiplier(options.mode));
    master.connect(context.destination);
    const nodes: AudioNode[] = [master];
    const profile = soundProfile(options, phase);
    const noise = createNoiseSource(context, profile.noise);
    const filter = context.createBiquadFilter();
    filter.type = profile.filter;
    filter.frequency.value = profile.frequency;
    filter.Q.value = profile.q;
    const tone = context.createBiquadFilter();
    tone.type = "peaking";
    tone.frequency.value = profile.toneFrequency;
    tone.gain.value = profile.toneGain;
    tone.Q.value = 0.7;
    const modGain = context.createGain();
    modGain.gain.value = 1;
    noise.connect(filter).connect(tone).connect(modGain).connect(master);
    nodes.push(noise, filter, tone, modGain);

    const lfo = context.createOscillator();
    const lfoGain = context.createGain();
    lfo.frequency.value = profile.modulationRate;
    lfoGain.gain.value = profile.modulationDepth;
    lfo.connect(lfoGain).connect(modGain.gain);
    lfo.start();
    nodes.push(lfo, lfoGain);

    if (profile.rumble) {
      const rumble = context.createOscillator();
      const rumbleGain = context.createGain();
      rumble.type = "sine";
      rumble.frequency.value = profile.rumble.frequency;
      rumbleGain.gain.value = profile.rumble.gain;
      rumble.connect(rumbleGain).connect(master);
      rumble.start();
      nodes.push(rumble, rumbleGain);
    }

    noise.start();
    Object.assign(focusAudio, {
      gain: master,
      nodes,
      preset: options.preset,
      signature,
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
    focusAudio.signature = "";
  }

  function isStoppableAudioNode(node: AudioNode): node is AudioNode & { stop: () => void } {
    const candidate = node as AudioNode & { stop?: unknown };
    return typeof candidate.stop === "function";
  }

  function setMasterVolume(value: number, multiplier = 1) {
    const gain = focusAudio.gain;
    const context = focusAudio.context;
    if (!gain || !context) return;
    gain.gain.setTargetAtTime(volumeToGain(value, multiplier), context.currentTime, 0.04);
  }

  return {
    render,
    saveSettings,
    prime,
    setVolume(value: number) {
      setMasterVolume(value, modeVolumeMultiplier(focusMode($("#focusSoundMode").value)));
    }
  };

  function setFieldValue(selector: string, value: string) {
    const field = $(selector);
    if (document.activeElement !== field) field.value = value;
  }
}

function focusOptions(settings: FocusSoundData["state"]["settings"] = {}): SyncOptions {
  const mode = focusMode(settings.focusSoundMode);
  return {
    enabled: Boolean(settings.focusSoundEnabled),
    mode,
    activity: focusActivity(settings.focusSoundActivity, mode),
    preset: focusSoundPreset(settings.focusSoundPreset),
    intensity: focusIntensity(settings.focusSoundIntensity),
    timerMode: focusTimerMode(settings.focusSoundTimerMode),
    timerMinutes: clamp(Number(settings.focusSoundTimerMinutes || 50), 1, 480),
    breakMinutes: clamp(Number(settings.focusSoundBreakMinutes || 5), 1, 120),
    volume: clamp(Number(settings.focusSoundVolume || 35), 0, 100)
  };
}

function soundProfile(options: SyncOptions, phase: "work" | "break") {
  const presetProfile = presetProfiles[phase === "break" ? "ocean" : options.preset];
  const intensity = phase === "break" ? "low" : options.intensity;
  const mode = phase === "break" ? "relax" : options.mode;
  const intensityProfile = intensityProfiles[intensity];
  const modeProfile = modeProfiles[mode];
  return {
    ...presetProfile,
    frequency: Math.round(presetProfile.frequency * modeProfile.frequencyMultiplier),
    modulationRate: intensityProfile.rate * modeProfile.rateMultiplier,
    modulationDepth: intensityProfile.depth * modeProfile.depthMultiplier,
    toneFrequency: modeProfile.toneFrequency,
    toneGain: modeProfile.toneGain,
    rumble: options.preset === "storm" && phase !== "break" ? { frequency: 54, gain: 0.018 } : null
  };
}

const presetProfiles: Record<FocusPreset, {
  noise: "brown" | "pink" | "white";
  filter: BiquadFilterType;
  frequency: number;
  q: number;
}> = {
  "brown-noise": { noise: "brown", filter: "lowpass", frequency: 560, q: 0.7 },
  "pink-noise": { noise: "pink", filter: "lowpass", frequency: 980, q: 0.5 },
  "white-noise": { noise: "white", filter: "highpass", frequency: 250, q: 0.4 },
  rain: { noise: "white", filter: "bandpass", frequency: 1800, q: 0.9 },
  ocean: { noise: "brown", filter: "lowpass", frequency: 620, q: 0.65 },
  storm: { noise: "brown", filter: "lowpass", frequency: 420, q: 0.8 },
  stream: { noise: "pink", filter: "bandpass", frequency: 1120, q: 0.55 }
};

const modeProfiles: Record<FocusMode, {
  frequencyMultiplier: number;
  rateMultiplier: number;
  depthMultiplier: number;
  toneFrequency: number;
  toneGain: number;
  volumeMultiplier: number;
}> = {
  focus: { frequencyMultiplier: 1.05, rateMultiplier: 1.35, depthMultiplier: 1.1, toneFrequency: 520, toneGain: 0.5, volumeMultiplier: 1 },
  relax: { frequencyMultiplier: 0.82, rateMultiplier: 0.7, depthMultiplier: 0.75, toneFrequency: 340, toneGain: -0.8, volumeMultiplier: 0.92 },
  sleep: { frequencyMultiplier: 0.62, rateMultiplier: 0.35, depthMultiplier: 0.55, toneFrequency: 260, toneGain: -1.4, volumeMultiplier: 0.72 },
  meditate: { frequencyMultiplier: 0.76, rateMultiplier: 0.48, depthMultiplier: 0.9, toneFrequency: 300, toneGain: -0.3, volumeMultiplier: 0.82 }
};

const intensityProfiles: Record<FocusIntensity, { rate: number; depth: number }> = {
  low: { rate: 0.08, depth: 0.035 },
  medium: { rate: 0.16, depth: 0.07 },
  high: { rate: 0.32, depth: 0.11 }
};

const activitiesByMode: Record<FocusMode, Array<{ value: FocusActivity; label: string }>> = {
  focus: [
    { value: "deep-work", label: "Deep work" },
    { value: "creative-flow", label: "Creative flow" },
    { value: "learning", label: "Learning" },
    { value: "light-work", label: "Light work" }
  ],
  relax: [
    { value: "recharge", label: "Recharge" },
    { value: "destress", label: "De-stress" },
    { value: "creative-flow", label: "Creative flow" }
  ],
  sleep: [
    { value: "wind-down", label: "Wind down" },
    { value: "power-nap", label: "Power nap" }
  ],
  meditate: [
    { value: "guided", label: "Guided" },
    { value: "unguided", label: "Unguided" }
  ]
};

function createNoiseSource(context: AudioContext, color: "brown" | "pink" | "white"): AudioBufferSourceNode {
  const length = context.sampleRate * 2;
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);
  let brown = 0;
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let b3 = 0;
  let b4 = 0;
  let b5 = 0;
  let b6 = 0;
  for (let index = 0; index < length; index += 1) {
    const white = Math.random() * 2 - 1;
    if (color === "brown") {
      brown = (brown + 0.02 * white) / 1.02;
      data[index] = brown * 3.5;
    } else if (color === "pink") {
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.96900 * b2 + white * 0.1538520;
      b3 = 0.86650 * b3 + white * 0.3104856;
      b4 = 0.55000 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.0168980;
      data[index] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.08;
      b6 = white * 0.115926;
    } else {
      data[index] = white * 0.45;
    }
  }
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  return source;
}

function setActivityOptions(mode: FocusMode, selected: FocusActivity): void {
  const field = document.querySelector("#focusSoundActivity") as HTMLSelectElement | null;
  if (!field) return;
  if (document.activeElement === field) return;
  const options = activitiesByMode[mode];
  const next = options.some((option) => option.value === selected) ? selected : options[0].value;
  field.replaceChildren(...options.map((option) => {
    const node = document.createElement("option");
    node.value = option.value;
    node.textContent = option.label;
    return node;
  }));
  field.value = next;
}

function timerState(options: SyncOptions) {
  const signature = `${options.timerMode}:${options.timerMinutes}:${options.breakMinutes}:${options.enabled}`;
  if (focusTimerMode(options.timerMode) === "infinite") {
    resetTimer();
    return { phase: "work" as const, remainingSeconds: null, done: false };
  }
  if (focusAudioNeedsNewTimer(signature)) {
    focusAudioTimerStart(signature);
  }
  const startedAt = globalTimerState.startedAt || Date.now();
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const workSeconds = options.timerMinutes * 60;
  if (options.timerMode === "timer") {
    return {
      phase: "work" as const,
      remainingSeconds: Math.max(0, workSeconds - elapsedSeconds),
      done: elapsedSeconds >= workSeconds
    };
  }
  const breakSeconds = options.breakMinutes * 60;
  const cycleSeconds = workSeconds + breakSeconds;
  const position = cycleSeconds ? elapsedSeconds % cycleSeconds : elapsedSeconds;
  if (position >= workSeconds) {
    return {
      phase: "break" as const,
      remainingSeconds: Math.max(0, cycleSeconds - position),
      done: false
    };
  }
  return {
    phase: "work" as const,
    remainingSeconds: Math.max(0, workSeconds - position),
    done: false
  };
}

const globalTimerState: { startedAt: number | null; signature: string } = {
  startedAt: null,
  signature: ""
};

function focusAudioNeedsNewTimer(signature: string): boolean {
  return !globalTimerState.startedAt || globalTimerState.signature !== signature;
}

function focusAudioTimerStart(signature: string): void {
  globalTimerState.startedAt = Date.now();
  globalTimerState.signature = signature;
}

function resetTimer(): void {
  globalTimerState.startedAt = null;
  globalTimerState.signature = "";
}

function statusText(options: SyncOptions, timer: { phase: "work" | "break"; remainingSeconds: number | null }): string {
  const base = `${modeLabel(options.mode)} | ${presetLabel(timer.phase === "break" ? "ocean" : options.preset)} | ${intensityLabel(options.intensity)}`;
  if (timer.remainingSeconds === null) return base;
  return `${base} | ${timer.phase === "break" ? "Break" : "Timer"} ${formatClock(timer.remainingSeconds)}`;
}

function soundSignature(options: SyncOptions, phase: "work" | "break"): string {
  return [
    options.mode,
    options.activity,
    phase === "break" ? "ocean" : options.preset,
    options.intensity,
    options.volume,
    phase
  ].join(":");
}

function focusMode(value: unknown): FocusMode {
  return typeof value === "string" && ["focus", "relax", "sleep", "meditate"].includes(value) ? value as FocusMode : "focus";
}

function focusActivity(value: unknown, mode: FocusMode): FocusActivity {
  const allowed = activitiesByMode[mode].map((option) => option.value);
  return typeof value === "string" && allowed.includes(value as FocusActivity) ? value as FocusActivity : allowed[0];
}

function focusSoundPreset(value: unknown): FocusPreset {
  return typeof value === "string" && ["brown-noise", "pink-noise", "white-noise", "rain", "ocean", "storm", "stream"].includes(value) ? value as FocusPreset : "brown-noise";
}

function focusIntensity(value: unknown): FocusIntensity {
  return typeof value === "string" && ["low", "medium", "high"].includes(value) ? value as FocusIntensity : "medium";
}

function focusTimerMode(value: unknown): FocusTimerMode {
  return typeof value === "string" && ["infinite", "timer", "interval"].includes(value) ? value as FocusTimerMode : "infinite";
}

function presetLabel(value: FocusPreset): string {
  return {
    "brown-noise": "brown noise",
    "pink-noise": "pink noise",
    "white-noise": "white noise",
    rain: "rain",
    ocean: "ocean",
    storm: "storm",
    stream: "stream"
  }[value];
}

function modeLabel(value: FocusMode): string {
  return {
    focus: "Focus",
    relax: "Relax",
    sleep: "Sleep",
    meditate: "Meditate"
  }[value];
}

function intensityLabel(value: FocusIntensity): string {
  return {
    low: "low",
    medium: "medium",
    high: "high"
  }[value];
}

function modeVolumeMultiplier(mode: FocusMode): number {
  return modeProfiles[mode]?.volumeMultiplier || 1;
}

function volumeToGain(value: number, multiplier = 1): number {
  return clamp(Number(value || 0), 0, 100) / 100 * 0.28 * multiplier;
}

function formatClock(seconds: number): string {
  const safe = Math.max(0, Math.round(seconds || 0));
  const minutes = Math.floor(safe / 60);
  const rest = safe % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}
