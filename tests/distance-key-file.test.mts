import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultState } from "../src/defaults.js";
import { updateDistanceKeySettings } from "../src/distanceKey.js";

const root = await mkdtemp(join(await realpath(tmpdir()), "sentinel-distance-key-"));
try {
  const state = defaultState();
  const keyPath = join(root, "removable", "sentinel.key");
  const result = updateDistanceKeySettings(state, {
    enabled: true,
    keyFilePath: keyPath,
    writeKeyFile: true
  });
  assert.equal(result.keyFilePath, keyPath);
  assert.match(await readFile(keyPath, "utf8"), /^[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}\n$/u);
  assert.equal((await stat(keyPath)).mode & 0o777, 0o600);

  const existingPath = join(root, "existing.txt");
  await writeFile(existingPath, "keep this content\n", { mode: 0o644 });
  const stateBeforeConflict = structuredClone(state);
  assert.throws(() => updateDistanceKeySettings(state, {
    enabled: true,
    keyFilePath: existingPath,
    writeKeyFile: true
  }), /already exists/i);
  assert.equal(await readFile(existingPath, "utf8"), "keep this content\n");
  assert.equal((await stat(existingPath)).mode & 0o777, 0o644);
  assert.deepEqual(state, stateBeforeConflict, "a failed key-file write must not rotate the saved token");

  const symlinkTarget = join(root, "symlink-target.txt");
  const symlinkPath = join(root, "symlink.key");
  await writeFile(symlinkTarget, "do not replace\n");
  await symlink(symlinkTarget, symlinkPath);
  assert.throws(() => updateDistanceKeySettings(state, {
    keyFilePath: symlinkPath,
    writeKeyFile: true
  }), /symbolic link|already exists/i);
  assert.equal(await readFile(symlinkTarget, "utf8"), "do not replace\n");

  const actualDirectory = join(root, "actual-directory");
  const linkedDirectory = join(root, "linked-directory");
  await mkdir(actualDirectory);
  await symlink(actualDirectory, linkedDirectory);
  assert.throws(() => updateDistanceKeySettings(state, {
    keyFilePath: join(linkedDirectory, "sentinel.key"),
    writeKeyFile: true
  }), /symbolic link/i);
  await assert.rejects(readFile(join(actualDirectory, "sentinel.key")), /ENOENT/u);
} finally {
  await rm(root, { recursive: true, force: true });
}
