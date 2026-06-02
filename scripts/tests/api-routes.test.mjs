import assert from "node:assert/strict";
import { API_ROUTES, isExtensionApiPath, matchApiRoute } from "../../src/server/apiRoutes.js";

const routeKeys = API_ROUTES.flatMap((route) => (
  route.methods.map((method) => `${method} ${route.path || `${route.prefix}*`}`)
));
assert.equal(new Set(routeKeys).size, routeKeys.length);

assert.equal(matchApiRoute("GET", "/api/state").id, "state");
assert.equal(matchApiRoute("POST", "/api/session/start").domain, "sessions");
assert.equal(matchApiRoute("DELETE", "/api/schedule/work").id, "scheduleDelete");
assert.equal(matchApiRoute("DELETE", "/api/intentional-use/rule/pause").id, "intentionalRuleDelete");
assert.equal(matchApiRoute("GET", "/api/not-real"), null);

assert.equal(isExtensionApiPath("/api/extension/check"), true);
assert.equal(isExtensionApiPath("/api/extension/rules"), true);
assert.equal(isExtensionApiPath("/api/extension/rules/sync"), true);
assert.equal(isExtensionApiPath("/api/state"), false);

const domains = new Map();
for (const route of API_ROUTES) {
  domains.set(route.domain, (domains.get(route.domain) || 0) + 1);
}
assert.equal(domains.get("sessions"), 5);
assert.equal(domains.get("devices"), 6);
assert.equal(domains.get("extension"), 3);
assert.ok(domains.get("hardening") >= 3);
