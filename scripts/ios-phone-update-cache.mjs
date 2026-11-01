import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

const runtimeInputs = [
  "package.json", "package-lock.json", "tsconfig.json", "node_modules/typescript/package.json",
  "app", "src", "scripts", "public", "extension",
  "ios/VigilSocial/VigilSocial/Icons",
  "ios/VigilSocial/VigilYouTubeInteractionExtension/Resources",
  "ios/VigilBrowser/VigilSafariExtension/Resources"
];

// Content hashes, including generated output, rather than mtimes or a release
// label: a deleted/tampered module or changed policy source always rebuilds.
async function treeFingerprint(root, paths) {
  const digest = createHash("sha256");
  async function visit(path) {
    const entry = await lstat(path).catch(error => { if (error.code !== "ENOENT") throw error; return null; });
    digest.update(relative(root, path)).update("\0");
    if (!entry) { digest.update("missing\0"); return; }
    if (entry.isDirectory()) {
      for (const name of (await readdir(path)).sort()) await visit(join(path, name));
    } else if (entry.isFile() || (entry.isSymbolicLink() && (await stat(path)).isFile())) {
      digest.update(await readFile(path)).update("\0");
    } else { throw new Error(`Unsupported phone-runtime cache input: ${relative(root, path)}`); }
  }
  for (const path of [...paths].sort()) await visit(join(root, path));
  return digest.digest("hex");
}

export async function ensurePhoneRuntime(root, build) {
  const manifestPath = join(root, "data", "ios-phone-runtime-cache.json");
  const inputs = await treeFingerprint(root, runtimeInputs);
  let cached;
  try { cached = JSON.parse(await readFile(manifestPath, "utf8")); } catch { /* Rebuild without a valid receipt. */ }
  if (cached?.schemaVersion === 1 && cached.inputs === inputs
      && cached.outputs === await treeFingerprint(root, ["dist/runtime"])) return { reused: true };
  await build();
  const after = await treeFingerprint(root, runtimeInputs);
  // Build generators may update source assets. Concurrent edits must never be
  // stamped as if the compiler had necessarily consumed their new contents.
  if (inputs === after) {
    const outputs = await treeFingerprint(root, ["dist/runtime"]);
    await mkdir(dirname(manifestPath), { recursive: true });
    const temporary = `${manifestPath}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ schemaVersion: 1, inputs: after, outputs }) + "\n", { mode: 0o600 });
    await rename(temporary, manifestPath);
  }
  return { reused: false };
}

export function phoneBuildCacheRoot(root, edition, home = homedir()) {
  if (!["personal", "enhanced"].includes(edition)) throw new Error("Unknown phone build edition");
  const repository = createHash("sha256").update(resolve(root)).digest("hex").slice(0, 16);
  return join(home, "Library", "Caches", "Vigil", "phone-builds", repository, edition);
}

export function phoneUpdateIsCurrent(report, { pushNotifications, force = false, replaceLegacy = false } = {}) {
  const receipt = report?.receipt;
  const required = ["instagram", "youtube", "snapchat", "linkedin", "facebook", "x", "tiktok", "reddit"];
  const launches = new Set(receipt?.serviceLaunches?.filter(entry => Number.isFinite(Date.parse(entry.verifiedAt))).map(entry => entry.service));
  return !force && !replaceLegacy && report?.edition === "personal"
    && Array.isArray(report.problems) && report.problems.length === 0
    && report.profileVerification?.available === true && Boolean(report.lockProfile)
    && report.serverState?.state?.deviceControls?.ios?.enabled === true
    && receipt?.socialContainer === true && receipt.edition === "personal"
    && Boolean(receipt.device?.udid) && receipt.device.udid === report.device?.udid
    && Boolean(report.livePolicyFingerprint) && receipt.policyFingerprint === report.livePolicyFingerprint
    && receipt.release?.sourceFingerprint === report.fingerprint?.hash
    && receipt.release?.sourceFingerprint === report.release?.sourceFingerprint
    && receipt.notificationPushEnvironment === pushNotifications
    && required.every(service => launches.has(service));
}

export function serviceLaunchReceiptMatches(selection, access, service, started) {
  return selection?.combined === true && selection.service === service
    && Date.parse(selection.selectedAt) >= started - 1000
    && access?.service === service && access.accessConfirmed === true
    && Date.parse(access.checkedAt) >= started - 1000;
}

export async function withStablePhoneSources(action, retry) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await action(); }
    catch (error) {
      if (error.code !== "VIGIL_PHONE_SOURCES_CHANGED" || attempt === 2) throw error;
      await retry();
    }
  }
}
