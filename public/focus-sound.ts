import { clamp } from "./format.js";
import { minecraftAudioCatalog } from "./minecraft-audio-catalog.js";
import type { MinecraftAudioTrackId } from "./minecraft-audio-catalog.js";
import { sacredAudioCatalog } from "./sacred-audio-catalog.js";
import type { SacredAudioTrackId } from "./sacred-audio-catalog.js";

type ControlElement = HTMLElement & {
  checked: boolean;
  value: string;
};

type QueryElement = (selector: string) => ControlElement;
type PostRequest = (path: string, body: unknown) => Promise<unknown>;
type Toast = (message: string) => void;

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
const generatedPresetValues = ["brown-noise", "pink-noise", "white-noise", "binaural-beat", "isochronic-tone"] as const;
const standardAudioPresetValues = ["rain", "ocean", "storm", "stream", "bach-goldberg-aria", "bach-invention-8", "bach-italian-concerto", "handel-harmonious-blacksmith", "scarlatti-sonata-k87", "scarlatti-sonata-k466"] as const;
const sacredAudioPresetValues = sacredAudioCatalog.map((track) => track.id) as SacredAudioTrackId[];
const minecraftAudioPresetValues = minecraftAudioCatalog.map((track) => track.id);
const realAudioPresetValues: readonly RealAudioPreset[] = [...standardAudioPresetValues, ...sacredAudioPresetValues, ...minecraftAudioPresetValues];
const focusPresetValues: readonly FocusPreset[] = [...generatedPresetValues, ...realAudioPresetValues];
type GeneratedPreset = typeof generatedPresetValues[number];
type StandardAudioPreset = typeof standardAudioPresetValues[number];
type RealAudioPreset = StandardAudioPreset | SacredAudioTrackId | MinecraftAudioTrackId;
type FocusPreset = GeneratedPreset | RealAudioPreset;
type FocusIntensity = "low" | "medium" | "high";
type FocusTimerMode = "infinite" | "timer" | "interval";
type FocusPresetKind = "noise" | "binaural" | "isochronic";
type NoiseColor = "brown" | "pink" | "white";

interface FocusAudioState {
  context: AudioContext | null;
  gain: GainNode | null;
  analyser: AnalyserNode | null;
  nodes: AudioNode[];
  preset: FocusPreset | "";
  signature: string;
  playing: boolean;
  blocked: boolean;
  visualizerFrame: number | null;
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

interface PresetProfile {
  kind: FocusPresetKind;
  noise?: NoiseColor;
  filter?: BiquadFilterType;
  frequency: number;
  q: number;
  carrierFrequency?: number;
}

interface SoundProfile extends PresetProfile {
  beatFrequency: number;
  modulationRate: number;
  modulationDepth: number;
  toneFrequency: number;
  toneGain: number;
  carrierFrequency: number;
}

interface RealAudioTrack {
  label: string;
  src: string;
  attribution: string;
  sourcePage: string;
  license: string;
  licenseUrl: string;
}

const audioBufferCache = new Map<string, Promise<AudioBuffer>>();
const spectrumMinimumFrequency = 45;
const spectrumMaximumFrequency = 16_000;
const waveformIdleScale = 0.06;

export function createFocusSoundController({ $, post, toast }: { $: QueryElement; post: PostRequest; toast: Toast }) {
  let audioStartGeneration = 0;
  let renderGeneration = 0;
  let renderedOptions: SyncOptions | null = null;
  let blockedPreset: FocusPreset | null = null;
  let soundViewActive = false;
  const reducedMotionQuery = typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)")
    : null;
  const focusAudio: FocusAudioState = {
    context: null,
    gain: null,
    analyser: null,
    nodes: [],
    preset: "",
    signature: "",
    playing: false,
    blocked: false,
    visualizerFrame: null
  };
  reducedMotionQuery?.addEventListener("change", () => {
    if (reducedMotionQuery.matches) {
      stopSpectrumVisualization();
    } else if (soundViewActive && focusAudio.analyser && focusAudio.playing) {
      startSpectrumVisualization(focusAudio.analyser);
    }
  });

  function render(data: FocusSoundData) {
    const generation = ++renderGeneration;
    const settings = data.state.settings || {};
    const requestedOptions = focusOptions(settings);
    const options = requestedOptions.enabled && requestedOptions.preset === blockedPreset
      ? { ...requestedOptions, enabled: false }
      : requestedOptions;
    renderedOptions = options;

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
    renderFocusStudio(options, focusAudio);

    void sync(options)
      .then(() => {
        if (generation === renderGeneration) renderFocusStudio(options, focusAudio);
      })
      .catch((error) => {
        const currentPlaybackFailed = generation === renderGeneration
          || Boolean(renderedOptions && samePlaybackRequest(options, renderedOptions));
        if (!currentPlaybackFailed) {
          if (renderedOptions) renderFocusStudio(renderedOptions, focusAudio);
          console.error("Focus sound playback failed", error);
          return;
        }
        focusAudio.blocked = true;
        blockedPreset = options.preset;
        stop();
        const disabledOptions = { ...options, enabled: false };
        renderedOptions = disabledOptions;
        $("#focusSoundEnabled").checked = false;
        renderFocusStudio(disabledOptions, focusAudio);
        toast(focusPlaybackErrorMessage(error));
        console.error("Focus sound playback failed", error);
        void post("/api/settings", { focusSoundEnabled: false }).catch((persistError) => {
          toast(`Could not turn off failed sound playback: ${focusPlaybackErrorDetail(persistError)}`);
          console.error("Could not turn off failed sound playback", persistError);
        });
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
    if (!options.enabled) {
      stop();
      resetTimer();
      return;
    }

    const timer = timerState(options);
    if (timer.done) {
      stop();
      return;
    }

    await prime();
    if (focusAudio.context?.state === "suspended") {
      stop();
      return;
    }

    const signature = soundSignature(options, timer.phase);
    if (!focusAudio.playing || focusAudio.signature !== signature) await start(options, timer.phase, signature);
    else setMasterVolume(options.volume, modeVolumeMultiplier(options.mode));
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

  async function start(options: SyncOptions, phase: "work" | "break", signature: string) {
    stop();
    const context = focusAudio.context;
    if (!context) return;
    const generation = ++audioStartGeneration;

    const mix = context.createGain();
    const analyser = context.createAnalyser();
    const master = context.createGain();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.68;
    analyser.minDecibels = -90;
    analyser.maxDecibels = -18;
    master.gain.value = volumeToGain(options.volume, modeVolumeMultiplier(options.mode));
    mix.connect(analyser).connect(master);
    master.connect(context.destination);
    const nodes: AudioNode[] = [mix, analyser, master];
    const preset = phase === "break" ? "ocean" : options.preset;
    const audio = realAudioTrack(preset);
    const profile = audio ? null : soundProfile(options, phase);
    Object.assign(focusAudio, {
      gain: master,
      analyser,
      nodes,
      preset,
      signature,
      playing: true,
      blocked: false
    });

    try {
      if (audio) {
        const source = await createRealAudioSource(context, audio);
        if (!isCurrentStart(nodes, generation, signature)) {
          stopAudioNodes(nodes);
          return;
        }
        connectRealAudioSource(source, mix, nodes);
      } else if (profile) {
        connectSoundProfile(context, profile, mix, nodes);
      }
    } catch (error) {
      stopAudioNodes(nodes);
      if (focusAudio.nodes === nodes && generation === audioStartGeneration) {
        clearFocusAudioState();
        throw error;
      }
      return;
    }

    if (!isCurrentStart(nodes, generation, signature)) {
      stopAudioNodes(nodes);
      return;
    }
    startSpectrumVisualization(analyser);
  }

  function isCurrentStart(nodes: AudioNode[], generation: number, signature: string): boolean {
    return focusAudio.nodes === nodes && generation === audioStartGeneration && focusAudio.signature === signature;
  }

  function stop() {
    audioStartGeneration += 1;
    stopSpectrumVisualization();
    stopAudioNodes(focusAudio.nodes || []);
    clearFocusAudioState();
  }

  function startSpectrumVisualization(analyser: AnalyserNode) {
    stopSpectrumVisualization();
    const wave = document.querySelector<HTMLElement>("#focusSoundWave");
    const bars = wave ? Array.from(wave.querySelectorAll<HTMLElement>("span")) : [];
    if (!soundViewActive || reducedMotionQuery?.matches || !bars.length || typeof window.requestAnimationFrame !== "function") return;

    const frequencyData = new Uint8Array(analyser.frequencyBinCount);
    const timeData = new Float32Array(analyser.fftSize);
    const displayedLevels = bars.map(() => waveformIdleScale);

    const draw = () => {
      if (!soundViewActive || reducedMotionQuery?.matches || focusAudio.analyser !== analyser || !focusAudio.playing) return;
      analyser.getByteFrequencyData(frequencyData);
      analyser.getFloatTimeDomainData(timeData);
      const loudness = signalLoudness(timeData);

      for (const [index, bar] of bars.entries()) {
        const band = spectrumBandLevel(analyser, frequencyData, index, bars.length);
        const target = waveformIdleScale + (1 - waveformIdleScale) * loudness * Math.pow(band, 0.86);
        const response = target > displayedLevels[index] ? 0.52 : 0.2;
        displayedLevels[index] += (target - displayedLevels[index]) * response;
        bar.style.setProperty("--wave-level", displayedLevels[index].toFixed(3));
      }

      focusAudio.visualizerFrame = window.requestAnimationFrame(draw);
    };

    focusAudio.visualizerFrame = window.requestAnimationFrame(draw);
  }

  function stopSpectrumVisualization() {
    if (focusAudio.visualizerFrame !== null && typeof window.cancelAnimationFrame === "function") {
      window.cancelAnimationFrame(focusAudio.visualizerFrame);
    }
    focusAudio.visualizerFrame = null;
    for (const bar of document.querySelectorAll<HTMLElement>("#focusSoundWave span")) {
      bar.style.removeProperty("--wave-level");
    }
  }

  function stopAudioNodes(nodes: AudioNode[]) {
    for (const node of nodes) {
      try {
        if (isStoppableAudioNode(node)) node.stop();
      } catch {}
      try {
        node.disconnect();
      } catch {}
    }
  }

  function clearFocusAudioState() {
    focusAudio.gain = null;
    focusAudio.analyser = null;
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
    restartTimer() {
      blockedPreset = null;
      focusAudio.blocked = false;
      resetTimer();
    },
    setViewActive(active: boolean) {
      soundViewActive = active;
      if (!active) {
        stopSpectrumVisualization();
      } else if (focusAudio.analyser && focusAudio.playing) {
        startSpectrumVisualization(focusAudio.analyser);
      }
    },
    isPlaying() {
      return focusAudio.playing;
    },
    setVolume(value: number) {
      setMasterVolume(value, modeVolumeMultiplier(focusMode($("#focusSoundMode").value)));
    }
  };

  function setFieldValue(selector: string, value: string) {
    const field = $(selector);
    if (document.activeElement !== field) field.value = value;
  }
}

function signalLoudness(samples: Float32Array): number {
  let sumOfSquares = 0;
  for (const sample of samples) sumOfSquares += sample * sample;
  const rms = Math.sqrt(sumOfSquares / samples.length);
  const decibels = 20 * Math.log10(Math.max(rms, 0.000_001));
  return Math.pow(clamp((decibels + 58) / 46, 0, 1), 1.15);
}

function spectrumBandLevel(analyser: AnalyserNode, data: Uint8Array, index: number, count: number): number {
  const nyquist = analyser.context.sampleRate / 2;
  const maximum = Math.min(spectrumMaximumFrequency, nyquist);
  const ratio = maximum / spectrumMinimumFrequency;
  const lowerFrequency = spectrumMinimumFrequency * Math.pow(ratio, index / count);
  const upperFrequency = spectrumMinimumFrequency * Math.pow(ratio, (index + 1) / count);
  const binWidth = analyser.context.sampleRate / analyser.fftSize;
  const start = clamp(Math.floor(lowerFrequency / binWidth), 0, data.length - 1);
  const end = clamp(Math.ceil(upperFrequency / binWidth), start + 1, data.length);
  let sumOfSquares = 0;
  for (let bin = start; bin < end; bin += 1) {
    const magnitude = data[bin] / 255;
    sumOfSquares += magnitude * magnitude;
  }
  return Math.sqrt(sumOfSquares / (end - start));
}

function focusPlaybackErrorMessage(error: unknown): string {
  return `Could not play this sound: ${focusPlaybackErrorDetail(error)}`;
}

function focusPlaybackErrorDetail(error: unknown): string {
  return error instanceof Error ? error.message : "Audio playback failed";
}

function samePlaybackRequest(left: SyncOptions, right: SyncOptions): boolean {
  return left.enabled === right.enabled
    && left.mode === right.mode
    && left.activity === right.activity
    && left.preset === right.preset
    && left.intensity === right.intensity;
}

function connectSoundProfile(context: AudioContext, profile: SoundProfile, master: GainNode, nodes: AudioNode[]): void {
  if (profile.kind === "binaural") {
    connectBinauralProfile(context, profile, master, nodes);
    return;
  }
  if (profile.kind === "isochronic") {
    connectIsochronicProfile(context, profile, master, nodes);
    return;
  }
  connectNoiseProfile(context, profile, master, nodes);
}

function connectNoiseProfile(context: AudioContext, profile: SoundProfile, master: GainNode, nodes: AudioNode[]): void {
  const noise = createNoiseSource(context, profile.noise || "brown");
  const filter = context.createBiquadFilter();
  filter.type = profile.filter || "lowpass";
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

  const lfo = context.createOscillator();
  const lfoGain = context.createGain();
  lfo.frequency.value = profile.modulationRate;
  lfoGain.gain.value = profile.modulationDepth;
  lfo.connect(lfoGain).connect(modGain.gain);
  noise.start();
  lfo.start();
  nodes.push(noise, filter, tone, modGain, lfo, lfoGain);
}

function connectBinauralProfile(context: AudioContext, profile: SoundProfile, master: GainNode, nodes: AudioNode[]): void {
  const left = context.createOscillator();
  const right = context.createOscillator();
  const leftGain = context.createGain();
  const rightGain = context.createGain();
  const leftPan = context.createStereoPanner();
  const rightPan = context.createStereoPanner();
  const bed = createNoiseSource(context, "pink");
  const bedFilter = context.createBiquadFilter();
  const bedGain = context.createGain();

  left.type = "sine";
  right.type = "sine";
  left.frequency.value = profile.carrierFrequency;
  right.frequency.value = profile.carrierFrequency + profile.beatFrequency;
  leftGain.gain.value = 0.075;
  rightGain.gain.value = 0.075;
  leftPan.pan.value = -1;
  rightPan.pan.value = 1;
  bedFilter.type = "lowpass";
  bedFilter.frequency.value = 850;
  bedFilter.Q.value = 0.35;
  bedGain.gain.value = 0.018;

  left.connect(leftGain).connect(leftPan).connect(master);
  right.connect(rightGain).connect(rightPan).connect(master);
  bed.connect(bedFilter).connect(bedGain).connect(master);
  left.start();
  right.start();
  bed.start();
  nodes.push(left, right, leftGain, rightGain, leftPan, rightPan, bed, bedFilter, bedGain);
}

function connectIsochronicProfile(context: AudioContext, profile: SoundProfile, master: GainNode, nodes: AudioNode[]): void {
  const tone = context.createOscillator();
  const toneFilter = context.createBiquadFilter();
  const toneGain = context.createGain();
  const pulse = context.createOscillator();
  const pulseGain = context.createGain();

  tone.type = "sine";
  tone.frequency.value = profile.carrierFrequency;
  toneFilter.type = "lowpass";
  toneFilter.frequency.value = 1800;
  toneFilter.Q.value = 0.45;
  toneGain.gain.value = 0.22;
  pulse.type = "square";
  pulse.frequency.value = profile.beatFrequency;
  pulseGain.gain.value = profile.modulationDepth;

  tone.connect(toneFilter).connect(toneGain).connect(master);
  pulse.connect(pulseGain).connect(toneGain.gain);
  tone.start();
  pulse.start();
  nodes.push(tone, toneFilter, toneGain, pulse, pulseGain);
}

async function createRealAudioSource(context: AudioContext, audio: RealAudioTrack): Promise<AudioBufferSourceNode> {
  const source = context.createBufferSource();
  source.buffer = await loadAudioBuffer(context, audio.src);
  source.loop = true;
  return source;
}

function connectRealAudioSource(source: AudioBufferSourceNode, master: GainNode, nodes: AudioNode[]): void {
  source.connect(master);
  source.start();
  nodes.push(source);
}

function loadAudioBuffer(context: AudioContext, src: string): Promise<AudioBuffer> {
  let cached = audioBufferCache.get(src);
  if (!cached) {
    cached = fetch(src)
      .then((response) => {
        if (!response.ok) throw new Error(`Could not load ${src}`);
        return response.arrayBuffer();
      })
      .then((buffer) => context.decodeAudioData(buffer))
      .catch((error) => {
        audioBufferCache.delete(src);
        throw error;
      });
    audioBufferCache.set(src, cached);
  }
  return cached;
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

function renderFocusStudio(options: SyncOptions, audioState: FocusAudioState): void {
  const player = document.querySelector<HTMLElement>("#audioPlayer");
  if (!player) return;

  const playing = audioState.playing;
  const activePreset = playing && audioState.preset ? audioState.preset : options.preset;
  const titleText = presetTitle(activePreset);
  player.dataset.playing = String(playing);

  const title = document.querySelector<HTMLElement>("#focusSoundNowPlaying");
  const attribution = document.querySelector<HTMLElement>("#focusSoundAttribution");
  const attributionText = document.querySelector<HTMLElement>("#focusSoundAttributionText");
  const sourceLink = document.querySelector<HTMLAnchorElement>("#focusSoundSourceLink");
  const licenseLink = document.querySelector<HTMLAnchorElement>("#focusSoundLicenseLink");
  const playButton = document.querySelector<HTMLButtonElement>("#focusSoundPlayButton");
  const playLabel = document.querySelector<HTMLElement>("#focusSoundPlayLabel");

  if (title) title.textContent = titleText;
  const track = realAudioTrack(activePreset);
  if (attribution) attribution.hidden = !track;
  if (track && attribution && attributionText && sourceLink && licenseLink) {
    const activeTrackButton = document.querySelector<HTMLButtonElement>(`[data-focus-preset="${activePreset}"]`);
    activeTrackButton?.closest<HTMLDetailsElement>(".audio-library-group")?.append(attribution);
    attributionText.textContent = track.attribution;
    sourceLink.href = track.sourcePage;
    licenseLink.href = track.licenseUrl;
    licenseLink.textContent = track.license;
  }
  if (playLabel) playLabel.textContent = playing ? "Pause" : "Listen";
  if (playButton) {
    playButton.setAttribute("aria-pressed", String(playing));
    playButton.setAttribute("aria-label", `${playing ? "Pause" : "Play"} ${titleText}`);
  }

  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-focus-preset]")) {
    const selected = button.dataset.focusPreset === options.preset;
    button.classList.toggle("is-active", selected);
    button.setAttribute("aria-pressed", String(selected));
    const action = button.querySelector<HTMLElement>("em");
    if (action) action.textContent = selected ? (playing ? "Playing" : "Ready") : "Play";
  }

  for (const group of document.querySelectorAll<HTMLDetailsElement>(".audio-library-group")) {
    const selectedTrack = group.querySelector<HTMLButtonElement>(`[data-focus-preset="${options.preset}"]`);
    group.dataset.selected = String(Boolean(selectedTrack));
    const summary = group.querySelector<HTMLElement>("[data-audio-group-current]");
    const selectedTitle = selectedTrack?.querySelector<HTMLElement>("strong")?.textContent;
    if (summary) summary.textContent = selectedTitle || summary.dataset.defaultSummary || "Sounds";
  }

  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-focus-timer-mode]")) {
    const timerMode = button.dataset.focusTimerMode;
    const minutes = Number(button.dataset.focusTimerMinutes || options.timerMinutes);
    const breakMinutes = Number(button.dataset.focusBreakMinutes || options.breakMinutes);
    const selected = timerMode === options.timerMode
      && (timerMode === "infinite" || minutes === options.timerMinutes)
      && (timerMode !== "interval" || breakMinutes === options.breakMinutes);
    button.classList.toggle("is-active", selected);
    button.setAttribute("aria-pressed", String(selected));
  }
}

function presetTitle(preset: FocusPreset): string {
  const sacred = sacredAudioCatalog.find((track) => track.id === preset);
  return sacred?.title || sentenceCase(presetLabel(preset));
}

function sentenceCase(value: string): string {
  return value ? value[0].toUpperCase() + value.slice(1) : value;
}

function soundProfile(options: SyncOptions, phase: "work" | "break") {
  const presetProfile = presetProfiles[generatedPreset(phase === "break" ? "brown-noise" : options.preset)];
  const intensity = phase === "break" ? "low" : options.intensity;
  const mode = phase === "break" ? "relax" : options.mode;
  const intensityProfile = intensityProfiles[intensity];
  const modeProfile = modeProfiles[mode];
  return {
    ...presetProfile,
    frequency: Math.round(presetProfile.frequency * modeProfile.frequencyMultiplier),
    beatFrequency: focusToneRate(options, mode, intensity),
    modulationRate: presetProfile.kind === "isochronic" ? focusToneRate(options, mode, intensity) : intensityProfile.rate * modeProfile.rateMultiplier,
    modulationDepth: presetProfile.kind === "isochronic" ? isochronicDepth(intensity) : intensityProfile.depth * modeProfile.depthMultiplier,
    toneFrequency: modeProfile.toneFrequency,
    toneGain: modeProfile.toneGain,
    carrierFrequency: Math.round((presetProfile.carrierFrequency || modeProfile.toneFrequency) * modeProfile.frequencyMultiplier)
  };
}

const presetProfiles: Record<GeneratedPreset, PresetProfile> = {
  "brown-noise": { kind: "noise", noise: "brown", filter: "lowpass", frequency: 560, q: 0.7 },
  "pink-noise": { kind: "noise", noise: "pink", filter: "lowpass", frequency: 980, q: 0.5 },
  "white-noise": { kind: "noise", noise: "white", filter: "lowpass", frequency: 5200, q: 0.22 },
  "binaural-beat": { kind: "binaural", frequency: 220, q: 0.5, carrierFrequency: 220 },
  "isochronic-tone": { kind: "isochronic", frequency: 196, q: 0.5, carrierFrequency: 196 }
};

const realAudioTracks: Record<RealAudioPreset, RealAudioTrack> = {
  rain: {
    label: "Rain",
    src: "/audio/nature/rain.ogg",
    attribution: "Rain field recording from PDSounds; public-domain release via Wikimedia Commons.",
    sourcePage: "https://commons.wikimedia.org/wiki/File:Rain_(1).ogg",
    license: "Public domain",
    licenseUrl: "https://creativecommons.org/publicdomain/mark/1.0/"
  },
  ocean: {
    label: "Ocean waves",
    src: "/audio/nature/ocean-waves.ogg",
    attribution: "Shore wave field recording; public-domain release via Wikimedia Commons.",
    sourcePage: "https://commons.wikimedia.org/wiki/File:Waves.ogg",
    license: "Public domain",
    licenseUrl: "https://creativecommons.org/publicdomain/mark/1.0/"
  },
  storm: {
    label: "Storm",
    src: "/audio/nature/storm-thunderbolts.ogg",
    attribution: "Thunderstorm field recording from PDSounds; public-domain release via Wikimedia Commons.",
    sourcePage: "https://commons.wikimedia.org/wiki/File:Storm_thunderbolts.ogg",
    license: "Public domain",
    licenseUrl: "https://creativecommons.org/publicdomain/mark/1.0/"
  },
  stream: {
    label: "Stream",
    src: "/audio/nature/forest-lawn-creek.ogg",
    attribution: "Forest Lawn Creek field recording; public-domain release via Wikimedia Commons.",
    sourcePage: "https://commons.wikimedia.org/wiki/File:Forest_lawn_creek.ogg",
    license: "Public domain",
    licenseUrl: "https://creativecommons.org/publicdomain/mark/1.0/"
  },
  "bach-goldberg-aria": {
    label: "Bach: Goldberg Aria",
    src: "/audio/baroque/bach-goldberg-aria-harpsichord.ogg",
    attribution: "J. S. Bach, Goldberg Variations, Aria, harpsichord performance via Wikimedia Commons.",
    sourcePage: "https://commons.wikimedia.org/wiki/File:Bach.Aria.Goldberg-Variationen.WerckmeisterIII.Harpsichord.ogg",
    license: "CC0 1.0",
    licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/"
  },
  "bach-invention-8": {
    label: "Bach: Invention 8",
    src: "/audio/baroque/bach-invention-8-harpsichord.ogg",
    attribution: "J. S. Bach, Invention 8, BWV 779, harpsichord performance via Wikimedia Commons.",
    sourcePage: "https://commons.wikimedia.org/wiki/File:J.S._Bach%27s_Invention_8_(BWV_779)_on_harpsichord.ogg",
    license: "CC0 1.0",
    licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/"
  },
  "bach-italian-concerto": {
    label: "Bach: Italian Concerto",
    src: "/audio/baroque/bach-italian-concerto-presto.ogg",
    attribution: "J. S. Bach, Italian Concerto, BWV 971, third movement, via Wikimedia Commons.",
    sourcePage: "https://commons.wikimedia.org/wiki/File:J._S._Bach_-_Italian_Concerto,_BWV._971_-_3._Presto.ogg",
    license: "CC0 1.0",
    licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/"
  },
  "handel-harmonious-blacksmith": {
    label: "Handel: Harmonious Blacksmith",
    src: "/audio/baroque/handel-harmonious-blacksmith.ogg",
    attribution: "G. F. Handel, The Harmonious Blacksmith, harpsichord performance via Wikimedia Commons.",
    sourcePage: "https://commons.wikimedia.org/wiki/File:Handel_-_Suites_for_Harpsichord_-_No.5_in_E_major_-_The_Harmonious_Blacksmith.ogg",
    license: "CC0 1.0",
    licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/"
  },
  "scarlatti-sonata-k87": {
    label: "Scarlatti: Sonata K.87",
    src: "/audio/baroque/scarlatti-sonata-k87.ogg",
    attribution: "Domenico Scarlatti, Sonata in B minor, K.87, digital harpsichord via Wikimedia Commons.",
    sourcePage: "https://commons.wikimedia.org/wiki/File:Domenico.Scarlatti.Sonata.b.minor.Kirkpatrick.87.ogg",
    license: "CC0 1.0",
    licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/"
  },
  "scarlatti-sonata-k466": {
    label: "Scarlatti: Sonata K.466",
    src: "/audio/baroque/scarlatti-sonata-k466.ogg",
    attribution: "Domenico Scarlatti, Sonata in F minor, K.466, digital harpsichord via Wikimedia Commons.",
    sourcePage: "https://commons.wikimedia.org/wiki/File:Domenico.Scarlatti.Sonata.f.minor.Kirkpatrick.466.ogg",
    license: "CC0 1.0",
    licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/"
  },
  ...Object.fromEntries(sacredAudioCatalog.map((track) => [track.id, {
    label: track.title,
    src: track.src,
    attribution: track.attribution,
    sourcePage: track.sourcePage,
    license: track.license,
    licenseUrl: track.licenseUrl
  }])) as Record<SacredAudioTrackId, RealAudioTrack>,
  ...Object.fromEntries(minecraftAudioCatalog.map((track) => [track.id, {
    label: track.title,
    src: track.src,
    attribution: track.attribution,
    sourcePage: track.sourcePage,
    license: track.license,
    licenseUrl: track.licenseUrl
  }])) as Record<MinecraftAudioTrackId, RealAudioTrack>
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

const focusToneRates: Record<FocusMode, number> = {
  focus: 14,
  relax: 8,
  sleep: 3.5,
  meditate: 6
};

const focusToneIntensityMultipliers: Record<FocusIntensity, number> = {
  low: 0.78,
  medium: 1,
  high: 1.18
};

const focusActivityRateOffsets: Partial<Record<FocusActivity, number>> = {
  "deep-work": 0.8,
  "creative-flow": -1.2,
  learning: 0.4,
  "light-work": -0.8,
  motivation: 1.4,
  recharge: -1.1,
  destress: -1.6,
  "wind-down": -1.4,
  "power-nap": -0.8,
  guided: -0.5,
  unguided: -0.9
};

function focusToneRate(options: SyncOptions, mode: FocusMode, intensity: FocusIntensity): number {
  const base = focusToneRates[mode] * focusToneIntensityMultipliers[intensity];
  const adjusted = base + (focusActivityRateOffsets[options.activity] || 0);
  return clamp(Number(adjusted.toFixed(2)), 2, 18);
}

function isochronicDepth(intensity: FocusIntensity): number {
  return {
    low: 0.11,
    medium: 0.16,
    high: 0.21
  }[intensity];
}

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
      data[index] = white * 0.28;
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

function soundSignature(options: SyncOptions, phase: "work" | "break"): string {
  return [
    options.mode,
    options.activity,
    phase === "break" ? "ocean" : options.preset,
    options.intensity,
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
  return isFocusPreset(value) ? value : "brown-noise";
}

function focusIntensity(value: unknown): FocusIntensity {
  return typeof value === "string" && ["low", "medium", "high"].includes(value) ? value as FocusIntensity : "medium";
}

function focusTimerMode(value: unknown): FocusTimerMode {
  return typeof value === "string" && ["infinite", "timer", "interval"].includes(value) ? value as FocusTimerMode : "infinite";
}

function presetLabel(value: FocusPreset): string {
  if (isRealAudioPreset(value)) return realAudioTracks[value].label;
  return {
    "brown-noise": "brown noise",
    "pink-noise": "pink noise",
    "white-noise": "white noise",
    "binaural-beat": "binaural beat",
    "isochronic-tone": "isochronic tone"
  }[value];
}

function modeVolumeMultiplier(mode: FocusMode): number {
  return modeProfiles[mode]?.volumeMultiplier || 1;
}

function volumeToGain(value: number, multiplier = 1): number {
  return clamp(Number(value || 0), 0, 100) / 100 * 0.28 * multiplier;
}

function realAudioTrack(preset: FocusPreset): RealAudioTrack | null {
  return isRealAudioPreset(preset) ? realAudioTracks[preset] : null;
}

function generatedPreset(preset: FocusPreset): GeneratedPreset {
  return isGeneratedPreset(preset) ? preset : "brown-noise";
}

function isFocusPreset(value: unknown): value is FocusPreset {
  return typeof value === "string" && (focusPresetValues as readonly string[]).includes(value);
}

function isGeneratedPreset(value: FocusPreset): value is GeneratedPreset {
  return (generatedPresetValues as readonly string[]).includes(value);
}

function isRealAudioPreset(value: FocusPreset): value is RealAudioPreset {
  return (realAudioPresetValues as readonly string[]).includes(value);
}
