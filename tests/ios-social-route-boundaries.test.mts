import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

if (process.platform === "darwin") {
  const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const projectRoot = existsSync(join(runtimeRoot, "ios")) ? runtimeRoot : dirname(dirname(runtimeRoot));
  const directory = await mkdtemp(join(tmpdir(), "vigil-social-route-boundaries-"));
  try {
    const main = join(directory, "main.swift");
    await writeFile(main, `import Foundation
let services: [(SocialService, String)] = [(.instagram, "www.instagram.com"), (.youtube, "m.youtube.com"), (.linkedin, "www.linkedin.com"), (.snapchat, "www.snapchat.com")]
var checked = 0
for (service, host) in services {
    let rejected = ["/foo/../shorts/abc", "/foo/%2e%2e/shorts/abc", "/foo/%252e%252e/shorts/abc", "//shorts/abc", "/shorts%2fabc", "/shorts%252fabc", "/shorts%25252fabc", "/shorts%5cabc", "/shorts%255cabc", "/%2573horts/abc", "/%2576ideo/abc", "/%2573potlight/abc"]
    for path in rejected {
        let url = URL(string: "https://" + host + path)!
        precondition(!service.allowsNavigation(to: url), "Ambiguous route accepted: " + url.absoluteString)
        precondition(!service.allowsEmbeddedNavigation(to: url), "Ambiguous frame route accepted: " + url.absoluteString)
        precondition(SocialIncomingLink(url) == nil, "Ambiguous incoming link accepted: " + url.absoluteString)
        checked += 1
    }
    precondition(!service.allowsNavigation(to: URL(string: "https://user:password@" + host + "/")!), "Userinfo accepted")
    precondition(service.allowsNavigation(to: service.homeURL), "Home route denied")
    precondition(service.allowsNavigation(to: URL(string: "https://" + host + "/name-%C3%A9")!), "Ordinary Unicode name denied")
    precondition(service.allowsNavigation(to: URL(string: "https://" + host + "/?opaque=%252Fxxx%252e&return=%2Ffoo%2F..%2Fshorts")!), "Tracking/auth query altered the route decision")
}
let signIn = URL(string: "https://accounts.google.com/v3/signin/identifier?continue=https%3A%2F%2Fwww.youtube.com%2F%3Fv%3Dabc")!
precondition(SocialService.youtube.allowsNavigation(to: signIn), "YouTube sign-in query denied")
let snapSignIn = SnapchatWebCompatibility.loginURL
precondition(SocialService.snapchat.allowsNavigation(to: snapSignIn), "Snapchat sign-in query denied")
for url in ["https://m.youtube.com/shorts/abc", "https://www.linkedin.com/feed/immersive/abc", "https://www.snapchat.com/spotlight/abc"] {
    let destination = URL(string: url)!
    precondition(SocialService.resolve(destination)!.isRestrictedSurface(destination), "Canonical restricted route escaped")
}
print("\\(checked) native ambiguous-route probes passed; ordinary names, opaque query fields, authentication and canonical restrictions retained.")
`);
    const execute = promisify(execFile);
    const executable = join(directory, "routes");
    await execute("/usr/bin/xcrun", ["swiftc", "-O", join(projectRoot, "ios/VigilSocial/VigilSocial/SocialService.swift"), main, "-o", executable], { timeout: 60_000 });
    const result = await execute(executable, [], { timeout: 30_000 });
    assert.match(result.stdout, /48 native ambiguous-route probes passed/);
    console.log(result.stdout.trim());
  } finally { await rm(directory, { recursive: true, force: true }); }
}
