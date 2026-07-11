import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { toPlist } from "../plist.js";
import type { UnknownRecord } from "../types.js";

const MAX_BODY_BYTES = 1024 * 1024;

type ResponseHeaders = Record<string, string>;

export async function readBody(request: IncomingMessage): Promise<UnknownRecord> {
  const raw = await readTextBody(request);
  if (!raw.trim()) throw requestBodyError(400, "Request body must be a JSON object.");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw requestBodyError(400, "Request body contains malformed JSON.");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw requestBodyError(400, "Request body must be a JSON object.");
  }
  return parsed as UnknownRecord;
}

export async function readTextBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const chunk of request) {
    const buffer = bodyChunkBuffer(chunk);
    byteLength += buffer.length;
    if (byteLength > MAX_BODY_BYTES) throw requestBodyError(413, "Request body too large.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, byteLength).toString("utf8");
}

function bodyChunkBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (typeof chunk === "string") return Buffer.from(chunk);
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  return Buffer.from(String(chunk));
}

function requestBodyError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

export async function serveStatic(
  response: ServerResponse,
  pathname: string,
  {
    publicDir,
    fallbackPublicDir,
    noCache = false,
    typescriptSourceRoot
  }: {
    publicDir: string;
    fallbackPublicDir?: string;
    noCache?: boolean;
    typescriptSourceRoot?: string;
  }
): Promise<void> {
  const fullPath = resolvePublicPath(pathname, publicDir);
  if (!fullPath) {
    sendJson(response, 403, { error: "Forbidden" });
    return;
  }

  try {
    const data = await readPublicAsset(fullPath, pathname, {
      fallbackPublicDir,
      typescriptSourceRoot
    });
    response.writeHead(200, {
      ...securityHeaders(),
      "Content-Type": contentType(fullPath),
      ...(noCache ? { "Cache-Control": "no-store" } : {})
    });
    response.end(data);
  } catch {
    sendJson(response, 404, { error: "Not found" });
  }
}

async function readPublicAsset(
  fullPath: string,
  pathname: string,
  options: { fallbackPublicDir?: string; typescriptSourceRoot?: string }
): Promise<Buffer | string> {
  try {
    return await readFile(fullPath);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }

  if (options.typescriptSourceRoot && extname(fullPath) === ".js") {
    const sourcePath = `${fullPath.slice(0, -3)}.ts`;
    try {
      const source = await readFile(sourcePath, "utf8");
      return transpilePublicTypescript(source, sourcePath);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
  }

  if (options.fallbackPublicDir) {
    const fallbackPath = resolvePublicPath(pathname, options.fallbackPublicDir);
    if (fallbackPath) return await readFile(fallbackPath);
  }
  throw Object.assign(new Error("Public asset was not found."), { code: "ENOENT" });
}

export function transpilePublicTypescript(source: string, filename: string): string {
  return stripTypeScriptTypes(source, {
    mode: "strip",
    sourceUrl: filename
  });
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export function resolvePublicPath(pathname: string, publicDir: string): string | null {
  const publicRoot = resolve(publicDir);
  const requested = pathname === "/" ? "/index.html" : pathname;
  let decoded;
  try {
    decoded = decodeURIComponent(requested);
  } catch {
    return null;
  }

  const relativePath = decoded
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .split("/")
    .filter((part) => part && part !== ".")
    .join("/");

  const fullPath = resolve(publicRoot, relativePath);
  if (fullPath !== publicRoot && !fullPath.startsWith(`${publicRoot}${sep}`)) return null;
  return fullPath;
}

export function sendJson(response: ServerResponse, status: number, body: unknown, headers: ResponseHeaders = {}): void {
  response.writeHead(status, { ...securityHeaders(), "Content-Type": "application/json; charset=utf-8", ...headers });
  response.end(`${JSON.stringify(body)}\n`);
}

export function sendDownload(response: ServerResponse, status: number, body: string | Buffer, filename: string, contentTypeValue: string, headers: ResponseHeaders = {}): void {
  response.writeHead(status, {
    ...securityHeaders(),
    "Content-Type": `${contentTypeValue}; charset=utf-8`,
    "Content-Disposition": `attachment; filename="${filename.replace(/"/g, "")}"`,
    ...headers
  });
  response.end(body);
}

export function sendMdmPlist(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { ...mdmHeaders(), "Content-Type": "application/x-apple-aspen-mdm; charset=utf-8" });
  response.end(toPlist(body));
}

export function sendEmpty(response: ServerResponse, status: number, headers: ResponseHeaders = {}): void {
  response.writeHead(status, { ...securityHeaders(), ...headers });
  response.end();
}

export function mdmHeaders(): ResponseHeaders {
  return {
    ...securityHeaders(),
    "Cache-Control": "no-store"
  };
}

export function sendHtml(response: ServerResponse, body: string): void {
  response.writeHead(200, { ...securityHeaders(), "Content-Type": "text/html; charset=utf-8" });
  response.end(body);
}

export function securityHeaders(): ResponseHeaders {
  return {
    "Content-Security-Policy": "frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY"
  };
}

export function contentType(path: string): string {
  const types: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".ogg": "audio/ogg",
    ".svg": "image/svg+xml"
  };
  return types[extname(path)] || "application/octet-stream";
}

export function serializeError(error: unknown): { error: string; blockers?: unknown } {
  return {
    error: errorMessage(error),
    blockers: objectValue(error, "blockers")
  };
}

export function errorStatus(error: unknown): number {
  const status = Number(objectValue(error, "status"));
  return Number.isInteger(status) ? status : 500;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function objectValue(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && key in value
    ? (value as UnknownRecord)[key]
    : undefined;
}
