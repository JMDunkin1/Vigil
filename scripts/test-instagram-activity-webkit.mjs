#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = await readFile(process.argv[2] ? resolve(process.argv[2])
  : join(root, "ios/VigilSocial/VigilSocial/DOMAdapters.swift"), "utf8");
const scriptNames = ["documentIdentityBootstrap", "instagramActivityFeedCompatibility", "instagramOutgoingUnreadCompatibility", "instagramInboxBadgeBootstrap",
  "instagramReferenceSearchGuard", "instagramSingleReelGuard", "instagramStableDocumentStartStyle"];
const script = scriptNames.map(name => {
  const value = source.match(new RegExp(`static let ${name} = #"""([\\s\\S]*?)"""#`, "u"))?.[1];
  assert.ok(value, `Missing production bootstrap ${name}`);
  return value;
}).join("");
const notifications = await readFile(process.argv[3] ? resolve(process.argv[3])
  : join(root, "ios/VigilSocial/VigilSocial/SocialNotifications.swift"), "utf8");
const install = notifications.match(/^ {4}static func install\(on webView: WKWebView,[\s\S]*?^ {4}\}/mu)?.[0];
const permission = notifications.match(/^ {4}static func script\(allowed: Bool\)[\s\S]*?^ {4}\}/mu)?.[0];
assert.ok(install); assert.ok(permission);
// Compile the actual bridge install method against real WKUserContentController.
// Stub only notification delivery/settings, so no account, system permission or
// network traffic is involved. This exercises the native script-list mutation.
const bridge = `
// The old live-array loop can append to the very array it is iterating. Bound
// this fixture's additions so that regression fails without exhausting memory.
@MainActor final class FixtureContentController: WKUserContentController {
  private var additions = 0
  override func addUserScript(_ script: WKUserScript) {
    additions += 1
    guard additions <= 32 else {
      print("FAIL Notification bridge is iterating and appending to WebKit's live script array")
      fflush(stdout)
      exit(1)
    }
    super.addUserScript(script)
  }
}
enum SocialService: String { case instagram }
@MainActor final class SocialNotifications {
  static let shared = SocialNotifications()
  static let supportedServices: [SocialService] = [.instagram]
  func enabled(for service: SocialService) -> Bool { false }
  func register(_ webView: WKWebView, for service: SocialService, permissionScript: WKUserScript,
                policyAllows: @escaping () -> Bool) {}
}
@MainActor final class SocialMessageNotificationBridge: NSObject, WKScriptMessageHandler {
  init(service: SocialService, policyAllows: @escaping () -> Bool) { super.init() }
  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {}
${install}
${permission}
}
`;
let runner = await readFile(join(root, "tests/fixtures/instagram-comments-interaction.swift"), "utf8");
assert.ok(runner.includes("                webView = page"));
assert.ok(runner.includes("                let config = WKWebViewConfiguration()"));
runner = runner.replace("                let config = WKWebViewConfiguration()",
  "                let config = WKWebViewConfiguration()\n                config.userContentController = FixtureContentController()");
runner = runner.replace("                webView = page", `
                SocialMessageNotificationBridge.install(on: page, service: .instagram, policyAllows: { false })
                let scripts = page.configuration.userContentController.userScripts
                guard scripts.count == 3, scripts[2].source == source,
                      scripts[2].injectionTime == .atDocumentStart, scripts[2].isForMainFrameOnly else {
                    print("FAIL Initial notification bridge discarded or changed the protected document-start script")
                    exit(1)
                }
                webView = page`);
runner = runner.replace("import Foundation", "import Foundation\n" + bridge);
// The loader initializes its hook to null and invokes it before resetting
// exports and executing the factory. A consumer may run before lazy waiters.
const loader = `
  window.fixtureWaiters=[];
  window.requireLazy=(names,callback)=>fixtureWaiters.push(callback);
  window.__onBeforeModuleFactory=null;
  window.fixtureRender=()=>{
    const record={id:'PolarisStoryTemplateConfigForSystemEntry',exports:null,
      factory:function(global,dependency,module,exports){
        if(arguments.length!==4||global!==window||dependency!=='dependency'||module.exports!==exports)
          throw new Error('Factory contract changed');
        exports.getItemTemplateConfigForSystemEntry=function(entry){
          if(this!==exports)throw new Error('Renderer receiver changed');
          if(entry.bad)throw new Error('Destination is null for activity feed story');
          return entry;
        };
      }};
    window.__onBeforeModuleFactory?.(record);
    record.exports={};
    record.factory(...[window,'dependency',record,record.exports].slice(0,record.factory.length));
    try{
      window.fixtureRendered=[{id:'before'},{bad:true},{id:'after'}]
        .map(entry=>record.exports.getItemTemplateConfigForSystemEntry(entry));
    }catch(error){window.fixtureError=error.message}
    fixtureWaiters.forEach(callback=>callback(record.exports));
  };
`;
const html = (split, render) => `<!doctype html><html><body><h1>Notifications</h1><script>${loader}
  ${split ? "</script><script>" : ""}${render ? "fixtureRender();" : ""}</script></body></html>`;
const condition = "!window.fixtureError&&JSON.stringify(window.fixtureRendered)==='[{\"id\":\"before\"},null,{\"id\":\"after\"}]'"
  + "&&window.__vigilInstagramActivityFeedCompatibility.installed&&window.__vigilInstagramActivityFeedCompatibility.skipped===1"
  + "&&window.__onBeforeModuleFactory===null";
const scenarios = [
  { name: "Cold Notifications render in the loader's own parser script", documentStart: true,
    path: "/notifications/", html: html(false, true), steps: [{ condition }] },
  { name: "Consumer renders before registered lazy callbacks", documentStart: true,
    path: "/notifications/", html: html(true, true), steps: [{ condition }] },
  { name: "First SPA Notifications visit after the old bootstrap deadline", documentStart: true,
    path: "/direct/inbox/", html: html(false, false), steps: [
      { delay: 16050, condition: "!window.__vigilInstagramActivityFeedCompatibility.installed" },
      { action: "history.pushState({},'', '/notifications/');fixtureRender()", condition }
    ] }
];
const directory = await mkdtemp(join(tmpdir(), "vigil-instagram-activity-"));
try {
  await Promise.all([
    writeFile(join(directory, "guard.js"), script), writeFile(join(directory, "stable.js"), ""),
    writeFile(join(directory, "runner.swift"), runner),
    writeFile(join(directory, "scenarios.json"), JSON.stringify(scenarios))
  ]);
  const executable = join(directory, "activity-test");
  await run("xcrun", ["swiftc", join(directory, "runner.swift"), "-o", executable], { timeout: 60000 });
  const marker = "VIGIL_INSTAGRAM_ACTIVITY_WEBKIT_COMPLETE";
  const result = await run(executable, [directory, marker], { timeout: 60000, maxBuffer: 1024 * 1024 });
  process.stdout.write(result.stdout);
  assert.ok(result.stdout.split(/\r?\n/u).includes(marker));
  await rm(directory, { recursive: true, force: true });
} catch (error) {
  if (error.stdout) process.stderr.write(error.stdout);
  if (error.stderr) process.stderr.write(error.stderr);
  process.stderr.write(`Notifications WebKit artifacts retained at ${directory}\n`);
  throw error;
}
