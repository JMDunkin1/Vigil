import type { IncomingMessage, ServerResponse } from "node:http";
import { minecraftAudioCatalog } from "../../public/minecraft-audio-catalog.js";
import { adultBlocklistSource, invalidateAdultBlocklistIfSourceChanged } from "../adultBlocklist.js";
import { parseBoolean } from "../booleans.js";
import { assertProtectedEditAllowed } from "../protection.js";
import { isProtectedSetting } from "../seal.js";
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

  const previousAdultBlocklistSource = adultBlocklistSource(state);
  const keys = updateSettings(state.settings, body);
  if (invalidateAdultBlocklistIfSourceChanged(state, previousAdultBlocklistSource)) {
    keys.push("adultBlocklistSnapshot");
  }
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
  return Object.keys(body || {}).some((key) => Boolean(settingMutation(key)) && isProtectedSetting(key));
}

function settingMutation(key: string): SettingMutation | null {
  return Object.hasOwn(SETTING_MUTATIONS, key) ? SETTING_MUTATIONS[key as keyof typeof SETTING_MUTATIONS] : null;
}

function booleanSetting<Key extends BooleanSettingKey>(key: Key): SettingMutation {
  return {
    apply(settings, value) {
      settings[key] = parseBoolean(value, settings[key] as boolean) as AppSettings[Key];
    }
  };
}

function alwaysEnabledBooleanSetting<Key extends BooleanSettingKey>(key: Key): SettingMutation {
  return {
    apply(settings) {
      settings[key] = true as AppSettings[Key];
    }
  };
}

function numberSetting<Key extends NumberSettingKey>(
  key: Key,
  { min = 1, max = 100000 }: { min?: number; max?: number } = {}
): SettingMutation {
  return {
    apply(settings, value) {
      settings[key] = clampNumber(value, min, max, settings[key] as number) as AppSettings[Key];
    }
  };
}

function stringSetting<Key extends StringSettingKey>(key: Key): SettingMutation {
  return {
    apply(settings, value) {
      settings[key] = String(value);
    }
  };
}

function enumSetting<Key extends StringSettingKey>(
  key: Key,
  values: readonly string[]
): SettingMutation {
  return {
    apply(settings, value) {
      const text = String(value || "");
      settings[key] = (values.includes(text) ? text : values[0]) as AppSettings[Key];
    }
  };
}

const SETTING_MUTATIONS = {
  pollIntervalMs: numberSetting("pollIntervalMs"),
  idleUsageTrackingEnabled: booleanSetting("idleUsageTrackingEnabled"),
  idleUsageThresholdSeconds: numberSetting("idleUsageThresholdSeconds", { min: 30, max: 3600 }),
  strictByDefault: booleanSetting("strictByDefault"),
  emergencyTokensPerWeek: numberSetting("emergencyTokensPerWeek"),
  emergencyDelaySeconds: numberSetting("emergencyDelaySeconds"),
  panicLockDurationMinutes: numberSetting("panicLockDurationMinutes", { min: 1, max: 1440 }),
  intentReasonEnabled: booleanSetting("intentReasonEnabled"),
  intentReasonMinLength: numberSetting("intentReasonMinLength", { min: 1, max: 280 }),
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
  focusSoundPreset: enumSetting("focusSoundPreset", [
    "brown-noise", "pink-noise", "white-noise", "rain", "ocean", "storm", "stream", "binaural-beat", "isochronic-tone",
    "bach-goldberg-aria", "bach-invention-8", "bach-italian-concerto", "handel-harmonious-blacksmith", "scarlatti-sonata-k87", "scarlatti-sonata-k466",
    "rorate-caeli", "o-come-emmanuel", "o-come-all-ye-faithful", "crux-fidelis", "pange-lingua", "victimae-paschali-laudes",
    "regina-caeli", "ave-maria-gregorian", "salve-regina", "veni-creator-spiritus", "kyrie-xi-orbis-factor", "dies-irae",
    ...minecraftAudioCatalog.map((track) => track.id)
  ]),
  focusSoundIntensity: enumSetting("focusSoundIntensity", ["low", "medium", "high"]),
  focusSoundTimerMode: enumSetting("focusSoundTimerMode", ["infinite", "timer", "interval"]),
  focusSoundTimerMinutes: numberSetting("focusSoundTimerMinutes", { min: 1, max: 480 }),
  focusSoundBreakMinutes: numberSetting("focusSoundBreakMinutes", { min: 1, max: 120 }),
  focusSoundVolume: numberSetting("focusSoundVolume", { min: 0, max: 100 }),
  typingChallengeEnabled: booleanSetting("typingChallengeEnabled"),
  interventionEnabled: booleanSetting("interventionEnabled"),
  interventionWindowMinutes: numberSetting("interventionWindowMinutes"),
  interventionThreshold: numberSetting("interventionThreshold"),
  interventionExtraDelaySeconds: numberSetting("interventionExtraDelaySeconds"),
  interventionMaxExtraDelaySeconds: numberSetting("interventionMaxExtraDelaySeconds"),
  intentionalUseEnabled: booleanSetting("intentionalUseEnabled"),
  baselineDailyMinutes: numberSetting("baselineDailyMinutes"),
  focusScoreGoal: numberSetting("focusScoreGoal"),
  activeProfileId: stringSetting("activeProfileId"),
  baselineProfileId: stringSetting("baselineProfileId"),
  foolproofModeEnabled: booleanSetting("foolproofModeEnabled"),
  appQuitEscalationSeconds: numberSetting("appQuitEscalationSeconds"),
  siteRedirectEnabled: booleanSetting("siteRedirectEnabled"),
  contentFilterEnabled: alwaysEnabledBooleanSetting("contentFilterEnabled"),
  adultBlocklistEnabled: booleanSetting("adultBlocklistEnabled"),
  adultBlocklistSourceId: enumSetting("adultBlocklistSourceId", ["hagezi-nsfw", "stevenblack-porn", "blocklistproject-porn", "shadowwhisperer-adult", "custom"]),
  adultBlocklistCustomUrl: stringSetting("adultBlocklistCustomUrl"),
  adultBlocklistPreloadLimit: numberSetting("adultBlocklistPreloadLimit", { min: 0, max: 250 }),
  browserNoiseBlockingEnabled: booleanSetting("browserNoiseBlockingEnabled"),
  appQuitEnabled: booleanSetting("appQuitEnabled"),
  strictBypassProtectionEnabled: alwaysEnabledBooleanSetting("strictBypassProtectionEnabled"),
  processSweepEnabled: booleanSetting("processSweepEnabled"),
  processSweepIntervalSeconds: numberSetting("processSweepIntervalSeconds"),
  systemSleepLockEnabled: booleanSetting("systemSleepLockEnabled"),
  systemSleepLockIntervalSeconds: numberSetting("systemSleepLockIntervalSeconds"),
  focusShortcutEnabled: booleanSetting("focusShortcutEnabled"),
  focusShortcutOnName: stringSetting("focusShortcutOnName"),
  focusShortcutOffName: stringSetting("focusShortcutOffName"),
  systemNetworkBlockingEnabled: booleanSetting("systemNetworkBlockingEnabled"),
  safariUrlFilterEnabled: alwaysEnabledBooleanSetting("safariUrlFilterEnabled"),
  externalNetworkBlockEnabled: booleanSetting("externalNetworkBlockEnabled"),
  externalNetworkBlockProvider: enumSetting("externalNetworkBlockProvider", ["manual"]),
  hostsBlockingEnabled: booleanSetting("hostsBlockingEnabled"),
  protectedEditsEnabled: booleanSetting("protectedEditsEnabled"),
  protectedEditDelaySeconds: numberSetting("protectedEditDelaySeconds"),
  protectedEditWindowMinutes: numberSetting("protectedEditWindowMinutes")
} satisfies Partial<Record<keyof AppSettings, SettingMutation>>;
