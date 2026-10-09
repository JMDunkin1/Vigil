import { RETIRED_SETTING_KEYS } from "../retiredFeatures.js";
import type { IncomingMessage, ServerResponse } from "node:http";
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
  apply(settings: AppSettings, value: unknown, context: SettingMutationContext): void;
}

interface SettingMutationContext {
  profileIds: ReadonlySet<string>;
}

interface SettingsApiContext {
  state: VigilState;
  schedulePolicyEnforcement?: (reason: string) => unknown;
}

export async function handleSettingsApiRoute(
  request: IncomingMessage,
  response: ServerResponse,
  { state, schedulePolicyEnforcement }: SettingsApiContext
): Promise<boolean> {
  const method = request.method || "GET";
  const path = new URL(request.url || "/", "http://localhost").pathname;
  if (method !== "POST" || path !== "/api/settings") return false;

  const body = await readBody(request);
  const onlyEnablingBrowserProtection = Object.keys(body).length === 1 && body.protectedBrowsersOnly === true;
  if (!onlyEnablingBrowserProtection && isProtectedSettingsMutation(body)) {
    assertProtectedEditAllowed(state, { kind: "settings" });
  }

  const previousAdultBlocklistSource = adultBlocklistSource(state);
  const keys = updateSettings(state.settings, body, state.profiles.map((profile) => profile.id));
  if (invalidateAdultBlocklistIfSourceChanged(state, previousAdultBlocklistSource)) {
    keys.push("adultBlocklistSnapshot");
  }
  if (!keys.length) {
    sendJson(response, 200, { ok: true, keys });
    return true;
  }
  addEvent(state, "settings_updated", { keys });
  if (settingsRequireImmediatePolicyEnforcement(keys)) schedulePolicyEnforcement?.("settings-updated");
  await saveState(state);
  sendJson(response, 200, { ok: true, keys });
  return true;
}

export function updateSettings(
  settings: AppSettings,
  body: UnknownRecord,
  profileIds: readonly string[] = []
): string[] {
  if (settings.protectedBrowsersOnly && Object.hasOwn(body, "protectedBrowsersOnly") && !parseBoolean(body.protectedBrowsersOnly)) {
    throw new Error("Protected-browser enforcement cannot be disabled.");
  }
  const retired = Object.keys(body).filter(key => RETIRED_SETTING_KEYS.has(key));
  if (retired.length) throw Object.assign(new Error(`These settings have been retired: ${retired.join(", ")}.`), { status: 410 });
  const draft = { ...settings };
  const context: SettingMutationContext = { profileIds: new Set(profileIds) };
  const updated: string[] = [];
  for (const [key, value] of Object.entries(body || {})) {
    const mutation = settingMutation(key);
    if (!mutation) continue;
    const before = (draft as unknown as UnknownRecord)[key];
    mutation.apply(draft, value, context);
    if (!Object.is(before, (draft as unknown as UnknownRecord)[key])) updated.push(key);
  }
  Object.assign(settings, draft);
  return updated;
}

const SETTINGS_WITHOUT_IMMEDIATE_ENFORCEMENT = new Set([
  "pollIntervalMs",
  "idleUsageTrackingEnabled",
  "idleUsageThresholdSeconds",
  "strictByDefault",
  "emergencyTokensPerWeek",
  "emergencyDelaySeconds",
  "panicLockDurationMinutes",
  "intentReasonEnabled",
  "intentReasonMinLength",
  "typingChallengeEnabled",
  "interventionEnabled",
  "interventionWindowMinutes",
  "interventionThreshold",
  "interventionExtraDelaySeconds",
  "interventionMaxExtraDelaySeconds",
  "baselineDailyMinutes",
  "focusScoreGoal",
  "browserNoiseBlockingEnabled",
  "externalNetworkBlockEnabled",
  "externalNetworkBlockProvider",
  "hostsBlockingEnabled",
  "protectedEditsEnabled",
  "protectedEditDelaySeconds",
  "protectedEditWindowMinutes"
]);

export function settingsRequireImmediatePolicyEnforcement(keys: readonly string[]): boolean {
  return keys.some((key) => !SETTINGS_WITHOUT_IMMEDIATE_ENFORCEMENT.has(key));
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

function profileIdSetting<Key extends "activeProfileId" | "baselineProfileId">(key: Key): SettingMutation {
  return {
    apply(settings, value, context) {
      const profileId = String(value || "").trim();
      if (profileId === "soft-block") throw Object.assign(new Error("Soft Lock has been retired."), { status: 410 });
      if (!profileId || !context.profileIds.has(profileId)) {
        throw settingsError(`Unknown profile for ${key}.`);
      }
      settings[key] = profileId as AppSettings[Key];
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
      if (!values.includes(text)) throw settingsError(`Invalid value for ${key}.`);
      settings[key] = text as AppSettings[Key];
    }
  };
}

function settingsError(message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status: 400 });
}

const SETTING_MUTATIONS = {
  pollIntervalMs: numberSetting("pollIntervalMs"),
  idleUsageTrackingEnabled: booleanSetting("idleUsageTrackingEnabled"),
  idleUsageThresholdSeconds: numberSetting("idleUsageThresholdSeconds", { min: 30, max: 3600 }),
  strictByDefault: alwaysEnabledBooleanSetting("strictByDefault"),
  emergencyTokensPerWeek: numberSetting("emergencyTokensPerWeek"),
  emergencyDelaySeconds: numberSetting("emergencyDelaySeconds"),
  panicLockDurationMinutes: numberSetting("panicLockDurationMinutes", { min: 1, max: 1440 }),
  intentReasonEnabled: alwaysEnabledBooleanSetting("intentReasonEnabled"),
  intentReasonMinLength: numberSetting("intentReasonMinLength", { min: 1, max: 280 }),
  typingChallengeEnabled: alwaysEnabledBooleanSetting("typingChallengeEnabled"),
  interventionEnabled: booleanSetting("interventionEnabled"),
  interventionWindowMinutes: numberSetting("interventionWindowMinutes"),
  interventionThreshold: numberSetting("interventionThreshold"),
  interventionExtraDelaySeconds: numberSetting("interventionExtraDelaySeconds"),
  interventionMaxExtraDelaySeconds: numberSetting("interventionMaxExtraDelaySeconds"),
  activeProfileId: profileIdSetting("activeProfileId"),
  baselineProfileId: profileIdSetting("baselineProfileId"),
  foolproofModeEnabled: booleanSetting("foolproofModeEnabled"),
  appQuitEscalationSeconds: numberSetting("appQuitEscalationSeconds"),
  siteRedirectEnabled: alwaysEnabledBooleanSetting("siteRedirectEnabled"),
  contentFilterEnabled: alwaysEnabledBooleanSetting("contentFilterEnabled"),
  sketchySiteMaxAgeDays: numberSetting("sketchySiteMaxAgeDays", { min: 1, max: 90 }),
  adultBlocklistEnabled: alwaysEnabledBooleanSetting("adultBlocklistEnabled"),
  adultBlocklistSourceId: enumSetting("adultBlocklistSourceId", ["hagezi-nsfw", "stevenblack-porn", "blocklistproject-porn", "shadowwhisperer-adult", "custom"]),
  adultBlocklistCustomUrl: stringSetting("adultBlocklistCustomUrl"),
  adultBlocklistPreloadLimit: numberSetting("adultBlocklistPreloadLimit", { min: 0, max: 250 }),
  browserNoiseBlockingEnabled: alwaysEnabledBooleanSetting("browserNoiseBlockingEnabled"),
  appQuitEnabled: alwaysEnabledBooleanSetting("appQuitEnabled"),
  strictBypassProtectionEnabled: alwaysEnabledBooleanSetting("strictBypassProtectionEnabled"),
  processSweepEnabled: alwaysEnabledBooleanSetting("processSweepEnabled"),
  processSweepIntervalSeconds: numberSetting("processSweepIntervalSeconds"),
  systemNetworkBlockingEnabled: alwaysEnabledBooleanSetting("systemNetworkBlockingEnabled"),
  safariUrlFilterEnabled: alwaysEnabledBooleanSetting("safariUrlFilterEnabled"),
  protectedEditsEnabled: alwaysEnabledBooleanSetting("protectedEditsEnabled"),
  protectedBrowsersOnly: alwaysEnabledBooleanSetting("protectedBrowsersOnly"),
  protectedEditDelaySeconds: numberSetting("protectedEditDelaySeconds"),
  protectedEditWindowMinutes: numberSetting("protectedEditWindowMinutes")
} satisfies Partial<Record<keyof AppSettings, SettingMutation>>;
