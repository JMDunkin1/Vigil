import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultState } from "../src/defaults.js";
import { buildFirewallBlock, buildPfConfBlock, extractManagedFirewallBlock, extractManagedPfConfBlock, firewallDomainSignature, firewallStatus, replaceManagedPfConfBlock } from "../src/firewall.js";
import { buildHostsBlock, extractHostsBlock, hostsBlockMatches, LEGACY_HOSTS_BEGIN, LEGACY_HOSTS_END, parseLaunchAgentPrint, replaceManagedHostsBlock } from "../src/hardening.js";
import { applyNetworkBlock } from "../scripts/apply-hosts.mjs";
import { now } from "./test-helpers.mjs";

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

  const unsafeAnchor = buildFirewallBlock(["unsafe.example"], [
    { domain: "unsafe.example", host: "unsafe.example", address: "127.0.0.1" },
    { domain: "unsafe.example", host: "unsafe.example", address: "::1" },
    { domain: "unsafe.example", host: "unsafe.example", address: "0:0:0:0:0:0:0:1" },
    { domain: "unsafe.example", host: "unsafe.example", address: "0.0.0.0" },
    { domain: "unsafe.example", host: "unsafe.example", address: "::" },
    { domain: "unsafe.example", host: "unsafe.example", address: "0:0:0:0:0:0:0:0" },
    { domain: "unsafe.example", host: "unsafe.example", address: "169.254.10.20" },
    { domain: "unsafe.example", host: "unsafe.example", address: "fe80::1" },
    { domain: "unsafe.example", host: "unsafe.example", address: "10.1.2.3" },
    { domain: "unsafe.example", host: "unsafe.example", address: "192.168.1.2" },
    { domain: "unsafe.example", host: "unsafe.example", address: "239.1.2.3" },
    { domain: "unsafe.example", host: "unsafe.example", address: "fc00::1" },
    { domain: "unsafe.example", host: "unsafe.example", address: "ff02::1" },
    { domain: "unsafe.example", host: "unsafe.example", address: "::ffff:127.0.0.1" },
    { domain: "unsafe.example", host: "unsafe.example", address: "0:0:0:0:0:ffff:127.0.0.1" },
    { domain: "unsafe.example", host: "unsafe.example", address: "93.184.216.34" },
    { domain: "unsafe.example", host: "unsafe.example", address: "2606:2800:220:1:248:1893:25c8:1946" }
  ]);
  assert.doesNotMatch(unsafeAnchor, /block return out quick to 127\.0\.0\.1/);
  assert.doesNotMatch(unsafeAnchor, /block return out quick to ::1/);
  assert.doesNotMatch(unsafeAnchor, /block return out quick to 0:0:0:0:0:0:0:1/);
  assert.doesNotMatch(unsafeAnchor, /block return out quick to 0\.0\.0\.0/);
  assert.doesNotMatch(unsafeAnchor, /block return out quick to ::\n/);
  assert.doesNotMatch(unsafeAnchor, /block return out quick to 0:0:0:0:0:0:0:0/);
  assert.doesNotMatch(unsafeAnchor, /block return out quick to 169\.254\.10\.20/);
  assert.doesNotMatch(unsafeAnchor, /block return out quick to fe80::1/);
  assert.doesNotMatch(unsafeAnchor, /block return out quick to 10\.1\.2\.3/);
  assert.doesNotMatch(unsafeAnchor, /block return out quick to 192\.168\.1\.2/);
  assert.doesNotMatch(unsafeAnchor, /block return out quick to 239\.1\.2\.3/);
  assert.doesNotMatch(unsafeAnchor, /block return out quick to fc00::1/);
  assert.doesNotMatch(unsafeAnchor, /block return out quick to ff02::1/);
  assert.doesNotMatch(unsafeAnchor, /block return out quick to ::ffff:127\.0\.0\.1/);
  assert.doesNotMatch(unsafeAnchor, /block return out quick to 0:0:0:0:0:ffff:127\.0\.0\.1/);
  assert.match(unsafeAnchor, /block return out quick to 93\.184\.216\.34/);
  assert.match(unsafeAnchor, /block return out quick to 2606:2800:220:1:248:1893:25c8:1946/);

  const pfConfBlock = buildPfConfBlock();
  const pfConf = replaceManagedPfConfBlock("anchor \"com.apple/*\"\n", pfConfBlock);
  assert.equal(extractManagedPfConfBlock(pfConf), pfConfBlock);
  assert.match(buildPfConfBlock("/tmp/sentinel-test-anchor"), /from "\/tmp\/sentinel-test-anchor"/);
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
  const wrongPath = await firewallStatus(state, now, { pfConfPath, anchorPath });
  assert.equal(wrongPath.current, false);
  assert.equal(wrongPath.stale, true);
  const tempPfConf = replaceManagedPfConfBlock("anchor \"com.apple/*\"\n", buildPfConfBlock(anchorPath));
  await writeFile(pfConfPath, tempPfConf, "utf8");
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
  const dir = await mkdtemp(join(tmpdir(), "sentinel-apply-hosts-success-"));
  const hostsPath = join(dir, "hosts");
  const pfConfPath = join(dir, "pf.conf");
  const anchorPath = join(dir, "custom.sentinel.block");
  const state = defaultState();
  state.settings.adultBlocklistEnabled = false;
  state.profiles = [{
    id: "default",
    name: "Default focus",
    mode: "blocklist",
    blockedApps: [],
    blockedSites: [],
    blockedUrlPatterns: [],
    allowedApps: [],
    allowedSites: []
  }];
  await writeFile(hostsPath, "127.0.0.1 localhost\n", "utf8");
  await writeFile(pfConfPath, "anchor \"com.apple/*\"\n", "utf8");
  const result = await applyNetworkBlock({
    state,
    hostsPath,
    pfConfPath,
    anchorPath,
    validateAndLoadPf: async () => {},
    flushDns: async () => {}
  });
  const appliedPfConf = await readFile(pfConfPath, "utf8");
  assert.equal(result.status.current, true);
  assert.equal(appliedPfConf.includes(`from "${anchorPath}"`), true);
  assert.doesNotMatch(appliedPfConf, /from "\/etc\/pf\.anchors\/com\.sentinel\.block"/);
  await rm(dir, { recursive: true, force: true });
}

{
  const dir = await mkdtemp(join(tmpdir(), "sentinel-apply-hosts-"));
  const hostsPath = join(dir, "hosts");
  const pfConfPath = join(dir, "pf.conf");
  const anchorPath = join(dir, "com.sentinel.block");
  const originalHosts = "127.0.0.1 localhost\n255.255.255.255 broadcasthost\n";
  const originalPfConf = "anchor \"com.apple/*\"\n";
  const originalAnchor = "# existing sentinel anchor\n";
  const state = defaultState();
  state.settings.adultBlocklistEnabled = false;
  state.profiles = [{
    id: "default",
    name: "Default focus",
    mode: "blocklist",
    blockedApps: [],
    blockedSites: [],
    blockedUrlPatterns: [],
    allowedApps: [],
    allowedSites: []
  }];
  await writeFile(hostsPath, originalHosts, "utf8");
  await writeFile(pfConfPath, originalPfConf, "utf8");
  await writeFile(anchorPath, originalAnchor, "utf8");
  await assert.rejects(
    applyNetworkBlock({
      state,
      hostsPath,
      pfConfPath,
      anchorPath,
      validateAndLoadPf: async () => {
        throw new Error("simulated pf validation failure");
      },
      flushDns: async () => {}
    }),
    /simulated pf validation failure/
  );
  assert.equal(await readFile(hostsPath, "utf8"), originalHosts);
  assert.equal(await readFile(pfConfPath, "utf8"), originalPfConf);
  assert.equal(await readFile(anchorPath, "utf8"), originalAnchor);
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
