import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { join } from "node:path";
import { BUILT_IN_CHROME_EXTENSION_ID, PORT } from "../src/defaults.js";
import { isDirectRun } from "../src/directRun.js";
import { verifyChromeWebStoreRelease } from "../src/extensionStoreVerification.js";
import { managedChatgptProfile, prepareExtensionRecovery, prepareExtensionRelease, verifyExtensionRelease } from "../src/managedChatgptExtension.js";
import type { ExtensionPublication, ManagedClientRehearsal } from "../src/managedChatgptExtension.js";

export async function runManagedChatgptExtension(args = process.argv.slice(2)): Promise<void> {
  const [command = "status", ...values] = args;
  if (command === "status") {
    // This is the active Electron partition, not the similarly named obsolete profile.
    const profile = join(homedir(), "Library", "Application Support", "Codex", "Default", "Partitions", "codex-browser-app", "Secure Preferences");
    const preferences = JSON.parse(await readFile(profile, "utf8"));
    const entry = preferences.extensions?.settings?.[BUILT_IN_CHROME_EXTENSION_ID];
    const manifest = entry?.path ? JSON.parse(await readFile(join(entry.path, "manifest.json"), "utf8")) : null;
    console.log(JSON.stringify({
      profile, installed: Boolean(entry), extensionId: BUILT_IN_CHROME_EXTENSION_ID,
      version: manifest?.version || null, source: entry?.path || null,
      disableReasons: entry?.disable_reasons || [], installationSource: entry?.location === 4 ? "unpacked" : entry?.location ?? null,
      policyInstalled: entry?.location === 7 || entry?.location === 9,
      removalProtectionVerified: false,
      detail: "Installation source alone does not verify effective policy, page filtering, or recovery. Lock activation requires actual client update and recovery receipts."
    }, null, 2));
    return;
  }
  if (command === "prepare") {
    const [source, output] = values;
    if (!source || !output || values.length !== 2) throw new Error("Usage: prepare <compiled-extension-folder> <new-release-folder>");
    console.log(JSON.stringify(await prepareExtensionRelease(source, output), null, 2));
    return;
  }
  if (command === "verify") {
    if (values.length !== 1) throw new Error("Usage: verify <release-folder>");
    console.log(JSON.stringify(await verifyExtensionRelease(values[0]!), null, 2));
    return;
  }
  if (command === "repair") {
    const [workingRelease, output, nextVersion, highestDeployedVersion] = values;
    if (!workingRelease || !output || !nextVersion || !highestDeployedVersion || values.length !== 4) {
      throw new Error("Usage: repair <working-release-folder> <new-release-folder> <next-version> <highest-deployed-version>");
    }
    console.log(JSON.stringify(await prepareExtensionRecovery(workingRelease, output, nextVersion, highestDeployedVersion), null, 2));
    return;
  }
  if (command === "profile") {
    const [releaseDirectory, publicationPath, output, mode, workingDirectory, rehearsalPath] = values;
    if (!releaseDirectory || !publicationPath || !output || !["trial", "locked"].includes(mode || "")
      || (mode === "locked" ? values.length !== 6 : values.length !== 4)) {
      throw new Error("Usage: profile <release-folder> <publication-json> <new-mobileconfig> trial | profile <release-folder> <publication-json> <new-mobileconfig> locked <working-release-folder> <client-rehearsal-json>");
    }
    const release = await verifyExtensionRelease(releaseDirectory);
    const publication = JSON.parse(await readFile(publicationPath, "utf8")) as ExtensionPublication;
    if (!publication.published || publication.extensionId !== release.extensionId || publication.publishedVersion !== release.version) {
      throw new Error("This exact companion version is unpublished. Keep the current installation; no policy was exported.");
    }
    const chromiumVersion = (await promisify(execFile)("/usr/bin/plutil", [
      "-extract", "ChromiumBaseVersion", "raw", "-o", "-", "/Applications/ChatGPT.app/Contents/Info.plist"
    ])).stdout.trim();
    const verifiedPublication = await verifyChromeWebStoreRelease(releaseDirectory, chromiumVersion);
    const workingRelease = workingDirectory ? await verifyExtensionRelease(workingDirectory) : undefined;
    const rehearsal = rehearsalPath ? JSON.parse(await readFile(rehearsalPath, "utf8")) as ManagedClientRehearsal : undefined;
    const currentClientVersion = mode === "locked" ? (await promisify(execFile)("/usr/bin/plutil", [
      "-extract", "CFBundleShortVersionString", "raw", "-o", "-", "/Applications/ChatGPT.app/Contents/Info.plist"
    ])).stdout.trim() : undefined;
    let currentNativeRequiredExtensionVersion: string | undefined;
    if (mode === "locked") {
      const response = await fetch(`http://127.0.0.1:${PORT}/api/extension/pairing`, { signal: AbortSignal.timeout(5_000) });
      if (!response.ok) throw new Error("Vigil's native companion API is unavailable; do not lock the installation.");
      const native = await response.json() as { requiredExtensionVersion?: string };
      currentNativeRequiredExtensionVersion = native.requiredExtensionVersion;
    }
    const profile = managedChatgptProfile(release, verifiedPublication, { locked: mode === "locked", workingRelease, rehearsal, currentClientVersion, currentNativeRequiredExtensionVersion });
    await writeFile(output, profile, { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ profile: output, installed: false, mode, detail: "Export only. Confirm the exact live policy and companion in ChatGPT before reporting enforcement." }, null, 2));
    return;
  }
  throw new Error("Commands: status, prepare, verify, repair, profile. This interface never removes policy, disables the extension, or stops Vigil.");
}

if (isDirectRun(import.meta.url)) {
  await runManagedChatgptExtension().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
