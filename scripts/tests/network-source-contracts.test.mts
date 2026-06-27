import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultState, REQUIRED_EXTENSION_VERSION } from "../../src/defaults.js";
import { buildFirewallBlock, buildPfConfBlock, extractManagedFirewallBlock, extractManagedPfConfBlock, firewallDomainSignature, firewallStatus, replaceManagedPfConfBlock } from "../../src/firewall.js";
import { buildHostsBlock, extractHostsBlock, hostsBlockMatches, LEGACY_HOSTS_BEGIN, LEGACY_HOSTS_END, parseLaunchAgentPrint, replaceManagedHostsBlock } from "../../src/hardening.js";
import { distractionPresets } from "../../src/presets.js";
import { now, recordValue, stringArrayValue } from "./test-helpers.mjs";

{
  const state = defaultState();
  const block = buildHostsBlock(state);
  const hosts = `127.0.0.1 localhost\n\n${block}\n\n255.255.255.255 broadcasthost\n`;
  assert.equal(hostsBlockMatches(extractHostsBlock(hosts), block), true);
  assert.match(block, /0\.0\.0\.0 pornhub\.com/);
  assert.doesNotMatch(block, /0\.0\.0\.0 youtube\.com/);
  assert.equal(hostsBlockMatches(extractHostsBlock(hosts).replace("pornhub.com", "example.com"), block), false);
  const legacyBlock = block
    .replace("# BEGIN SENTINEL", LEGACY_HOSTS_BEGIN)
    .replace("# END SENTINEL", LEGACY_HOSTS_END);
  const legacyHosts = `127.0.0.1 localhost\n\n${legacyBlock}\n\n255.255.255.255 broadcasthost\n`;
  assert.equal(extractHostsBlock(legacyHosts), legacyBlock);
  const migratedHosts = replaceManagedHostsBlock(legacyHosts, block);
  assert.equal(migratedHosts.includes(LEGACY_HOSTS_BEGIN), false);
  assert.equal(hostsBlockMatches(extractHostsBlock(migratedHosts), block), true);
  const duplicateHosts = replaceManagedHostsBlock(`${legacyHosts}\n${block}\n`, block);
  assert.equal((duplicateHosts.match(/# BEGIN SENTINEL/g) || []).length, 1);
  assert.equal(duplicateHosts.includes(LEGACY_HOSTS_BEGIN), false);
  const orphanBeginHosts = replaceManagedHostsBlock(`127.0.0.1 localhost\n\n# BEGIN SENTINEL\n0.0.0.0 stale.example\n\n255.255.255.255 broadcasthost\n`, block);
  assert.equal(hostsBlockMatches(extractHostsBlock(orphanBeginHosts), block), true);
  assert.equal(orphanBeginHosts.includes("stale.example"), false);
  assert.match(orphanBeginHosts, /255\.255\.255\.255 broadcasthost/);
  const orphanEndHosts = replaceManagedHostsBlock(`127.0.0.1 localhost\n\n0.0.0.0 stale.example\n# END SENTINEL\n\n255.255.255.255 broadcasthost\n`, block);
  assert.equal(hostsBlockMatches(extractHostsBlock(orphanEndHosts), block), true);
  assert.equal(orphanEndHosts.includes("stale.example"), false);
  assert.match(orphanEndHosts, /255\.255\.255\.255 broadcasthost/);

  const launch = parseLaunchAgentPrint(`service = enabled
pid = 12345
last exit code = 0
`);
  assert.equal(launch.running, true);
  assert.equal(launch.pid, 12345);
  assert.equal(launch.lastExitStatus, 0);
}

{
  const domains = ["example.com", "news.example"];
  const entries = [
    { domain: "example.com", host: "example.com", address: "93.184.216.34" },
    { domain: "news.example", host: "www.news.example", address: "203.0.113.7" },
    { domain: "duplicate.example", host: "duplicate.example", address: "93.184.216.34" }
  ];
  const anchor = buildFirewallBlock(domains, entries, [{ host: "www.example.com", error: "ENOTFOUND" }]);
  assert.equal(extractManagedFirewallBlock(anchor), anchor);
  assert.match(anchor, /# Domain-Count: 2/);
  assert.match(anchor, /block return out quick to 93\.184\.216\.34/);
  assert.match(anchor, /block return out quick to 203\.0\.113\.7/);
  assert.equal((anchor.match(/block return out quick to 93\.184\.216\.34/g) || []).length, 1);
  assert.match(anchor, new RegExp(firewallDomainSignature(domains)));

  const pfConfBlock = buildPfConfBlock();
  const pfConf = replaceManagedPfConfBlock("anchor \"com.apple/*\"\n", pfConfBlock);
  assert.equal(extractManagedPfConfBlock(pfConf), pfConfBlock);
  const migratedPfConf = replaceManagedPfConfBlock(`${pfConf}\n${pfConfBlock}\n`, pfConfBlock);
  assert.equal((migratedPfConf.match(/# BEGIN SENTINEL PF/g) || []).length, 1);
  const orphanBeginPfConf = replaceManagedPfConfBlock(`anchor "com.apple/*"\n\n# BEGIN SENTINEL PF\nanchor "stale"\n\nload anchor "com.apple" from "/etc/pf.anchors/com.apple"\n`, pfConfBlock);
  assert.equal(extractManagedPfConfBlock(orphanBeginPfConf), pfConfBlock);
  assert.equal(orphanBeginPfConf.includes("stale"), false);
  assert.match(orphanBeginPfConf, /load anchor "com\.apple"/);
  const orphanEndPfConf = replaceManagedPfConfBlock(`anchor "com.apple/*"\n\nanchor "stale"\n# END SENTINEL PF\n\nload anchor "com.apple" from "/etc/pf.anchors/com.apple"\n`, pfConfBlock);
  assert.equal(extractManagedPfConfBlock(orphanEndPfConf), pfConfBlock);
  assert.equal(orphanEndPfConf.includes("stale"), false);
  assert.match(orphanEndPfConf, /load anchor "com\.apple"/);

  const dir = await mkdtemp(join(tmpdir(), "sentinel-firewall-"));
  const pfConfPath = join(dir, "pf.conf");
  const anchorPath = join(dir, "com.sentinel.block");
  const state = defaultState();
  state.settings.adultBlocklistEnabled = false;
  state.profiles = [{
    id: "default",
    name: "Default focus",
    mode: "blocklist",
    blockedApps: [],
    blockedSites: ["example.com"],
    blockedUrlPatterns: [],
    allowedApps: [],
    allowedSites: []
  }];
  await writeFile(pfConfPath, pfConf, "utf8");
  await writeFile(anchorPath, buildFirewallBlock(["example.com"], [entries[0]]), "utf8");
  const current = await firewallStatus(state, now, { pfConfPath, anchorPath });
  assert.equal(current.current, true);
  assert.equal(current.installedEntries, 1);
  await writeFile(anchorPath, buildFirewallBlock(["example.com"]), "utf8");
  const unresolved = await firewallStatus(state, now, { pfConfPath, anchorPath });
  assert.equal(unresolved.current, false);
  assert.equal(unresolved.stale, true);
  assert.equal(unresolved.installedEntries, 0);
  await writeFile(anchorPath, buildFirewallBlock(["example.com"], [entries[0]]), "utf8");
  state.profiles[0].blockedSites = ["changed.example"];
  const stale = await firewallStatus(state, now, { pfConfPath, anchorPath });
  assert.equal(stale.stale, true);
  await rm(dir, { recursive: true, force: true });
}

{
  const state = defaultState();
  state.activeSession = {
    id: "custom-pattern-session",
    title: "Pattern session",
    mode: "focus",
    profileId: "default",
    lockLevel: "deep",
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    canEndEarly: false,
    source: "manual",
    profileSnapshot: {
      ...state.profiles[0],
      mode: "blocklist",
      blockedSites: [],
      hostsUrlPatternBlocking: true,
      blockedUrlPatterns: [
        "example.com/games",
        "https://www.news.example/path?q=1",
        "/reels",
        "casino",
        "localhost/admin"
      ],
      allowedSites: []
    }
  };
  const block = buildHostsBlock(state, now);
  assert.match(block, /0\.0\.0\.0 example\.com/);
  assert.match(block, /0\.0\.0\.0 news\.example/);
  assert.doesNotMatch(block, /casino/);
  assert.doesNotMatch(block, /localhost/);
  assert.doesNotMatch(block, /\/reels/);
}

{
  const serverSource = await readFile(join(process.cwd(), "src", "server.js"), "utf8");
  const sessionRoutesSource = await readFile(join(process.cwd(), "src", "server", "sessionRoutes.js"), "utf8");
  const hardeningRoutesSource = await readFile(join(process.cwd(), "src", "server", "hardeningRoutes.js"), "utf8");
  const hardeningSummarySource = await readFile(join(process.cwd(), "src", "server", "hardeningSummary.js"), "utf8");
  const extensionApiSource = await readFile(join(process.cwd(), "src", "server", "extensionApi.js"), "utf8");
  const localScriptsSource = await readFile(join(process.cwd(), "src", "server", "localScripts.js"), "utf8");
  const statePayloadSource = await readFile(join(process.cwd(), "src", "server", "statePayload.js"), "utf8");
  assert.match(hardeningRoutesSource, /\/api\/hardening\/hosts\/apply/);
  assert.match(localScriptsSource, /with administrator privileges/);
  assert.match(hardeningSummarySource, /npm run seal:source/);
  assert.match(hardeningSummarySource, /extensionLoad/);
  assert.match(sessionRoutesSource, /Brick Mode/);
  assert.match(sessionRoutesSource, /\/api\/panic\/start/);
  assert.match(sessionRoutesSource, /panicLockDurationMinutes/);
  assert.match(hardeningSummarySource, /browser control pages/);
  assert.match(statePayloadSource, /strictPreflightState/);
  assert.match(statePayloadSource, /profileSnapshot: snapshotProfile\(profile\)/);
  assert.match(extensionApiSource, /\/api\/extension\/rules\/sync/);
  assert.match(statePayloadSource, /focusShortcutSummary/);
  assert.match(sessionRoutesSource, /assertIntentReason/);
  assert.doesNotMatch(serverSource, /\/api\/devices\/android|Android|android_settings/);
  const indexSource = await readFile(join(process.cwd(), "public", "index.html"), "utf8");
  assert.match(indexSource, /id="startNormalMode"/);
  assert.match(indexSource, /id="startSoftBlock"/);
  assert.match(indexSource, /id="startFullBrick"/);
  assert.match(indexSource, /data-device-target="computer"/);
  assert.match(indexSource, /data-device-target="phone"/);
  assert.match(indexSource, /Apple Companion Control/);
  assert.doesNotMatch(indexSource, /Android|ADB/);
  assert.match(indexSource, /id="startPanicLock"/);
  assert.match(indexSource, /id="panicLockDurationMinutes"/);
  assert.match(indexSource, /id="focusShortcutEnabled"/);
  assert.match(indexSource, /id="intentReasonEnabled"/);
  assert.match(indexSource, /id="focusSoundEnabled"/);
  const appSource = await readFile(join(process.cwd(), "public", "app.js"), "utf8");
  const appEventsSource = await readFile(join(process.cwd(), "public", "app-events.js"), "utf8");
  const hardeningPanelSource = await readFile(join(process.cwd(), "public", "hardening-panel.js"), "utf8");
  assert.match(appSource, /BRICK_MODE_PROFILE_ID/);
  assert.match(appEventsSource, /\/api\/panic\/start/);
  assert.match(hardeningPanelSource, /saveFocusShortcuts/);
  assert.doesNotMatch(appSource, /Android|android|ADB/);
  assert.match(hardeningPanelSource, /renderIntentReasonHints/);
  assert.doesNotMatch(appSource, /innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
  assert.doesNotMatch(appSource, /createDistanceKeyQrSvg|BarcodeDetector/);
  const distanceKeyUiSource = await readFile(join(process.cwd(), "public", "distance-key-ui.js"), "utf8");
  assert.match(distanceKeyUiSource, /createDistanceKeyQrSvg/);
  assert.match(distanceKeyUiSource, /BarcodeDetector/);
  assert.match(distanceKeyUiSource, /function print/);
  const focusSoundSource = await readFile(join(process.cwd(), "public", "focus-sound.js"), "utf8");
  assert.match(focusSoundSource, /focusSoundPreset/);
  assert.match(focusSoundSource, /createNoiseSource/);
  const qrSource = await readFile(join(process.cwd(), "public", "distance-key-qr.js"), "utf8");
  assert.match(qrSource, /distanceKeyQrMatrix/);
  const extensionSource = await readFile(join(process.cwd(), "extension", "background.js"), "utf8");
  assert.match(extensionSource, /ALLOWLIST_RULE_START/);
  assert.match(extensionSource, /excludedRequestDomains/);
  assert.match(extensionSource, /reportRuleSync/);
  assert.match(extensionSource, /sentinelLocalServer/);
  assert.match(extensionSource, /x-sentinel-extension-token/);
  const extensionManifest = recordValue(JSON.parse(await readFile(join(process.cwd(), "extension", "manifest.json"), "utf8")), "extension manifest");
  assert.equal(extensionManifest.version, REQUIRED_EXTENSION_VERSION);
  assert.equal(extensionManifest.options_page, "options.html");
  const monitorSource = await readFile(join(process.cwd(), "src", "monitor.js"), "utf8");
  assert.match(monitorSource, /blocked_browser_control/);
  const sealSource = await readFile(join(process.cwd(), "src", "seal.js"), "utf8");
  assert.match(sealSource, /rename\(tempPath, sealPath\)/);
  assert.equal(distractionPresets().some((preset) => preset.id === "rehab" && preset.sites.includes("youtube.com")), true);
}

{
  const serverSource = await readFile("src/server.js", "utf8");
  const sessionRoutesSource = await readFile("src/server/sessionRoutes.js", "utf8");
  assert.match(serverSource, /scheduleImmediateSessionEnforcement/);
  assert.match(serverSource, /session_immediate_enforcement/);
  assert.match(sessionRoutesSource, /plannerBlockId/);
  assert.match(sessionRoutesSource, /completeIntentionalPlanBlock/);
  const monitorSource = await readFile("src/monitor.js", "utf8");
  assert.match(monitorSource, /enforceImmediately/);
  assert.match(monitorSource, /lastImmediateEnforcement/);
  assert.match(monitorSource, /enforceSystemSleepLock/);
  assert.match(monitorSource, /lastSystemSleepLock/);
  assert.match(monitorSource, /sweepBlockedProcesses\(now, \{ force: true \}\)/);
  const challengeSource = await readFile("src/challenge.js", "utf8");
  assert.match(challengeSource, /TypingChallengeError/);
  assert.match(challengeSource, /generateChallengeText/);
  const macosSource = await readFile("src/macos.js", "utf8");
  assert.match(macosSource, /CGSession/);
  assert.match(macosSource, /displaysleepnow/);
  assert.match(macosSource, /key code 53/);
  assert.match(macosSource, /window\.location\.replace/);
  assert.match(macosSource, /document\.querySelectorAll\('video,audio'\)/);
}

{
  const manifest = recordValue(JSON.parse(await readFile("extension/manifest.json", "utf8")), "extension manifest");
  assert.equal(stringArrayValue(manifest.permissions, "extension permissions").includes("declarativeNetRequest"), true);
  const background = await readFile("extension/background.js", "utf8");
  assert.match(background, /NOISE_BLOCK_DOMAINS/);
  assert.match(background, /YOUTUBE_AUTOFILL_REQUEST_DOMAINS/);
  assert.match(background, /initiatorDomains: \["youtube\.com"\]/);
  assert.match(background, /SITE_BLOCK_RULE_START/);
  assert.match(background, /CONTENT_BLOCK_RULE_START/);
  assert.match(background, /contentBlockRules/);
  assert.match(background, /syncSiteBlockingFromServer/);
  assert.match(background, /updateDynamicRules/);
  assert.match(background, /deferTabAction/);
  assert.match(background, /DEFAULT_LOCAL_SERVER/);
  const options = await readFile("extension/options.js", "utf8");
  assert.match(options, /sentinelExtensionToken/);
  const content = await readFile("extension/content.js", "utf8");
  assert.match(content, /cleanupBrowserNoise/);
  assert.match(content, /applyYoutubeAutofillFriction/);
  assert.match(content, /teardownYoutubeAutofillFriction/);
  assert.match(content, /browserNoiseBlockingEnabled === false/);
  assert.match(content, /removeAttribute\("data-sentinel-youtube-friction"\)/);
  assert.match(content, /removeEventListener\("focusin", hardenYoutubeSearchFromEvent, true\)/);
  assert.match(content, /data-sentinel-youtube-friction/);
  assert.match(content, /data-sentinel-page-guard/);
  assert.match(content, /location\.replace/);
  const installer = await readFile("scripts/install-launch-agent.mjs", "utf8");
  assert.match(installer, /agent-runner\.mjs/);
}
