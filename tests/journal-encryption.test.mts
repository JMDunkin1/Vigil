import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = await mkdtemp(join(tmpdir(), "vigil-journal-encryption-"));
await chmod(dataDir, 0o755);
process.env.VIGIL_DATA_DIR = dataDir;

const [{ defaultState }, encryption, store] = await Promise.all([
  import("../src/defaults.js"),
  import("../src/journalEncryption.js"),
  import("../src/store.js")
]);

try {
  const state = defaultState();
  state.intentionalUse.journalEntries = [{
    id: "private-entry",
    title: "A title that must not appear on disk",
    body: "A private body that must not appear on disk",
    mood: "",
    energy: null,
    tags: [],
    behaviorIds: [],
    ruleIds: [],
    createdAt: "2026-07-13T06:00:00.000Z",
    updatedAt: "2026-07-13T06:00:00.000Z",
    entryDate: "2026-07-13T06:00:00.000Z"
  }];

  await store.saveState(state);
  const storedText = await readFile(store.STATE_PATH, "utf8");
  const stored = JSON.parse(storedText) as Record<string, unknown>;
  const intentionalUse = stored.intentionalUse as Record<string, unknown>;
  assert.equal("journalEntries" in intentionalUse, false);
  assert.equal(typeof intentionalUse.journalEntriesEncrypted, "object");
  assert.doesNotMatch(storedText, /A title that must not appear on disk|A private body that must not appear on disk/);
  assert.equal((await stat(encryption.journalEncryptionKeyPath(dataDir))).mode & 0o777, 0o600);

  const loaded = await store.loadState();
  assert.equal(loaded.intentionalUse.journalEntries[0]?.title, "A title that must not appear on disk");
  assert.equal(loaded.intentionalUse.journalEntries[0]?.body, "A private body that must not appear on disk");

  const encrypted = await encryption.encryptJournalEntries([{ title: "Tamper test" }], dataDir);
  encrypted.ciphertext = `${encrypted.ciphertext.slice(0, -2)}AA`;
  await assert.rejects(
    encryption.decryptJournalEntries(encrypted, dataDir),
    /could not decrypt the journal archive/i
  );
} finally {
  await rm(dataDir, { recursive: true, force: true });
}
