import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const root = resolve(process.env.VIGIL_REPO_ROOT || process.cwd());
const directory = resolve(process.argv[2] || join(root, "data", "ios-url-filter"));
const pirDirectory = join(directory, "pir");
const sourceManifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as Record<string, unknown>;
const shardCount = Number(sourceManifest.shardCount);
if (!Number.isSafeInteger(shardCount) || shardCount < 1) throw new Error("URL Filter source manifest has an invalid shard count.");

const expectedNames = new Set<string>();
const shards: Array<Record<string, unknown>> = [];
for (let index = 0; index < shardCount; index += 1) {
  const databaseName = `url-${index}.bin`;
  const parametersName = `url-${index}.params.txtpb`;
  expectedNames.add(databaseName);
  expectedNames.add(parametersName);
  const database = await readFile(join(pirDirectory, databaseName));
  const parameters = await readFile(join(pirDirectory, parametersName));
  shards.push({
    id: index,
    database: { file: databaseName, bytes: database.byteLength, sha256: sha256(database) },
    parameters: { file: parametersName, bytes: parameters.byteLength, sha256: sha256(parameters) }
  });
}
const unexpected = (await readdir(pirDirectory))
  .filter((name) => /^url-\d+\.(?:bin|params\.txtpb)$/u.test(name) && !expectedNames.has(name));
if (unexpected.length) throw new Error(`Unexpected processed PIR shards exist: ${unexpected.join(", ")}`);

await atomicJson(join(pirDirectory, "processed-manifest.json"), {
  schemaVersion: 1,
  finalizedAt: new Date().toISOString(),
  exactIndexSnapshotHash: sourceManifest.exactIndexSnapshotHash,
  pirDatabaseRevision: sourceManifest.pirDatabaseRevision,
  pirDatabaseSha256: sourceManifest.pirDatabaseSha256,
  shardCount,
  shards
});
await atomicJson(join(pirDirectory, "deployment-manifest.json"), {
  schemaVersion: 1,
  exactIndexSnapshotHash: sourceManifest.exactIndexSnapshotHash,
  prefilterTag: sourceManifest.prefilterTag,
  prefilterSha256: sourceManifest.prefilterSha256,
  pirDatabaseRevision: sourceManifest.pirDatabaseRevision,
  pirDatabaseSha256: sourceManifest.pirDatabaseSha256,
  shardCount,
  shards
});
console.log(`Finalized and hashed ${shardCount} processed URL Filter PIR shards.`);

async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
