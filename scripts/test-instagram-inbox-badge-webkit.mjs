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
const source = await readFile(join(root, "ios/VigilSocial/VigilSocial/DOMAdapters.swift"), "utf8");
const script = source.match(/static let instagramInboxBadgeBootstrap = #"""([\s\S]*?)"""#/u)?.[1];
assert.ok(script);
let runner = await readFile(join(root, "tests/fixtures/instagram-comments-interaction.swift"), "utf8");
// Keep a visible WebKit document for foreground eligibility, with an invisible,
// non-key window offscreen so the regression never steals the user's focus.
assert.ok(runner.includes("window.orderFrontRegardless()"));
runner = runner.replace("window.orderFrontRegardless()", `window.alphaValue = 0
                window.setFrameOrigin(NSPoint(x: -12000, y: -12000))
                window.orderBack(nil)`);

const html = (count, delay = 0) => `<!doctype html><html><body>
<nav><a href="/direct/inbox/" aria-label="Messages">Messages<span id="badge"></span></a></nav>
<script>
window.fixtureRequests=0;
window.fixtureThreads=[
  {unread:${count > 0},muted:false},{unread:${count > 1},muted:false},
  {unread:true,muted:true},{unread:false,muted:false}];
window.fixtureMailbox=null;
const render=()=>{document.querySelector('#badge').textContent=fixtureMailbox
  ?String(fixtureMailbox.filter(thread=>thread.unread&&!thread.muted).length)||'':'';
  if(document.querySelector('#badge').textContent==='0')document.querySelector('#badge').textContent='';};
render();
const environment={};
const query={kind:'Request',params:{name:'IGDBadgeCountOffMsysQuery',operationKind:'query'},operation:{},fragment:{}};
const modules={
  CometRelay:{fetchQuery(env,operation,variables,options){
    if(env!==environment||operation!==query||variables.device_id_for_iris_subscription!=='site-device'
        ||options.fetchPolicy!=='network-only')throw Error('Changed native query');
    fixtureRequests++;
    return {subscribe(observer){let cancelled=false;
      observer.start({unsubscribe(){cancelled=true}});
      setTimeout(()=>{if(cancelled)return;
        fixtureMailbox=fixtureThreads;render();observer.complete();},20);
    }};
  }},
  PolarisRelayEnvironment:{default:environment},
  'IGDBadgeCountOffMsysQuery.graphql':query,
  IGDMqttWebDeviceID:{clientId:'site-device'},CurrentUser:{isLoggedIn:()=>true}};
// Runtime arrival is deliberately later than document-start injection. The
// badge has already rendered empty, and nobody navigates to the inbox.
setTimeout(()=>{window.require=name=>name==='Bootloader'
  ?{loadModules(names,callback){setTimeout(()=>callback(...names.map(name=>modules[name])),10)}}
  :null;},${delay});
</script></body></html>`;
const scenarios = [
  { name: "Cold Home shows two unread DMs without visiting Messages", documentStart: true,
    path: "/", html: html(2), steps: [
      { condition: "document.querySelector('#badge').textContent==='2'&&fixtureRequests===1&&location.pathname==='/'&&window.__vigilInstagramInboxBadgeBootstrap.status==='ready'" },
      { action: "dispatchEvent(new Event('online'));dispatchEvent(new Event('pageshow'))",
        condition: "fixtureRequests===1" }
    ] },
  { name: "A signed-in Home with no unread DMs keeps the badge empty", documentStart: true,
    path: "/", html: html(0), steps: [
      { condition: "window.__vigilInstagramInboxBadgeBootstrap.status==='ready'&&fixtureRequests===1&&document.querySelector('#badge').textContent===''&&location.pathname==='/'" }
    ] },
  { name: "A slow startup loads the real badge modules without an inbox click", documentStart: true,
    path: "/", html: html(2, 1250), steps: [
      { condition: "document.querySelector('#badge').textContent==='2'&&fixtureRequests===1" }
    ] }
];
const directory = await mkdtemp(join(tmpdir(), "vigil-instagram-inbox-badge-"));
try {
  await Promise.all([
    writeFile(join(directory, "guard.js"), script), writeFile(join(directory, "stable.js"), ""),
    writeFile(join(directory, "runner.swift"), runner),
    writeFile(join(directory, "scenarios.json"), JSON.stringify(scenarios))
  ]);
  const executable = join(directory, "inbox-badge-test");
  await run("xcrun", ["swiftc", join(directory, "runner.swift"), "-o", executable], { timeout: 60000 });
  const marker = "VIGIL_INSTAGRAM_INBOX_BADGE_WEBKIT_COMPLETE";
  const result = await run(executable, [directory, marker], { timeout: 60000, maxBuffer: 1024 * 1024 });
  process.stdout.write(result.stdout);
  assert.ok(result.stdout.split(/\r?\n/u).includes(marker));
  await rm(directory, { recursive: true, force: true });
} catch (error) {
  if (error.stdout) process.stderr.write(error.stdout);
  if (error.stderr) process.stderr.write(error.stderr);
  process.stderr.write(`Inbox badge WebKit artifacts retained at ${directory}\n`);
  throw error;
}
