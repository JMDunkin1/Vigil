import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VigilState } from "../src/types.js";

const dataDir = await mkdtemp(join(tmpdir(), "vigil-invalid-state-"));
await chmod(dataDir, 0o755);
process.env.VIGIL_DATA_DIR = dataDir;

const malformed = Buffer.from('{"version": 1, "settings": ', "utf8");
const oldSeal = Buffer.from('{"algorithm":"hmac-sha256","digest":"old-evidence"}\n', "utf8");
await writeFile(join(dataDir, "state.json"), malformed);
await writeFile(join(dataDir, "state.seal.json"), oldSeal);

const [store, { integrityLockdownActive }, seal] = await Promise.all([
  import("../src/store.js"),
  import("../src/integrityLockdown.js"),
  import("../src/seal.js")
]);

try {
  const recovered = await store.loadState();
  assert.equal(integrityLockdownActive(recovered), true);
  assert.equal(Boolean(recovered.integrity.stateSeal.tamperDetectedAt), true);
  assert.match(recovered.integrity.stateSeal.tamperDetail || "", /invalid.*quarantined/i);

  const names = await readdir(dataDir);
  const evidenceName = names.find((name) => /^state\.corrupt\..+\.json$/u.test(name) && !name.endsWith(".seal.json"));
  const sealEvidenceName = names.find((name) => /^state\.corrupt\..+\.seal\.json$/u.test(name));
  assert.ok(evidenceName, "the malformed state bytes must be quarantined");
  assert.ok(sealEvidenceName, "the prior seal must be preserved with the corrupt state");
  assert.deepEqual(await readFile(join(dataDir, evidenceName)), malformed);
  assert.deepEqual(await readFile(join(dataDir, sealEvidenceName)), oldSeal);
  assert.equal((await stat(join(dataDir, evidenceName))).mode & 0o777, 0o600);

  const recoveredText = await readFile(store.STATE_PATH, "utf8");
  const persisted = JSON.parse(recoveredText) as VigilState;
  assert.equal(Boolean(persisted.integrity.stateSeal.tamperDetectedAt), true);
  assert.equal(integrityLockdownActive(persisted), true);
  assert.equal((await seal.verifyStateTextSeal(recoveredText, {
    keyPath: store.STATE_SEAL_KEY_PATH,
    sealPath: store.STATE_SEAL_PATH
  })).ok, true);

  const secondLoad = await store.loadState();
  assert.equal(integrityLockdownActive(secondLoad), true, "the fail-closed alarm must survive restart");
  const secondNames = await readdir(dataDir);
  assert.equal(secondNames.filter((name) => /^state\.corrupt\..+\.json$/u.test(name) && !name.endsWith(".seal.json")).length, 1);
} finally {
  await rm(dataDir, { recursive: true, force: true });
}
