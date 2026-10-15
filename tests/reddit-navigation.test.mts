import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

type Rule = { priority: number; action: { type: string; redirect?: { extensionPath: string } }; condition: { regexFilter: string; resourceTypes: string[] } };
const rules: Rule[] = JSON.parse(await readFile(new URL("../extension/reddit-navigation-rules.json", import.meta.url), "utf8"));
const redirects = rules.filter(rule => rule.action.type === "redirect");
const redirected = (url: string) => redirects.some(rule => new RegExp(rule.condition.regexFilter, "i").test(url));

for (const host of ["reddit.com", "www.reddit.com", "old.reddit.com", "new.reddit.com", "np.reddit.com", "m.reddit.com"]) {
  for (const path of ["/", "/?feed=home", "/#home", "/r/reviews", "/r/reviews/", "/r/reviews/?sort=hot", "/r/all/", "/r/popular/", "/search?q=kettle", "/user/person/", "/gallery/abc123", "/over18", "/api/over18"]) {
    assert.equal(redirected(`https://${host}${path}`), true, `${host}${path} must be rejected before any response can become a download`);
  }
  for (const path of ["/comments/abc123/", "/r/reviews/comments/abc123/kettle/", "/r/reviews/comments/abc123/kettle/def456/?context=3"]) {
    assert.equal(redirected(`https://${host}${path}`), false, `${host}${path} must still reach the provenance and content guards`);
  }
}
for (const url of ["https://redd.it/abc123", "https://preview.redditmedia.com/image", "https://www.reddit.com.evil.example/", "https://notreddit.com/", "https://example.com/reddit.com/"]) {
  assert.equal(redirected(url), /\.(?:it|com)\/(?:abc123|image)$/u.test(url), url);
}
for (const rule of rules) {
  assert.deepEqual(rule.condition.resourceTypes, ["main_frame"], "Reddit documents alone are affected; comments, images and media requests retain their native types");
  assert.ok(rule.priority < 80, "navigation handling must remain below active allowlist, content and site enforcement");
  assert.notEqual(rule.action.type, "allow", "avoiding downloads cannot grant access or exempt a thread from stronger rules");
}
for (const rule of redirects) assert.equal(rule.action.redirect?.extensionPath, "/reddit-review-blocked.html");

for (const query of ["?js_challenge=1", "?solution=opaque&js_challenge=1&jsc_token=opaque", "?js_challenge=1&sort=top"]) {
  assert.equal(redirected("https://www.reddit.com/r/reviews/comments/abc123/kettle/" + query), true, "automatic verification redirects are blocked before Safari can turn them into downloads");
}
assert.equal(redirected("https://www.reddit.com/r/reviews/comments/abc123/kettle/?sort=top"), false);
assert.equal(redirected("https://www.reddit.com.evil.example/?js_challenge=1"), false);
const page = await readFile(new URL("../extension/reddit-review-blocked.html", import.meta.url), "utf8");
assert.match(page, /<h1>Blocked<\/h1>/u);
assert.match(page, />Back<\/a>/u);
assert.doesNotMatch(page, /data-vigil-quiet-return/u, "a failed Reddit document must have a clear block instead of a blank page or an automatic return loop");
const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const projectRoot = basename(runtimeRoot) === "runtime" ? dirname(dirname(runtimeRoot)) : runtimeRoot;
for (const path of [join(runtimeRoot, "extension/manifest.json"), join(projectRoot, "ios/VigilSocial/VigilYouTubeInteractionExtension/Resources/manifest.json")]) {
  const manifest = JSON.parse(await readFile(path, "utf8"));
  assert.ok(manifest.permissions.includes("declarativeNetRequest"));
  assert.ok(manifest.declarative_net_request.rule_resources.some((entry: { id: string; enabled: boolean; path: string }) => entry.id === "vigil_reddit_navigation" && entry.enabled && entry.path === "reddit-navigation-rules.json"));
}
console.log("Reddit request routing, download rejection, policy precedence and browser packaging passed.");
