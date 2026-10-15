import assert from "node:assert/strict";
import { verifyVigilStaticRules } from "../src/extensionStaticRules.js";

function fixture(options: { failed?: boolean; disabledSet?: boolean; disabledRule?: boolean; unreadable?: boolean } = {}) {
  const checked: chrome.declarativeNetRequest.RegexOptions[] = [];
  const rules = [
    { id: 1, action: { type: "redirect", redirect: { extensionPath: "/blocked.html" } }, condition: { regexFilter: "unsafe", resourceTypes: ["main_frame"] } },
    { id: 2, action: { type: "redirect", redirect: { regexSubstitution: "https://example.test/\\1" } }, condition: { regexFilter: "(capture)", isUrlFilterCaseSensitive: true, resourceTypes: ["main_frame"] } },
    { id: 3, action: { type: "block" }, condition: { requestDomains: ["example.test"], resourceTypes: ["sub_frame"] } }
  ];
  const api = {
    runtime: { getManifest: () => ({ declarative_net_request: { rule_resources: [{ id: "required", enabled: true, path: "rules.json" }] } }), getURL: (path: string) => "https://extension-fixture.test/" + path },
    declarativeNetRequest: {
      getEnabledRulesets: async () => options.disabledSet ? [] : ["required"],
      getDisabledRuleIds: async () => options.disabledRule ? [1] : [],
      isRegexSupported: async (value: chrome.declarativeNetRequest.RegexOptions) => {
        checked.push(value);
        return options.failed && value.regex === "unsafe" ? { isSupported: false, reason: "memoryLimitExceeded" } : { isSupported: true };
      }
    }
  } as unknown as typeof chrome;
  const read = (async () => new Response(JSON.stringify(rules), { status: options.unreadable ? 404 : 200 })) as typeof fetch;
  return { api, read, checked };
}
const valid = fixture();
const proof = await verifyVigilStaticRules(valid.api, valid.read);
assert.equal(proof.ok, true);
assert.equal(proof.totalRules, 3);
assert.equal(proof.regexRules, 2);
assert.deepEqual(valid.checked, [
  { regex: "unsafe", isCaseSensitive: false, requireCapturing: false },
  { regex: "(capture)", isCaseSensitive: true, requireCapturing: true }
]);
for (const options of [{ failed: true }, { disabledSet: true }, { disabledRule: true }, { unreadable: true }]) {
  const value = fixture(options);
  const result = await verifyVigilStaticRules(value.api, value.read);
  assert.equal(result.ok, false, "Compiler failure, disabled protection and unreadable rules cannot be reported as verified");
}
const invalid = fixture();
const missing = { runtime: invalid.api.runtime, declarativeNetRequest: {} } as typeof chrome;
assert.equal((await verifyVigilStaticRules(missing, invalid.read)).ok, false);
console.log("Static-rule proof passed: compiler options, rejection, enablement, disabled rules, missing API and unreadable assets.");
