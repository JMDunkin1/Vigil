import assert from "node:assert/strict";
import { API_ROUTES, isExtensionApiPath, matchApiRoute } from "../src/server/apiRoutes.js";

const routeKeys = API_ROUTES.flatMap((route) => (
  route.methods.map((method) => `${method} ${route.path || `${route.prefix}*`}`)
));
assert.equal(new Set(routeKeys).size, routeKeys.length);

assert.equal(matchApiRoute("GET", "/api/account/session")?.id, "accountSession");
assert.equal(matchApiRoute("POST", "/api/account/signup")?.id, "accountSignup");
assert.equal(matchApiRoute("POST", "/api/account/login")?.id, "accountLogin");
assert.equal(matchApiRoute("POST", "/api/account/logout")?.id, "accountLogout");
assert.equal(matchApiRoute("GET", "/api/state")?.id, "state");
assert.equal(matchApiRoute("GET", "/api/extension/pairing")?.id, "extensionPairing");
assert.equal(matchApiRoute("GET", "/api/diagnostic/export")?.id, "diagnosticExport");
assert.equal(matchApiRoute("GET", "/api/app-update/status")?.id, "appUpdateStatus");
assert.equal(matchApiRoute("POST", "/api/app-update/start")?.id, "appUpdateStart");
assert.equal(matchApiRoute("POST", "/api/app-relaunch")?.id, "appRelaunch");
assert.equal(matchApiRoute("POST", "/api/session/preview")?.id, "sessionPreview");
assert.equal(matchApiRoute("POST", "/api/session/start")?.domain, "sessions");
assert.equal(matchApiRoute("POST", "/api/protection/level")?.id, "protectionLevel");
assert.equal(matchApiRoute("POST", "/api/hardening/safari-filter/apply")?.id, "safariFilterApply");
assert.equal(matchApiRoute("POST", "/api/hardening/chrome-safe-search/apply")?.id, "chromeSafeSearchApply");
assert.equal(matchApiRoute("POST", "/api/adult-blocklist/settings")?.id, "adultBlocklistSettings");
assert.equal(matchApiRoute("POST", "/api/adult-blocklist/refresh")?.id, "adultBlocklistRefresh");
assert.equal(matchApiRoute("POST", "/api/devices/ios/app-removal")?.id, "iosAppRemoval");
assert.equal(matchApiRoute("POST", "/api/devices/ios/usb-profile-apply")?.id, "iosUsbProfileApply");
assert.equal(matchApiRoute("GET", "/api/devices/ios/mdm/doctor")?.id, "iosMdmDoctor");
assert.equal(matchApiRoute("GET", "/api/devices/ios/mdm/device-usage-token")?.id, "iosMdmDeviceUsageToken");
assert.equal(matchApiRoute("DELETE", "/api/profile/custom")?.id, "profileDelete");
assert.equal(matchApiRoute("DELETE", "/api/schedule/work")?.id, "scheduleDelete");
assert.equal(matchApiRoute("DELETE", "/api/intentional-use/rule/pause")?.id, "intentionalRuleDelete");
assert.equal(matchApiRoute("GET", "/api/intentional-use/journal/security")?.id, "intentionalJournalSecurity");
assert.equal(matchApiRoute("POST", "/api/intentional-use/journal/security")?.id, "intentionalJournalSecurity");
assert.equal(matchApiRoute("POST", "/api/intentional-use/journal/password"), null);
assert.equal(matchApiRoute("POST", "/api/intentional-use/journal/unlock"), null);
assert.equal(matchApiRoute("POST", "/api/intentional-use/journal/unlock-touch-id")?.id, "intentionalJournalTouchId");
assert.equal(matchApiRoute("POST", "/api/intentional-use/journal/lock")?.id, "intentionalJournalLock");
assert.equal(matchApiRoute("GET", "/api/intentional-use/journal/entries")?.id, "intentionalJournalEntries");
assert.equal(matchApiRoute("POST", "/api/intentional-use/journal")?.id, "intentionalJournal");
assert.equal(matchApiRoute("DELETE", "/api/intentional-use/journal/reflection")?.id, "intentionalJournalDelete");
assert.equal(matchApiRoute("POST", "/api/intentional-use/plan/block")?.id, "intentionalPlanBlock");
assert.equal(matchApiRoute("DELETE", "/api/intentional-use/plan/item/homework")?.id, "intentionalPlanItemDelete");
assert.equal(matchApiRoute("POST", "/api/intentional-use/recovery/setup")?.id, "intentionalRecoverySetup");
assert.equal(matchApiRoute("POST", "/api/intentional-use/recovery/check-in")?.id, "intentionalRecoveryCheckIn");
assert.equal(matchApiRoute("POST", "/api/intentional-use/recovery/sos")?.id, "intentionalRecoverySos");
assert.equal(matchApiRoute("DELETE", "/api/intentional-use/behavior/night-phone")?.id, "intentionalBehaviorDelete");
assert.equal(matchApiRoute("POST", "/api/grayscale/settings")?.id, "grayscaleSettings");
assert.equal(matchApiRoute("POST", "/api/grayscale/schedule")?.id, "grayscaleSchedule");
assert.equal(matchApiRoute("DELETE", "/api/grayscale/schedule/night")?.id, "grayscaleScheduleDelete");
assert.equal(matchApiRoute("GET", "/api/not-real"), null);

assert.equal(isExtensionApiPath("/api/extension/check"), true);
assert.equal(isExtensionApiPath("/api/extension/pairing"), true);
assert.equal(isExtensionApiPath("/api/extension/rules"), true);
assert.equal(isExtensionApiPath("/api/extension/rules/sync"), true);
assert.equal(isExtensionApiPath("/api/state"), false);

const domains = new Map();
for (const route of API_ROUTES) {
  domains.set(route.domain, (domains.get(route.domain) || 0) + 1);
}
assert.equal(domains.get("sessions"), 7);
assert.equal(domains.get("diagnostics"), 1);
assert.equal(domains.get("app"), 3);
assert.equal(domains.get("account"), 4);
assert.equal(domains.get("devices"), 10);
assert.equal(domains.get("grayscale"), 3);
assert.equal(domains.get("extension"), 6);
assert.equal(domains.get("profiles"), 2);
assert.equal(domains.get("intentionalUse"), 24);
assert.ok(domains.get("hardening") >= 3);
