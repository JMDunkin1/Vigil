import assert from "node:assert/strict";
import { defaultState } from "../src/defaults.js";
import { blockedPage } from "../src/server/pages.js";
import { blockPageDiagnostic } from "../src/blockPageDiagnostics.js";

const state = defaultState();
const connectionPage = blockedPage({
  url: new URL("http://127.0.0.1:8787/blocked?site=Browser+protection+connection+interrupted&kind=browser-protection"),
  state
});
assert.match(connectionPage, /<h1>Blocked<\/h1>/u);
assert.match(connectionPage, /href="about:blank">Back<\/a>/u);
assert.match(connectionPage, /class="reason" hidden/u);
assert.match(connectionPage, /V1-MAC-CONNECTION-[A-F0-9]{8}/u);
const details = JSON.parse(connectionPage.match(/id="vigilBlockDetails" type="application\/json">([\s\S]*?)<\/script>/u)![1]);
assert.equal(details.kind, "browser-protection");
assert.match(details.detail, /The extension may still be enabled/u);
assert.doesNotMatch(connectionPage.match(/<h1>[\s\S]*?<\/h1>/u)![0], /connection|Vigil|site/iu);
const a = blockPageDiagnostic({ source: "MAC", kind: "limit", target: "example.com", policyId: "rule-1" });
assert.equal(a.reference, blockPageDiagnostic({ source: "MAC", kind: "limit", target: "example.com", policyId: "rule-1" }).reference);
assert.notEqual(a.reference, blockPageDiagnostic({ source: "MAC", kind: "limit", target: "other.example", policyId: "rule-1" }).reference);
assert.notEqual(a.reference, blockPageDiagnostic({ source: "MAC", kind: "limit", target: "example.com", policyId: "rule-2" }).reference);
const hostilePage = blockedPage({ url: new URL("http://127.0.0.1:8787/blocked?kind=limit&site=" + encodeURIComponent('</script><img src=x onerror=alert(1)>')), state });
assert.doesNotMatch(hostilePage, /<img src=x/u);
assert.match(hostilePage, /\\u003c/u, "hidden diagnostics must remain safe JSON rather than executable page content");
