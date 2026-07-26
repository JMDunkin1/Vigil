import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  GUARDIAN_RETIREMENT_MINIMUM_AGE_MS,
  guardianRetirementBlockers,
  launchctlDisabledStateMatches,
  predecessorRetirementPlistMatches,
  retirementAdministratorAppleScript
} from "../scripts/retire-legacy-guardians.mjs";
import {
  GUARDIAN_PROTOCOL_V7,
  LEGACY_GUARDIAN_PROTOCOL
} from "../src/guardianProtocol.js";
import { toPlist } from "../src/plist.js";

const running = { loaded: true, pid: 42, running: true };
const supervisor = { loaded: true, pid: 84, running: true };
const now = Date.now();

assert.deepEqual(guardianRetirementBlockers({
  currentFirst: running,
  currentSecond: running,
  currentStartedAt: now - GUARDIAN_RETIREMENT_MINIMUM_AGE_MS,
  lockValid: true,
  now,
  predecessors: [{ label: LEGACY_GUARDIAN_PROTOCOL.label, loaded: false }],
  supervisorFirst: supervisor,
  supervisorSecond: supervisor
}), []);

assert.match(guardianRetirementBlockers({
  currentFirst: running,
  currentSecond: { ...running, pid: 43 },
  currentStartedAt: now - GUARDIAN_RETIREMENT_MINIMUM_AGE_MS + 1,
  lockValid: false,
  now,
  predecessors: [{ label: LEGACY_GUARDIAN_PROTOCOL.label, loaded: true }],
  supervisorFirst: supervisor,
  supervisorSecond: { ...supervisor, running: false }
}).join(" "), /updater lock[\s\S]*current system guardian[\s\S]*embedded supervisor[\s\S]*minimum healthy generation age[\s\S]*never terminated/u);

function guardianPlist(label: string, scriptPath: string): string {
  return toPlist({
    KeepAlive: true,
    Label: label,
    ProcessType: "Background",
    ProgramArguments: [
      scriptPath,
      "--vigil-safety-boundary-do-not-terminate-or-bootout"
    ],
    RunAtLoad: true,
    StandardErrorPath: "/Library/Application Support/Vigil/System Guardian/guardian.log",
    StandardOutPath: "/Library/Application Support/Vigil/System Guardian/guardian.log",
    ThrottleInterval: 5
  });
}

assert.equal(
  predecessorRetirementPlistMatches(
    guardianPlist(LEGACY_GUARDIAN_PROTOCOL.label, LEGACY_GUARDIAN_PROTOCOL.scriptPath),
    LEGACY_GUARDIAN_PROTOCOL
  ),
  true
);
assert.equal(
  predecessorRetirementPlistMatches(
    guardianPlist(GUARDIAN_PROTOCOL_V7.label, `${GUARDIAN_PROTOCOL_V7.scriptPath}.substituted`),
    GUARDIAN_PROTOCOL_V7
  ),
  false,
  "retirement must never remove a launchd definition that points outside its exact historical topology"
);
assert.equal(launchctlDisabledStateMatches(
  'disabled services = {\n\t"tech.caseline.vigil.system-guardian.v7" => disabled\n}',
  GUARDIAN_PROTOCOL_V7.label
), true);
assert.equal(launchctlDisabledStateMatches(
  'disabled services = {\n\t"tech.caseline.vigil.system-guardian.v7" => enabled\n}',
  GUARDIAN_PROTOCOL_V7.label
), false);

const sourceRoot = existsSync(join(process.cwd(), "scripts", "retire-legacy-guardians.mts"))
  ? resolve(process.cwd())
  : resolve(process.cwd(), "..", "..");
const source = await readFile(join(sourceRoot, "scripts", "retire-legacy-guardians.mts"), "utf8");
const administratorScript = retirementAdministratorAppleScript();
assert.match(administratorScript, /with administrator privileges[\s\S]*Vigil and its current protections stay online/u);
assert.match(administratorScript, /quoted form of nodePath[\s\S]*quoted form of workerPath[\s\S]*quoted form of lockToken/u,
  "the privileged worker command must quote every variable path and authorization value");
assert.doesNotMatch(source, /launchctl", \["bootout"|launchctl", \["kickstart"|process\.kill/u,
  "generation retirement must never stop or signal a Vigil availability process");
assert.match(source, /mkdtemp\("\/private\/var\/tmp\/tech\.caseline\.vigil\.guardian-retirement\."[\s\S]*?cp\(runtimeRoot, stagedRuntime[\s\S]*?acquireUpdaterLock/u,
  "the worker must be staged outside privacy-protected source folders before administrator approval");
assert.match(source, /acquireUpdaterLock[\s\S]*?retirementAdministratorAppleScript[\s\S]*?finally \{[\s\S]*?lock\.release[\s\S]*?rm\(stageRoot/u,
  "the user coordinator must exclude updates for the full privileged retirement transaction");
assert.match(source, /writeRetirementReceipt\(receipt\)[\s\S]*?runLaunchctl\(\["disable"[\s\S]*?await rm\(plan\.plistPath\)/u,
  "a durable prepared receipt must precede disabling and removing inactive definitions");
assert.match(source, /if \(predecessor\.loaded\)[\s\S]*?refused to terminate loaded predecessor/u,
  "retirement must fail closed if any predecessor becomes loaded");
assert.match(source, /assertProtectionContinuity[\s\S]*?receipt\.phase = "complete"/u,
  "current guardian and supervisor continuity must be rechecked before completion");
