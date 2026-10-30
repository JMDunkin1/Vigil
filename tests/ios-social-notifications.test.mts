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
function install(allowed: boolean, service = "") {
  const events: unknown[] = [];
  const window = { top: null as unknown, __vigilNotificationService: service, webkit: { messageHandlers: { vigilWebActivity: { postMessage: (event: unknown) => events.push(event) } } } };
  window.top = window;
  const context = vm.createContext({ window, navigator: {}, DOMException, EventTarget, Event, location: { href: "https://www.snapchat.com/web/" } });
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
const snap = install(true, "snapchat");
for (const type of [201, 205, 206, 230, 234, 235, 1250, 1252, 1270, 1272]) {
  await vm.runInContext(`navigator.serviceWorker.ready.then(r => r.showNotification('Private sender', {body:'Private message',data:{type:${type},url:'https://example.test',sender:'private'}}))`, snap.context);
}
assert.equal(snap.events.length, 10, "Snapchat worker notifications must reach the contact bridge");
assert.deepEqual(JSON.parse(JSON.stringify(snap.events[0])), { type: "contact", kind: "message", href: "https://www.snapchat.com/web/" });
assert.deepEqual(JSON.parse(JSON.stringify(snap.events[6])), { type: "contact", kind: "call", href: "https://www.snapchat.com/web/" });
for (const type of [undefined, "201", 0, 207, 210, 220, 240, 1251, 1253, 2000, 1518, 99999]) {
  await vm.runInContext(`navigator.serviceWorker.ready.then(r => r.showNotification('New message', {data:{type:${JSON.stringify(type)}}}))`, snap.context);
}
assert.equal(snap.events.length, 10, "Snaps, typing, reactions, ended calls, suggestions and unknown categories stay silent");
vm.runInContext("window.__vigilWebAlertsAllowed = false", snap.context);
await vm.runInContext("navigator.serviceWorker.ready.then(r => r.showNotification('Message', {data:{type:201}}))", snap.context);
assert.equal(snap.events.length, 10);
await assert.rejects(vm.runInContext("navigator.serviceWorker.ready.then(r => r.pushManager.subscribe())", snap.context), /not configured/u);
assert.equal(await vm.runInContext("navigator.serviceWorker.getRegistrations().then(r => r.length)", snap.context), 0,
  "The compatibility bridge must not install workers or intercept network requests");
console.log("Opt-in notifications, Snapchat worker contact filtering, and private payload isolation passed.");
