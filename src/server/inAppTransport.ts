import { Readable } from "node:stream";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";

const MAX_IN_APP_BODY_BYTES = 1024 * 1024;

export interface InAppRequest {
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
}

export interface InAppResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

export interface InAppTransport {
  request(input: InAppRequest): Promise<InAppResponse>;
  stop(): Promise<void>;
}

export function createLoopbackRuntimeProxy(port: number): InAppTransport {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Vigil cannot proxy an invalid companion server port.");
  }
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    async request(input) {
      const method = String(input.method || "GET").toUpperCase();
      const body = requestBody(input.body);
      const response = await fetch(new URL(normalizePath(input.path), baseUrl), {
        method,
        headers: normalizeProxyHeaders(input.headers),
        body: ["GET", "HEAD"].includes(method) || !body.length ? undefined : requestArrayBuffer(body),
        redirect: "manual"
      });
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body: new Uint8Array(await response.arrayBuffer())
      };
    },
    async stop() {
      // The development server belongs to its npm process, not Electron.
    }
  };
}

export async function runInAppRequest(
  input: InAppRequest,
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>
): Promise<InAppResponse> {
  const body = requestBody(input.body);
  const request = inAppIncomingMessage(input, body);
  let settled = false;
  let status = 200;
  let headers: Record<string, string> = {};
  const chunks: Buffer[] = [];

  let resolveResponse: (response: InAppResponse) => void = () => {};
  const responsePromise = new Promise<InAppResponse>((resolve) => {
    resolveResponse = resolve;
  });

  const finish = (chunk?: unknown): void => {
    if (settled) return;
    if (chunk !== undefined && chunk !== null) chunks.push(responseChunk(chunk));
    settled = true;
    resolveResponse({
      status,
      headers,
      body: Buffer.concat(chunks)
    });
  };

  const response = {
    writeHead(nextStatus: number, nextHeaders: Record<string, string | number | string[]> = {}) {
      status = nextStatus;
      headers = normalizeResponseHeaders(nextHeaders);
      return response;
    },
    end(chunk?: unknown, encodingOrCallback?: unknown, callback?: unknown) {
      finish(chunk);
      if (typeof encodingOrCallback === "function") encodingOrCallback();
      if (typeof callback === "function") callback();
      return response;
    }
  } as unknown as ServerResponse;

  await handler(request, response);
  if (!settled) finish();
  return await responsePromise;
}

function inAppIncomingMessage(input: InAppRequest, body: Buffer): IncomingMessage {
  const request = Readable.from(body.length ? [body] : []) as Readable & {
    method?: string;
    url?: string;
    headers?: IncomingHttpHeaders;
    socket?: { remoteAddress?: string };
  };
  request.method = String(input.method || "GET").toUpperCase();
  request.url = normalizePath(input.path);
  request.headers = normalizeRequestHeaders(input.headers);
  request.socket = { remoteAddress: "127.0.0.1" };
  return request as unknown as IncomingMessage;
}

function requestBody(value: InAppRequest["body"]): Buffer {
  const body = value instanceof Uint8Array
    ? Buffer.from(value)
    : Buffer.from(String(value || ""), "utf8");
  if (body.length > MAX_IN_APP_BODY_BYTES) {
    throw Object.assign(new Error("Request body too large."), { status: 413 });
  }
  return body;
}

function requestArrayBuffer(body: Buffer): ArrayBuffer {
  const copy = new Uint8Array(body.length);
  copy.set(body);
  return copy.buffer;
}

function normalizePath(value: string): string {
  const url = new URL(String(value || "/"), "http://127.0.0.1");
  return `${url.pathname}${url.search}`;
}

function normalizeRequestHeaders(value: Record<string, string> = {}): IncomingHttpHeaders {
  const headers: IncomingHttpHeaders = { host: "127.0.0.1:8787" };
  for (const [name, headerValue] of Object.entries(value)) {
    const normalizedName = name.trim().toLowerCase();
    if (!normalizedName || normalizedName === "host") continue;
    headers[normalizedName] = String(headerValue);
  }
  return headers;
}

function normalizeProxyHeaders(value: Record<string, string> = {}): Headers {
  const headers = new Headers();
  for (const [name, headerValue] of Object.entries(value)) {
    const normalizedName = name.trim().toLowerCase();
    if (!normalizedName || normalizedName === "host") continue;
    headers.set(normalizedName, String(headerValue));
  }
  return headers;
}

function normalizeResponseHeaders(value: Record<string, string | number | string[]>): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(value)) {
    headers[name] = Array.isArray(headerValue) ? headerValue.join(", ") : String(headerValue);
  }
  return headers;
}

function responseChunk(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  return Buffer.from(String(value));
}
