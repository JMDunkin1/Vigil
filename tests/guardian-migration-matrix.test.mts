import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  CURRENT_GUARDIAN_PROTOCOL,
  GUARDIAN_PROTOCOLS,
  SUPPORTED_PREDECESSOR_GUARDIAN_PROTOCOLS,
  guardianProtocolForTopology
} from "../src/guardianProtocol.js";
import { toPlist } from "../src/plist.js";
import { SYSTEM_GUARDIAN_SAFETY_ARG } from "../src/systemGuardian.js";
import {
  normalParentCommandCompatibilityBlockers,
  predecessorAvailabilityProgramMatches,
  predecessorGuardianContentMatches,
  predecessorGuardianProgramFingerprint
} from "../scripts/install-system-guardian.mjs";
import {
  HISTORICAL_GUARDIAN_PROGRAMS,
  HISTORICAL_GUARDIAN_TEST_CONFIG
} from "./fixtures/guardian-historical-programs.mjs";
import {
  GUARDIAN_MIGRATION_CASE_FIXTURES,
  HISTORICAL_GUARDIAN_PROTOCOL_FIXTURES
} from "./fixtures/guardian-protocol-history.mjs";

const historicalDescriptors = HISTORICAL_GUARDIAN_PROTOCOL_FIXTURES.filter(
  ({ current }) => !current
);
const descriptorByKey = new Map(GUARDIAN_PROTOCOLS.map((protocol) => [protocol.key, protocol]));
const fixtureByKey = new Map(historicalDescriptors.map((protocol) => [protocol.key, protocol]));
const executablePath = `${HISTORICAL_GUARDIAN_TEST_CONFIG.appPath}/Contents/MacOS/Vigil`;
const backgroundParentCommand =
  `${executablePath} --vigil-background ${SYSTEM_GUARDIAN_SAFETY_ARG}`;

assert.equal(CURRENT_GUARDIAN_PROTOCOL.key, "v8", "the migration destination must be protocol v8");
assert.deepEqual(
  GUARDIAN_MIGRATION_CASE_FIXTURES.map(({ fromKey, toKey }) => `${fromKey}->${toKey}`),
  ["legacy->v8", "v3->v8", "v4->v8", "v5->v8", "v6->v8", "v7->v8"],
  "the deterministic matrix must cover every checked-in predecessor generation"
);
assert.deepEqual(
  [...Object.keys(HISTORICAL_GUARDIAN_PROGRAMS)].sort(),
  GUARDIAN_MIGRATION_CASE_FIXTURES.map(({ fromKey }) => fromKey).sort(),
  "every migration case must have exact historical guardian program bytes"
);
assert.deepEqual(
  SUPPORTED_PREDECESSOR_GUARDIAN_PROTOCOLS.map(({ key }) => key),
  ["v7", "v6", "v5", "v4", "v3", "legacy"],
  "v8 must discover every supported historical guardian, newest first"
);

for (const migration of GUARDIAN_MIGRATION_CASE_FIXTURES) {
  const descriptor = descriptorByKey.get(migration.fromKey);
  const fixture = fixtureByKey.get(migration.fromKey);
  assert.ok(descriptor, `${migration.fromKey} must exist in the runtime protocol registry`);
  assert.ok(fixture, `${migration.fromKey} must exist in the independent protocol fixture`);
  assert.equal(migration.toKey, CURRENT_GUARDIAN_PROTOCOL.key);
  assert.deepEqual(
    descriptor,
    fixture,
    `${migration.fromKey}->v8 must retain its exact historical schema and provenance`
  );
  assert.equal(
    SUPPORTED_PREDECESSOR_GUARDIAN_PROTOCOLS.filter(
      ({ key }) => key === migration.fromKey
    ).length,
    1,
    `${migration.fromKey} must occur exactly once in v8 predecessor discovery`
  );

  const program = HISTORICAL_GUARDIAN_PROGRAMS[migration.fromKey];
  assert.equal(
    Buffer.byteLength(program, "utf8"),
    migration.programBytes,
    `${migration.fromKey} fixture bytes must remain exact`
  );
  assert.equal(
    createHash("sha256").update(program, "utf8").digest("hex"),
    migration.fixtureProgramSha256,
    `${migration.fromKey} checked-in program bytes must match their raw fixture SHA-256`
  );
  assert.match(program, /^#!\/bin\/zsh\n/u);
  assert.equal(
    predecessorAvailabilityProgramMatches(program),
    true,
    `${migration.fromKey} must retain an enforcing availability loop`
  );
  assert.equal(
    predecessorGuardianProgramFingerprint(program, descriptor),
    descriptor.programSha256,
    `${migration.fromKey} exact historical bytes must match the pinned normalized SHA-256`
  );
  assert.match(descriptor.programSha256 || "", /^[a-f0-9]{64}$/u);
  assert.match(descriptor.sourceCommit || "", /^[a-f0-9]{40}$/u);

  const candidate = {
    label: descriptor.label,
    plistPath: descriptor.plistPath,
    scriptPath: descriptor.scriptPath
  };
  const plist = historicalGuardianPlist(candidate);
  assert.equal(
    predecessorGuardianContentMatches(
      program,
      plist,
      candidate,
      HISTORICAL_GUARDIAN_TEST_CONFIG
    ),
    true,
    `${migration.fromKey}->v8 must accept its exact script, schema, configuration, and root topology`
  );
  assert.equal(
    guardianProtocolForTopology(candidate),
    descriptor,
    `${migration.fromKey} must resolve only through its exact three-part topology`
  );

  for (const [field, value] of [
    ["label", `${candidate.label}.substituted`],
    ["plistPath", `${candidate.plistPath}.substituted`],
    ["scriptPath", `${candidate.scriptPath}.substituted`]
  ] as const) {
    const substitutedCandidate = { ...candidate, [field]: value };
    assert.equal(
      guardianProtocolForTopology(substitutedCandidate),
      null,
      `${migration.fromKey} must reject a substituted ${field}`
    );
    assert.equal(
      predecessorGuardianContentMatches(
        program,
        plist,
        substitutedCandidate,
        HISTORICAL_GUARDIAN_TEST_CONFIG
      ),
      false,
      `${migration.fromKey}->v8 must fail closed on a substituted ${field}`
    );
  }

  const configuredMutation = replaceOne(
    program,
    `target_uid=${HISTORICAL_GUARDIAN_TEST_CONFIG.targetUid}\n`,
    `target_uid=${HISTORICAL_GUARDIAN_TEST_CONFIG.targetUid + 1}\n`
  );
  assert.equal(
    predecessorGuardianProgramFingerprint(configuredMutation, descriptor),
    descriptor.programSha256,
    `${migration.fromKey}'s normalized hash intentionally excludes deployment assignments`
  );
  assert.equal(
    predecessorGuardianContentMatches(
      configuredMutation,
      plist,
      candidate,
      HISTORICAL_GUARDIAN_TEST_CONFIG
    ),
    false,
    `${migration.fromKey}->v8 must separately reject a wrong deployment assignment`
  );

  const duplicateAssignment = replaceOne(
    program,
    `target_uid=${HISTORICAL_GUARDIAN_TEST_CONFIG.targetUid}\n`,
    `target_uid=${HISTORICAL_GUARDIAN_TEST_CONFIG.targetUid}\n`
      + `target_uid=${HISTORICAL_GUARDIAN_TEST_CONFIG.targetUid}\n`
  );
  assert.equal(
    predecessorGuardianProgramFingerprint(duplicateAssignment, descriptor),
    "",
    `${migration.fromKey} must reject an ambiguous duplicated dynamic assignment`
  );
  assert.equal(
    predecessorGuardianContentMatches(
      duplicateAssignment,
      plist,
      candidate,
      HISTORICAL_GUARDIAN_TEST_CONFIG
    ),
    false
  );

  const staticByteMutation = replaceOne(
    program,
    "# VIGIL SAFETY BOUNDARY:",
    "# VIGIL SAFETY BOUNDARY MUTATED:"
  );
  assert.notEqual(
    predecessorGuardianProgramFingerprint(staticByteMutation, descriptor),
    descriptor.programSha256,
    `${migration.fromKey} must reject a static guardian-program mutation`
  );
  assert.equal(
    predecessorGuardianContentMatches(
      staticByteMutation,
      plist,
      candidate,
      HISTORICAL_GUARDIAN_TEST_CONFIG
    ),
    false
  );

  const revisionMutation = descriptor.revision === null
    ? replaceOne(program, "#!/bin/zsh\n", "#!/bin/zsh\n# vigil-system-guardian-revision=8\n")
    : replaceOne(
        program,
        `# vigil-system-guardian-revision=${descriptor.revision}\n`,
        `# vigil-system-guardian-revision=${descriptor.revision + 1}\n`
      );
  assert.equal(
    predecessorGuardianContentMatches(
      revisionMutation,
      plist,
      candidate,
      HISTORICAL_GUARDIAN_TEST_CONFIG
    ),
    false,
    `${migration.fromKey}->v8 must reject a substituted protocol revision`
  );

  assert.ok(program.includes(descriptor.recoveryAuthorizationKind));
  const schemaKindMutation = program.replaceAll(
    descriptor.recoveryAuthorizationKind,
    `${descriptor.recoveryAuthorizationKind}-substituted`
  );
  assert.equal(
    predecessorGuardianContentMatches(
      schemaKindMutation,
      plist,
      candidate,
      HISTORICAL_GUARDIAN_TEST_CONFIG
    ),
    false,
    `${migration.fromKey}->v8 must reject a substituted recovery schema kind`
  );

  for (const [description, mutatedPlist] of [
    [
      "label",
      historicalGuardianPlist({ ...candidate, label: `${candidate.label}.substituted` })
    ],
    [
      "script argument",
      historicalGuardianPlist({ ...candidate, scriptPath: `${candidate.scriptPath}.substituted` })
    ],
    [
      "non-root user override",
      plist.replace("</dict>", "<key>UserName</key><string>migration-fixture</string></dict>")
    ],
    [
      "disabled KeepAlive",
      replaceOne(
        plist,
        "  <key>KeepAlive</key>\n  <true/>",
        "  <key>KeepAlive</key>\n  <false/>"
      )
    ],
    [
      "weakened relaunch throttle",
      replaceOne(
        plist,
        "  <key>ThrottleInterval</key>\n  <integer>5</integer>",
        "  <key>ThrottleInterval</key>\n  <integer>3600</integer>"
      )
    ]
  ] as const) {
    assert.equal(
      predecessorGuardianContentMatches(
        program,
        mutatedPlist,
        candidate,
        HISTORICAL_GUARDIAN_TEST_CONFIG
      ),
      false,
      `${migration.fromKey}->v8 must reject a ${description}`
    );
  }

  assert.equal(
    migration.bootstrapClaim,
    descriptor.bootstrapClaimKind !== null && descriptor.bootstrapClaimPath !== null,
    `${migration.fromKey} must preserve its historical bootstrap-claim schema`
  );
  assert.equal(descriptor.recoveryProtocol, migration.recoveryProtocol);
  assert.equal(
    normalParentCommandCompatibilityBlockers(
      [descriptor],
      backgroundParentCommand,
      executablePath,
      true
    ).length,
    0,
    `${migration.fromKey}->v8 must accept the protected background parent command`
  );
  assert.deepEqual(
    normalParentCommandCompatibilityBlockers(
      [descriptor],
      executablePath,
      executablePath,
      true
    ).map(({ key }) => key),
    migration.canonicalParentBlocked ? [migration.fromKey] : [],
    `${migration.fromKey}->v8 must enforce its historical canonical-parent policy`
  );
  assert.equal(
    normalParentCommandCompatibilityBlockers(
      [descriptor],
      executablePath,
      executablePath,
      false
    ).length,
    0,
    `${migration.fromKey} setup-only migration must not be confused with immediate update authorization`
  );
}

const mixedCanonicalBlockers = normalParentCommandCompatibilityBlockers(
  (["legacy", "v3", "v5", "v6", "v7"] as const).map((key) => {
    const descriptor = descriptorByKey.get(key);
    assert.ok(descriptor);
    return descriptor;
  }),
  executablePath,
  executablePath,
  true
);
assert.deepEqual(
  mixedCanonicalBlockers.map(({ key }) => key),
  ["v3", "v5"],
  "a mixed migration must report every and only loaded background-only predecessor"
);

assert.equal(CURRENT_GUARDIAN_PROTOCOL.programSha256, null);
assert.equal(CURRENT_GUARDIAN_PROTOCOL.sourceCommit, null);
assert.equal(CURRENT_GUARDIAN_PROTOCOL.current, true);
assert.equal(
  new Set(
    [CURRENT_GUARDIAN_PROTOCOL, ...SUPPORTED_PREDECESSOR_GUARDIAN_PROTOCOLS]
      .map(({ recoveryAuthorizationPath }) => recoveryAuthorizationPath)
  ).size,
  7,
  "v8 and every checked-in predecessor must keep recovery attestations isolated"
);
assert.deepEqual(
  GUARDIAN_PROTOCOLS
    .filter(({ bootstrapClaimKind }) => bootstrapClaimKind !== null)
    .map(({ key }) => key),
  ["v3", "v4", "v5", "v6", "v7", "v8"],
  "the bootstrap-claim schema matrix must remain exact"
);
assert.deepEqual(
  GUARDIAN_PROTOCOLS
    .filter(({ maintenanceAuthorizationPath }) =>
      maintenanceAuthorizationPath.endsWith("/maintenance-authorization.plist"))
    .map(({ key }) => key),
  ["legacy", "v3", "v4"],
  "only the intentional pre-v5 protocols may share the original maintenance path"
);

function historicalGuardianPlist(candidate: {
  label: string;
  scriptPath: string;
}): string {
  return toPlist({
    KeepAlive: true,
    Label: candidate.label,
    ProcessType: "Background",
    ProgramArguments: [candidate.scriptPath, SYSTEM_GUARDIAN_SAFETY_ARG],
    RunAtLoad: true,
    StandardErrorPath: "/Library/Application Support/Vigil/System Guardian/guardian.log",
    StandardOutPath: "/Library/Application Support/Vigil/System Guardian/guardian.log",
    ThrottleInterval: 5
  });
}

function replaceOne(source: string, search: string, replacement: string): string {
  const first = source.indexOf(search);
  assert.notEqual(first, -1, `fixture must contain ${JSON.stringify(search)}`);
  assert.equal(
    source.indexOf(search, first + search.length),
    -1,
    `fixture mutation target must be unique: ${JSON.stringify(search)}`
  );
  return `${source.slice(0, first)}${replacement}${source.slice(first + search.length)}`;
}
