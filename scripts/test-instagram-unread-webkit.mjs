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
const script = source.match(/static let instagramOutgoingUnreadCompatibility = #"""([\s\S]*?)"""#/u)?.[1];
assert.ok(script);
const html = `<!doctype html><html><body><h1>Fictional inbox</h1>
<script>
window.fixtureSubscriptions=[];
window.requireLazy=(names,callback)=>fixtureSubscriptions.push(callback);
</script>
<script>
window.fixtureData={marked_as_unread:false,last_activity_timestamp_ms:'2000',
 slide_read_receipts:[{participant_fbid:'100',watermark_timestamp_ms:'1000'}],
 __IGDMessagesList_slide_messages_connection:{edges:[
  {node:{id:'new',sender_fbid:'100',timestamp_ms:'2000'}},
  {node:{id:'old',sender_fbid:'200',timestamp_ms:'1000'}}]}};
const fragment={kind:'Fragment',name:'XFBIGDirectViewerThreadIsUnreadResolver_XFBIGDirectViewerThread',
 selections:['marked_as_unread','last_activity_timestamp_ms','slide_read_receipts'].map(name=>({kind:'ScalarField',name}))};
const fragments={readFragment:(selection,key)=>key};
const user={getEIMU:()=> '100'};
const module={client__is_unread(key){const data=fragments.readFragment(fragment,key);
 return data.marked_as_unread===true||Number(data.slide_read_receipts[0].watermark_timestamp_ms)<Number(data.last_activity_timestamp_ms);}};
fixtureSubscriptions.forEach(callback=>callback(module,fragment,fragments,user));
// Compiled query modules capture the export rather than looking it up per call.
window.fixtureResolver=module.client__is_unread;
window.fixtureFirstRender=fixtureResolver(fixtureData);
</script></body></html>`;
const scenarios = [{
  name: "Document-start outgoing unread correction precedes first parser-time query",
  documentStart: true, path: "/direct/inbox/", html, steps: [
    { condition: "fixtureSubscriptions.length===1&&window.__vigilInstagramOutgoingUnreadCompatibility.installed&&fixtureFirstRender===false" },
    { action: "fixtureData.__IGDMessagesList_slide_messages_connection.edges[0].node.sender_fbid='200'",
      condition: "fixtureResolver(fixtureData)===true" },
    { action: "fixtureData.__IGDMessagesList_slide_messages_connection.edges[0].node.sender_fbid='100';fixtureData.marked_as_unread=true",
      condition: "fixtureResolver(fixtureData)===true" },
    { action: "fixtureData.marked_as_unread=false;fixtureData.__IGDMessagesList_slide_messages_connection.edges.splice(1,0,{node:{id:'unseen',sender_fbid:'200',timestamp_ms:'1500'}})",
      condition: "fixtureResolver(fixtureData)===true" },
    { condition: "fixtureData.slide_read_receipts[0].watermark_timestamp_ms==='1000'" }
  ]
}];
const directory = await mkdtemp(join(tmpdir(), "vigil-instagram-unread-"));
try {
  await Promise.all([
    writeFile(join(directory, "guard.js"), script),
    writeFile(join(directory, "stable.js"), ""),
    writeFile(join(directory, "scenarios.json"), JSON.stringify(scenarios))
  ]);
  const executable = join(directory, "unread-test");
  await run("xcrun", ["swiftc", join(root, "tests/fixtures/instagram-comments-interaction.swift"), "-o", executable], { timeout: 60000 });
  const marker = "VIGIL_INSTAGRAM_UNREAD_WEBKIT_COMPLETE";
  const result = await run(executable, [directory, marker], { timeout: 60000, maxBuffer: 1024 * 1024 });
  process.stdout.write(result.stdout);
  assert.ok(result.stdout.split(/\r?\n/u).includes(marker));
  await rm(directory, { recursive: true, force: true });
} catch (error) {
  if (error.stdout) process.stderr.write(error.stdout);
  if (error.stderr) process.stderr.write(error.stderr);
  process.stderr.write(`Unread WebKit artifacts retained at ${directory}\n`);
  throw error;
}
