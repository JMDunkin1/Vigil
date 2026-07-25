import assert from "node:assert/strict";
import { systemGuardianScript } from "../src/systemGuardian.js";

const script = systemGuardianScript({
  appPath: "/Applications/Vigil.app",
  targetHome: "/Users/test-user",
  targetUid: 501,
  targetUser: "test-user"
});

assert.match(
  script,
  /Vigil guardian check failed: check=\$last_guardian_check detail=\$last_guardian_detail/u,
  "the guardian log must identify the exact failed check instead of emitting one generic attestation message"
);
assert.doesNotMatch(
  script,
  /could not attest the updater's durable recovery transaction yet/u,
  "the suppressed generic recovery message must not remain"
);
for (const check of [
  "guardian.recovery.manifest.private-target-file",
  "guardian.recovery.manifest.policy-sha256",
  "guardian.recovery.app.initial-identity",
  "guardian.recovery.app.target-identity",
  "guardian.recovery.maintenance-token",
  "guardian.recovery.authorization.write.initial-commit",
  "guardian.recovery.authorization.write.target-cdhash",
  "guardian.recovery.authorization.publish"
]) {
  assert.match(script, new RegExp(check.replaceAll(".", "\\."), "u"), `missing precise guardian diagnostic ${check}`);
}
assert.match(
  script,
  /app_identity_matches_manifest "\$app_path" initial "\$manifest_path" \|\| \{ guardian_check_failed "guardian\.recovery\.app\.initial-identity"[^}]+return 1; \}/u,
  "diagnostic instrumentation must preserve fail-closed return behavior"
);
assert.match(
  script,
  /plutil -insert appTargetCdHash[\s\S]*?guardian_check_failed "guardian\.recovery\.authorization\.write\.target-cdhash"[^}]+return 1;/u,
  "a failed root plist write must stop attestation at its named field"
);
