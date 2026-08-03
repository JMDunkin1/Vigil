import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { buildIosUrlFilterDataset, decodeIosUrlFilterPrefilter } from "../src/iosUrlFilterPrefilter.js";
import {
  IOS_URL_FILTER_CONTROL_PROVIDER_BUNDLE_IDENTIFIER,
  IOS_URL_FILTER_HOST_BUNDLE_IDENTIFIER,
  IOS_URL_FILTER_MINIMUM_FETCH_INTERVAL_SECONDS,
  IOS_URL_FILTER_USECASE_NAME,
  parseIosUrlFilterServiceConfiguration
} from "../src/iosUrlFilterServiceConfiguration.js";

const root = resolve(process.env.VIGIL_REPO_ROOT || process.cwd());
const options = parseArguments(process.argv.slice(2));
const exactIndexPath = resolve(options.exactIndex || join(root, "data", "adult-blocklist.sdi"));
const outputDirectory = resolve(options.output || join(root, "data", "ios-url-filter"));
const exactIndex = await readFile(exactIndexPath);
const dataset = buildIosUrlFilterDataset({ exactIndex });
const decoded = decodeIosUrlFilterPrefilter(dataset.prefilter.bytes);
const shardCount = Math.max(Math.floor(dataset.domainCount / options.entriesPerShard), 1);
const databaseDirectory = join(outputDirectory, "pir");

await mkdir(databaseDirectory, { recursive: true, mode: 0o700 });
for (const entry of await readdir(databaseDirectory)) {
  if (/^url-\d+\.(?:bin|params\.txtpb)$/u.test(entry)
    || entry === "processed-manifest.json"
    || entry === "deployment-manifest.json") {
    await rm(join(databaseDirectory, entry), { force: true });
  }
}
await atomicWrite(join(outputDirectory, "url-filter-prefilter.vuf"), dataset.prefilter.bytes, 0o600);
await atomicWrite(join(databaseDirectory, "input.txtpb"), dataset.pirDatabase, 0o600);
await atomicJson(join(databaseDirectory, "url-config.json"), {
  inputDatabase: "input.txtpb",
  outputDatabase: "url-SHARD_ID.bin",
  outputPirParameters: "url-SHARD_ID.params.txtpb",
  rlweParameters: "n_4096_logq_27_28_28_logt_5",
  sharding: { entryCountPerShard: options.entriesPerShard },
  trialsPerShard: 5,
  databaseType: "keyword"
});
await atomicJson(join(databaseDirectory, "service-config.json"), {
  users: [{ tier: "vigil", tokens: [options.authenticationToken] }],
  usecases: [{ fileStem: "url", shardCount, name: IOS_URL_FILTER_USECASE_NAME }]
});

if (options.pirServerURL && options.privacyPassIssuerURL && options.deploymentManifestURL) {
  const service = parseIosUrlFilterServiceConfiguration({
    schemaVersion: 1,
    pirServerURL: options.pirServerURL,
    privacyPassIssuerURL: options.privacyPassIssuerURL,
    deploymentManifestURL: options.deploymentManifestURL,
    authenticationToken: options.authenticationToken,
    hostBundleIdentifier: IOS_URL_FILTER_HOST_BUNDLE_IDENTIFIER,
    controlProviderBundleIdentifier: IOS_URL_FILTER_CONTROL_PROVIDER_BUNDLE_IDENTIFIER,
    usecaseName: IOS_URL_FILTER_USECASE_NAME,
    prefilterFetchIntervalSeconds: options.prefilterFetchIntervalSeconds,
    prefilterTag: decoded.metadata.tag,
    pirDatabaseRevision: decoded.metadata.pirDatabaseRevision,
    pirDatabaseSha256: dataset.pirDatabaseSha256,
    exactIndexSnapshotHash: decoded.metadata.snapshotHash
  });
  await atomicJson(join(outputDirectory, "service.json"), service);
}

await atomicJson(join(outputDirectory, "manifest.json"), {
  schemaVersion: 1,
  generatedAt: decoded.metadata.generatedAt,
  exactIndexPath,
  exactIndexSnapshotHash: decoded.metadata.snapshotHash,
  exactIndexPayloadSha256: decoded.metadata.exactIndexPayloadSha256,
  exactDomainCount: decoded.metadata.exactDomainCount,
  prefilterTag: decoded.metadata.tag,
  prefilterSha256: sha256(dataset.prefilter.bytes),
  bloomBitsetSha256: decoded.metadata.bitsetSha256,
  pirDatabaseRevision: decoded.metadata.pirDatabaseRevision,
  pirDatabaseSha256: dataset.pirDatabaseSha256,
  shardCount,
  entriesPerShard: options.entriesPerShard,
  serviceConfigured: Boolean(options.pirServerURL && options.privacyPassIssuerURL && options.deploymentManifestURL)
});

console.log(`Prepared ${dataset.domainCount.toLocaleString("en-US")} URL Filter rows in ${outputDirectory}.`);
console.log(`Prefilter tag: ${decoded.metadata.tag}`);
console.log(`PIR database: ${dataset.pirDatabaseSha256}`);
if (!options.pirServerURL || !options.privacyPassIssuerURL || !options.deploymentManifestURL) {
  console.log("No deployable service.json was written; pass all three HTTPS service/deployment URLs when production is ready.");
}

function parseArguments(args: string[]) {
  const values = [...args];
  const result = {
    exactIndex: "",
    output: "",
    pirServerURL: "",
    privacyPassIssuerURL: "",
    deploymentManifestURL: "",
    authenticationToken: randomBytes(32).toString("base64url"),
    entriesPerShard: 50_000,
    prefilterFetchIntervalSeconds: IOS_URL_FILTER_MINIMUM_FETCH_INTERVAL_SECONDS
  };
  while (values.length) {
    const key = values.shift();
    const value = values.shift();
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}.`);
    if (key === "--exact-index") result.exactIndex = value;
    else if (key === "--output") result.output = value;
    else if (key === "--pir-server-url") result.pirServerURL = value;
    else if (key === "--privacy-pass-issuer-url") result.privacyPassIssuerURL = value;
    else if (key === "--deployment-manifest-url") result.deploymentManifestURL = value;
    else if (key === "--authentication-token") result.authenticationToken = value;
    else if (key === "--entries-per-shard") result.entriesPerShard = Number(value);
    else if (key === "--fetch-interval") result.prefilterFetchIntervalSeconds = Number(value);
    else throw new Error(`Unknown option: ${key}`);
  }
  if (!Number.isSafeInteger(result.entriesPerShard) || result.entriesPerShard < 1) {
    throw new Error("--entries-per-shard must be a positive integer.");
  }
  const configuredURLCount = [result.pirServerURL, result.privacyPassIssuerURL, result.deploymentManifestURL].filter(Boolean).length;
  if (configuredURLCount !== 0 && configuredURLCount !== 3) {
    throw new Error("--pir-server-url, --privacy-pass-issuer-url, and --deployment-manifest-url are all required for deployable configuration.");
  }
  return result;
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await atomicWrite(path, Buffer.from(`${JSON.stringify(value, null, 2)}\n`), 0o600);
}

async function atomicWrite(path: string, bytes: Uint8Array, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { mode });
    await chmod(temporary, mode);
    await rename(temporary, path);
    await chmod(path, mode);
  } finally {
    await rm(temporary, { force: true });
  }
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
