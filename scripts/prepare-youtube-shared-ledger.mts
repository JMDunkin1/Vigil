import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { mergeYouTubeLedgers } from "../src/youtubeLedgerMigration.js";
import type { YouTubeMigrationSources } from "../src/youtubeLedgerMigration.js";
import { isDirectRun } from "../src/directRun.js";

export async function prepareSharedYouTubeMigration(paths: Record<keyof YouTubeMigrationSources,string>, output: string) {
  const sources = {} as YouTubeMigrationSources;
  const originals: {name:string;bytes:Buffer;sha256:string}[] = [];
  for (const name of ["mac", "ios-app", "ios-safari"] as const) {
    const bytes = await readFile(paths[name]);
    sources[name] = JSON.parse(bytes.toString("utf8"));
    originals.push({name,bytes,sha256:createHash("sha256").update(bytes).digest("hex")});
  }
  const merged = mergeYouTubeLedgers(sources);
  await mkdir(output,{mode:0o700});
  for (const original of originals) await writeFile(join(output,`${original.name}.json`),original.bytes,{flag:"wx",mode:0o600});
  for (const original of originals) {
    const archived = await readFile(join(output,`${original.name}.json`));
    if (createHash("sha256").update(archived).digest("hex") !== original.sha256) throw new Error("Archived ledger verification failed; sharing remains inactive.");
  }
  await writeFile(join(output,"seed.json"),JSON.stringify(merged.seed),{flag:"wx",mode:0o600});
  await writeFile(join(output,"manifest.json"),JSON.stringify({preparedAt:new Date().toISOString(),
    originals:originals.map(({name,sha256})=>({name,sha256})),overflow:merged.overflow,originalSlotCount:merged.originalSlotCount,
    note:"Prepared only. No service was deployed and no device configuration was changed."},null,2),{flag:"wx",mode:0o600});
}
if (isDirectRun(import.meta.url)) {
  const args = process.argv.slice(2);
  if(args.length!==4) throw new Error("Usage: prepare-youtube-shared-ledger <verified-mac-state> <verified-ios-app-ledger> <verified-ios-safari-ledger> <new-output-directory>");
  await prepareSharedYouTubeMigration({mac:resolve(args[0]),"ios-app":resolve(args[1]),"ios-safari":resolve(args[2])},resolve(args[3]));
  console.log("Three original ledgers backed up and a conservative migration seed prepared. Sharing remains inactive.");
}
