import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { shouldInstallRemoteUpdate } from "../app/updater.js";
import { atomicInstallBuiltApp, type AppInstallation } from "../scripts/update-packaged-app.mjs";
import {
  assertBootstrapAuthorizationPayload,
  bootstrapUpdateProtocol,
  runtimeReadyMainCommandMatches,
  selectRuntimeReadyMainPid
} from "../scripts/bootstrap-update-protocol.mjs";
import type {
  BootstrapAuthorizationPayload,
  BootstrapBuildIdentity,
  BootstrapUpdaterCapability,
  ProtectedAvailabilitySnapshot,
  UpdateProtocolBootstrapOperations,
  UpdateProtocolBootstrapRequest
} from "../scripts/bootstrap-update-protocol.mjs";
import {
  UPDATE_PROTOCOL_BOOTSTRAP_AUTHORIZATION_KIND,
  UPDATE_PROTOCOL_BOOTSTRAP_AUTHORIZATION_MAX_SECONDS
} from "../src/updateMaintenance.js";

const sourceRoot = existsSync(join(process.cwd(), "scripts", "bootstrap-update-protocol.mts"))
  ? process.cwd()
  : resolve(process.cwd(), "..", "..");
const [bootstrapSource, guardianInstallerSource, guardianSetupSource] = await Promise.all([
  readFile(join(sourceRoot, "scripts", "bootstrap-update-protocol.mts"), "utf8"),
  readFile(join(sourceRoot, "scripts", "install-system-guardian.mts"), "utf8"),
  readFile(join(sourceRoot, "scripts", "setup-system-guardian.mts"), "utf8")
]);

assert.match(bootstrapSource, /atomicInstallBuiltApp\(sourceAppPath, targetAppPath, "", operations\)/u,
  "the online bootstrap must use the existing journaled atomic app replacement primitive");
assert.match(bootstrapSource, /execFileAsync\("\/bin\/cp", \["-ac", source, destination\]/u,
  "the one-time bundle staging copy should use an APFS clone when available");
assert.match(bootstrapSource, /assertExactSignedGeneration\(\s*sourceAppPath, destination, signatures\.sourceCdHash, signatures\.sourceCdHash, sourceBuild\s*\)/u,
  "the cloned candidate must be signature- and build-pinned before atomic activation");
const exactBridgeGenerationVerifier = bootstrapSource.match(
  /async function assertExactBridgeGeneration\([\s\S]*?\n\}\n\nasync function exactBridgeGenerationMatches/u
)?.[0] || "";
assert.equal(
  [...exactBridgeGenerationVerifier.matchAll(/\{ allowAtomicInstallBundlePaths: true \}/gu)].length,
  2,
  "both candidate and baseline branches must accept only the atomic bridge generation names during bootstrap"
);
assert.match(bootstrapSource, /captureAvailability[\s\S]*?AVAILABILITY_STABILITY_MS[\s\S]*?captureAvailability/u,
  "the same live app and supervisor identities must survive a bounded post-activation stability window");
assert.match(bootstrapSource, /beginMaintenance\(lock\)[\s\S]*?installCandidate[\s\S]*?markVerified\(\)[\s\S]*?finalize\(\)[\s\S]*?maintenance\.release/u,
  "an authenticated maintenance marker must cover candidate installation through finalization");
assert.match(guardianSetupSource, /"--lock-path"[\s\S]*?"--lock-token"/u,
  "the signed worker command must expose the exact lock path and token to legacy supervisor authentication");
assert.match(guardianSetupSource, /transferTo\(workerPid\)/u,
  "setup must transfer the held updater lock to the signed bridge worker");
assert.ok(
  guardianSetupSource.indexOf("waitForBootstrapWorkerAuthorization({")
    < guardianSetupSource.indexOf("lock.transferTo(workerPid)"),
  "the root-owned exact relay/worker claim must exist before setup transfers lock ownership"
);
assert.match(bootstrapSource, /publishBootstrapWorkerAuthorizationRequest[\s\S]*?waitForTransferredUpdaterLock/u,
  "the signed worker must publish its exact relay identity before waiting for lock transfer");
assert.match(guardianSetupSource, /relayExecutable[\s\S]*?targetAppPath[\s\S]*?spawn\(relayExecutable/u,
  "the bridge worker must be parented by the installed Vigil launcher for root guardian authorization");
assert.doesNotMatch(guardianSetupSource, /process\.kill|\bkill\b|pkill|killall|bootout|unload/u,
  "the setup relay must never stop or signal Vigil or its supervisors");
assert.doesNotMatch(bootstrapSource, /process\.kill|\bkill\b|pkill|killall|bootout|unload/u,
  "the online protocol bootstrap must never stop or signal Vigil or its supervisors");
assert.match(
  guardianInstallerSource,
  /readPinnedRegularFile\(updaterScriptPath[\s\S]*?assertPackagedUpdaterProtocol\(updaterBytes\.toString\("utf8"\)\)[\s\S]*?updaterScriptSha256: sha256\(updaterBytes\)/u,
  "root authorization must pin the candidate updater bytes only after proving their v3 recovery capability"
);
assert.match(
  guardianInstallerSource,
  /verifyUpdateProtocolBridgeEquivalence\([\s\S]*?bridgeManifestSha256: bridgeEquivalence\.manifestSha256[\s\S]*?bridgePayloadTreeSha256: bridgeEquivalence\.payloadTreeSha256[\s\S]*?bridgeBaselineBuildInfoSha256/u,
  "the privileged installer must independently verify and pin the closed A-equivalent bridge payload"
);
assert.match(
  guardianSetupSource,
  /realpath\(directScript\)[\s\S]*?updateProtocolBridgePayloadModulePath\(sourceAppPath, "scripts\/setup-system-guardian\.mjs"\)[\s\S]*?relayWrapper[\s\S]*?relayPayload/u,
  "the installed relay must bind its fixed signed wrapper to the exact digest-addressed setup payload"
);
assert.match(
  guardianInstallerSource,
  /PACKAGED_UPDATE_RECOVERY_PROTOCOL_REVISION = \$\{UPDATE_PACKAGED_APP_RECOVERY_PROTOCOL_REVISION\}/u,
  "the privileged capability check must require the exact packaged-updater protocol revision"
);

await verifyCachedUpdaterPathFollowsAtomicBundleSwap();

assert.equal(
  selectRuntimeReadyMainPid(101, "101\n909\n"),
  101,
  "runtime-ready evidence must select the main app while the installed-launcher relay is also live"
);
assert.throws(
  () => selectRuntimeReadyMainPid(101, "909\n"),
  /not among the live signed app processes/u,
  "a relay PID must never substitute for a missing runtime-ready main app"
);
assert.equal(
  runtimeReadyMainCommandMatches(
    "/Applications/Vigil.app/Contents/MacOS/Vigil --vigil-background --vigil-safety-boundary-do-not-terminate-or-bootout",
    "/Applications/Vigil.app/Contents/MacOS/Vigil"
  ),
  true
);
assert.equal(
  runtimeReadyMainCommandMatches(
    "/Applications/Vigil.app/Contents/MacOS/Vigil /tmp/setup-system-guardian.mjs --bootstrap-worker-relay true",
    "/Applications/Vigil.app/Contents/MacOS/Vigil"
  ),
  false,
  "the installed launcher relay must not satisfy the main-runtime command identity"
);

const installedCommitA = "a".repeat(40);
const upstreamCommitM = "e".repeat(40);
const checkoutCommitM = upstreamCommitM;
const bridgeBuildCommitF = installedCommitA;
const bridgeMatchesCheckout = bridgeBuildCommitF === checkoutCommitM;
const bridgeMatchesUpstream = bridgeBuildCommitF === upstreamCommitM;
assert.equal(
  shouldInstallRemoteUpdate({
    upstream: upstreamCommitM,
    ahead: 0,
    behind: 0,
    dirty: false
  }, !bridgeMatchesCheckout, bridgeMatchesUpstream),
  true,
  "an A-identity protocol bridge must still offer the clean checkout's newer M"
);

const sourceAppPath = "/private/tmp/vigil-bootstrap-fixture/Vigil.app";
const targetAppPath = "/Applications/Vigil.app";
const account = userInfo();
const request: UpdateProtocolBootstrapRequest = {
  sourceAppPath,
  targetAppPath,
  targetHome: account.homedir,
  targetUid: process.getuid?.() ?? 501,
  targetUser: account.username,
  bootstrapToken: "12345678-1234-4123-8123-123456789abc",
  expectedUpdateCommit: upstreamCommitM
};
const sourceBuild: BootstrapBuildIdentity = {
  commit: bridgeBuildCommitF,
  fingerprint: "b".repeat(64),
  sourceRoot: "/private/tmp/vigil-bootstrap-repo"
};
const targetBuild: BootstrapBuildIdentity = {
  commit: sourceBuild.commit,
  fingerprint: sourceBuild.fingerprint,
  sourceRoot: sourceBuild.sourceRoot
};
const updaterCapability: BootstrapUpdaterCapability = {
  revision: 3,
  sha256: "9".repeat(64),
  bootstrapSha256: "8".repeat(64),
  setupSha256: "7".repeat(64)
};
const bridgeEquivalence = {
  manifestSha256: "2".repeat(64),
  equivalentTreeSha256: "3".repeat(64),
  payloadTreeSha256: "4".repeat(64),
  wrappersSha256: "5".repeat(64),
  baselineBuildInfoSha256: "6".repeat(64)
};
const availability: ProtectedAvailabilitySnapshot = {
  app: { pid: 101, startedAt: "Wed Jul 22 18:00:00 2026" },
  supervisor: { pid: 202, startedAt: "Wed Jul 22 17:00:00 2026" }
};
const authorizationEvidence = {
  sourceAppPath,
  targetAppPath,
  targetHome: request.targetHome,
  targetUid: request.targetUid,
  targetUser: request.targetUser,
  bootstrapToken: request.bootstrapToken,
  expectedUpdateCommit: request.expectedUpdateCommit,
  sourceBuild,
  targetBuild,
  signatures: { sourceCdHash: "c".repeat(40), targetCdHash: "d".repeat(40) },
  updater: updaterCapability,
  bridge: bridgeEquivalence
};
const authorizationModifiedEpoch = 1_000;
const authorizationNowEpoch = 1_001;
const validAuthorization: BootstrapAuthorizationPayload = {
  kind: UPDATE_PROTOCOL_BOOTSTRAP_AUTHORIZATION_KIND,
  token: request.bootstrapToken,
  sourceAppPath,
  targetAppPath,
  repoRoot: sourceBuild.sourceRoot,
  targetHome: request.targetHome,
  targetUid: request.targetUid,
  targetUser: request.targetUser,
  sourceCdHash: authorizationEvidence.signatures.sourceCdHash,
  targetCdHash: authorizationEvidence.signatures.targetCdHash,
  sourceCommit: sourceBuild.commit,
  sourceFingerprint: sourceBuild.fingerprint,
  targetCommit: targetBuild.commit,
  targetFingerprint: targetBuild.fingerprint,
  updaterScriptSha256: updaterCapability.sha256,
  bootstrapScriptSha256: updaterCapability.bootstrapSha256,
  setupScriptSha256: updaterCapability.setupSha256,
  bridgeManifestSha256: bridgeEquivalence.manifestSha256,
  bridgeEquivalentTreeSha256: bridgeEquivalence.equivalentTreeSha256,
  bridgePayloadTreeSha256: bridgeEquivalence.payloadTreeSha256,
  bridgeWrappersSha256: bridgeEquivalence.wrappersSha256,
  bridgeBaselineBuildInfoSha256: bridgeEquivalence.baselineBuildInfoSha256,
  expectedUpdateCommit: request.expectedUpdateCommit,
  createdAtEpoch: authorizationModifiedEpoch,
  expiresAtEpoch: authorizationNowEpoch + 30
};
assert.doesNotThrow(() => assertBootstrapAuthorizationPayload(
  authorizationEvidence,
  validAuthorization,
  authorizationModifiedEpoch,
  authorizationNowEpoch
));
for (const [label, patch] of [
  ["token", { token: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }],
  ["initial generation", { targetCdHash: "e".repeat(40) }],
  ["bridge build", { sourceCommit: "2".repeat(40) }],
  ["updater bytes", { updaterScriptSha256: "7".repeat(64) }],
  ["bootstrap bytes", { bootstrapScriptSha256: "6".repeat(64) }],
  ["setup bytes", { setupScriptSha256: "5".repeat(64) }],
  ["bridge manifest", { bridgeManifestSha256: "7".repeat(64) }],
  ["bridge equivalent tree", { bridgeEquivalentTreeSha256: "7".repeat(64) }],
  ["bridge payload tree", { bridgePayloadTreeSha256: "7".repeat(64) }],
  ["bridge wrappers", { bridgeWrappersSha256: "7".repeat(64) }],
  ["bridge baseline build-info", { bridgeBaselineBuildInfoSha256: "7".repeat(64) }],
  ["follow-on commit", { expectedUpdateCommit: "6".repeat(40) }],
  ["expired grant", { expiresAtEpoch: authorizationNowEpoch - 1 }],
  ["overlong grant", {
    expiresAtEpoch: authorizationModifiedEpoch + UPDATE_PROTOCOL_BOOTSTRAP_AUTHORIZATION_MAX_SECONDS + 1
  }]
] as const) {
  assert.throws(
    () => assertBootstrapAuthorizationPayload(
      authorizationEvidence,
      { ...validAuthorization, ...patch },
      authorizationModifiedEpoch,
      authorizationNowEpoch
    ),
    /does not match/u,
    `root authorization must fail closed on a changed ${label}`
  );
}

const alreadyInstalledEvidence = {
  ...authorizationEvidence,
  targetBuild: sourceBuild,
  signatures: {
    sourceCdHash: authorizationEvidence.signatures.sourceCdHash,
    targetCdHash: authorizationEvidence.signatures.sourceCdHash
  }
};
const freshAlreadyInstalledAuthorization: BootstrapAuthorizationPayload = {
  ...validAuthorization,
  targetCdHash: alreadyInstalledEvidence.signatures.targetCdHash,
  targetCommit: sourceBuild.commit,
  targetFingerprint: sourceBuild.fingerprint
};
assert.doesNotThrow(() => assertBootstrapAuthorizationPayload(
  alreadyInstalledEvidence,
  freshAlreadyInstalledAuthorization,
  authorizationModifiedEpoch,
  authorizationNowEpoch
), "an already-installed F retry must accept only a freshly minted exact F authorization");
assert.throws(() => assertBootstrapAuthorizationPayload(
  alreadyInstalledEvidence,
  validAuthorization,
  authorizationModifiedEpoch,
  authorizationNowEpoch
), /does not match/u, "an old A authorization must never be reused after F is canonical");

const successEvents: string[] = [];
const success = await bootstrapUpdateProtocol(request, fakeOperations(successEvents));
assert.deepEqual(success, {
  ok: true,
  sourceCdHash: "c".repeat(40),
  previousCdHash: "d".repeat(40),
  installedCommit: sourceBuild.commit,
  installedFingerprint: sourceBuild.fingerprint,
  appPid: 101,
  supervisorPid: 202
});
assert.deepEqual(successEvents, [
  "lock",
  "no-recovery",
  "source-directory",
  "target-directory",
  "signed-origin",
  "verify-initial-1",
  "read-source-build",
  "read-target-build",
  "read-source-updater",
  "verify-bridge-initial",
  "verify-initial-2",
  "authorization-before",
  "guardian-before",
  "continuation-before",
  "availability-before",
  "maintenance-begin",
  "install",
  "verify-installed",
  "read-installed-build",
  "read-installed-updater",
  "verify-bridge-installed",
  "guardian-after",
  "continuation-after",
  "availability-immediate",
  "wait-500",
  "availability-stable",
  "verify-premark-1",
  "read-source-build-premark",
  "read-installed-build-premark",
  "read-source-updater-premark",
  "read-installed-updater-premark",
  "verify-bridge-source-premark",
  "verify-bridge-installed-premark",
  "verify-premark-2",
  "guardian-premark",
  "authorization-premark",
  "availability-premark",
  "continuation-premark",
  "mark-verified",
  "finalize",
  "maintenance-release",
  "release"
], "verification and continuity must precede disposal of the rollback generation");
assert.equal(successEvents.filter((event) => event.startsWith("authorization-")).length, 2);
assert.ok(successEvents.lastIndexOf("authorization-premark") < successEvents.indexOf("mark-verified"),
  "authorization must be checked at the pre-mark boundary and never after durable verification");
assert.match(bootstrapSource, /reconcileAtomicInstallResidue\([\s\S]*?alreadyInstalledCandidate/u,
  "an already-installed exact F retry must reconcile trusted residue without reinstalling F");
assert.match(bootstrapSource, /quarantinePartial[\s\S]*?partial bootstrap bundle/u,
  "a failed pre-pin clone must be quarantined instead of deleted or promoted");
assert.match(bootstrapSource, /unexpected bootstrap move/u,
  "every bootstrap move must match a strict old/new generation mapping");

await assertPreinstallGateFailure(
  { signedOriginError: new Error("unsigned bootstrap origin") },
  /unsigned bootstrap origin/u,
  "signed-origin",
  "verify-initial-1"
);
await assertPreinstallGateFailure(
  { updaterCapabilityErrorAtRead: 1 },
  /required v3 updater capability/u,
  "read-source-updater",
  "verify-initial-2"
);
await assertPreinstallGateFailure(
  { changedInitialSignatureAtCheck: 2 },
  /changed while bootstrap evidence/u,
  "verify-initial-2",
  "authorization-before"
);
await assertPreinstallGateFailure(
  { authorizationError: new Error("root authorization mismatch") },
  /root authorization mismatch/u,
  "authorization-before",
  "guardian-before"
);
await assertPreinstallGateFailure(
  { guardianErrorAtCall: 1 },
  /v3 guardian not ready/u,
  "guardian-before",
  "continuation-before"
);
await assertPreinstallGateFailure(
  { continuationErrorAtCall: 1 },
  /follow-on update is not actionable/u,
  "continuation-before",
  "availability-before"
);

const postInstallGuardianEvents: string[] = [];
await assert.rejects(
  bootstrapUpdateProtocol(request, fakeOperations(postInstallGuardianEvents, { guardianErrorAtCall: 2 })),
  /v3 guardian not ready/u,
  "the guardian readiness gate must be rechecked against the live v3 guardian after activation"
);
assert.ok(postInstallGuardianEvents.indexOf("guardian-after") > postInstallGuardianEvents.indexOf("install"));
assert.equal(postInstallGuardianEvents.includes("continuation-after"), false);
assert.ok(postInstallGuardianEvents.indexOf("rollback") > postInstallGuardianEvents.indexOf("guardian-after"));

const postInstallContinuationEvents: string[] = [];
await assert.rejects(
  bootstrapUpdateProtocol(request, fakeOperations(postInstallContinuationEvents, { continuationErrorAtCall: 2 })),
  /follow-on update is not actionable/u,
  "the exact follow-on update must remain actionable after the bridge app is activated"
);
assert.ok(postInstallContinuationEvents.indexOf("continuation-after") > postInstallContinuationEvents.indexOf("guardian-after"));
assert.ok(postInstallContinuationEvents.indexOf("rollback") > postInstallContinuationEvents.indexOf("continuation-after"));

const preMarkGuardianEvents: string[] = [];
await assert.rejects(
  bootstrapUpdateProtocol(request, fakeOperations(preMarkGuardianEvents, { guardianErrorAtCall: 3 })),
  /v3 guardian not ready/u,
  "guardian readiness must remain true at the final pre-mark boundary"
);
assert.ok(preMarkGuardianEvents.indexOf("guardian-premark") > preMarkGuardianEvents.indexOf("verify-premark-2"));
assert.equal(preMarkGuardianEvents.includes("continuation-premark"), false);
assert.ok(preMarkGuardianEvents.indexOf("maintenance-release") > preMarkGuardianEvents.indexOf("rollback"));

const preMarkContinuationEvents: string[] = [];
await assert.rejects(
  bootstrapUpdateProtocol(request, fakeOperations(preMarkContinuationEvents, { continuationErrorAtCall: 3 })),
  /follow-on update is not actionable/u,
  "the source continuation must remain actionable immediately before verification"
);
assert.ok(preMarkContinuationEvents.indexOf("continuation-premark") > preMarkContinuationEvents.indexOf("guardian-premark"));
assert.ok(preMarkContinuationEvents.indexOf("continuation-premark") > preMarkContinuationEvents.indexOf("availability-premark"));
assert.equal(preMarkContinuationEvents.includes("mark-verified"), false);

const preMarkAuthorizationEvents: string[] = [];
await assert.rejects(
  bootstrapUpdateProtocol(request, fakeOperations(preMarkAuthorizationEvents, { authorizationErrorAtCall: 2 })),
  /root authorization mismatch at pre-mark/u,
  "the exact root grant must be re-read at the final pre-mark boundary"
);
assert.ok(preMarkAuthorizationEvents.indexOf("authorization-premark") > preMarkAuthorizationEvents.indexOf("guardian-premark"));
assert.equal(preMarkAuthorizationEvents.includes("availability-premark"), false);
assert.equal(preMarkAuthorizationEvents.includes("continuation-premark"), false);
assert.equal(preMarkAuthorizationEvents.includes("mark-verified"), false);
assert.ok(preMarkAuthorizationEvents.indexOf("maintenance-release") > preMarkAuthorizationEvents.indexOf("rollback"));

const changedPreMarkSourceEvents: string[] = [];
await assert.rejects(
  bootstrapUpdateProtocol(request, fakeOperations(changedPreMarkSourceEvents, { changedSourceBuildAtRead: 2 })),
  /final verification boundary/u,
  "the signed source build must be re-read and remain exact at pre-mark"
);
assert.ok(changedPreMarkSourceEvents.indexOf("read-source-build-premark") > changedPreMarkSourceEvents.indexOf("availability-stable"));
assert.equal(changedPreMarkSourceEvents.includes("guardian-premark"), false);
assert.ok(changedPreMarkSourceEvents.indexOf("maintenance-release") > changedPreMarkSourceEvents.indexOf("rollback"));

const changedInstalledUpdaterEvents: string[] = [];
await assert.rejects(
  bootstrapUpdateProtocol(request, fakeOperations(changedInstalledUpdaterEvents, {
    installedUpdaterCapability: { ...updaterCapability, sha256: "8".repeat(64) }
  })),
  /exact signed v3 bridge app/u,
  "the updater capability re-read at the canonical path must match the exact authorized bytes"
);
assert.ok(changedInstalledUpdaterEvents.indexOf("rollback") > changedInstalledUpdaterEvents.indexOf("read-installed-updater"));

const rollbackEvents: string[] = [];
const changedSupervisor = fakeOperations(rollbackEvents, {
  availability: [
    availability,
    { ...availability, supervisor: { pid: 303, startedAt: "Wed Jul 22 18:10:00 2026" } }
  ]
});
await assert.rejects(
  bootstrapUpdateProtocol(request, changedSupervisor),
  /changed process identity/u,
  "a supervisor identity change must reject the online bootstrap"
);
assert.equal(rollbackEvents.at(-1), "release", "a failed bootstrap must always release the updater lock");
assert.ok(rollbackEvents.indexOf("mark-verified") > rollbackEvents.indexOf("availability-immediate"));
assert.equal(rollbackEvents.includes("rollback"), false,
  "process replacement must never put old bundle bytes underneath a process that may have mapped the candidate");
assert.equal(rollbackEvents.includes("finalize"), true,
  "availability failure must finalize the verified candidate so a legacy supervisor cannot promote bridge residue later");
assert.ok(rollbackEvents.indexOf("maintenance-release") > rollbackEvents.indexOf("finalize"),
  "authenticated maintenance must remain active until availability-failure finalization finishes");

const changedMainProcessEvents: string[] = [];
const changedMainProcess = fakeOperations(changedMainProcessEvents, {
  availability: [
    availability,
    { ...availability, app: { pid: 303, startedAt: "Wed Jul 22 18:10:00 2026" } }
  ]
});
await assert.rejects(
  bootstrapUpdateProtocol(request, changedMainProcess),
  /changed process identity/u,
  "replacement of the exact original main app PID must reject the online bootstrap"
);
assert.ok(changedMainProcessEvents.indexOf("mark-verified") > changedMainProcessEvents.indexOf("availability-immediate"));
assert.equal(changedMainProcessEvents.includes("rollback"), false);

const reusedMainPidEvents: string[] = [];
await assert.rejects(
  bootstrapUpdateProtocol(request, fakeOperations(reusedMainPidEvents, {
    availability: [
      availability,
      { ...availability, app: { ...availability.app, startedAt: "Wed Jul 22 18:10:00 2026" } }
    ]
  })),
  /changed process identity/u,
  "PID reuse must not inherit the original main-process identity"
);
assert.ok(reusedMainPidEvents.indexOf("mark-verified") > reusedMainPidEvents.indexOf("availability-immediate"));

const nestedSourcePath = join(targetAppPath, "Contents", "Resources", "Protocol Bridge.app");
const nestedSourceRequest: UpdateProtocolBootstrapRequest = {
  ...request,
  sourceAppPath: nestedSourcePath
};
const nestedSourceEvents: string[] = [];
await assert.rejects(
  bootstrapUpdateProtocol(nestedSourceRequest, fakeOperations(nestedSourceEvents)),
  /disjoint/iu,
  "the signed source app must not be nested inside the canonical installed app"
);
assert.deepEqual(nestedSourceEvents, [], "obvious path overlap must be rejected before even acquiring the updater lock");

for (const sidecarSuffix of [".vigil-next", ".vigil-previous"]) {
  const sidecarSourcePath = join(`${targetAppPath}${sidecarSuffix}`, "Protocol Bridge.app");
  const sidecarEvents: string[] = [];
  await assert.rejects(
    bootstrapUpdateProtocol({
      ...request,
      sourceAppPath: sidecarSourcePath
    }, fakeOperations(sidecarEvents)),
    /disjoint/iu,
    `the bootstrap source must not be nested inside the ${sidecarSuffix} transaction sidecar`
  );
  assert.deepEqual(sidecarEvents, [],
    "a transaction-sidecar source must be rejected before cleanup or lock acquisition can touch it");
}

const userDataSourceEvents: string[] = [];
await assert.rejects(
  bootstrapUpdateProtocol({
    ...request,
    sourceAppPath: join(
      request.targetHome,
      "Library", "Application Support", "Vigil", "Protocol Bridge.app"
    )
  }, fakeOperations(userDataSourceEvents)),
  /disjoint/iu,
  "the signed source app must not be nested inside the updater transaction directory"
);
assert.deepEqual(userDataSourceEvents, [],
  "user-data/source overlap must fail before acquiring the updater lock");

const recoveryEvents: string[] = [];
const recoveryBlocked = fakeOperations(recoveryEvents, { recoveryError: new Error("pending recovery") });
await assert.rejects(bootstrapUpdateProtocol(request, recoveryBlocked), /pending recovery/u);
assert.deepEqual(recoveryEvents, ["lock", "no-recovery", "release"],
  "a pending recovery transaction must block before any app or signature operation");

interface FakeOptions {
  availability?: ProtectedAvailabilitySnapshot[];
  authorizationError?: Error;
  authorizationErrorAtCall?: number;
  changedSourceBuildAtRead?: number;
  changedInitialSignatureAtCheck?: number;
  continuationErrorAtCall?: number;
  guardianErrorAtCall?: number;
  installedUpdaterCapability?: BootstrapUpdaterCapability;
  recoveryError?: Error;
  signedOriginError?: Error;
  updaterCapabilityErrorAtRead?: number;
}

async function assertPreinstallGateFailure(
  options: FakeOptions,
  message: RegExp,
  reachedEvent: string,
  forbiddenNextEvent: string
): Promise<void> {
  const events: string[] = [];
  await assert.rejects(bootstrapUpdateProtocol(request, fakeOperations(events, options)), message);
  assert.equal(events.includes(reachedEvent), true, `expected ${reachedEvent} to run`);
  assert.equal(events.includes(forbiddenNextEvent), false,
    `${forbiddenNextEvent} must not run after ${reachedEvent} fails`);
  assert.equal(events.includes("install"), false, "every authorization and readiness gate must pass before installation");
  assert.equal(events.at(-1), "release", "a rejected pre-install gate must release the exact updater lock");
}

async function verifyCachedUpdaterPathFollowsAtomicBundleSwap(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "vigil-bootstrap-cached-updater-"));
  const candidateAppPath = join(root, "candidate", "Vigil.app");
  const installedAppPath = join(root, "installed", "Vigil.app");
  const updaterRelativePath = join(
    "Contents",
    "Resources",
    "app.asar.unpacked",
    "dist",
    "runtime",
    "scripts",
    "update-packaged-app.mjs"
  );
  const cachedCanonicalUpdaterPath = join(installedAppPath, updaterRelativePath);
  try {
    await Promise.all([
      mkdir(dirname(join(candidateAppPath, updaterRelativePath)), { recursive: true }),
      mkdir(dirname(cachedCanonicalUpdaterPath), { recursive: true })
    ]);
    await Promise.all([
      writeFile(join(candidateAppPath, updaterRelativePath), "export const generation = 'new';\n"),
      writeFile(cachedCanonicalUpdaterPath, "export const generation = 'old';\n")
    ]);
    assert.equal(await readFile(cachedCanonicalUpdaterPath, "utf8"), "export const generation = 'old';\n");

    const installation = await atomicInstallBuiltApp(candidateAppPath, installedAppPath, "");
    assert.equal(
      await readFile(cachedCanonicalUpdaterPath, "utf8"),
      "export const generation = 'new';\n",
      "a pathname cached by the live old controller must resolve to the newly activated updater bytes"
    );
    assert.equal(
      await readFile(join(`${installedAppPath}.vigil-previous`, updaterRelativePath), "utf8"),
      "export const generation = 'old';\n",
      "the atomic swap must retain the old bytes only in the rollback generation"
    );
    await installation.markVerified();
    await installation.finalize();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function fakeOperations(
  events: string[],
  options: FakeOptions = {}
): UpdateProtocolBootstrapOperations {
  let signatureChecks = 0;
  let installedSignatureChecks = 0;
  let installed = false;
  let guardianChecks = 0;
  let continuationChecks = 0;
  let authorizationChecks = 0;
  let updaterReads = 0;
  let sourceBuildReads = 0;
  let targetBuildReads = 0;
  let availabilityReads = 0;
  const installation: AppInstallation = {
    async attachStateSnapshot() { events.push("attach-state"); },
    async markVerified() { events.push("mark-verified"); },
    async finalize() { events.push("finalize"); },
    async rollback() { events.push("rollback"); }
  };
  return {
    async canonicalDirectory(path, label) {
      events.push(label.startsWith("bootstrap") ? "source-directory" : "target-directory");
      return path;
    },
    async assertSignedOrigin() {
      events.push("signed-origin");
      if (options.signedOriginError) throw options.signedOriginError;
    },
    async verifyMatchingApps() {
      signatureChecks += 1;
      if (!installed) {
        events.push(`verify-initial-${signatureChecks}`);
        return {
          sourceCdHash: "c".repeat(40),
          targetCdHash: options.changedInitialSignatureAtCheck === signatureChecks
            ? "e".repeat(40)
            : "d".repeat(40)
        };
      }
      installedSignatureChecks += 1;
      events.push(installedSignatureChecks === 1
        ? "verify-installed"
        : `verify-premark-${installedSignatureChecks - 1}`);
      return { sourceCdHash: "c".repeat(40), targetCdHash: "c".repeat(40) };
    },
    async readBuildIdentity(path) {
      if (path === sourceAppPath) {
        sourceBuildReads += 1;
        events.push(sourceBuildReads === 1 ? "read-source-build" : "read-source-build-premark");
        return options.changedSourceBuildAtRead === sourceBuildReads
          ? { ...sourceBuild, fingerprint: "4".repeat(64) }
          : sourceBuild;
      }
      targetBuildReads += 1;
      events.push(!installed
        ? "read-target-build"
        : targetBuildReads === 2
          ? "read-installed-build"
          : "read-installed-build-premark");
      return installed ? sourceBuild : targetBuild;
    },
    async readUpdaterCapability(path) {
      updaterReads += 1;
      events.push(path === sourceAppPath
        ? updaterReads === 1 ? "read-source-updater" : "read-source-updater-premark"
        : updaterReads === 2 ? "read-installed-updater" : "read-installed-updater-premark");
      if (options.updaterCapabilityErrorAtRead === updaterReads) {
        throw new Error("required v3 updater capability is missing");
      }
      return path === targetAppPath && installed && options.installedUpdaterCapability
        ? options.installedUpdaterCapability
        : updaterCapability;
    },
    async verifyBridgeEquivalence(installedApp, candidateApp, verificationOptions) {
      if (!installed) {
        events.push("verify-bridge-initial");
        assert.equal(installedApp, targetAppPath);
        assert.equal(candidateApp, sourceAppPath);
        assert.equal(verificationOptions, undefined);
      } else if (candidateApp === sourceAppPath) {
        events.push("verify-bridge-source-premark");
        assert.equal(installedApp, null);
        assert.equal(verificationOptions, undefined);
      } else {
        events.push(events.includes("verify-bridge-installed")
          ? "verify-bridge-installed-premark"
          : "verify-bridge-installed");
        assert.equal(installedApp, `${targetAppPath}.vigil-previous`);
        assert.equal(candidateApp, targetAppPath);
        assert.deepEqual(verificationOptions, { allowAtomicInstallBundlePaths: true });
      }
      return bridgeEquivalence;
    },
    async assertBootstrapAuthorization(evidence) {
      authorizationChecks += 1;
      events.push(authorizationChecks === 1 ? "authorization-before" : "authorization-premark");
      assert.equal(evidence.sourceAppPath, sourceAppPath);
      assert.equal(evidence.targetAppPath, targetAppPath);
      assert.equal(evidence.bootstrapToken, request.bootstrapToken);
      assert.equal(evidence.expectedUpdateCommit, request.expectedUpdateCommit);
      assert.deepEqual(evidence.sourceBuild, sourceBuild);
      assert.deepEqual(evidence.targetBuild, targetBuild);
      assert.deepEqual(evidence.updater, updaterCapability);
      assert.deepEqual(evidence.bridge, bridgeEquivalence);
      if (options.authorizationError || options.authorizationErrorAtCall === authorizationChecks) {
        throw options.authorizationError || new Error("root authorization mismatch at pre-mark");
      }
      return { cdHash: "d".repeat(40), build: targetBuild };
    },
    async assertGuardianReady() {
      guardianChecks += 1;
      events.push(guardianChecks === 1
        ? "guardian-before"
        : guardianChecks === 2
          ? "guardian-after"
          : "guardian-premark");
      if (options.guardianErrorAtCall === guardianChecks) throw new Error("v3 guardian not ready");
    },
    async assertUpdateContinuation(observedSourceBuild, expectedUpdateCommit) {
      continuationChecks += 1;
      events.push(continuationChecks === 1
        ? "continuation-before"
        : continuationChecks === 2
          ? "continuation-after"
          : "continuation-premark");
      assert.deepEqual(observedSourceBuild, sourceBuild);
      assert.equal(expectedUpdateCommit, request.expectedUpdateCommit);
      if (options.continuationErrorAtCall === continuationChecks) {
        throw new Error("follow-on update is not actionable");
      }
    },
    async acquireLock() {
      events.push("lock");
      return {
        path: join(request.targetHome, "Library", "Application Support", "Vigil", "updater", "update.lock"),
        token: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        ownerPid: process.pid,
        async release() { events.push("release"); }
      };
    },
    async beginMaintenance(lock) {
      events.push("maintenance-begin");
      assert.equal(lock.token, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
      assert.equal(lock.ownerPid, process.pid);
      return { async release() { events.push("maintenance-release"); } };
    },
    async assertNoRecoveryTransaction() {
      events.push("no-recovery");
      if (options.recoveryError) throw options.recoveryError;
    },
    async captureAvailability() {
      availabilityReads += 1;
      events.push(availabilityReads === 1
        ? "availability-before"
        : availabilityReads === 2
          ? "availability-immediate"
          : availabilityReads === 3
            ? "availability-stable"
            : "availability-premark");
      return options.availability?.[availabilityReads - 1] || availability;
    },
    async installCandidate(
      _source,
      _target,
      signatures,
      observedSourceBuild,
      observedTargetBuild,
      authorizedTarget,
      bridge
    ) {
      events.push("install");
      assert.deepEqual(signatures, { sourceCdHash: "c".repeat(40), targetCdHash: "d".repeat(40) });
      assert.deepEqual(observedSourceBuild, sourceBuild);
      assert.deepEqual(observedTargetBuild, targetBuild);
      assert.deepEqual(authorizedTarget, { cdHash: "d".repeat(40), build: targetBuild });
      assert.deepEqual(bridge, bridgeEquivalence);
      installed = true;
      return installation;
    },
    async wait(milliseconds) {
      events.push(`wait-${milliseconds}`);
    }
  };
}
