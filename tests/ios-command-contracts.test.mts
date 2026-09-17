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

// These commands may inspect or prepare recovery data, but must never restore
// a supervised device or reinstate the retired two-restore enrollment flow.
assert.doesNotMatch(restore, /await backup\.restore\(|pair-supervised|_include_escrow_bag/u);
assert.doesNotMatch(supervise, /"backup2"|create-keybag|"supervise"/u);
assert.match(supervise, /apply-ios-usb-profile\.mjs/u);
assert.match(supervise, /--require-checkpoint/u);

assert.match(watch, /apply-ios-usb-profile\.mjs/u);
assert.match(watch, /--supervisor-keybag/u);
assert.match(watch, /--require-checkpoint/u);
assert.doesNotMatch(watch, /["']supervise["']/u);
