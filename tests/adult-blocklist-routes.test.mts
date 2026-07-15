import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

const dataDir = await mkdtemp(join(tmpdir(), "vigil-adult-blocklist-routes-"));
process.env.VIGIL_DATA_DIR = dataDir;

const {
  ADULT_BLOCKLIST_PHONE_ARTIFACT_PATH,
  ADULT_BLOCKLIST_SOURCES,
  clearAdultBlocklistCacheForTest,
  setAdultBlocklistDomainsForTest,
  writeAdultBlocklistPhoneArtifact
} = await import("../src/adultBlocklist.js");
const { decodePhoneBlocklistArtifact, phoneBlocklistMatchesHost } = await import("../src/adultBlocklistPhoneArtifact.js");
const { defaultState } = await import("../src/defaults.js");
const { handleAdultBlocklistApiRoute } = await import("../src/server/adultBlocklistRoutes.js");

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
  const routeResponse = mockResponse();
  const handled = await handleAdultBlocklistApiRoute(
    mockRequest("POST", "/api/adult-blocklist/settings", { allowlist: ["allowed.exampleadult.test"] }),
    routeResponse,
    {
      state,
      recordIosMdmPolicyQueue: (reason) => queuedReasons.push(reason)
    }
  );

  assert.equal(handled, true);
  assert.equal(routeResponse.statusCodeValue, 200);
  assert.deepEqual(state.adultBlocklist.allowlist, ["allowed.exampleadult.test"]);
  assert.deepEqual(queuedReasons, ["adult-blocklist-settings"]);

  const after = decodePhoneBlocklistArtifact(await readFile(ADULT_BLOCKLIST_PHONE_ARTIFACT_PATH));
  assert.equal(phoneBlocklistMatchesHost(after, "allowed.exampleadult.test"), "");
  assert.equal(phoneBlocklistMatchesHost(after, "blocked.exampleadult.test"), "blocked.exampleadult.test");
} finally {
  clearAdultBlocklistCacheForTest();
  await rm(dataDir, { recursive: true, force: true });
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
