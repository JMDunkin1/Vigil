import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext, Script } from "node:vm";
import { spawnSync } from "node:child_process";

const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const projectRoot = existsSync(join(runtimeRoot, "ios")) ? runtimeRoot : resolve(runtimeRoot, "..", "..");
const [services, adapters, store] = await Promise.all([
  readFile(join(projectRoot, "ios/VigilSocial/VigilSocial/SocialService.swift"), "utf8"),
  readFile(join(projectRoot, "ios/VigilSocial/VigilSocial/DOMAdapters.swift"), "utf8"),
  readFile(join(projectRoot, "ios/VigilSocial/VigilSocial/SocialWebViewStore.swift"), "utf8")
]);
assert.match(store, /static func shouldHandoffContentLink[\s\S]*?guard !service\.allowsNavigation\(to: url\), let link = SocialIncomingLink\(url\)[\s\S]*?return link\.service != service/u,
  "Adding Facebook must preserve permitted first-party authentication before considering a cross-service handoff");
assert.equal((store.match(/Self\.shouldHandoffContentLink\(from: (?:service|currentService), to: url\)/gu) || []).length, 2,
  "both ordinary navigation and popup handoffs must preserve Instagram Facebook authentication");
const configurationSource = services.match(/static let configurationJSON = #"""\n([\s\S]*?)\n    """#/u)?.[1];
const factory = adapters.match(/private static let focusedSocialPolicyFactory = #"""\n([\s\S]*?)\n    """#/u)?.[1];
const template = adapters.match(/private static let focusedSocialAdapter = #"""\n([\s\S]*?)\n    """#/u)?.[1];
const rootRegistry = adapters.match(/private static let rootRegistryFactory = #"""\n([\s\S]*?)\n    """#/u)?.[1];
assert.ok(configurationSource && factory && template && rootRegistry);
type Configuration = { hosts: string[]; homeURL: string; installationFlag: string; authentication: string[]; allowed: string[]; restricted: string[]; concealed: string[]; controlLabels: string[] };
const configurations = JSON.parse(configurationSource) as Record<string, Configuration>;
assert.deepEqual(Object.keys(configurations), ["facebook", "x", "tiktok", "reddit"]);
type RoutePolicy = { route: (value: string) => "content" | "authentication" | "blocked" };
const makePolicy = runInNewContext(factory, { URL, location: { href: "https://www.reddit.com/message/inbox/" } }) as (configuration: Configuration) => RoutePolicy;
const examples: Record<string, { content: string[]; auth: string[]; blocked: string[] }> = {
  facebook: {
    content: ["/messages/", "/messages/t/123", "/composer/", "/alice", "/alice/posts/123", "/profile.php?id=123", "/photo.php?fbid=123", "/groups/gardening", "/groups/gardening/posts/123"],
    auth: ["/login/", "/login.php", "/checkpoint/challenge/", "/recover/initiate", "/dialog/oauth"],
    blocked: ["/", "/watch", "/reels/123", "/marketplace", "/friends/suggestions", "/friends", "/groups", "/search", "/l.php?u=https://evil.test", "/unknown/feed/route"]
  },
  x: {
    content: ["/messages", "/messages/123", "/i/chat/123", "/compose/post", "/alice", "/alice/status/123", "/alice/status/123/video/1", "/alice/following", "/notifications", "/search?q=gardening&f=user"],
    auth: ["/i/flow/login", "/account/access", "/i/flow/password_reset", "/login"],
    blocked: ["/", "/home", "/explore", "/i/videos", "/i/immersive", "/i/trends", "/i/connect_people", "/grok", "/hashtag/trending", "/unknown/path"]
  },
  tiktok: {
    content: ["/messages", "/inbox", "/upload", "/creator-center/upload", "/tiktokstudio/upload?from=creator_center", "/@gardening", "/@gardening/video/123456789", "/@gardening/photo/123456789", "/search/user?q=gardening"],
    auth: ["/login", "/login/phone-or-email/email", "/signup", "/verify"],
    blocked: ["/", "/foryou", "/following", "/friends", "/explore", "/live", "/music/123", "/tag/gardening", "/embed/123", "/t/abcdefg", "/search", "/tiktokstudio/explore", "/unknown/path"]
  },
  reddit: {
    content: ["/message/inbox/", "/chat", "/submit", "/r/gardening/submit", "/r/gardening", "/r/gardening/new", "/r/gardening/comments/abc123/example/", "/r/gardening/comments/abc123/example/def456", "/user/gardener", "/user/gardener/saved", "/search?q=gardening"],
    auth: ["/login/", "/register", "/password", "/account/login", "/auth/redirect", "/api/v1/authorize"],
    blocked: ["/", "/r/all", "/r/popular", "/r/random", "/r/randnsfw", "/popular", "/best", "/watch", "/videos", "/over18", "/api/over18", "/unknown/path"]
  }
};
const nativeCases: Array<[string, string, string]> = [];
for (const [service, configuration] of Object.entries(configurations)) {
  const policy = makePolicy(configuration);
  new Script(template.replace("FOCUSED_POLICY_FACTORY", factory)
    .replace("FOCUSED_POLICY_CONFIGURATION", JSON.stringify(configuration))
    .replace("FOCUSED_SERVICE", service).replace("ROOT_REGISTRY_FACTORY", rootRegistry));
  for (const host of configuration.hosts) {
    for (const [kind, paths] of Object.entries(examples[service]!)) {
      for (const path of paths) {
        const url = `https://${host}${path}`;
        const expected = kind === "auth" ? "authentication" : kind === "content" ? "content" : "blocked";
        assert.equal(policy.route(url), expected, `${service}: ${url}`);
        nativeCases.push([service, url, expected]);
      }
    }
  }
  assert.equal(policy.route(configuration.homeURL), "content", `${service} home must remain focused and usable`);
  const origin = new URL(configuration.homeURL).origin;
  const homePath = new URL(configuration.homeURL).pathname;
  for (const url of [
    `http://${new URL(origin).host}${homePath}`, `${origin}:444${homePath}`,
    origin.replace("https://", "https://user:password@") + homePath,
    `${origin}.evil.test${homePath}`, `${origin}/%6dessages`, `${origin}/messages%2F..%2Fhome`,
    `${origin}/messages/../explore`, `https://evil.test${homePath}`, `javascript:alert(1)`
  ]) {
    assert.equal(policy.route(url), "blocked", url);
    nativeCases.push([service, url, "blocked"]);
  }
}

// The same-document authentication exception must stop at login completion,
// and embedded CAPTCHA documents must never become a main-frame exception.
const authTemplate = adapters.match(/if let policy = service\.focusedRoutePolicy \{\s*return #"""([\s\S]*?)"""#/u)?.[1];
assert.ok(authTemplate);
function runGuard(service: string, href: string, embedded = false) {
  const window: { top?: unknown } = {};
  window.top = embedded ? {} : window;
  let interval = () => {};
  let reloads = 0;
  const attributes = new Map<string, string>();
  const context = {
    URL, window, location: { href, reload: () => { reloads++; } }, injected: false,
    document: { createElement: () => ({ textContent: "" }), documentElement: {
      appendChild: () => {}, setAttribute: (key: string, value: string) => attributes.set(key, value)
    } }, history: { pushState: () => {}, replaceState: () => {} },
    setInterval: (callback: () => void) => { interval = callback; return 1; },
    clearInterval: () => { interval = () => {}; }, addEventListener: () => {}
  };
  runInNewContext(authTemplate!.replace("FOCUSED_POLICY_FACTORY", factory!)
    .replace("FOCUSED_POLICY_CONFIGURATION", JSON.stringify(configurations[service]))
    .replace("GUARDED_BODY", "injected = true;"), context);
  return { context, tick: () => interval(), reloads: () => reloads, attributes };
}
for (const [service, example] of Object.entries(examples)) {
  const configuration = configurations[service]!;
  for (const path of example.auth) {
    const result = runGuard(service, new URL(path, configuration.homeURL).href);
    assert.equal(result.context.injected, false, path);
    result.tick();
    assert.equal(result.reloads(), 0);
    result.context.location.href = configuration.homeURL;
    result.tick(); result.tick();
    assert.equal(result.reloads(), 1, "Complete login through one protected-document reload");
    assert.equal(result.attributes.get("data-vigil-focused-auth-transition"), "true", "Conceal completed auth before protected reload");
  }
  assert.equal(runGuard(service, configuration.homeURL).context.injected, true);
  for (const href of ["https://www.google.com/recaptcha/api2/anchor", "https://www.recaptcha.net/recaptcha/enterprise/bframe"]) {
    assert.equal(runGuard(service, href, true).context.injected, false);
    assert.equal(runGuard(service, href).context.injected, true);
  }
}

// A hidden WebKit document must continue the existing classification queue.
// A pending foreground frame is transferred once, rather than leaving the
// scheduled flag set while requestAnimationFrame is suspended by iOS.
const schedulingStart = adapters.indexOf("            let mediaObserver = null;");
const schedulingEnd = adapters.indexOf("            const queueMedia =", schedulingStart);
assert.ok(schedulingStart >= 0 && schedulingEnd > schedulingStart);
const scheduling = adapters.slice(schedulingStart, schedulingEnd);
for (const initiallyHidden of [false, true]) {
  let frame: (() => void) | null = null;
  const timers: Array<() => void> = [];
  let visibilityChanged = () => {};
  let cancellations = 0;
  const document = {
    visibilityState: initiallyHidden ? "hidden" : "visible",
    addEventListener: (_: string, callback: () => void) => { visibilityChanged = callback; }
  };
  const context = {
    document, requestAnimationFrame: (callback: () => void) => { frame = callback; return 1; },
    cancelAnimationFrame: () => { cancellations++; }, setTimeout: (callback: () => void) => { timers.push(callback); },
    activeMediaRequests: 0, maximumConcurrentMedia: 1, pendingMedia: new Set(),
    mediaWorkScheduled: false, schedule: () => {},
    HTMLImageElement: class {}, HTMLVideoElement: class {},
    mediaCaptureKind: () => null, submitMedia: () => {}
  };
  runInNewContext(scheduling + "\nschedule = scheduleMediaWork;", context);
  context.schedule();
  assert.equal(context.mediaWorkScheduled, true);
  if (initiallyHidden) {
    assert.equal(frame, null, "Hidden queue must not depend on an animation frame");
  } else {
    assert.equal(timers.length, 0, "Foreground scheduling stays on animation frames");
    document.visibilityState = "hidden";
    visibilityChanged(); visibilityChanged();
    assert.equal(cancellations, 1, "Transfer the pending frame exactly once");
  }
  assert.equal(timers.length, 1);
  timers.shift()!();
  assert.equal(context.mediaWorkScheduled, false);
}

if (process.platform === "darwin") {
  // Execute the actual Swift policy, including URL parsing, service resolution,
  // embedded-auth confinement, deep links, and the native single-video guard.
  const temporary = await mkdtemp(join(tmpdir(), "vigil-expanded-native-"));
  try {
    const encodedCases = nativeCases.map(([service, url, expected]) => `[${JSON.stringify(service)}, ${JSON.stringify(url)}, ${JSON.stringify(expected)}]`).join(",\n");
    await writeFile(join(temporary, "main.swift"), `import Foundation
let cases = [${encodedCases}]
for test in cases {
  let service = SocialService(rawValue: test[0])!
  let url = URL(string: test[1])!
  let observed = service.usesUnmodifiedAuthenticationDocument(url) ? "authentication" : (!service.isRestrictedSurface(url) ? "content" : "blocked")
  precondition(observed == test[2], "Native route mismatch: \\(test[1]) expected \\(test[2]) got \\(observed)")
  if test[2] != "blocked" { precondition(SocialService.resolve(url) == service) }
  precondition((SocialIncomingLink(url) != nil) == (test[2] != "blocked"))
}
for service in [SocialService.facebook, .x, .tiktok, .reddit] {
  precondition(service.postingURL != nil && !service.isRestrictedSurface(service.postingURL!))
  let captcha = URL(string: "https://www.google.com/recaptcha/api2/anchor")!
  precondition(!service.allowsEmbeddedNavigation(to: captcha))
  precondition(!service.allowsEmbeddedNavigation(to: captcha, mainDocumentURL: service.homeURL))
  let login = URL(string: cases.first { $0[0] == service.rawValue && $0[2] == "authentication" }![1])!
  precondition(service.allowsEmbeddedNavigation(to: captcha, mainDocumentURL: login))
}
let facebookLogin = URL(string: "https://www.facebook.com/login.php")!
precondition(SocialService.resolve(facebookLogin) == .facebook)
precondition(SocialService.instagram.allowsNavigation(to: facebookLogin) && SocialService.instagram.usesUnmodifiedAuthenticationDocument(facebookLogin))
precondition(SocialService.instagram.postingURL == nil && SocialService.youtube.postingURL == nil && SocialService.snapchat.postingURL == nil)
precondition(SocialService.linkedin.postingURL?.host == "www.linkedin.com")
let item = URL(string: "https://www.tiktok.com/@gardening/video/123")!
precondition(TikTokSingleItemPolicy.blocksNavigation(from: item, to: URL(string: "https://www.tiktok.com/@gardening/video/456")!))
precondition(!TikTokSingleItemPolicy.blocksNavigation(from: item, to: URL(string: "https://www.tiktok.com/@gardening")!))
print("Native expanded-service route, compose, deep-link and auth isolation passed.")
`);
    const executable = join(temporary, "routes");
    const compile = spawnSync("swiftc", [join(projectRoot, "ios/VigilSocial/VigilSocial/SocialService.swift"), join(temporary, "main.swift"), "-o", executable], { encoding: "utf8", timeout: 60_000 });
    assert.equal(compile.status, 0, compile.stderr);
    const result = spawnSync(executable, [], { encoding: "utf8", timeout: 15_000 });
    assert.equal(result.status, 0, result.stderr);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
console.log("Expanded-service native/SPA route parity, auth transition, focused composers, strict origins and script syntax passed.");
