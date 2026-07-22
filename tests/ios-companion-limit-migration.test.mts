import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = await mkdtemp(join(tmpdir(), "vigil-ios-companion-limit-migration-"));
process.env.VIGIL_DATA_DIR = dataDir;

try {
  const { defaultState } = await import("../src/defaults.js");
  const legacy = defaultState();
  const instagram = legacy.limitRules.find((rule) => rule.id === "instagram-20-20-template");
  const youtube = legacy.limitRules.find((rule) => rule.id === "soft-lock-youtube-20-20-template");
  assert.ok(instagram);
  assert.ok(youtube);
  instagram.apps = instagram.apps.filter((app) => app !== "tech.caseline.vigil.instagram");
  youtube.apps = youtube.apps.filter((app) => app !== "tech.caseline.vigil.youtube");
  legacy.limitRules.push(
    {
      ...instagram,
      id: "custom-native-instagram-limit",
      name: "Custom native Instagram limit",
      apps: ["com.example.reader", "com.burbn.instagram"],
      sites: []
    },
    {
      ...youtube,
      id: "custom-native-youtube-limit",
      name: "Custom native YouTube limit",
      apps: ["com.google.ios.youtube"],
      sites: []
    },
    {
      ...instagram,
      id: "custom-unrelated-limit",
      name: "Custom unrelated limit",
      apps: ["com.example.reader"],
      sites: ["example.test"]
    }
  );
  await writeFile(join(dataDir, "state.json"), `${JSON.stringify(legacy, null, 2)}\n`);

  const { loadState } = await import("../src/store.js");
  const migrated = await loadState();
  assert.equal(
    migrated.limitRules.find((rule) => rule.id === instagram.id)?.apps.includes("tech.caseline.vigil.instagram"),
    true,
    "existing Instagram limits must follow the fixed companion bundle"
  );
  assert.equal(
    migrated.limitRules.find((rule) => rule.id === youtube.id)?.apps.includes("tech.caseline.vigil.youtube"),
    true,
    "existing YouTube limits must follow the fixed companion bundle"
  );
  assert.deepEqual(
    migrated.limitRules.find((rule) => rule.id === "custom-native-instagram-limit")?.apps,
    ["com.example.reader", "com.burbn.instagram", "tech.caseline.vigil.instagram"],
    "custom native Instagram limits must gain only the Instagram companion target"
  );
  assert.deepEqual(
    migrated.limitRules.find((rule) => rule.id === "custom-native-youtube-limit")?.apps,
    ["com.google.ios.youtube", "tech.caseline.vigil.youtube"],
    "custom native YouTube limits must gain only the YouTube companion target"
  );
  assert.deepEqual(
    migrated.limitRules.find((rule) => rule.id === "custom-unrelated-limit")?.apps,
    ["com.example.reader"],
    "unrelated custom limits must not gain companion targets"
  );
} finally {
  await rm(dataDir, { recursive: true, force: true });
}
