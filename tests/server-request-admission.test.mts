import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { errorStatus, readTextBody, sendJson, serializeError } from "../src/server/http.js";

const { startVigilServer, stopVigilServer } = await import("../src/server.js");
const handle = await startVigilServer({ host: "127.0.0.1", port: 0 });
const socket = createConnection({ host: "127.0.0.1", port: handle.port });
let slowJsonSocket: ReturnType<typeof createConnection> | null = null;

try {
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.write([
    "POST /mdm/checkin HTTP/1.1",
    `Host: 127.0.0.1:${handle.port}`,
    "Transfer-Encoding: chunked",
    "Content-Type: application/xml",
    "",
    "6",
    "<plist",
    ""
  ].join("\r\n"));
  await new Promise((resolve) => setTimeout(resolve, 50));

  const response = await withTimeout(handle.request({
    method: "POST",
    path: "/api/settings",
    headers: {
      "Content-Type": "application/json",
      "X-Vigil-Intent": "vigil-app"
    },
    body: "{}"
  }), 1_000);
  assert.equal(response.status, 200, "an incomplete public MDM body must not occupy the mutation coordinator");

  const jsonSocket = createConnection({ host: "127.0.0.1", port: handle.port });
  slowJsonSocket = jsonSocket;
  await new Promise<void>((resolve, reject) => {
    jsonSocket.once("connect", resolve);
    jsonSocket.once("error", reject);
  });
  jsonSocket.write([
    "POST /api/settings HTTP/1.1",
    `Host: 127.0.0.1:${handle.port}`,
    "Content-Length: 2",
    "Content-Type: application/json",
    "X-Vigil-Intent: vigil-app",
    "",
    "{"
  ].join("\r\n"));
  await new Promise((resolve) => setTimeout(resolve, 50));

  const whileJsonIsSlow = await withTimeout(handle.request({
    method: "POST",
    path: "/api/settings",
    headers: {
      "Content-Type": "application/json",
      "X-Vigil-Intent": "vigil-app"
    },
    body: "{}"
  }), 1_000);
  assert.equal(whileJsonIsSlow.status, 200, "an incomplete authorized JSON body must not occupy the mutation coordinator");
  socket.end("0\r\n\r\n");
  jsonSocket.end("}");

  const previousAuth = process.env.VIGIL_AUTH_ENABLED;
  process.env.VIGIL_AUTH_ENABLED = "1";
  try {
    const unauthorized = await rawStalledRequest(handle.port, [
      "POST /api/settings HTTP/1.1",
      `Host: 127.0.0.1:${handle.port}`,
      "Content-Length: 1048576",
      "Content-Type: application/json",
      "",
      "{"
    ].join("\r\n"));
    assert.match(unauthorized, /^HTTP\/1\.1 401 /u, "hosted mutations must authenticate before their body is buffered");
    assert.match(unauthorized, /\r\nConnection: close\r\n/iu, "early body rejection must close the connection after its response");
  } finally {
    if (previousAuth === undefined) delete process.env.VIGIL_AUTH_ENABLED;
    else process.env.VIGIL_AUTH_ENABLED = previousAuth;
  }

  const oversized = await rawStalledRequest(handle.port, [
    "POST /api/settings HTTP/1.1",
    `Host: 127.0.0.1:${handle.port}`,
    "Content-Length: 1048577",
    "Content-Type: application/json",
    "X-Vigil-Intent: vigil-app",
    "",
    ""
  ].join("\r\n"), Buffer.alloc(1024 * 1024 + 1, "x"));
  assert.match(oversized, /^HTTP\/1\.1 413 /u, "an oversized upload must receive the intended HTTP response");
  assert.match(oversized, /\r\nConnection: close\r\n/iu, "oversized uploads must close only after their response");

  const timeoutServer = createServer((request, response) => {
    void readTextBody(request, { timeoutMs: 25 }).then(
      () => sendJson(response, 200, { ok: true }),
      (error) => sendJson(response, errorStatus(error), serializeError(error))
    );
  });
  await new Promise<void>((resolve, reject) => {
    timeoutServer.once("error", reject);
    timeoutServer.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = timeoutServer.address();
    if (!address || typeof address === "string") throw new Error("Timeout test server did not expose a TCP port.");
    const timedOut = await rawStalledRequest(address.port, [
      "POST / HTTP/1.1",
      `Host: 127.0.0.1:${address.port}`,
      "Content-Length: 2",
      "Content-Type: application/json",
      "",
      "{"
    ].join("\r\n"));
    assert.match(timedOut, /^HTTP\/1\.1 408 /u, "a stalled upload must receive the intended HTTP response");
    assert.match(timedOut, /\r\nConnection: close\r\n/iu, "timed-out uploads must close only after their response");
  } finally {
    await new Promise<void>((resolve, reject) => timeoutServer.close((error) => error ? reject(error) : resolve()));
  }

  const serverSource = await readFile(new URL("../src/server.js", import.meta.url), "utf8");
  const preparationIndex = serverSource.indexOf("prepareMutationRequest(request, response, method, path)");
  const admissionIndex = serverSource.indexOf("requestMutationCoordinator.run", preparationIndex);
  assert.ok(preparationIndex >= 0 && admissionIndex > preparationIndex, "slow request preparation must happen before mutation admission");
  assert.match(
    serverSource,
    /prepared: \{ adultBlocklistRefresh: await prepareAdultBlocklistRefresh/u,
    "adult blocklist network preparation must also happen before mutation admission"
  );
  assert.match(serverSource, /completeFailedIosMdmPush\(error, committedState\)/u, "failed MDM attempts must merge their cloned diagnostics");
  assert.match(serverSource, /entry\.payload\.action === "mdm-push" && effectState/u, "recovered monitor MDM failures must also merge diagnostics");
} finally {
  socket.destroy();
  slowJsonSocket?.destroy();
  await stopVigilServer();
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Timed out waiting for an independent mutation.")), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function rawStalledRequest(port: number, request: string, body?: Buffer): Promise<string> {
  const client = createConnection({ host: "127.0.0.1", port });
  return await new Promise<string>((resolve, reject) => {
    let response = "";
    const timer = setTimeout(() => {
      client.destroy();
      reject(new Error("Timed out waiting for an HTTP rejection."));
    }, 1_000);
    const finish = (error?: Error) => {
      clearTimeout(timer);
      if (error && !response) reject(error);
      else resolve(response);
    };
    client.on("data", (chunk) => { response += chunk.toString("utf8"); });
    client.once("error", finish);
    client.once("close", () => finish());
    client.once("connect", () => {
      client.write(request);
      if (body) client.write(body);
    });
  });
}
