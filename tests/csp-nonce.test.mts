import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { sendHtml } from "../src/server/http.js";

let status = 0;
let headers: Record<string, string> = {};
let body = "";
const response = {
  writeHead(nextStatus: number, nextHeaders: Record<string, string>) { status = nextStatus; headers = nextHeaders; return response; },
  end(chunk: unknown) { body = String(chunk || ""); return response; }
} as unknown as ServerResponse;
sendHtml(response, "<style>body{color:red}</style><script>globalThis.ok=true</script>");
assert.equal(status, 200);
const csp = headers["Content-Security-Policy"];
assert.doesNotMatch(csp, /unsafe-inline/u);
const nonce = csp.match(/'nonce-([^']+)'/u)?.[1];
assert.ok(nonce);
assert.ok(body.includes(`<style nonce="${nonce}">`));
assert.ok(body.includes(`<script nonce="${nonce}">`));

const root = await sourceRoot();
for (const path of ["src/server/pages.ts", "public/dom.ts", "public/tracking-view.ts", "public/saint-stage.ts", "public/distance-key-ui.ts"]) {
  const source = await readFile(join(root, path), "utf8");
  assert.doesNotMatch(source, /\.style(?:\.|\[)|style\.textContent/u, `${path} must project runtime presentation through CSP-safe attributes or classes`);
}

async function sourceRoot(): Promise<string> {
  for (const candidate of [process.cwd(), resolve(process.cwd(), "..", "..")]) {
    try { await access(join(candidate, "tsconfig.json")); return candidate; } catch { /* next layout */ }
  }
  throw new Error("Could not locate the Vigil source root.");
}
