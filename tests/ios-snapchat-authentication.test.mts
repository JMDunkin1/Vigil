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
  const window = { top: {} };
  const context = { URL, window, location: { href }, injected: false };
  runInNewContext(snapchatAuthenticationGuard.replace("GUARDED_BODY", "injected = true;"), context);
  assert.equal(context.injected, expectedInjection, href);
}
for (const host of ["www.google.com", "recaptcha.google.com", "www.recaptcha.net"]) {
  for (const path of ["api2/anchor", "api2/bframe", "enterprise/anchor", "enterprise/bframe"]) {
    for (const embedded of [true, false]) {
      const window: { top?: unknown } = {};
      window.top = embedded ? {} : window;
      const href = `https://${host}/recaptcha/${path}?k=test-key`;
      const context = { URL, window, location: { href }, injected: false };
      runInNewContext(snapchatAuthenticationGuard.replace("GUARDED_BODY", "injected = true;"), context);
      assert.equal(context.injected, !embedded, `${href} embedded=${embedded}`);
    }
  }
}
for (const href of [
  "https://www.google.com/search?q=test",
  "https://www.google.com/recaptcha/",
  "https://www.google.com/recaptcha/api2/anchor/extra",
  "https://www.google.com/recaptcha/api2/%61nchor",
  "https://www.google.com/recaptcha/api2/anchor%2F..%2F..%2Fsearch",
  "https://www.google.com.evil.example/recaptcha/api2/anchor",
  "https://evil.example/recaptcha/api2/anchor",
  "https://www.google.com:444/recaptcha/api2/anchor",
  "http://www.google.com/recaptcha/api2/anchor",
  "https://user@www.google.com/recaptcha/api2/anchor"
]) {
  const context = { URL, window: { top: {} }, location: { href }, injected: false };
  runInNewContext(snapchatAuthenticationGuard.replace("GUARDED_BODY", "injected = true;"), context);
  assert.equal(context.injected, true, href);
}
console.log("Snapchat authentication isolation: 43 cases passed.");
