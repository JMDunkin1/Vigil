import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const html = await readFile("public/index.html", "utf8");
const ids = [...html.matchAll(/\bid="([A-Za-z][\w:-]*)"/g)].map((match) => match[1]);
const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
assert.deepEqual([...new Set(duplicateIds)], [], "dashboard HTML must not contain duplicate IDs");

const idSet = new Set(ids);
for (const match of html.matchAll(/\bfor="([A-Za-z][\w:-]*)"/g)) {
  assert.ok(idSet.has(match[1]), `label references missing control #${match[1]}`);
}

const scripts = (await readdir("public"))
  .filter((name) => name.endsWith(".js"))
  .sort();
const missing = new Set<string>();
for (const name of scripts) {
  const source = await readFile(join("public", name), "utf8");
  for (const match of source.matchAll(/(?:\$\$?|querySelector(?:All)?)\(\s*["'`](#[A-Za-z][\w:-]*)/g)) {
    const id = match[1].slice(1);
    if (!idSet.has(id)) missing.add(`${name}:${match[1]}`);
  }
}
assert.deepEqual([...missing], [], "frontend code must not query dashboard IDs that do not exist");
assert.doesNotMatch(html, /tracking-legacy-surface|legacy-home-actions/, "retired hidden UI must not return");
