import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { errorStatus, readBody } from "../src/server/http.js";

assert.deepEqual(await readBody(bodyRequest('{"ok":true}')), { ok: true });

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

function bodyRequest(body: string | Buffer): IncomingMessage {
  return Readable.from([body]) as unknown as IncomingMessage;
}

function hasBodyError(status: number, message: RegExp): (error: unknown) => boolean {
  return (error) => errorStatus(error) === status
    && error instanceof Error
    && message.test(error.message);
}
