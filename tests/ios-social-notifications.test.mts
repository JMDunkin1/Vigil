import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const projectRoot = existsSync(join(runtimeRoot, "ios")) ? runtimeRoot : resolve(runtimeRoot, "..", "..");
const source = await readFile(join(projectRoot, "ios/VigilSocial/VigilSocial/SocialNotifications.swift"), "utf8");
const match = source.match(/static func script\(allowed: Bool\) -> String \{\s*"""([\s\S]*?)"""/u);
assert.ok(match);
function install(allowed: boolean) {
  const events: unknown[] = [];
  const window = { top: null as unknown, webkit: { messageHandlers: { vigilWebActivity: { postMessage: (event: unknown) => events.push(event) } } } };
  window.top = window;
  const context = vm.createContext({ window, EventTarget, Event, location: { href: "https://www.snapchat.com/web/" } });
  const script = match![1]!.replace(/\\\(allowed \? "true" : "false"\)/gu, String(allowed));
  vm.runInContext(script, context);
  return { context, events };
}
const disabled = install(false);
assert.equal(vm.runInContext("window.Notification.permission", disabled.context), "denied");
vm.runInContext("new window.Notification('Private sender', {body:'private message', tag:'secret'})", disabled.context);
assert.equal(disabled.events.length, 0);
const enabled = install(true);
assert.equal(vm.runInContext("window.Notification.permission", enabled.context), "granted");
vm.runInContext("new window.Notification('Private sender', {body:'private message', tag:'secret', data:{url:'https://example.test'}})", enabled.context);
assert.equal(enabled.events.length, 1);
assert.deepEqual(JSON.parse(JSON.stringify(enabled.events[0])), { type: "activity", href: "https://www.snapchat.com/web/" },
  "Web alerts must not export private text, media, tags, or destinations to native notifications");
vm.runInContext("window.__vigilWebAlertsAllowed = false; new window.Notification('Later')", enabled.context);
assert.equal(enabled.events.length, 1, "Disabling native alerts applies to an already loaded page");
assert.match(source, /UIApplication\.shared\.applicationState == \.active/u, "No claimed delivery while closed");
assert.match(source, /message\.frameInfo\.isMainFrame, policyAllows\(\)/u, "Events obey native policy access");
assert.match(source, /service\.isCanonicalAppHost/u, "Notification events cannot originate from arbitrary embedded pages");
assert.match(source, /session\.updatePermission\(enabled\(for: session\.service\)\)/u,
  "Changes to authorization and alert settings must update the installed permission script");
assert.match(source, /controller\.userScripts\.map[\s\S]*?controller\.removeAllUserScripts\(\)[\s\S]*?for script in scripts \{ controller\.addUserScript\(script\) \}/u,
  "Permission updates must preserve other WebKit scripts while replacing the persistent permission script");
const nativeTests = await readFile(join(projectRoot, "ios/VigilSocial/VigilSocialTests/SocialNotificationsTests.swift"), "utf8");
assert.match(nativeTests, /testWebAlertPermissionSurvivesDocumentRecreationAndPreservesOtherScripts/u);
console.log("Opt-in web notifications and private payload isolation passed.");
