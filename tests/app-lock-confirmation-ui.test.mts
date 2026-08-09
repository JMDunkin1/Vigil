import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const appSource = await readFile("public/app.js", "utf8");
const renderAppLocks = section(appSource, "function renderAppLocks", "function configureAppLockUnlockButton");
const configureUnlock = section(appSource, "function configureAppLockUnlockButton", "async function requestAppLockUnlock");

assert.match(
  renderAppLocks,
  /pendingRules\.find\(\(rule\) => rule\.pendingRequest\?\.id === selectedAppLockRequestId\)/u,
  "app-lock rendering must keep one explicit pending-request selection"
);
assert.match(
  renderAppLocks,
  /selectedRule\?\.pendingRequest\?\.challenge/u,
  "the displayed challenge must come from the selected pending request"
);
assert.match(
  renderAppLocks,
  /selectedRule\?\.name \|\| "App lock"[\s\S]*?selectedChallenge\.text/u,
  "the challenge prompt must identify the app lock whose request is selected"
);
assert.match(
  renderAppLocks,
  /selected: rule\.pendingRequest\?\.id === selectedAppLockRequestId/u,
  "each row must decide whether it owns the shared confirmation controls by request id"
);
assert.match(
  configureUnlock,
  /if \(!confirmation\.selected\)[\s\S]*?button\.addEventListener\("click", confirmation\.select\);[\s\S]*?return;/u,
  "an unselected pending row must select its own request instead of confirming with another row's challenge"
);
assert.match(
  configureUnlock,
  /confirmAppLockUnlock\(rule, pendingRequest\)/u,
  "confirmation must keep the selected rule paired with its own pending request"
);
assert.match(
  appSource,
  /requestId: pendingRequest\.id,[\s\S]*?challengeText: \$\("#appLockChallengeInput"\)\.value/u,
  "confirmation must submit the selected request id with the challenge currently bound to it"
);

function section(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing source marker: ${start}`);
  assert.notEqual(endIndex, -1, `missing source marker: ${end}`);
  return source.slice(startIndex, endIndex);
}
