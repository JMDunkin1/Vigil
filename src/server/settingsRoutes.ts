import type { IncomingMessage, ServerResponse } from "node:http";
import { parseBoolean } from "../booleans.js";
import { assertProtectedEditAllowed } from "../protection.js";
import { addEvent, saveState } from "../store.js";
import { clampNumber } from "../time.js";
import type { AppSettings, VigilState, UnknownRecord } from "../types.js";
import { readBody, sendJson } from "./http.js";

type BooleanSettingKey = {
  [Key in keyof AppSettings]: AppSettings[Key] extends boolean ? Key : never
}[keyof AppSettings];

type NumberSettingKey = {
  [Key in keyof AppSettings]: AppSettings[Key] extends number ? Key : never
}[keyof AppSettings];

type StringSettingKey = {
  [Key in keyof AppSettings]: AppSettings[Key] extends string ? Key : never
}[keyof AppSettings];

interface SettingMutation {
  guarded?: boolean;
  apply(settings: AppSettings, value: unknown): void;
}

interface SettingsApiContext {
  state: VigilState;
}

export async function handleSettingsApiRoute(
  request: IncomingMessage,
  response: ServerResponse,
  { state }: SettingsApiContext
): Promise<boolean> {
  const method = request.method || "GET";
  const path = new URL(request.url || "/", "http://localhost").pathname;
  if (method !== "POST" || path !== "/api/settings") return false;

  const body = await readBody(request);
  if (isProtectedSettingsMutation(body)) {
    assertProtectedEditAllowed(state, { kind: "settings" });
  }

  const keys = updateSettings(state.settings, body);
  addEvent(state, "settings_updated", { keys });
  await saveState(state);
  sendJson(response, 200, { ok: true, keys });
  return true;
}

export function updateSettings(settings: AppSettings, body: UnknownRecord): string[] {
  const updated: string[] = [];
  for (const [key, value] of Object.entries(body || {})) {
    const mutation = settingMutation(key);
    if (!mutation) continue;
    mutation.apply(settings, value);
    updated.push(key);
  }
  return updated;
}

export function isProtectedSettingsMutation(body: UnknownRecord): boolean {
  return Object.keys(body || {}).some((key) => Boolean(settingMutation(key)?.guarded));
}

function settingMutation(key: string): SettingMutation | null {
  return Object.hasOwn(SETTING_MUTATIONS, key) ? SETTING_MUTATIONS[key as keyof typeof SETTING_MUTATIONS] : null;
}

function booleanSetting<Key extends BooleanSettingKey>(key: Key, options: { guarded?: boolean } = {}): SettingMutation {
  return {
    guarded: options.guarded,
    apply(settings, value) {
      settings[key] = parseBoolean(value, settings[key] as boolean) as AppSettings[Key];
    }
  };
}

function alwaysEnabledBooleanSetting<Key extends BooleanSettingKey>(key: Key, options: { guarded?: boolean } = {}): SettingMutation {
  return {
    guarded: options.guarded,
    apply(settings) {
      settings[key] = true as AppSettings[Key];
    }
  };
}

function numberSetting<Key extends NumberSettingKey>(
  key: Key,
  { min = 1, max = 100000, guarded = false }: { min?: number; max?: number; guarded?: boolean } = {}
): SettingMutation {
  return {
    guarded,
    apply(settings, value) {
      settings[key] = clampNumber(value, min, max, settings[key] as number) as AppSettings[Key];
    }
  };
}

function stringSetting<Key extends StringSettingKey>(key: Key, options: { guarded?: boolean } = {}): SettingMutation {
  return {
    guarded: options.guarded,
    apply(settings, value) {
      settings[key] = String(value);
    }
  };
}

function enumSetting<Key extends StringSettingKey>(
  key: Key,
  values: readonly string[],
  options: { guarded?: boolean } = {}
): SettingMutation {
  return {
    guarded: options.guarded,
    apply(settings, value) {
      const text = String(value || "");
      settings[key] = (values.includes(text) ? text : values[0]) as AppSettings[Key];
    }
  };
}

const GUARDED = { guarded: true } as const;

const SETTING_MUTATIONS = {
  pollIntervalMs: numberSetting("pollIntervalMs"),
  idleUsageTrackingEnabled: booleanSetting("idleUsageTrackingEnabled", GUARDED),
  idleUsageThresholdSeconds: numberSetting("idleUsageThresholdSeconds", { ...GUARDED, min: 30, max: 3600 }),
  strictByDefault: booleanSetting("strictByDefault", GUARDED),
  emergencyTokensPerWeek: numberSetting("emergencyTokensPerWeek"),
  emergencyDelaySeconds: numberSetting("emergencyDelaySeconds"),
  panicLockDurationMinutes: numberSetting("panicLockDurationMinutes", { ...GUARDED, min: 1, max: 1440 }),
  intentReasonEnabled: booleanSetting("intentReasonEnabled", GUARDED),
  intentReasonMinLength: numberSetting("intentReasonMinLength", { ...GUARDED, min: 1, max: 280 }),
  focusSoundEnabled: booleanSetting("focusSoundEnabled"),
  focusSoundMode: enumSetting("focusSoundMode", ["focus", "relax", "sleep", "meditate"]),
  focusSoundActivity: enumSetting("focusSoundActivity", [
    "deep-work",
    "creative-flow",
    "learning",
    "light-work",
    "motivation",
    "recharge",
    "destress",
    "wind-down",
    "power-nap",
    "guided",
    "unguided"
  ]),
  focusSoundPreset: enumSetting("focusSoundPreset", ["brown-noise", "pink-noise", "white-noise", "rain", "ocean", "storm", "stream"]),
  focusSoundIntensity: enumSetting("focusSoundIntensity", ["low", "medium", "high"]),
  focusSoundTimerMode: enumSetting("focusSoundTimerMode", ["infinite", "timer", "interval"]),
  focusSoundTimerMinutes: numberSetting("focusSoundTimerMinutes", { min: 1, max: 480 }),
  focusSoundBreakMinutes: numberSetting("focusSoundBreakMinutes", { min: 1, max: 120 }),
  focusSoundVolume: numberSetting("focusSoundVolume", { min: 0, max: 100 }),
  typingChallengeEnabled: booleanSetting("typingChallengeEnabled", GUARDED),
  interventionEnabled: booleanSetting("interventionEnabled", GUARDED),
  interventionWindowMinutes: numberSetting("interventionWindowMinutes", GUARDED),
  interventionThreshold: numberSetting("interventionThreshold", GUARDED),
  interventionExtraDelaySeconds: numberSetting("interventionExtraDelaySeconds", GUARDED),
  interventionMaxExtraDelaySeconds: numberSetting("interventionMaxExtraDelaySeconds", GUARDED),
  intentionalUseEnabled: booleanSetting("intentionalUseEnabled", GUARDED),
  baselineDailyMinutes: numberSetting("baselineDailyMinutes"),
  focusScoreGoal: numberSetting("focusScoreGoal"),
  activeProfileId: stringSetting("activeProfileId", GUARDED),
  baselineProfileId: stringSetting("baselineProfileId", GUARDED),
  foolproofModeEnabled: booleanSetting("foolproofModeEnabled", GUARDED),
  appQuitEscalationSeconds: numberSetting("appQuitEscalationSeconds", GUARDED),
  siteRedirectEnabled: booleanSetting("siteRedirectEnabled", GUARDED),
  contentFilterEnabled: alwaysEnabledBooleanSetting("contentFilterEnabled", GUARDED),
  browserNoiseBlockingEnabled: booleanSetting("browserNoiseBlockingEnabled", GUARDED),
  appQuitEnabled: booleanSetting("appQuitEnabled", GUARDED),
  strictBypassProtectionEnabled: alwaysEnabledBooleanSetting("strictBypassProtectionEnabled", GUARDED),
  processSweepEnabled: booleanSetting("processSweepEnabled", GUARDED),
  processSweepIntervalSeconds: numberSetting("processSweepIntervalSeconds", GUARDED),
  systemSleepLockEnabled: booleanSetting("systemSleepLockEnabled", GUARDED),
  systemSleepLockIntervalSeconds: numberSetting("systemSleepLockIntervalSeconds", GUARDED),
  focusShortcutEnabled: booleanSetting("focusShortcutEnabled", GUARDED),
  focusShortcutOnName: stringSetting("focusShortcutOnName", GUARDED),
  focusShortcutOffName: stringSetting("focusShortcutOffName", GUARDED),
  systemNetworkBlockingEnabled: booleanSetting("systemNetworkBlockingEnabled", GUARDED),
  safariUrlFilterEnabled: alwaysEnabledBooleanSetting("safariUrlFilterEnabled", GUARDED),
  externalNetworkBlockEnabled: booleanSetting("externalNetworkBlockEnabled", GUARDED),
  externalNetworkBlockProvider: enumSetting("externalNetworkBlockProvider", ["manual"], GUARDED),
  hostsBlockingEnabled: booleanSetting("hostsBlockingEnabled"),
  protectedEditsEnabled: booleanSetting("protectedEditsEnabled", GUARDED),
  protectedEditDelaySeconds: numberSetting("protectedEditDelaySeconds", GUARDED),
  protectedEditWindowMinutes: numberSetting("protectedEditWindowMinutes", GUARDED)
} satisfies Partial<Record<keyof AppSettings, SettingMutation>>;
