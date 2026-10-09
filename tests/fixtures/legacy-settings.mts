import { defaultState as currentState, DEFAULT_BLOCKED_SITES } from "../../src/defaults.js";
import type { VigilState } from "../../src/types.js";

/** Explicit legacy state for recovery/compatibility tests, never fresh-product defaults. */
export function legacyState(): VigilState {
  const state = currentState();
  state.settings.intentionalUseEnabled = true;
  state.schedules = [{ id: "sleep-template", name: "Sleep wind-down", enabled: false, mode: "sleep", profileId: "default", lockLevel: "deep", days: [0,1,2,3,4,5,6], start: "22:30", end: "07:00", wifiNetworks: [] }];
  state.limitRules = [
    { id: "instagram-20-20-template", name: "Instagram 20/20", enabled: true, type: "time", lockLevel: "deep", days: [0,1,2,3,4,5,6], apps: ["Instagram", "com.burbn.instagram", "tech.caseline.vigil.instagram"], sites: ["instagram.com"], limitMinutes: 20, unlocksAllowed: 0, blockMinutes: 20, excludedProfileIds: ["soft-block"] },
    { id: "soft-lock-youtube-20-20-template", name: "Soft Lock YouTube 20/20", enabled: true, type: "time", lockLevel: "deep", days: [0,1,2,3,4,5,6], apps: ["YouTube", "com.google.ios.youtube", "tech.caseline.vigil.youtube"], sites: ["youtube.com"], limitMinutes: 20, unlocksAllowed: 0, blockMinutes: 20, requiredProfileId: "soft-block" },
    { id: "social-open-template", name: "Social open limit", enabled: false, type: "open", lockLevel: "deep", days: [0,1,2,3,4,5,6], apps: [], sites: DEFAULT_BLOCKED_SITES, limitMinutes: 45, unlocksAllowed: 5, blockMinutes: 0 }
  ];
  state.intentionalUse.rules = [{ id: "short-form-intent-template", name: "Short-form pause", enabled: true, frictionLevel: "standard", days: [0,1,2,3,4,5,6], start: "00:00", end: "23:59", apps: [], sites: ["instagram.com", "tiktok.com", "x.com", "twitter.com"], urlPatterns: ["reddit.com/r/all", "reddit.com/r/popular", "youtube.com/shorts", "m.youtube.com/shorts"], delaySeconds: 12, sessionMinutes: 10, dailyBudgetMinutes: 30, budgetWarningPercent: 50, askMood: true }];
  state.intentionalUse.behaviors = ["chastity", "rosary", "reading", "exercise"].map(id => ({ id: `habit-${id}`, name: id === "chastity" ? "Chastity" : id === "rosary" ? "Pray the Rosary" : id === "reading" ? "Reading" : "Exercise", description: "Legacy habit", direction: "build", unit: "yes-no", weeklyTarget: id === "exercise" ? 5 : 7, ruleIds: [], replacement: "", active: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
  state.intentionalUse.planLists = ["todo", "watchlist"].map(id => ({ id, name: id, kind: id === "todo" ? "todo" : "watch", description: "", active: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
  return state;
}
