import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureRuntimeTreeDigest } from "../src/runtimeTreeDigest.js";

const root = await realpath(await mkdtemp(join(tmpdir(), "vigil-digest-buffer-")));
try {
  const fixtures = [];
  for (const variant of [1, 2]) {
    const path = join(root, String(variant));
    await mkdir(path);
    const entries: Array<{ path: string; type: string; mode: number; size?: number; sha256?: string }> = [
      { path: ".", type: "directory", mode: (await lstat(path)).mode & 0o7777 }
    ];
    let totalBytes = 0;
    for (let index = 0; index < 12; index += 1) {
      const name = `${index}.bin`;
      // Alternate empty, short, and multi-chunk reads to expose stale bytes
      // and cross-request corruption when scratch buffers are reused.
      const size = index % 3 === 0 ? 0 : index % 3 === 1 ? 17 + index : 1024 * 1024 + index;
      const bytes = Buffer.alloc(size, variant * 12 + index);
      await writeFile(join(path, name), bytes);
      entries.push({
        path: name,
        type: "file",
        mode: (await lstat(join(path, name))).mode & 0o7777,
        size,
        sha256: createHash("sha256").update(bytes).digest("hex")
      });
      totalBytes += size;
    }
    entries.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
    const hash = createHash("sha256").update("vigil-runtime-tree-v1\n");
    for (const entry of entries) hash.update(`${JSON.stringify(entry)}\n`);
    fixtures.push({ path, sha256: hash.digest("hex"), totalBytes });
  }

  const originalAllocUnsafe = Buffer.allocUnsafe;
  let largeAllocations = 0;
  Buffer.allocUnsafe = (size: number) => {
    if (size >= 1024 * 1024) largeAllocations += 1;
    return originalAllocUnsafe(size);
  };
  try {
    const results = await Promise.all(fixtures.map((fixture) => captureRuntimeTreeDigest(fixture.path)));
    for (const [index, result] of results.entries()) {
      assert.equal(result.sha256, fixtures[index]!.sha256, "concurrent captures must hash every exact file byte");
      assert.equal(result.totalBytes, fixtures[index]!.totalBytes);
      assert.equal(result.entryCount, 13);
    }
    assert.ok(largeAllocations <= fixtures.length,
      "digest scratch allocations must stay bounded per request, independent of file count or verification passes");
  } finally {
    Buffer.allocUnsafe = originalAllocUnsafe;
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
