import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePlist } from "../../src/plist.js";
import type { VigilState } from "../../src/types.js";
import { recordValue } from "./test-helpers.mjs";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const dataDir = await mkdtemp(join(tmpdir(), "vigil-manageengine-export-"));

try {
  const profilePath = join(dataDir, "vigil-manageengine-policy.mobileconfig");
  const summaryPath = join(dataDir, "vigil-manageengine-policy.summary.json");
  const result = await runExporter(["--out", profilePath, "--summary", summaryPath], dataDir);

  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /State saved: yes/);

  const savedState = JSON.parse(await readFile(join(dataDir, "state.json"), "utf8")) as VigilState;
  const savedPassword = savedState.deviceControls.ios.removalPassword;
  assert.equal(typeof savedPassword, "string");
  const removalPassword = savedPassword as string;
  assert.ok(removalPassword.length >= 16);

  const profile = recordValue(parsePlist(await readFile(profilePath, "utf8")), "ManageEngine profile");
  assert.equal(profile.PayloadRemovalDisallowed, true);
  assert.ok(Array.isArray(profile.PayloadContent), "profile payload content should be an array");
  const removalPayload = profile.PayloadContent
    .map((item) => recordValue(item, "profile payload"))
    .find((payload) => payload.PayloadType === "com.apple.profileRemovalPassword");
  assert.ok(removalPayload, "hardened ManageEngine profile should include a removal password payload");
  assert.equal(removalPayload.RemovalPassword, removalPassword);

  const summaryText = await readFile(summaryPath, "utf8");
  const summary = recordValue(JSON.parse(summaryText), "ManageEngine export summary");
  assert.equal(summary.stateSaved, true);
  assert.equal(summary.hardenRemoval, true);
  assert.equal(summary.removalPasswordStoredInVigilState, true);
  assert.equal(summaryText.includes(removalPassword), false);

  const typoProfilePath = join(dataDir, "typo-should-not-write.mobileconfig");
  const typoSummaryPath = join(dataDir, "typo-should-not-write.summary.json");
  const typoResult = await runExporter(["--out", typoProfilePath, "--summary", typoSummaryPath, "--enrolment-window"], dataDir);

  assert.notEqual(typoResult.code, 0, typoResult.stdout);
  assert.match(typoResult.stderr, /Unknown option: --enrolment-window/);
  assert.equal(await fileExists(typoProfilePath), false);
  assert.equal(await fileExists(typoSummaryPath), false);

  const inlineEqualsProfilePath = join(dataDir, "policy=name.mobileconfig");
  const inlineEqualsSummaryPath = join(dataDir, "policy=name.summary.json");
  const inlineEqualsResult = await runExporter([
    `--out=${inlineEqualsProfilePath}`,
    `--summary=${inlineEqualsSummaryPath}`,
    "--enrollment-window"
  ], dataDir);

  assert.equal(inlineEqualsResult.code, 0, inlineEqualsResult.stderr || inlineEqualsResult.stdout);
  assert.match(inlineEqualsResult.stdout, new RegExp(`Wrote ManageEngine iOS profile: ${escapeRegExp(inlineEqualsProfilePath)}`));
  assert.match(await readFile(inlineEqualsProfilePath, "utf8"), /^\s*<\?xml/);
  const inlineEqualsSummary = recordValue(JSON.parse(await readFile(inlineEqualsSummaryPath, "utf8")), "inline-equals summary");
  assert.equal(inlineEqualsSummary.mode, "enrollment-window");
  assert.equal(inlineEqualsSummary.outputPath, inlineEqualsProfilePath);
  assert.equal(inlineEqualsSummary.hardenRemoval, false);
  assert.equal(inlineEqualsSummary.restrictInstallAndErase, false);

  const noSuffixProfilePath = join(dataDir, "vigil-manageengine-policy-no-suffix");
  const noSuffixSummaryPath = `${noSuffixProfilePath}.summary.json`;
  const noSuffixResult = await runExporter(["--out", noSuffixProfilePath], dataDir);

  assert.equal(noSuffixResult.code, 0, noSuffixResult.stderr || noSuffixResult.stdout);
  assert.match(noSuffixResult.stdout, new RegExp(`Wrote ManageEngine iOS profile: ${escapeRegExp(noSuffixProfilePath)}`));
  assert.match(noSuffixResult.stdout, new RegExp(`Summary: ${escapeRegExp(noSuffixSummaryPath)}`));
  assert.match(await readFile(noSuffixProfilePath, "utf8"), /^\s*<\?xml/);
  assert.equal(recordValue(JSON.parse(await readFile(noSuffixSummaryPath, "utf8")), "no-suffix summary").outputPath, noSuffixProfilePath);
} finally {
  await rm(dataDir, { recursive: true, force: true });
}

function runExporter(args: string[], vigilDataDir: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(root, "scripts", "export-manageengine-ios-profile.mjs"), ...args], {
      cwd: root,
      env: {
        ...process.env,
        VIGIL_DATA_DIR: vigilDataDir
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("exit", (code, signal) => {
      resolve({ code: signal ? 1 : code || 0, stdout, stderr });
    });
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT") return false;
    throw error;
  }
}
