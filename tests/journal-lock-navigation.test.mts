import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { shouldConfirmJournalDraftOnViewExit, shouldLockJournalOnViewExit } from "../public/journal-lock.js";

assert.equal(shouldLockJournalOnViewExit("journal", "home", 0, true), true);
assert.equal(shouldLockJournalOnViewExit("journal", "settings", 0, true), true);
assert.equal(shouldLockJournalOnViewExit("journal", "home", 5, true), false);
assert.equal(shouldLockJournalOnViewExit("home", "journal", 0, true), false);
assert.equal(shouldLockJournalOnViewExit("journal", "home", 0, false), false);
assert.equal(shouldConfirmJournalDraftOnViewExit(true, true), true);
assert.equal(shouldConfirmJournalDraftOnViewExit(true, false), false);
assert.equal(shouldConfirmJournalDraftOnViewExit(false, true), false);

const html = await readFile("public/index.html", "utf8");
assert.match(html, /<option value="0" selected>When I leave Journal<\/option>/u);

const appSource = await readFile("public/app.js", "utf8");
assert.match(appSource, /shouldConfirmJournalDraftOnViewExit[\s\S]*?window\.confirm\("Leave Journal and discard your unsaved entry\?"\)/u);
const appEventsSource = await readFile("public/app-events.js", "utf8");
assert.match(appEventsSource, /const journalForm = \$\("#journalEntryForm"\)[\s\S]*?trackFormChanges\(journalForm\)/u);
