import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const LABEL = "tech.caseline.vigil.phone-renewal";
export const RENEWAL_WINDOW_MS = 48 * 60 * 60 * 1000;
export const FRESH_SIGNING_WINDOW_MS = 5 * 24 * 60 * 60 * 1000;

// Include extensions: an expired Safari companion is an expired deployment,
// even when the containing app still has a valid provisioning profile.
export function signingProfilesNeedingRefresh(profiles, now = Date.now(), window = FRESH_SIGNING_WINDOW_MS) {
  return profiles.filter((profile) => {
    const expires = Date.parse(profile?.expiresAt || "");
    return !Number.isFinite(expires) || expires <= Number(now) + window;
  });
}

export async function freshSigningBuild({ build, readProfiles, quarantine, now = Date.now, window = FRESH_SIGNING_WINDOW_MS }) {
  await build();
  let profiles = await readProfiles();
  let stale = signingProfilesNeedingRefresh(profiles, now(), window);
  if (stale.length) {
    await quarantine(stale);
    await build();
    profiles = await readProfiles();
    stale = signingProfilesNeedingRefresh(profiles, now(), window);
  }
  if (!profiles.length || stale.length) {
    throw new Error(`Xcode did not renew the provisioning profiles (${stale.map((profile) => `${profile.name}: ${profile.expiresAt}`).join(", ")}). Refusing to install an app or Safari extension with too little signing time left.`);
  }
  return profiles;
}

export function renewalDecision(receipt, fingerprint, now = Date.now()) {
  if (receipt?.edition !== "personal" || receipt?.socialContainer !== true) return { status: "unconfigured" };
  const app = receipt.apps?.find((entry) => entry.bundleId === "tech.caseline.vigil.instagram");
  const expiresAt = app?.signingProfile?.expiresAt || "";
  if (!app?.launchVerifiedAt || !receipt.policyFingerprint || !receipt.device?.udid
    || !Number.isFinite(Date.parse(expiresAt))) return { status: "unverified", expiresAt };
  if (Date.parse(expiresAt) > Number(now) + RENEWAL_WINDOW_MS) return { status: "current", expiresAt };
  if (!fingerprint || receipt.release?.sourceFingerprint !== fingerprint) return { status: "sources-changed", expiresAt };
  return { status: "due", expiresAt, device: receipt.device.udid };
}

export function verifiedLauncherState(receipt, now = Date.now()) {
  const app = receipt?.apps?.find((entry) => entry.bundleId === "tech.caseline.vigil.instagram");
  const required = ["instagram", "youtube", "snapchat", "linkedin"];
  const launches = new Set(receipt?.serviceLaunches?.filter((entry) => entry.verifiedAt).map((entry) => entry.service));
  const profiles = app?.signingProfile?.profiles || [app?.signingProfile];
  const expirations = profiles.map((profile) => Date.parse(profile?.expiresAt || ""));
  const expires = Math.min(...expirations);
  if (receipt?.edition !== "personal" || receipt?.socialContainer !== true
    || !receipt.policyFingerprint || !app?.launchVerifiedAt
    || !required.every((service) => launches.has(service))
    || !expirations.length || expirations.some((expiration) => !Number.isFinite(expiration)) || expires <= now) {
    throw new Error("A current verified app-and-policy receipt is required to publish launcher expiry.");
  }
  // Informational preflight only. This is never a signing credential or an
  // authorization token; iOS and the supervised policy still enforce access.
  return { schemaVersion: 1, expiresAt: new Date(expires).toISOString(), updatedAt: receipt.deployedAt };
}

export async function publishPhoneLauncherState(receipt, root = ROOT, home = homedir()) {
  const state = verifiedLauncherState(receipt);
  const local = join(root, "data", "ios-phone-launchers", "vigil-signing.json");
  // The native "Get File from Folder: Shortcuts" action reads this app's
  // iCloud container, not a same-named folder in the general CloudDocs root.
  const cloud = join(home, "Library", "Mobile Documents", "iCloud~is~workflow~my~workflows", "Documents");
  const paths = [local];
  if (await stat(cloud).then((entry) => entry.isDirectory(), () => false)) {
    paths.push(join(cloud, "Vigil", "vigil-signing.json"));
  }
  for (const path of paths) {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  }
  console.log(`Launcher expiry published: ${state.expiresAt}${paths.length > 1 ? " • synced to iCloud Shortcuts/Vigil" : " • local copy"}`);
  return paths;
}

export async function withPhoneUpdateLock(root, action) {
  const path = join(root, "data", "ios-phone-update.lock");
  await mkdir(dirname(path), { recursive: true });
  try {
    await mkdir(path);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const recovery = `${path}.recovery`;
    await withPhoneRecoveryLock(recovery, async () => {
      const owner = await readFile(join(path, "pid"), "utf8").catch(() => "");
      const pid = Number(owner);
      let alive = true;
      if (Number.isInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); } catch (probe) { if (probe.code === "ESRCH") alive = false; }
      } else {
        // Another writer may have created the directory but not yet saved its PID.
        alive = Date.now() - (await stat(path)).mtimeMs < 60_000;
      }
      if (alive) throw new Error("A verified Vigil phone update is already running; retry after it finishes.", { cause: error });
      // Serialize stale-lock recovery before removal; competing updates must
      // never mistake a newly acquired directory for the previous owner.
      const stale = `${path}.stale-${process.pid}`;
      await rename(path, stale);
      await rm(stale, { recursive: true, force: true });
      await mkdir(path);
      await writeFile(join(path, "pid"), String(process.pid), { mode: 0o600 });
    });
  }
  try {
    await writeFile(join(path, "pid"), String(process.pid), { mode: 0o600 });
    return await action();
  } finally {
    await rm(path, { recursive: true, force: true });
  }
}

async function withPhoneRecoveryLock(path, action) {
  const ready = join(path, "claims-v1");
  const created = await mkdir(path).then(() => true, (error) => {
    if (error.code !== "EEXIST") throw error;
    return false;
  });
  if (!created && !await readFile(ready, "utf8").then((value) => value === "1\n", () => false)
    && Date.now() - (await stat(path)).mtimeMs < 60_000) {
    // An older updater may have created its ownerless recovery directory and
    // still be using it. Give that publication gap the same grace as the lock.
    throw new Error("Another Vigil phone update owns the update lock; retry after it finishes.");
  }
  await writeFile(ready, "1\n", { mode: 0o600 });
  // Keep this registry directory: each immutable claim publishes its PID in
  // its name atomically. Reaping a dead claim cannot remove a replacement
  // owner's claim or require another recovery mutex that could be abandoned.
  const claim = `${process.pid}-${randomUUID()}`;
  await mkdir(join(path, claim));
  try {
    for (const other of await readdir(path)) {
      if (other === "claims-v1" || other === claim) continue;
      const pid = Number(/^(\d+)-[\da-f-]+$/u.exec(other)?.[1]);
      let alive = true;
      if (Number.isInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); } catch (error) { if (error.code === "ESRCH") alive = false; }
      }
      if (alive) throw new Error("Another Vigil phone update owns the update lock; retry after it finishes.");
      await rm(join(path, other), { recursive: true, force: true });
    }
    return await action();
  } finally {
    await rm(join(path, claim), { recursive: true, force: true });
  }
}

const xml = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

export function renewalLaunchAgent({ root, node, home, device, server }) {
  const log = join(home, "Library", "Logs", "Vigil", "phone-renewal.log");
  const args = [node, join(root, "scripts", "ios-phone-renewal.mjs"), device, server];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>
<key>WorkingDirectory</key><string>${xml(root)}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(`${dirname(node)}:/usr/bin:/bin:/usr/sbin:/sbin`)}</string></dict>
<key>StartInterval</key><integer>21600</integer>
<key>StandardOutPath</key><string>${xml(log)}</string>
<key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>
`;
}

// Called only after the normal app-and-policy transaction passes all checks.
// This independent maintenance job never unloads or restarts enforcement.
export async function installPhoneRenewal(device, server, root = ROOT) {
  if (process.platform !== "darwin") return;
  const home = homedir();
  const path = join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
  await mkdir(dirname(path), { recursive: true });
  await mkdir(join(home, "Library", "Logs", "Vigil"), { recursive: true });
  const plist = renewalLaunchAgent({ root, node: process.execPath, home, device, server });
  const previous = await readFile(path, "utf8").catch(() => "");
  const domain = `gui/${process.getuid()}`;
  const loaded = await exec("/bin/launchctl", ["print", `${domain}/${LABEL}`]).then(() => true, () => false);
  if (loaded && previous !== plist) {
    // Never replace the arguments of a running update. Its next login will
    // load the new path; foreground phone updates remain available meanwhile.
    await writeFile(path, plist, { mode: 0o600 });
    console.warn("Phone renewal configuration changed; it will take effect at the next Mac login.");
    return;
  }
  await writeFile(path, plist, { mode: 0o600 });
  if (!loaded) await exec("/bin/launchctl", ["bootstrap", domain, path]);
  console.log("Automatic phone signing renewal: every six hours, starting 48 hours before expiry.");
}

export async function runPhoneRenewal({ receipt, fingerprint, now, update }) {
  const decision = renewalDecision(receipt, fingerprint, now);
  if (decision.status !== "due") return decision;
  try {
    await update(decision.device);
    return { ...decision, status: "renewed" };
  } catch (error) {
    return { ...decision, status: "needs-connection", detail: error.message };
  }
}

async function main(device, server = "http://127.0.0.1:8787") {
  if (!/^[A-Za-z0-9-]+$/.test(device || "")) throw new Error("A verified phone UDID is required for renewal.");
  const receiptPath = join(ROOT, "data", "ios-phone-deployments", `${device}.json`);
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  let fingerprint = "";
  // Avoid loading/building anything while the installation is still fresh.
  if (renewalDecision(receipt, "").status === "sources-changed") {
    const { stdout } = await exec(process.execPath, [join(ROOT, "scripts", "ios-phone-suite.mjs"), "fingerprint", "--edition", "personal"], { cwd: ROOT, timeout: 60_000 });
    fingerprint = stdout.trim();
  }
  const result = await runPhoneRenewal({ receipt, fingerprint, update: (udid) => new Promise((done, fail) => {
    const child = spawn(process.execPath, [join(ROOT, "scripts", "ios-phone-suite.mjs"), "renew", "--edition", "personal", "--app", "instagram", "--device", udid, "--server", server], { cwd: ROOT, stdio: "inherit" });
    child.once("error", fail);
    child.once("exit", (code) => code === 0 ? done() : fail(new Error(`Verified phone update exited with ${code}. See phone-renewal.log.`)));
  }) });
  const statusPath = join(ROOT, "data", "ios-phone-renewal-status.json");
  const previous = await readFile(statusPath, "utf8").then(JSON.parse, () => ({}));
  const key = `${device}:${result.expiresAt}:${result.status}`;
  if (!["current", "unconfigured", "renewed"].includes(result.status) && previous.notificationKey !== key) {
    const message = result.status === "sources-changed"
      ? "Vigil phone signing needs renewal. Sources changed: run npm run agent:update:social with the paired iPhone connected."
      : "Vigil phone signing needs renewal. Connect the paired iPhone to this Mac, then run npm run agent:update:social. See phone-renewal.log for details.";
    await exec("/usr/bin/osascript", ["-e", "on run argv\ndisplay notification (item 1 of argv) with title \"Vigil phone renewal\"\nend run", message]);
  }
  const temporary = `${statusPath}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({ ...result, checkedAt: new Date().toISOString(), notificationKey: key }), { mode: 0o600 });
  await rename(temporary, statusPath);
  console.log(JSON.stringify(result));
}

if (resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  try { await main(...process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
