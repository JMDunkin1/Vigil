import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultState } from "../src/defaults.js";
import { addIntentionalJournalEntry, intentionalUseSummary } from "../src/intentionalUse.js";
import {
  journalVaultSummary,
  requireJournalVaultSession,
  revokeJournalVaultSession,
  setJournalVaultAutoLockMinutes,
  unlockJournalVaultWithTouchId
} from "../src/journalVault.js";
import { getTouchIdSecret, touchIdSecretPath } from "../src/touchIdAuth.js";

const now = new Date("2026-07-10T12:00:00-04:00");
const state = defaultState();
addIntentionalJournalEntry(state, {
  title: "Private reflection",
  body: "This body must not leak through the dashboard."
}, now);

const publicSummary = intentionalUseSummary(state, {}, now);
assert.deepEqual(publicSummary.lifeLog.entries, []);
assert.equal(publicSummary.lifeLog.stats.totalEntries, 1);
assert.equal(journalVaultSummary(state).configured, true);

const configured = setJournalVaultAutoLockMinutes(state, {
  autoLockMinutes: 10
});
assert.equal(configured.configured, true);
assert.equal(configured.autoLockMinutes, 10);
assert.throws(() => requireJournalVaultSession(state, {}, now), /Unlock the journal/);

const tempDataDir = await mkdtemp(join(tmpdir(), "vigil-touch-id-"));
try {
  const firstSecret = await getTouchIdSecret(tempDataDir);
  const secondSecret = await getTouchIdSecret(tempDataDir);
  assert.equal(firstSecret, secondSecret);
  assert.equal((await readFile(touchIdSecretPath(tempDataDir), "utf8")).trim(), firstSecret);
  assert.equal((await stat(touchIdSecretPath(tempDataDir))).mode & 0o777, 0o600);
  const touchSession = await unlockJournalVaultWithTouchId(state, {
    "x-vigil-touch-id-secret": firstSecret
  }, now, tempDataDir);
  assert.equal(touchSession.method, "touch-id");
  assert.equal(requireJournalVaultSession(state, {
    "x-vigil-journal-token": touchSession.token
  }, new Date(now.getTime() + 9 * 60_000))?.method, "touch-id");
  assert.throws(() => requireJournalVaultSession(state, {
    "x-vigil-journal-token": touchSession.token
  }, new Date(now.getTime() + 11 * 60_000)), /Unlock the journal/);
  const secondSession = await unlockJournalVaultWithTouchId(state, {
    "x-vigil-touch-id-secret": firstSecret
  }, now, tempDataDir);
  assert.equal(revokeJournalVaultSession({ "x-vigil-journal-token": secondSession.token }), true);
  await assert.rejects(() => unlockJournalVaultWithTouchId(state, {
    "x-vigil-touch-id-secret": "wrong"
  }, now, tempDataDir), /not accepted/);
} finally {
  await rm(tempDataDir, { recursive: true, force: true });
}
