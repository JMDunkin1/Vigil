import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  administratorAppleScript,
  locallyRebuildableSignaturesMatch,
  protectedAvailabilityIsRunning,
  setupSystemGuardian
} from "../src/guardianSetup.js";
import type {
  GuardianSetupAdminRequest,
  GuardianSetupOperations,
  GuardianSetupRequest
} from "../src/guardianSetup.js";
import type { GuardianMaintenanceReadiness } from "../src/updateMaintenance.js";
import { SYSTEM_GUARDIAN_SCRIPT_PATH } from "../src/updateMaintenance.js";

const execFileAsync = promisify(execFile);

const legacyReadiness: GuardianMaintenanceReadiness = {
  ready: false,
  guardianInstalled: true,
  reason: "legacy-protocol",
  setupRequired: true,
  setupSupported: true,
  message: "Guardian setup required"
};
const readyReadiness: GuardianMaintenanceReadiness = {
  ready: true,
  guardianInstalled: true,
  reason: "ready",
  setupRequired: false,
  setupSupported: false,
  message: null
};
const request: GuardianSetupRequest = {
  sourceAppPath: "/private/tmp/Vigil Setup.app",
  targetAppPath: "/Applications/Vigil.app",
  targetHome: "/Users/test-user",
  targetUid: 501,
  targetUser: "test-user",
  electronPath: "/private/tmp/Vigil Setup.app/Contents/MacOS/Vigil",
  installerPath: "/private/tmp/Vigil Setup.app/Contents/Resources/app.asar.unpacked/dist/runtime/scripts/install-system-guardian.mjs"
};
const guardianBytes = Buffer.from("legacy guardian bytes", "utf8");
const sourceCdHash = "a".repeat(40);
const targetCdHash = "b".repeat(40);
let readinessReads = 0;
let availabilityChecks = 0;
let signatureChecks = 0;
let adminRequest: GuardianSetupAdminRequest | null = null;
const setupEvents: string[] = [];
const operations = fakeOperations({
  readiness: async () => readinessReads++ === 0 ? legacyReadiness : readyReadiness,
  verifyMatchingSignedApps: async () => {
    signatureChecks += 1;
    return { sourceCdHash, targetCdHash };
  },
  assertProtectedAvailability: async () => { availabilityChecks += 1; },
  preflight: async () => { setupEvents.push("preflight"); },
  runAdministrator: async (value) => {
    setupEvents.push("administrator");
    adminRequest = value;
  }
});
const result = await setupSystemGuardian(request, operations);
assert.equal(result.ok, true);
assert.equal(result.canceled, false);
assert.equal(result.readiness.reason, "ready");
assert.equal(readinessReads, 2, "setup must verify readiness again after the privileged helper exits");
assert.equal(signatureChecks, 1, "the setup and installed bundles must be matched before authorization");
assert.equal(availabilityChecks, 2, "Vigil and its user supervisor must remain online across setup");
assert.deepEqual(setupEvents, ["preflight", "administrator"],
  "the exact privileged migration must pass read-only preflight before macOS requests a password");
assert.ok(adminRequest, "legacy setup must request one native administrator transaction");
assert.equal(
  (adminRequest as GuardianSetupAdminRequest).expectedCurrentGuardianSha256,
  createHash("sha256").update(guardianBytes).digest("hex"),
  "root activation must be pinned to the exact guardian bytes inspected before the prompt"
);
assert.equal((adminRequest as GuardianSetupAdminRequest).targetAppPath, "/Applications/Vigil.app");
assert.equal((adminRequest as GuardianSetupAdminRequest).expectedSourceCdHash, sourceCdHash);
assert.equal((adminRequest as GuardianSetupAdminRequest).expectedTargetCdHash, targetCdHash);
assert.equal((adminRequest as GuardianSetupAdminRequest).requireNormalUpdateCompatibility, false,
  "guardian-only migration must not claim that older canonical-parent protocols can authorize an immediate update");

let blockedPreflightAdminCalls = 0;
await assert.rejects(
  setupSystemGuardian(request, fakeOperations({
    preflight: async () => {
      throw new Error(
        "Vigil guardian preflight failed: check=guardian.predecessor.topology detail=The v5 guardian path is unsafe."
      );
    },
    runAdministrator: async () => { blockedPreflightAdminCalls += 1; }
  })),
  /check=guardian\.predecessor\.topology.*v5 guardian path is unsafe/u,
  "a deterministic predecessor blocker must be reported exactly before authentication"
);
assert.equal(blockedPreflightAdminCalls, 0, "failed preflight must never request an administrator password");

const protocolBootstrapToken = "12345678-1234-4123-8123-123456789abc";
const protocolBootstrapExpectedUpdateCommit = "c".repeat(40);
let bridgeReadinessReads = 0;
let bridgeAdminCalls = 0;
let bridgeAdminRequest: GuardianSetupAdminRequest | null = null;
const bridgeResult = await setupSystemGuardian({
  ...request,
  protocolBootstrap: {
    token: protocolBootstrapToken,
    expectedUpdateCommit: protocolBootstrapExpectedUpdateCommit
  }
}, fakeOperations({
  readiness: async () => bridgeReadinessReads++ === 0 ? legacyReadiness : readyReadiness,
  runAdministrator: async (value) => {
    bridgeAdminCalls += 1;
    bridgeAdminRequest = value;
  }
}));
assert.equal(bridgeResult.ok, true);
assert.equal(bridgeAdminCalls, 1,
  "the updater-protocol bridge must mint its root authorization in the same one-time administrator transaction as guardian refresh");
assert.equal(bridgeReadinessReads, 2,
  "the bridge must verify the newly installed guardian after the single administrator transaction");
assert.equal((bridgeAdminRequest as GuardianSetupAdminRequest | null)?.protocolBootstrapToken, protocolBootstrapToken);
assert.equal(
  (bridgeAdminRequest as GuardianSetupAdminRequest | null)?.protocolBootstrapExpectedUpdateCommit,
  protocolBootstrapExpectedUpdateCommit,
  "root authorization must pin the exact follow-on update that remains actionable after bridging"
);
assert.equal((bridgeAdminRequest as GuardianSetupAdminRequest | null)?.authorizationOnly, false,
  "the first migration must add the current parallel guardian without replacing any running predecessor");

let absentGuardianAdminRequest: GuardianSetupAdminRequest | null = null;
await setupSystemGuardian({
  ...request,
  protocolBootstrap: {
    token: protocolBootstrapToken,
    expectedUpdateCommit: protocolBootstrapExpectedUpdateCommit
  }
}, fakeOperations({
  stat: async (path) => {
    if (path === SYSTEM_GUARDIAN_SCRIPT_PATH) {
      const error = new Error("missing parallel guardian") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    }
    return path.endsWith(".app") ? directoryStat() : fileStat();
  },
  runAdministrator: async (value) => { absentGuardianAdminRequest = value; }
}));
assert.equal(
  (absentGuardianAdminRequest as GuardianSetupAdminRequest | null)?.expectedCurrentGuardianSha256,
  "absent",
  "the first current-protocol install must pin the expected absence of its new script path"
);

let currentGuardianAdminCalls = 0;
let currentGuardianReadinessReads = 0;
let currentGuardianAdminRequest: GuardianSetupAdminRequest | null = null;
const currentGuardianResult = await setupSystemGuardian({
    ...request,
    protocolBootstrap: {
      token: protocolBootstrapToken,
      expectedUpdateCommit: protocolBootstrapExpectedUpdateCommit
    }
  }, fakeOperations({
    readiness: async () => {
      currentGuardianReadinessReads += 1;
      return readyReadiness;
    },
    runAdministrator: async (value) => {
      currentGuardianAdminCalls += 1;
      currentGuardianAdminRequest = value;
    }
  }));
assert.equal(currentGuardianResult.ok, true);
assert.equal(currentGuardianAdminCalls, 1,
  "a current guardian must support reauthorizing an expired or interrupted exact bridge");
assert.equal(currentGuardianReadinessReads, 2,
  "authorization-only retry must recheck the still-running parallel guardian");
assert.equal((currentGuardianAdminRequest as GuardianSetupAdminRequest | null)?.authorizationOnly, true,
  "retry must replace only the short-lived root grant and never restart either guardian");

let staleGuardianAdminCalls = 0;
await assert.rejects(
  setupSystemGuardian({
    ...request,
    protocolBootstrap: {
      token: protocolBootstrapToken,
      expectedUpdateCommit: protocolBootstrapExpectedUpdateCommit
    }
  }, fakeOperations({
    readiness: async () => legacyReadiness,
    runAdministrator: async () => { staleGuardianAdminCalls += 1; }
  })),
  /guardian setup required/iu,
  "the bridge must fail closed if the single privileged transaction does not leave a current ready guardian"
);
assert.equal(staleGuardianAdminCalls, 1,
  "a failed readiness recheck must not loop into repeated administrator prompts");

let canceledAdminCalls = 0;
const canceled = await setupSystemGuardian(request, fakeOperations({
  runAdministrator: async () => {
    canceledAdminCalls += 1;
    throw new Error("User canceled. (-128)");
  }
}));
assert.equal(canceled.ok, false);
assert.equal(canceled.canceled, true);
assert.equal(canceledAdminCalls, 1);
assert.equal(canceled.readiness.reason, "legacy-protocol", "canceling must leave the original readiness authoritative");

let unsupportedAdminCalls = 0;
await assert.rejects(
  setupSystemGuardian(request, fakeOperations({
    readiness: async () => ({
      ...legacyReadiness,
      reason: "unsafe",
      setupSupported: false,
      message: "Guardian is unsafe"
    }),
    runAdministrator: async () => { unsupportedAdminCalls += 1; }
  })),
  /guardian is unsafe/iu
);
assert.equal(unsupportedAdminCalls, 0, "unsafe guardian state must fail before an administrator prompt");

let wrongTargetAdminCalls = 0;
await assert.rejects(
  setupSystemGuardian({ ...request, targetAppPath: "/Applications/Other.app" }, fakeOperations({
    runAdministrator: async () => { wrongTargetAdminCalls += 1; }
  })),
  /unexpected app path/iu
);
assert.equal(wrongTargetAdminCalls, 0, "the renderer or CLI cannot redirect privileged setup to another app");

const appleScript = administratorAppleScript();
assert.equal((appleScript.match(/do shell script/gu) || []).length, 1, "setup must use exactly one native administrator prompt");
assert.match(appleScript, /quoted form of sourceAppPath/u);
assert.match(appleScript, /quoted form of sourceCdHash/u);
assert.match(appleScript, /quoted form of targetCdHash/u);
assert.match(appleScript, /ELECTRON_RUN_AS_NODE=1/u);
assert.match(appleScript, /codesign --verify --deep --strict/u);
assert.match(appleScript, /with administrator privileges/u);
assert.match(appleScript, /--expected-current-script-sha256/u);
assert.match(appleScript, /mktemp -d \/private\/var\/tmp\/tech\.caseline\.vigil\.guardian-setup\.XXXXXX/u,
  "privileged setup must first isolate the signed app in a root-only staging directory");
assert.match(appleScript, /ditto --noqtn/u);
assert.match(appleScript, /codesign --verify --deep --strict \\"\$stage_app\\"/u,
  "the immutable staged bundle must be verified after copying and before any JavaScript runs as root");
assert.match(appleScript, /ELECTRON_RUN_AS_NODE=1 \\"\$stage_app\/Contents\/MacOS\/Vigil\\" \\"\$stage_app\/Contents\/Resources\/app\.asar\.unpacked\/dist\/runtime\/scripts\/install-system-guardian\.mjs\\"/u,
  "the privileged runtime and installer must both come from the verified root-only snapshot");
assert.match(appleScript, /case \\"\$setup_root\\" in \/private\/var\/tmp\/tech\.caseline\.vigil\.guardian-setup\.\*/u,
  "cleanup must remain constrained to the dedicated setup staging prefix");
const stagedHashPin = appleScript.indexOf('staged_cdhash=$(/usr/bin/codesign -dv --verbose=4');
const substitutionGate = appleScript.indexOf('if [ \\"$staged_cdhash\\" != \\"$7\\" ]');
const privilegedJavaScript = appleScript.indexOf("ELECTRON_RUN_AS_NODE=1");
assert.ok(stagedHashPin >= 0 && substitutionGate > stagedHashPin && privilegedJavaScript > substitutionGate,
  "the root shell must reject source or target bundle substitution before executing staged JavaScript");
assert.match(appleScript, /--expected-source-cdhash/u);
assert.match(appleScript, /--expected-target-cdhash/u);
assert.match(appleScript, /--bootstrap-source-app/u);
assert.match(appleScript, /--bootstrap-token/u);
assert.match(appleScript, /--bootstrap-expected-update-commit/u);
assert.match(appleScript, /--require-normal-update-compatibility/u);
const bootstrapShellLine = appleScript.split("\n")
  .find((line) => line.includes("set shellProgram to shellProgram &"));
const bootstrapShellFragment = bootstrapShellLine?.match(/& "(.*)"$/u)?.[1]
  ?.replaceAll('\\"', '"');
assert.ok(bootstrapShellFragment, "the privileged shell must append its bridge authorization arguments");
const shellArguments = [
  request.sourceAppPath,
  request.targetAppPath,
  request.targetHome,
  String(request.targetUid),
  request.targetUser,
  "guardian-sha",
  sourceCdHash,
  targetCdHash,
  protocolBootstrapToken,
  protocolBootstrapExpectedUpdateCommit,
  "false",
  "false"
];
const { stdout: expandedBootstrapArguments } = await execFileAsync("/bin/sh", [
  "-c",
  `/usr/bin/printf '%s\\n' ${bootstrapShellFragment}`,
  "vigil-guardian-setup",
  ...shellArguments
]);
assert.deepEqual(expandedBootstrapArguments.trim().split("\n"), [
  "--bootstrap-source-app",
  request.sourceAppPath,
  "--bootstrap-token",
  protocolBootstrapToken,
  "--bootstrap-expected-update-commit",
  protocolBootstrapExpectedUpdateCommit,
  "--authorization-only",
  "false",
  "--require-normal-update-compatibility",
  "false"
], "the actual /bin/sh positional expansion must preserve the tenth commit and compatibility policy arguments exactly");
if (process.platform === "darwin") {
  const compileRoot = await mkdtemp(join(tmpdir(), "vigil-guardian-applescript-"));
  try {
    await execFileAsync("/usr/bin/osacompile", ["-o", join(compileRoot, "guardian-setup.scpt"), "-e", appleScript]);
  } finally {
    await rm(compileRoot, { recursive: true, force: true });
  }
}

assert.equal(locallyRebuildableSignaturesMatch(
  signature({ adhoc: true }),
  signature({ adhoc: true })
), true, "credential-free ad-hoc local builds must remain refreshable");
assert.equal(locallyRebuildableSignaturesMatch(
  signature({ authorities: ["Vigil Local Code Signing"], designatedRequirement: "identifier vigil and anchor H\"abc\"" }),
  signature({ authorities: ["Vigil Local Code Signing"], designatedRequirement: "identifier vigil and anchor H\"abc\"" })
), true, "the stable local signing certificate must remain refreshable");
assert.equal(locallyRebuildableSignaturesMatch(
  signature({ authorities: ["Vigil Local Code Signing"], designatedRequirement: "identifier vigil and anchor H\"abc\"" }),
  signature({ authorities: ["Vigil Local Code Signing"], designatedRequirement: "identifier vigil and anchor H\"def\"" })
), false, "a certificate reusing the local signing common name must not cross the root setup boundary");
assert.equal(locallyRebuildableSignaturesMatch(
  signature({ authorities: ["Apple Development: Developer A"], teamIdentifier: "TEAM123" }),
  signature({ authorities: ["Apple Development: Developer B"], teamIdentifier: "TEAM123" })
), true, "Apple Development builds from the same team must remain refreshable");
assert.equal(locallyRebuildableSignaturesMatch(
  signature({ authorities: ["Apple Development: Developer A"], teamIdentifier: "TEAM123" }),
  signature({ authorities: ["Apple Development: Developer B"], teamIdentifier: "TEAM999" })
), false, "unrelated Apple Development identities must not cross the root setup boundary");
const developerIdRequirement = "identifier \"tech.caseline.vigil\" and anchor apple generic and certificate leaf[subject.OU] = TEAM123";
const developerIdAuthority = "Developer ID Application: CaseLine LLC (TEAM123)";
assert.equal(locallyRebuildableSignaturesMatch(
  signature({
    authorities: [developerIdAuthority, "Developer ID Certification Authority", "Apple Root CA"],
    designatedRequirement: developerIdRequirement,
    teamIdentifier: "TEAM123"
  }),
  signature({
    authorities: [developerIdAuthority, "Developer ID Certification Authority", "Apple Root CA"],
    designatedRequirement: developerIdRequirement,
    teamIdentifier: "TEAM123"
  })
), true, "Developer ID releases with the same exact app trust identity must remain refreshable");
for (const [label, target] of [
  ["team", signature({
    authorities: [developerIdAuthority],
    designatedRequirement: developerIdRequirement,
    teamIdentifier: "TEAM999"
  })],
  ["leaf authority", signature({
    authorities: ["Developer ID Application: Impostor LLC (TEAM123)"],
    designatedRequirement: developerIdRequirement,
    teamIdentifier: "TEAM123"
  })],
  ["designated requirement", signature({
    authorities: [developerIdAuthority],
    designatedRequirement: `${developerIdRequirement} and certificate leaf[subject.CN] = \"Changed\"`,
    teamIdentifier: "TEAM123"
  })],
  ["bundle identifier", signature({
    authorities: [developerIdAuthority],
    designatedRequirement: developerIdRequirement,
    identifier: "tech.caseline.vigil.other",
    teamIdentifier: "TEAM123"
  })],
  ["nonempty team", signature({
    authorities: [developerIdAuthority],
    designatedRequirement: developerIdRequirement
  })]
] as const) {
  assert.equal(locallyRebuildableSignaturesMatch(
    signature({
      authorities: [developerIdAuthority],
      designatedRequirement: developerIdRequirement,
      teamIdentifier: "TEAM123"
    }),
    target
  ), false, `Developer ID ${label} mismatches must not cross the root setup boundary`);
}

assert.equal(protectedAvailabilityIsRunning("state = running\npid = 321\n", "654\n"), true);
assert.equal(protectedAvailabilityIsRunning("state = waiting\npid = 321\n", "654\n"), false,
  "a merely loaded supervisor is not sufficient for guardian replacement");
assert.equal(protectedAvailabilityIsRunning("state = running\n", "654\n"), false,
  "the supervisor must expose a live process id before guardian replacement");
assert.equal(protectedAvailabilityIsRunning("state = running\npid = 321\n", ""), false,
  "the protected app itself must still be running before guardian replacement");

function fakeOperations(overrides: Partial<GuardianSetupOperations> = {}): GuardianSetupOperations {
  let readinessCount = 0;
  return {
    readiness: async () => readinessCount++ === 0 ? legacyReadiness : readyReadiness,
    canonicalPath: async (path) => path,
    stat: async (path) => path.endsWith(".app") ? directoryStat() : fileStat(),
    read: async () => guardianBytes,
    verifyMatchingSignedApps: async () => ({ sourceCdHash, targetCdHash }),
    assertProtectedAvailability: async () => undefined,
    preflight: async () => undefined,
    runAdministrator: async () => undefined,
    ...overrides
  };
}

function fileStat(): Stats {
  return {
    isFile: () => true,
    isDirectory: () => false,
    isSymbolicLink: () => false,
    uid: 0,
    mode: 0o100755
  } as Stats;
}

function directoryStat(): Stats {
  return {
    isFile: () => false,
    isDirectory: () => true,
    isSymbolicLink: () => false,
    uid: 501,
    mode: 0o40755
  } as Stats;
}

function signature({
  adhoc = false,
  authorities = [],
  designatedRequirement = "",
  identifier = "tech.caseline.vigil",
  teamIdentifier = ""
}: {
  adhoc?: boolean;
  authorities?: string[];
  designatedRequirement?: string;
  identifier?: string;
  teamIdentifier?: string;
}) {
  return {
    adhoc,
    authorities,
    cdHash: sourceCdHash,
    designatedRequirement,
    identifier,
    teamIdentifier
  };
}
