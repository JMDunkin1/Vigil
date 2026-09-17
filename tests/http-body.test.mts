import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { PassThrough, Readable } from "node:stream";
import { errorStatus, MAX_CONCURRENT_BODY_READS, readBody, readTextBody } from "../src/server/http.js";

assert.deepEqual(await readBody(bodyRequest('{"ok":true}')), { ok: true });
const cachedRequest = bodyRequest('{"cached":true}');
assert.equal(await readTextBody(cachedRequest), '{"cached":true}');
assert.deepEqual(await readBody(cachedRequest), { cached: true }, "pre-admission buffering must remain readable by the route handler");

await assert.rejects(
  readBody(bodyRequest("{")),
  hasBodyError(400, /malformed JSON/i)
);
await assert.rejects(
  readBody(bodyRequest("")),
  hasBodyError(400, /JSON object/i)
);
for (const body of ["null", "[]", '"text"', "42", "true"]) {
  await assert.rejects(
    readBody(bodyRequest(body)),
    hasBodyError(400, /JSON object/i)
  );
}
await assert.rejects(
  readBody(bodyRequest(Buffer.alloc(1024 * 1024 + 1, "x"))),
  hasBodyError(413, /too large/i)
);
const oversizedStream = new PassThrough();
const oversizedStall = oversizedStream as unknown as IncomingMessage;
oversizedStream.write(Buffer.alloc(1024 * 1024 + 1, "x"));
await assert.rejects(
  readTextBody(oversizedStall),
  hasBodyError(413, /too large/i)
);
assert.equal(oversizedStall.destroyed, false, "an oversized body must preserve the response side of the connection");
const stalled = new PassThrough() as unknown as IncomingMessage;
await assert.rejects(
  readTextBody(stalled, { timeoutMs: 10 }),
  hasBodyError(408, /timed out/i)
);
assert.equal(stalled.destroyed, false, "a timed-out body must preserve the response side of the connection");

const admittedStreams = Array.from({ length: MAX_CONCURRENT_BODY_READS }, () => new PassThrough());
const admittedReads = admittedStreams.map((stream) => readTextBody(stream as unknown as IncomingMessage));
const excessStream = new PassThrough();
await assert.rejects(
  readTextBody(excessStream as unknown as IncomingMessage),
  hasBodyError(503, /too many request bodies/i)
);
excessStream.end();
for (const stream of admittedStreams) stream.end("{}");
assert.deepEqual(await Promise.all(admittedReads), admittedStreams.map(() => "{}"), "body buffering must have bounded admission");

// Closed requests must release their admission slots immediately, including
// streams which close without delivering an `aborted` event.
const disconnectedStreams = Array.from({ length: MAX_CONCURRENT_BODY_READS }, () => new PassThrough());
const disconnectedReads = disconnectedStreams.map((stream) => assert.rejects(
  readTextBody(stream as unknown as IncomingMessage),
  hasBodyError(400, /aborted/i)
));
for (const stream of disconnectedStreams) stream.destroy();
await Promise.all(disconnectedReads);
assert.deepEqual(await readBody(bodyRequest('{"afterDisconnect":true}')), { afterDisconnect: true });
for (const stream of disconnectedStreams) {
  for (const event of ["data", "end", "error", "aborted", "close"]) {
    assert.equal(stream.listenerCount(event), 0, `closed body must release its ${event} listener`);
  }
}
const alreadyClosed = new PassThrough();
alreadyClosed.destroy();
await assert.rejects(readTextBody(alreadyClosed as unknown as IncomingMessage), hasBodyError(400, /no longer readable/i));
const alreadyAborted = Object.assign(new PassThrough(), { aborted: true });
await assert.rejects(readTextBody(alreadyAborted as unknown as IncomingMessage), hasBodyError(400, /no longer readable/i));
alreadyAborted.destroy();

function bodyRequest(body: string | Buffer): IncomingMessage {
  return Readable.from([body]) as unknown as IncomingMessage;
}

function hasBodyError(status: number, message: RegExp): (error: unknown) => boolean {
  return (error) => errorStatus(error) === status
    && error instanceof Error
    && message.test(error.message);
}
