import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { AdultBlocklistRefreshPreparation } from "../src/adultBlocklist.js";

const dataDir = await mkdtemp(join(tmpdir(), "vigil-adult-blocklist-routes-"));
process.env.VIGIL_DATA_DIR = dataDir;

const {
  ADULT_BLOCKLIST_PHONE_ARTIFACT_PATH,
  ADULT_BLOCKLIST_SOURCES,
  adultBlocklistSource,
  clearAdultBlocklistCacheForTest,
  setAdultBlocklistDomainsForTest,
  writeAdultBlocklistPhoneArtifact
} = await import("../src/adultBlocklist.js");
const { decodePhoneBlocklistArtifact, phoneBlocklistMatchesHost } = await import("../src/adultBlocklistPhoneArtifact.js");
const { defaultState } = await import("../src/defaults.js");
const { handleAdultBlocklistApiRoute } = await import("../src/server/adultBlocklistRoutes.js");
const { RuntimeMutationCoordinator } = await import("../src/server/mutationCoordinator.js");

try {
  const state = defaultState();
  setAdultBlocklistDomainsForTest([
    "allowed.exampleadult.test",
    "blocked.exampleadult.test"
  ], ADULT_BLOCKLIST_SOURCES[0]);
  await writeAdultBlocklistPhoneArtifact(state);

  const before = decodePhoneBlocklistArtifact(await readFile(ADULT_BLOCKLIST_PHONE_ARTIFACT_PATH));
  assert.equal(phoneBlocklistMatchesHost(before, "allowed.exampleadult.test"), "allowed.exampleadult.test");

  const queuedReasons: string[] = [];
  const enforcementReasons: string[] = [];
  const postCommitEffects: Array<() => void | Promise<void>> = [];
  const effectKinds: string[] = [];
  const routeResponse = mockResponse();
  const handled = await handleAdultBlocklistApiRoute(
    mockRequest("POST", "/api/adult-blocklist/settings", { allowlist: ["allowed.exampleadult.test"] }),
    routeResponse,
    {
      state,
      currentState: () => state,
      afterCommit: (effect, descriptor) => {
        postCommitEffects.push(effect);
        effectKinds.push(descriptor?.kind || "");
      },
      recordIosMdmPolicyQueue: (reason) => queuedReasons.push(reason),
      schedulePolicyEnforcement: (reason) => enforcementReasons.push(reason)
    }
  );

  assert.equal(handled, true);
  assert.equal(routeResponse.statusCodeValue, 200);
  assert.deepEqual(state.adultBlocklist.allowlist, ["allowed.exampleadult.test"]);
  assert.deepEqual(queuedReasons, ["adult-blocklist-settings"]);
  assert.deepEqual(enforcementReasons, ["adult-blocklist-settings"]);
  assert.deepEqual(effectKinds, ["adult-blocklist-phone-sync"]);

  const beforeCommit = decodePhoneBlocklistArtifact(await readFile(ADULT_BLOCKLIST_PHONE_ARTIFACT_PATH));
  assert.equal(phoneBlocklistMatchesHost(beforeCommit, "allowed.exampleadult.test"), "allowed.exampleadult.test");
  await Promise.all(postCommitEffects.map(async (effect) => await effect()));

  const after = decodePhoneBlocklistArtifact(await readFile(ADULT_BLOCKLIST_PHONE_ARTIFACT_PATH));
  assert.equal(phoneBlocklistMatchesHost(after, "allowed.exampleadult.test"), "");
  assert.equal(phoneBlocklistMatchesHost(after, "blocked.exampleadult.test"), "blocked.exampleadult.test");

  const syncDescriptors: NonNullable<Parameters<AdultBlocklistApiContext["afterCommit"]>[1]>[] = [];
  for (const allowlist of [["allowed.exampleadult.test"], ["blocked.exampleadult.test"]]) {
    const response = mockResponse();
    await handleAdultBlocklistApiRoute(
      mockRequest("POST", "/api/adult-blocklist/settings", { allowlist }),
      response,
      {
        state,
        currentState: () => state,
        afterCommit: (_effect, descriptor) => {
          assert.ok(descriptor);
          syncDescriptors.push(descriptor);
        }
      }
    );
    assert.equal(response.statusCodeValue, 200);
  }
  assert.equal(syncDescriptors.length, 2);
  assert.notEqual(syncDescriptors[0].key, syncDescriptors[1].key, "different allowlists on one snapshot need distinct durable sync intents");

  const blockedCoordinator = new RuntimeMutationCoordinator(defaultState(), {}, [], async () => {});
  let markFirstStarted = () => {};
  const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
  let releaseFirst = () => {};
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  await blockedCoordinator.run(async ({ afterCommit }) => {
    afterCommit(async () => {
      markFirstStarted();
      await firstGate;
    }, { ...syncDescriptors[0], awaitAttempt: false });
  });
  await firstStarted;
  let secondRuns = 0;
  await blockedCoordinator.run(async ({ afterCommit }) => {
    afterCommit(() => { secondRuns += 1; }, { ...syncDescriptors[1], awaitAttempt: false });
  });
  assert.equal(blockedCoordinator.pendingEffects().length, 2, "a later allowlist sync must remain durable while the earlier effect is blocked");
  releaseFirst();
  blockedCoordinator.stopAdmission();
  await blockedCoordinator.drain();
  assert.equal(secondRuns, 1);
  assert.equal(blockedCoordinator.pendingEffects().length, 0);

  const retryState = defaultState();
  await writeAdultBlocklistPhoneArtifact(retryState);
  const retryCoordinator = new RuntimeMutationCoordinator(retryState, {}, [], async () => {});
  await retryCoordinator.retryPending(async () => ({ ok: true }));
  let failFirstAttempt = true;
  await updateAllowlistWithCoordinator(["allowed.exampleadult.test"], true);
  assert.equal(retryCoordinator.pendingEffects().length, 1, "the failed sync must remain pending for retry");

  await updateAllowlistWithCoordinator(["blocked.exampleadult.test"], false);
  const newerArtifact = decodePhoneBlocklistArtifact(await readFile(ADULT_BLOCKLIST_PHONE_ARTIFACT_PATH));
  assert.equal(phoneBlocklistMatchesHost(newerArtifact, "allowed.exampleadult.test"), "allowed.exampleadult.test");
  assert.equal(phoneBlocklistMatchesHost(newerArtifact, "blocked.exampleadult.test"), "");

  await waitFor(() => retryCoordinator.pendingEffects().length === 0);
  const afterStaleRetry = decodePhoneBlocklistArtifact(await readFile(ADULT_BLOCKLIST_PHONE_ARTIFACT_PATH));
  assert.equal(
    phoneBlocklistMatchesHost(afterStaleRetry, "allowed.exampleadult.test"),
    "allowed.exampleadult.test",
    "a failed sync retry must not restore an artifact from its obsolete allowlist"
  );
  assert.equal(phoneBlocklistMatchesHost(afterStaleRetry, "blocked.exampleadult.test"), "");
  retryCoordinator.stopAdmission();
  await retryCoordinator.drain();

  const refreshState = defaultState();
  const refreshCoordinator = new RuntimeMutationCoordinator(refreshState, {}, [], async () => {});
  const refreshSource = adultBlocklistSource(refreshState);
  const refreshDomains = ["same-content.exampleadult.test"];
  const refreshHash = createHash("sha256").update(refreshDomains.join("\n")).digest("hex");
  const refreshDescriptors: NonNullable<Parameters<AdultBlocklistApiContext["afterCommit"]>[1]>[] = [];
  let markFirstRefreshStarted = () => {};
  const firstRefreshStarted = new Promise<void>((resolve) => { markFirstRefreshStarted = resolve; });
  let releaseFirstRefresh = () => {};
  const firstRefreshGate = new Promise<void>((resolve) => { releaseFirstRefresh = resolve; });
  let markSecondRefreshStarted = () => {};
  const secondRefreshStarted = new Promise<void>((resolve) => { markSecondRefreshStarted = resolve; });
  let releaseSecondRefresh = () => {};
  const secondRefreshGate = new Promise<void>((resolve) => { releaseSecondRefresh = resolve; });

  await queueRefresh("2026-07-15T10:00:00.000Z");
  await firstRefreshStarted;
  await queueRefresh("2026-07-15T10:01:00.000Z");
  assert.equal(refreshDescriptors.length, 2);
  assert.equal(refreshDescriptors[0].payload?.hash, refreshDescriptors[1].payload?.hash, "same-content refreshes share a domain hash");
  assert.notEqual(refreshDescriptors[0].payload?.snapshotPath, refreshDescriptors[1].payload?.snapshotPath, "each refresh has a versioned snapshot identity");
  assert.notEqual(refreshDescriptors[0].key, refreshDescriptors[1].key, "same-content refreshes must remain distinct durable intents");
  assert.equal(refreshCoordinator.pendingEffects().length, 2, "the newer refresh must not reuse an in-flight older intent");

  const repeatedSnapshotSyncDescriptors: NonNullable<Parameters<AdultBlocklistApiContext["afterCommit"]>[1]>[] = [];
  for (const snapshotPath of refreshDescriptors.map((descriptor) => String(descriptor.payload?.snapshotPath || ""))) {
    const phoneSyncState = defaultState();
    phoneSyncState.adultBlocklist.hash = refreshHash;
    phoneSyncState.adultBlocklist.snapshotPath = snapshotPath;
    const response = mockResponse();
    await handleAdultBlocklistApiRoute(
      mockRequest("POST", "/api/adult-blocklist/settings", { allowlist: [] }),
      response,
      {
        state: phoneSyncState,
        currentState: () => phoneSyncState,
        afterCommit: (_effect, descriptor) => {
          assert.ok(descriptor);
          repeatedSnapshotSyncDescriptors.push(descriptor);
        }
      }
    );
    assert.equal(response.statusCodeValue, 200);
  }
  assert.deepEqual(
    repeatedSnapshotSyncDescriptors.map((descriptor) => descriptor.payload?.snapshotPath),
    refreshDescriptors.map((descriptor) => descriptor.payload?.snapshotPath),
    "phone sync payloads must retain the complete selected snapshot identity"
  );
  assert.notEqual(
    repeatedSnapshotSyncDescriptors[0].key,
    repeatedSnapshotSyncDescriptors[1].key,
    "phone sync intents for same-content versioned snapshots must remain distinct"
  );

  const newerIntentMarker = Buffer.from("newer-refresh-awaiting-durable-sync");
  await writeFile(ADULT_BLOCKLIST_PHONE_ARTIFACT_PATH, newerIntentMarker);
  releaseFirstRefresh();
  await secondRefreshStarted;
  assert.deepEqual(
    await readFile(ADULT_BLOCKLIST_PHONE_ARTIFACT_PATH),
    newerIntentMarker,
    "the obsolete older refresh must not overwrite phone metadata for the newer snapshot intent"
  );
  assert.deepEqual(
    refreshCoordinator.pendingEffects().map((entry) => entry.key),
    [refreshDescriptors[1].key],
    "completing the older intent must not acknowledge the newer durable work"
  );

  releaseSecondRefresh();
  refreshCoordinator.stopAdmission();
  await refreshCoordinator.drain();
  assert.equal(refreshCoordinator.pendingEffects().length, 0);
  const repeatedRefreshArtifact = decodePhoneBlocklistArtifact(await readFile(ADULT_BLOCKLIST_PHONE_ARTIFACT_PATH));
  assert.equal(repeatedRefreshArtifact.metadata.snapshotHash, refreshHash);
  assert.equal(repeatedRefreshArtifact.metadata.generatedAt, "2026-07-15T10:01:00.000Z", "the newer refresh metadata must win");
  assert.equal(refreshState.adultBlocklist.snapshotPath, refreshDescriptors[1].payload?.snapshotPath);

  async function queueRefresh(generatedAt: string): Promise<void> {
    const preparation: AdultBlocklistRefreshPreparation = {
      attemptedAt: generatedAt,
      source: refreshSource,
      snapshot: {
        version: 1,
        generatedAt,
        domainCount: refreshDomains.length,
        hash: refreshHash,
        source: refreshSource,
        domains: refreshDomains
      },
      error: null
    };
    await refreshCoordinator.run(async ({ state: draftState, afterCommit }) => {
      const response = mockResponse();
      await handleAdultBlocklistApiRoute(
        mockRequest("POST", "/api/adult-blocklist/refresh", {}),
        response,
        {
          state: draftState,
          currentState: () => refreshState,
          preparedRefresh: preparation,
          afterCommit: (effect, descriptor) => {
            assert.ok(descriptor);
            const refreshIndex = refreshDescriptors.length;
            refreshDescriptors.push(descriptor);
            afterCommit(async () => {
              if (refreshIndex === 0) {
                markFirstRefreshStarted();
                await firstRefreshGate;
              } else {
                markSecondRefreshStarted();
                await secondRefreshGate;
              }
              await effect();
            }, { ...descriptor, awaitAttempt: false });
          }
        }
      );
      assert.equal(response.statusCodeValue, 200);
    });
  }

  async function updateAllowlistWithCoordinator(allowlist: string[], failOnce: boolean): Promise<void> {
    await retryCoordinator.run(async ({ state: draftState, afterCommit }) => {
      const response = mockResponse();
      await handleAdultBlocklistApiRoute(
        mockRequest("POST", "/api/adult-blocklist/settings", { allowlist }),
        response,
        {
          state: draftState,
          currentState: () => retryState,
          afterCommit: (effect, descriptor) => afterCommit(async () => {
            if (failOnce && failFirstAttempt) {
              failFirstAttempt = false;
              throw new Error("deterministic first phone sync failure");
            }
            await effect();
          }, descriptor)
        }
      );
      assert.equal(response.statusCodeValue, 200);
    });
  }
} finally {
  clearAdultBlocklistCacheForTest();
  await rm(dataDir, { recursive: true, force: true });
}

interface AdultBlocklistApiContext {
  currentState: () => import("../src/types.js").VigilState;
  afterCommit: (
    effect: () => void | Promise<void>,
    descriptor?: import("../src/server/mutationCoordinator.js").DurableEffectDescriptor
  ) => void;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "timed out waiting for the durable retry");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function mockRequest(method: string, url: string, body: object): IncomingMessage {
  return Object.assign(Readable.from([JSON.stringify(body)]), {
    method,
    url,
    headers: { "content-type": "application/json" },
    socket: { remoteAddress: "127.0.0.1" }
  }) as IncomingMessage;
}

interface MockResponse {
  statusCodeValue?: number;
  bodyText: string;
  writeHead(statusCode: number): MockResponse;
  end(chunk?: unknown): MockResponse;
}

function mockResponse(): ServerResponse & MockResponse {
  const target: MockResponse = {
    bodyText: "",
    writeHead(statusCode: number) {
      this.statusCodeValue = statusCode;
      return this;
    },
    end(chunk?: unknown) {
      this.bodyText += chunk ? String(chunk) : "";
      return this;
    }
  };
  return target as ServerResponse & MockResponse;
}
