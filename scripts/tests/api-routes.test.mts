import assert from "node:assert/strict";
import { API_ROUTES, isExtensionApiPath, matchApiRoute } from "../../src/server/apiRoutes.js";

const routeKeys = API_ROUTES.flatMap((route) => (
  route.methods.map((method) => `${method} ${route.path || `${route.prefix}*`}`)
));
assert.equal(new Set(routeKeys).size, routeKeys.length);

assert.equal(matchApiRoute("GET", "/api/state")?.id, "state");
assert.equal(matchApiRoute("GET", "/api/extension/pairing")?.id, "extensionPairing");
assert.equal(matchApiRoute("GET", "/api/backup/export")?.id, "backupExport");
assert.equal(matchApiRoute("POST", "/api/session/preview")?.id, "sessionPreview");
assert.equal(matchApiRoute("POST", "/api/session/start")?.domain, "sessions");
assert.equal(matchApiRoute("POST", "/api/hardening/safari-filter/apply")?.id, "safariFilterApply");
assert.equal(matchApiRoute("POST", "/api/adult-blocklist/settings")?.id, "adultBlocklistSettings");
assert.equal(matchApiRoute("POST", "/api/adult-blocklist/refresh")?.id, "adultBlocklistRefresh");
assert.equal(matchApiRoute("POST", "/api/devices/ios/usb-profile-apply")?.id, "iosUsbProfileApply");
assert.equal(matchApiRoute("GET", "/api/devices/ios/mdm/doctor")?.id, "iosMdmDoctor");
assert.equal(matchApiRoute("DELETE", "/api/schedule/work")?.id, "scheduleDelete");
assert.equal(matchApiRoute("DELETE", "/api/intentional-use/rule/pause")?.id, "intentionalRuleDelete");
assert.equal(matchApiRoute("POST", "/api/intentional-use/journal")?.id, "intentionalJournal");
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
assert.equal(domains.get("sessions"), 6);
assert.equal(domains.get("backup"), 1);
assert.equal(domains.get("devices"), 8);
assert.equal(domains.get("grayscale"), 3);
assert.equal(domains.get("extension"), 6);
assert.equal(domains.get("intentionalUse"), 20);
assert.ok(domains.get("hardening") >= 3);
