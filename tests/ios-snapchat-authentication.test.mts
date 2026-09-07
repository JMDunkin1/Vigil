import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const projectRoot = existsSync(join(runtimeRoot, "ios")) ? runtimeRoot : resolve(runtimeRoot, "..", "..");
const socialDOMAdaptersSource = await readFile(
  join(projectRoot, "ios", "VigilSocial", "VigilSocial", "DOMAdapters.swift"), "utf8"
);
const snapchatAuthenticationGuard = socialDOMAdaptersSource.match(
  /private static func authenticationDocumentGuard[\s\S]*?if service == \.snapchat \{\s*return #"""([\s\S]*?)"""#/u
)?.[1];
assert.ok(snapchatAuthenticationGuard, "Snapchat must protect its authentication documents");
for (const [href, expectedInjection] of [
  ["https://accounts.snapchat.com/v2/login", false],
  ["https://accounts.snapchat.com:443/accounts/login", false],
  ["https://accounts.snapchat.com/accounts/challenge", false],
  ["https://www.snapchat.com/web/", true],
  ["https://web.snapchat.com/", true],
  ["https://www.snapchat.com/spotlight/123", true],
  ["https://accounts.snapchat.com.evil.example/", true],
  ["https://accounts.snapchat.com:444/", true],
  ["http://accounts.snapchat.com/", true]
] as const) {
  const context = { URL, location: { href }, injected: false };
  runInNewContext(snapchatAuthenticationGuard.replace("GUARDED_BODY", "injected = true;"), context);
  assert.equal(context.injected, expectedInjection, href);
}
console.log("Snapchat authentication isolation: 9 cases passed.");
