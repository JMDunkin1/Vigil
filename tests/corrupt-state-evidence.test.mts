import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preserveCorruptStateEvidence } from "../src/corruptStateEvidence.js";

const root = await mkdtemp(join(await realpath(tmpdir()), "sentinel-corrupt-evidence-"));
try {
  const raw = Buffer.from('{"broken":', "utf8");
  const unreadableSealPath = join(root, "state.seal.json");
  await mkdir(unreadableSealPath);

  const result = await preserveCorruptStateEvidence(raw, {
    dataDir: root,
    sealPath: unreadableSealPath
  });

  assert.equal(result.complete, false, "an existing seal must be preserved before quarantine is complete");
  assert.equal(result.stateEvidenceSaved, true, "the partial state evidence copy may be retained");
  assert.equal(result.sealEvidenceSaved, false);
  assert.deepEqual(await readFile(result.stateEvidencePath), raw);
  await assert.rejects(readFile(result.sealEvidencePath), /ENOENT/u);
} finally {
  await rm(root, { recursive: true, force: true });
}
