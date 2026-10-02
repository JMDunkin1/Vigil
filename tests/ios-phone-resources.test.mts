import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const root = existsSync(join(runtimeRoot, "ios")) ? runtimeRoot : resolve(runtimeRoot, "..", "..");
const project = await readFile(join(root, "ios/VigilSocial/VigilSocial.xcodeproj/project.pbxproj"), "utf8");

function objectBody(id: string): string {
  const body = project.match(new RegExp(`^[\\t ]*${id}\\b[^=]*= \\{([^}]+)\\};`, "m"))?.[1];
  assert.ok(body, `Missing Xcode object ${id}`);
  return body;
}

for (const targetName of ["VigilInstagram", "VigilSocial", "VigilYouTubeInteractionExtension"]) {
  const candidates = [...project.matchAll(new RegExp(`^[\\t ]*([A-Z0-9]{24}) /\\* ${targetName} \\*/ = \\{`, "gm"))];
  const targetId = candidates.map((match) => match[1])
    .find((id) => /isa = PBXNativeTarget;/u.test(objectBody(id)));
  assert.ok(targetId, `Missing Xcode target ${targetName}`);
  const phases = objectBody(targetId).match(/buildPhases = \(([\s\S]*?)\);/u)?.[1].match(/[A-Z0-9]{24}/gu) || [];
  const resources = phases.map(objectBody).find((body) => /isa = PBXResourcesBuildPhase;/u.test(body));
  assert.ok(resources, `${targetName} must have a resource copy phase`);
  const buildIds = resources.match(/files = \(([\s\S]*?)\);/u)?.[1].match(/[A-Z0-9]{24}/gu) || [];
  const bundledPaths = buildIds.map((id) => {
    const fileId = objectBody(id).match(/fileRef = ([A-Z0-9]{24})/u)?.[1];
    assert.ok(fileId, `Resource ${id} must reference a file`);
    return objectBody(fileId).match(/path = "?([^";]+)"?;/u)?.[1];
  });
  assert.ok(bundledPaths.includes("youtube-player-response.js"),
    `${targetName} must bundle the player-response guard consumed by its protected YouTube surface`);
}

console.log("iOS phone resource graph tests passed.");
