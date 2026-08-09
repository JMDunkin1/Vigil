import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  isBlankNewJournalDraft,
  shouldConfirmJournalDraftOnViewExit,
  shouldLockJournalOnViewExit
} from "../public/journal-lock.js";

assert.equal(shouldLockJournalOnViewExit("journal", "home", 0, true), true);
assert.equal(shouldLockJournalOnViewExit("journal", "settings", 0, true), true);
assert.equal(shouldLockJournalOnViewExit("journal", "home", 5, true), false);
assert.equal(shouldLockJournalOnViewExit("home", "journal", 0, true), false);
assert.equal(shouldLockJournalOnViewExit("journal", "home", 0, false), false);
assert.equal(shouldConfirmJournalDraftOnViewExit(true, true, false), true);
assert.equal(shouldConfirmJournalDraftOnViewExit(true, true, true), false);
assert.equal(shouldConfirmJournalDraftOnViewExit(true, false, false), false);
assert.equal(shouldConfirmJournalDraftOnViewExit(false, true, false), false);
assert.equal(isBlankNewJournalDraft("", "", ""), true);
assert.equal(isBlankNewJournalDraft("", "  ", "\n"), true);
assert.equal(isBlankNewJournalDraft("", "A title", ""), false);
assert.equal(isBlankNewJournalDraft("", "", "Some writing"), false);
assert.equal(isBlankNewJournalDraft("saved-entry", "", ""), false);

const html = await readFile("public/index.html", "utf8");
assert.doesNotMatch(html, /data-view(?:-target)?="journal"|journalEntryForm|journalSecurityForm/u, "Journal must not remain in the focused renderer");

const appSource = await readFile("public/app.js", "utf8");
assert.doesNotMatch(appSource, /journal-lock|journalEntryForm|bindJournal|unlockJournal/u, "the active renderer must not initialize Journal compatibility code");
