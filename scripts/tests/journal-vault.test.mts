import assert from "node:assert/strict";

import { defaultState } from "../../src/defaults.js";
import { addIntentionalJournalEntry, intentionalUseSummary } from "../../src/intentionalUse.js";
import {
  journalVaultSummary,
  requireJournalVaultSession,
  revokeJournalVaultSession,
  setJournalVaultPassword,
  unlockJournalVaultWithPassword,
  unlockJournalVaultWithTouchId,
  verifyJournalVaultPassword
} from "../../src/journalVault.js";

const now = new Date("2026-07-10T12:00:00-04:00");
const state = defaultState();
addIntentionalJournalEntry(state, {
  title: "Private reflection",
  body: "This body must not leak through the dashboard."
}, now);

const publicSummary = intentionalUseSummary(state, {}, now);
assert.deepEqual(publicSummary.lifeLog.entries, []);
assert.equal(publicSummary.lifeLog.stats.totalEntries, 1);
assert.equal(journalVaultSummary(state).configured, false);

const configured = setJournalVaultPassword(state, {
  password: "ora-et-labora",
  autoLockMinutes: 10
}, now);
assert.equal(configured.configured, true);
assert.equal(configured.autoLockMinutes, 10);
assert.equal(state.intentionalUse.journalVault.passwordHash.includes("ora-et-labora"), false);
assert.equal(verifyJournalVaultPassword(state.intentionalUse.journalVault, "ora-et-labora"), true);
assert.equal(verifyJournalVaultPassword(state.intentionalUse.journalVault, "wrong-password"), false);

assert.throws(() => unlockJournalVaultWithPassword(state, { password: "wrong-password" }, now), /incorrect/);
const passwordSession = unlockJournalVaultWithPassword(state, { password: "ora-et-labora" }, now);
assert.equal(passwordSession.method, "password");
assert.equal(requireJournalVaultSession(state, {
  "x-vigil-journal-token": passwordSession.token
}, new Date(now.getTime() + 9 * 60_000))?.method, "password");
assert.throws(() => requireJournalVaultSession(state, {
  "x-vigil-journal-token": passwordSession.token
}, new Date(now.getTime() + 11 * 60_000)), /Unlock the journal/);

const secondSession = unlockJournalVaultWithPassword(state, { password: "ora-et-labora" }, now);
assert.equal(revokeJournalVaultSession({ "x-vigil-journal-token": secondSession.token }), true);
assert.throws(() => requireJournalVaultSession(state, {
  "x-vigil-journal-token": secondSession.token
}, now), /Unlock the journal/);

const previousSecret = process.env.VIGIL_TOUCH_ID_SECRET;
process.env.VIGIL_TOUCH_ID_SECRET = "test-touch-id-secret";
const touchSession = unlockJournalVaultWithTouchId(state, {
  "x-vigil-touch-id-secret": "test-touch-id-secret"
}, now);
assert.equal(touchSession.method, "touch-id");
assert.throws(() => unlockJournalVaultWithTouchId(state, {
  "x-vigil-touch-id-secret": "wrong"
}, now), /not accepted/);
if (previousSecret === undefined) delete process.env.VIGIL_TOUCH_ID_SECRET;
else process.env.VIGIL_TOUCH_ID_SECRET = previousSecret;

assert.throws(() => setJournalVaultPassword(state, {
  currentPassword: "wrong-password",
  password: "new-password"
}, now), /Current journal password is incorrect/);
