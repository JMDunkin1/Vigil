import assert from "node:assert/strict";
import {
  CURRENT_GUARDIAN_PROTOCOL,
  GUARDIAN_PROTOCOLS,
  SUPPORTED_PREDECESSOR_GUARDIAN_PROTOCOLS,
  guardianProtocolForTopology
} from "../src/guardianProtocol.js";
import { HISTORICAL_GUARDIAN_PROTOCOL_FIXTURES } from "./fixtures/guardian-protocol-history.mjs";

assert.deepEqual(
  GUARDIAN_PROTOCOLS,
  HISTORICAL_GUARDIAN_PROTOCOL_FIXTURES,
  "the runtime guardian registry must match the checked-in legacy and v3-v7 historical fixtures"
);

assert.equal(CURRENT_GUARDIAN_PROTOCOL.key, "v8");
assert.deepEqual(
  SUPPORTED_PREDECESSOR_GUARDIAN_PROTOCOLS.map(({ key }) => key),
  ["v7", "v6", "v5", "v4", "v3", "legacy"],
  "predecessor discovery must try every supported older protocol from newest to oldest"
);

for (const protocol of GUARDIAN_PROTOCOLS) {
  assert.equal(Object.isFrozen(protocol), true, `${protocol.key} descriptor must be immutable`);
  assert.equal(Object.isFrozen(protocol.dynamicAssignments), true, `${protocol.key} assignments must be immutable`);
  if (protocol.current) assert.equal(protocol.sourceCommit, null, "unreleased current bytes must not claim historical provenance");
  else assert.match(protocol.sourceCommit || "", /^[a-f0-9]{40}$/u);
  assert.equal(
    guardianProtocolForTopology(protocol),
    protocol,
    `${protocol.key} must be discoverable only by its exact label, plist, and script topology`
  );
  assert.equal(
    guardianProtocolForTopology({ ...protocol, scriptPath: `${protocol.scriptPath}.substituted` }),
    null,
    `${protocol.key} must reject a substituted guardian script path`
  );
}

assert.deepEqual(
  GUARDIAN_PROTOCOLS.filter(({ current }) => current).map(({ key }) => key),
  ["v8"],
  "exactly one guardian protocol must be current"
);
assert.equal(
  new Set(GUARDIAN_PROTOCOLS.map(({ label }) => label)).size,
  GUARDIAN_PROTOCOLS.length,
  "guardian labels must be unique"
);
assert.equal(
  new Set(GUARDIAN_PROTOCOLS.map(({ plistPath }) => plistPath)).size,
  GUARDIAN_PROTOCOLS.length,
  "guardian plists must be unique"
);
assert.equal(
  new Set(GUARDIAN_PROTOCOLS.map(({ scriptPath }) => scriptPath)).size,
  GUARDIAN_PROTOCOLS.length,
  "guardian scripts must be unique"
);
assert.equal(
  new Set(GUARDIAN_PROTOCOLS.map(({ recoveryAuthorizationPath }) => recoveryAuthorizationPath)).size,
  GUARDIAN_PROTOCOLS.length,
  "recovery attestations must remain isolated by guardian protocol"
);

const claimedProtocols = GUARDIAN_PROTOCOLS.filter(
  (protocol) => protocol.bootstrapClaimPath !== null || protocol.bootstrapClaimKind !== null
);
assert.deepEqual(claimedProtocols.map(({ key }) => key), ["v3", "v4", "v5", "v6", "v7", "v8"]);
assert.equal(
  new Set(claimedProtocols.map(({ bootstrapClaimPath }) => bootstrapClaimPath)).size,
  claimedProtocols.length,
  "every versioned guardian must retain its historical bootstrap-claim path"
);
assert.ok(claimedProtocols.every(
  ({ bootstrapClaimKind }) => bootstrapClaimKind === "vigil-root-update-protocol-bootstrap-worker-claim-v1"
));

assert.deepEqual(
  GUARDIAN_PROTOCOLS
    .filter(({ maintenanceAuthorizationPath }) => maintenanceAuthorizationPath.endsWith("/maintenance-authorization.plist"))
    .map(({ key }) => key),
  ["legacy", "v3", "v4"],
  "the intentional shared pre-v5 maintenance path must remain represented"
);
