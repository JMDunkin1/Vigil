import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const projectRoot = existsSync(join(runtimeRoot, "ios")) ? runtimeRoot : resolve(runtimeRoot, "..", "..");
const source = await readFile(join(projectRoot, "ios/VigilSocial/VigilSocial/DOMAdapters.swift"), "utf8");
const guard = source.match(
  /private static func authenticationDocumentGuard[\s\S]*?if service == \.linkedin \{\s*return #"""([\s\S]*?)"""#/u
)?.[1];
assert.ok(guard);

function runGuard(href: string, embedded = false) {
  const window: { top?: unknown } = {};
  window.top = embedded ? {} : window;
  let tick = () => {};
  let reloads = 0;
  const context = {
    URL, window, location: { href, reload: () => { reloads++; } }, injected: false,
    setInterval: (callback: () => void) => { tick = callback; return 1; },
    clearInterval: () => { tick = () => {}; }, addEventListener: () => {}
  };
  runInNewContext(guard!.replace("GUARDED_BODY", "injected = true;"), context);
  return { context, tick: () => tick(), reloads: () => reloads };
}

for (const path of ["login", "uas/login", "checkpoint/challenge/", "signup", "start", "authwall", "passwordReset/"]) {
  const result = runGuard(`https://www.linkedin.com/${path}`);
  assert.equal(result.context.injected, false, path);
  result.tick();
  assert.equal(result.reloads(), 0, "Do not interrupt authentication");
  result.context.location.href = "https://www.linkedin.com/feed/";
  result.tick();
  result.tick();
  assert.equal(result.reloads(), 1, "A completed SPA login must reload into content protection exactly once");
}
for (const host of ["www.google.com", "recaptcha.google.com", "www.recaptcha.net"]) {
  for (const path of ["api2/anchor", "api2/bframe", "enterprise/anchor", "enterprise/bframe"]) {
    const href = `https://${host}/recaptcha/${path}?k=test-key`;
    assert.equal(runGuard(href, true).context.injected, false, href);
    assert.equal(runGuard(href).context.injected, true, "CAPTCHA exemption must be frame-only");
  }
}
for (const href of [
  "https://www.linkedin.com/feed/", "https://www.linkedin.com/video/",
  "https://www.linkedin.com/login-extra", "https://www.linkedin.com/%6cogin",
  "https://www.linkedin.com.evil.test/login", "https://www.linkedin.com:444/login",
  "http://www.linkedin.com/login", "https://user@www.linkedin.com/login",
  "https://www.google.com/search?q=test", "https://www.google.com/recaptcha/",
  "https://www.google.com/recaptcha/api2/anchor/extra",
  "https://www.google.com/recaptcha/api2/%61nchor",
  "https://www.google.com/recaptcha/api2/anchor%2F..%2F..%2Fsearch",
  "https://www.google.com.evil.test/recaptcha/api2/anchor",
  "https://www.google.com:444/recaptcha/api2/anchor",
  "http://www.google.com/recaptcha/api2/anchor",
  "https://user@www.google.com/recaptcha/api2/anchor"
]) {
  assert.equal(runGuard(href, true).context.injected, true, href);
}
console.log("LinkedIn authentication guards, CAPTCHA isolation, and protected login transition passed.");
