import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { toPlist } from "../plist.js";

const MAX_BODY_BYTES = 1024 * 1024;

export async function readBody(request) {
  const raw = await readTextBody(request);
  return raw ? JSON.parse(raw) : {};
}

export async function readTextBody(request) {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > MAX_BODY_BYTES) throw new Error("Request body too large");
  }
  return raw;
}

export async function serveStatic(response, pathname, { publicDir }) {
  const fullPath = resolvePublicPath(pathname, publicDir);
  if (!fullPath) {
    sendJson(response, 403, { error: "Forbidden" });
    return;
  }

  try {
    const data = await readFile(fullPath);
    response.writeHead(200, { ...securityHeaders(), "Content-Type": contentType(fullPath) });
    response.end(data);
  } catch {
    sendJson(response, 404, { error: "Not found" });
  }
}

export function resolvePublicPath(pathname, publicDir) {
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

export function sendJson(response, status, body, headers = {}) {
  response.writeHead(status, { ...securityHeaders(), "Content-Type": "application/json; charset=utf-8", ...headers });
  response.end(`${JSON.stringify(body)}\n`);
}

export function sendDownload(response, status, body, filename, contentTypeValue) {
  response.writeHead(status, {
    ...securityHeaders(),
    "Content-Type": `${contentTypeValue}; charset=utf-8`,
    "Content-Disposition": `attachment; filename="${filename.replace(/"/g, "")}"`
  });
  response.end(body);
}

export function sendMdmPlist(response, status, body) {
  response.writeHead(status, { ...mdmHeaders(), "Content-Type": "application/x-apple-aspen-mdm; charset=utf-8" });
  response.end(toPlist(body));
}

export function sendEmpty(response, status, headers = {}) {
  response.writeHead(status, { ...securityHeaders(), ...headers });
  response.end();
}

export function mdmHeaders() {
  return {
    ...securityHeaders(),
    "Cache-Control": "no-store"
  };
}

export function sendHtml(response, body) {
  response.writeHead(200, { ...securityHeaders(), "Content-Type": "text/html; charset=utf-8" });
  response.end(body);
}

export function securityHeaders() {
  return {
    "Content-Security-Policy": "frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY"
  };
}

export function contentType(path) {
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml"
  };
  return types[extname(path)] || "application/octet-stream";
}
