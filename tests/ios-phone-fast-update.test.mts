import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ensurePhoneRuntime, phoneBuildCacheRoot, phoneUpdateIsCurrent, serviceLaunchReceiptMatches, withStablePhoneSources } from "../scripts/ios-phone-update-cache.mjs";
import { terminalCommand, updateFailureHelp } from "../scripts/vigil.mjs";
import { installVigilCommand } from "../scripts/install-vigil-cli.mjs";

const root = await mkdtemp(join(tmpdir(), "vigil-fast-update-"));
try {
  await mkdir(join(root, "src"));
  await mkdir(join(root, "dist", "runtime", "src"), { recursive: true });
  const source = join(root, "src", "policy.ts"), compiled = join(root, "dist", "runtime", "src", "policy.js");
  await writeFile(source, "deny A");
  let builds = 0;
  const build = async () => { builds++; await writeFile(compiled, await readFile(source)); };
  assert.equal((await ensurePhoneRuntime(root, build)).reused, false);
  assert.equal((await ensurePhoneRuntime(root, build)).reused, true);
  assert.equal(builds, 1);
  const old = await stat(source);
  await writeFile(source, "deny B"); await utimes(source, old.atime, old.mtime);
  assert.equal((await ensurePhoneRuntime(root, build)).reused, false, "same-size/mtime policy edits must not reuse stale compiled policy");
  await writeFile(compiled, "tampered");
  assert.equal((await ensurePhoneRuntime(root, build)).reused, false, "compiled-output integrity is checked too");
  await rm(compiled);
  assert.equal((await ensurePhoneRuntime(root, build)).reused, false, "missing compiled output must rebuild");
  await ensurePhoneRuntime(root, async () => { throw new Error("Unexpected build"); });
  await writeFile(source, "deny C");
  await assert.rejects(ensurePhoneRuntime(root, async () => { throw new Error("Compiler failed"); }), /Compiler failed/);
  await ensurePhoneRuntime(root, build);
  await writeFile(source, "deny D");
  await ensurePhoneRuntime(root, async () => { await build(); await writeFile(source, "deny E"); });
  assert.equal((await ensurePhoneRuntime(root, build)).reused, false, "concurrent edits cannot be stamped as consumed by the compiler");

  const cache = phoneBuildCacheRoot(root, "personal", "/home/test");
  assert.ok(cache.startsWith("/home/test/Library/Caches/Vigil/phone-builds/"));
  assert.equal(phoneBuildCacheRoot(root, "personal", "/home/test"), cache);
  assert.notEqual(phoneBuildCacheRoot(root + "other", "personal", "/home/test"), cache);
  assert.notEqual(phoneBuildCacheRoot(root, "enhanced", "/home/test"), cache);
  assert.throws(() => phoneBuildCacheRoot(root, "../outside"));

  const hash = "current-source", policy = "exact-current-policy";
  const report = {
    edition: "personal", problems: [], profileVerification: { available: true }, lockProfile: {},
    serverState: { state: { deviceControls: { ios: { enabled: true } } } }, device: { udid: "phone-1" },
    livePolicyFingerprint: policy, fingerprint: { hash }, release: { sourceFingerprint: hash },
    receipt: { edition: "personal", socialContainer: true, device: { udid: "phone-1" }, policyFingerprint: policy,
      release: { sourceFingerprint: hash }, notificationPushEnvironment: "off",
      serviceLaunches: ["instagram", "youtube", "snapchat", "linkedin", "facebook", "x", "tiktok", "reddit"].map(service => ({ service, verifiedAt: "2026-11-01T19:00:00Z" })) }
  };
  const options = { pushNotifications: "off" };
  assert.equal(phoneUpdateIsCurrent(report, options), true);
  for (const changed of [
    { ...report, problems: ["signing expired"] },
    { ...report, edition: "enhanced" },
    { ...report, receipt: null },
    { ...report, profileVerification: { available: false } },
    { ...report, lockProfile: null },
    { ...report, livePolicyFingerprint: "different-policy" },
    { ...report, device: { udid: "other-phone" } },
    { ...report, fingerprint: { hash: "changed-source" } },
    { ...report, serverState: { state: { deviceControls: { ios: { enabled: false } } } } },
    { ...report, receipt: { ...report.receipt, socialContainer: false } },
    { ...report, receipt: { ...report.receipt, serviceLaunches: report.receipt.serviceLaunches.slice(0, 3) } }
  ]) assert.equal(phoneUpdateIsCurrent(changed, options), false, "fast completion requires the entire verified app-and-policy transaction");
  assert.equal(phoneUpdateIsCurrent(report, { ...options, force: true }), false);
  assert.equal(phoneUpdateIsCurrent(report, { ...options, replaceLegacy: true }), false);
  assert.equal(phoneUpdateIsCurrent(report, { pushNotifications: "development" }), false);

  const started = Date.parse("2026-11-01T19:00:00Z");
  const selection = { combined: true, service: "snapchat", selectedAt: new Date(started).toISOString() };
  const access = { service: "snapchat", accessConfirmed: true, checkedAt: new Date(started).toISOString() };
  assert.equal(serviceLaunchReceiptMatches(selection, access, "snapchat", started), true);
  assert.equal(serviceLaunchReceiptMatches(selection, { ...access, accessConfirmed: false }, "snapchat", started), false);
  assert.equal(serviceLaunchReceiptMatches(selection, access, "youtube", started), false);
  assert.equal(serviceLaunchReceiptMatches({ ...selection, combined: false }, access, "snapchat", started), false);
  assert.equal(serviceLaunchReceiptMatches(selection, { ...access, checkedAt: new Date(started - 1001).toISOString() }, "snapchat", started), false);
  assert.equal(serviceLaunchReceiptMatches({ ...selection, selectedAt: "invalid" }, access, "snapchat", started), false);

  let transactions = 0, retries = 0;
  assert.equal(await withStablePhoneSources(async () => {
    if (++transactions < 3) throw Object.assign(new Error("Edited during build"), { code: "VIGIL_PHONE_SOURCES_CHANGED" });
    return "verified";
  }, () => { retries++; }), "verified");
  assert.equal(retries, 2);
  transactions = 0;
  await assert.rejects(withStablePhoneSources(async () => {
    transactions++; throw new Error("Invalid signature");
  }, () => { throw new Error("Should not retry unrelated failures"); }), /Invalid signature/);
  assert.equal(transactions, 1);
  transactions = 0;
  await assert.rejects(withStablePhoneSources(async () => {
    transactions++; throw Object.assign(new Error("Still editing"), { code: "VIGIL_PHONE_SOURCES_CHANGED" });
  }, () => {}), /Still editing/);
  assert.equal(transactions, 3, "concurrent edits must never cause an unbounded update loop");

  assert.deepEqual(terminalCommand(["update"]), { command: "update", target: "phone", verbose: false, args: ["run", "--silent", "agent:update:social"] });
  assert.deepEqual(terminalCommand(["update", "phone", "--verbose", "--device", "phone-1"]), { command: "update", target: "phone", verbose: true, args: ["run", "--silent", "agent:update:social", "--", "--device", "phone-1"] });
  assert.deepEqual(terminalCommand(["update", "mac"]), { command: "update", target: "mac", verbose: false, args: ["run", "--silent", "agent:update"] });
  assert.deepEqual(terminalCommand(["status", "mac"]), { command: "status", target: "mac", verbose: false, args: ["run", "--silent", "agent", "--", "update-status"] });
  assert.throws(() => terminalCommand(["disable", "phone"]), /Unknown command/);
  assert.throws(() => terminalCommand(["update", "unknown"]), /Unknown target/);
  assert.match(updateFailureHelp("invalid code signature"), /Verify App.*cellular/);
  assert.match(updateFailureHelp("paired iPhone is not reachable"), /USB or.*local network/);
  assert.match(updateFailureHelp("A verified Vigil phone update is already running"), /Another phone update/);

  const cliRoot = join(root, "project with 'quote"), home = join(root, "home");
  await mkdir(join(cliRoot, "scripts"), { recursive: true });
  await writeFile(join(cliRoot, "scripts", "vigil.mjs"), "console.log(JSON.stringify(process.argv.slice(2)));\n");
  const installed = await installVigilCommand({ root: cliRoot, home });
  assert.equal((await stat(installed)).mode & 0o777, 0o755);
  const literal = ["update", "phone", "--server", "$(touch SHOULD_NOT_EXIST); spaces"];
  const result = await promisify(execFile)(installed, literal, { cwd: root });
  assert.deepEqual(JSON.parse(result.stdout), literal, "the installed command must quote paths and pass terminal arguments literally");
  await installVigilCommand({ root: cliRoot, home });
  await writeFile(installed, "#!/bin/sh\n# unrelated user command\n");
  await assert.rejects(installVigilCommand({ root: cliRoot, home }), /already belongs to another command/);
} finally { await rm(root, { recursive: true, force: true }); }
console.log("Fast phone updates: content-verified cache, exact no-op gates, fresh service receipts and standalone terminal command passed.");
