import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = existsSync(join(process.cwd(), "scripts", "supervise-ios-preserving-layout.mjs"))
  ? process.cwd()
  : resolve(process.cwd(), "..", "..");

const [apply, restore, supervise, watch] = await Promise.all([
  readFile(join(root, "scripts", "apply-ios-usb-profile.mjs"), "utf8"),
  readFile(join(root, "scripts", "restore-ios-home-layout.mjs"), "utf8"),
  readFile(join(root, "scripts", "supervise-ios-preserving-layout.mjs"), "utf8"),
  readFile(join(root, "scripts", "watch-ios-usb-profile.mjs"), "utf8")
]);

assert.match(apply, /--require-checkpoint/u);
assert.match(apply, /--supervisor-keybag/u);
assert.match(apply, /readLayoutPaths\(\{/u);
assert.match(
  apply,
  /async function verifyCheckpoint[\s\S]*?await validateRestorableBackupPayload\(\{[\s\S]*?backupPath: backupRoot,[\s\S]*?password,[\s\S]*?pythonPath: PYIOSBACKUP_PYTHON_PATH,[\s\S]*?timeoutMs: PAYLOAD_VALIDATION_TIMEOUT_MS[\s\S]*?async function verifyBackupDevice/u,
  "required recovery checkpoints must receive a password-aware deep payload traversal"
);
assert.ok(
  apply.indexOf("await verifyCheckpoint(checkpoint.path, udid, options.password)")
    < apply.indexOf("await requireSupervisorKeybag(options.supervisorKeybag)"),
  "checkpoint payload validation must finish before keybag handling or any device/profile mutation"
);
assert.match(apply, /hasActivePhonePolicy/u);
assert.match(apply, /removeProfile\(udid, supervisorKeybagPath\)/u);
assert.match(apply, /"usbmux", "list", "--usb"/u);
assert.doesNotMatch(apply, /create-keybag/u);
assert.doesNotMatch(apply, /["']supervise["']/u);

assert.match(restore, /--yes-restore-layout/u);
assert.match(restore, /Mobilebackup2Service/u);
assert.match(restore, /backup\._include_escrow_bag = False/u);
assert.match(restore, /reboot=False/u);
assert.match(restore, /remove=False/u);
assert.match(restore, /skip_apps=True/u);
assert.match(restore, /pair-supervised/u);
assert.match(
  restore,
  /async function validateLayoutRestorePayload[\s\S]*?await validateRestorableBackupPayload\(\{[\s\S]*?backupPath: join\(payloadRoot, udid\),[\s\S]*?password,[\s\S]*?pythonPath: PYIOSBACKUP_PYTHON_PATH,[\s\S]*?timeoutMs: RESTORE_TIMEOUT_MS/u,
  "the pruned no-remove restore payload must receive a password-aware deep traversal"
);
const restoreValidationIndex = restore.indexOf("await validateLayoutRestorePayload(payloadRoot, udid, options.password)");
const restorePairingIndex = restore.indexOf("await ensureRestorePairing(udid, options.supervisorKeybag)");
const restoreMutationIndex = restore.indexOf("await restoreLayoutPayload(udid, payloadRoot, options.password)");
assert.ok(
  restoreValidationIndex >= 0
    && restoreValidationIndex < restorePairingIndex
    && restorePairingIndex < restoreMutationIndex,
  "the pruned payload must pass deep validation before restore pairing and backup2 restore"
);

assert.match(supervise, /--yes-supervise-and-restore/u);
assert.match(supervise, /backup2",\s*"backup"/u);
assert.match(supervise, /"--full"/u);
assert.match(supervise, /profile",\s*"create-keybag"/u);
assert.match(supervise, /profile",\s*"supervise"/u);
assert.match(supervise, /CloudConfigurationDetails\.plist/u);
assert.match(supervise, /waitForCloudConfigurationCleared/u);
assert.match(supervise, /backup2",\s*"restore"/u);
assert.match(supervise, /"--no-remove"/u);
assert.match(supervise, /"--skip-apps"/u);
assert.match(supervise, /isSupervisedCloud\(restoredCloud\)/u);
assert.match(supervise, /pair-supervised/u);
assert.match(supervise, /apply-ios-usb-profile\.mjs/u);
assert.match(supervise, /--require-checkpoint/u);

assert.match(watch, /apply-ios-usb-profile\.mjs/u);
assert.match(watch, /--supervisor-keybag/u);
assert.match(watch, /--require-checkpoint/u);
assert.doesNotMatch(watch, /["']supervise["']/u);
