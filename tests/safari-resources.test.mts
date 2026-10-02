import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const root = basename(runtimeRoot) === 'runtime' ? dirname(dirname(runtimeRoot)) : runtimeRoot;
const { safariManifestScripts, verifySafariResources } = await import(pathToFileURL(join(root, 'scripts/safari-resources.mjs')).href);
const sourceResources = join(root, 'ios/VigilSocial/VigilYouTubeInteractionExtension/Resources');
const macResources = join(root, 'macos/Vigil Safari/Vigil Safari Extension/Resources');
const manifest = JSON.parse(await readFile(join(sourceResources, 'manifest.json'), 'utf8'));
await verifySafariResources(sourceResources, macResources);

// Check target membership, not just the resource directory: Xcode only copies
// files referenced by the extension target's Resources build phase.
const { stdout } = await promisify(execFile)('/usr/bin/plutil', [
  '-convert', 'json', '-o', '-', join(root, 'macos/Vigil Safari/Vigil Safari.xcodeproj/project.pbxproj')
]);
type ProjectObject = { isa?: string; name?: string; path?: string; fileRef?: string; buildPhases?: string[]; files?: string[] };
const objects = (JSON.parse(stdout) as { objects: Record<string, ProjectObject> }).objects;
const extension = Object.values(objects).find(object => object.isa === 'PBXNativeTarget' && object.name === 'Vigil Safari Extension');
assert.ok(extension);
const resources = extension.buildPhases?.map(id => objects[id]).find(object => object?.isa === 'PBXResourcesBuildPhase');
assert.ok(resources);
const bundledNames = new Set(resources.files?.map(id => {
  const reference = objects[objects[id]?.fileRef || ''];
  return basename(reference?.path || '');
}));
for (const name of safariManifestScripts(manifest) as string[]) {
  assert.ok(bundledNames.has(name), `${name} must be copied into the Mac Safari extension`);
}

const directory = await mkdtemp(join(tmpdir(), 'vigil-safari-resources-test-'));
try {
  const bundleResources = join(directory, 'bundle');
  const fixtureResources = join(directory, 'source');
  await cp(sourceResources, fixtureResources, { recursive: true });
  await cp(macResources, bundleResources, { recursive: true, dereference: true });
  await verifySafariResources(fixtureResources, bundleResources);
  const responsePath = join(bundleResources, 'youtube-player-response.js');
  await rm(responsePath);
  await assert.rejects(verifySafariResources(fixtureResources, bundleResources), /Missing Safari resource: youtube-player-response\.js/u);
  await writeFile(responsePath, '// stale response guard');
  await assert.rejects(verifySafariResources(fixtureResources, bundleResources), /Stale Safari resource: youtube-player-response\.js/u);
  await cp(join(sourceResources, 'youtube-player-response.js'), responsePath);

  // Newly declared content/background scripts must be checked automatically,
  // even before someone adds them to the canonical asset list.
  for (const kind of ['content', 'background', 'worker']) {
    const name = `new-${kind}.js`;
    const updated = structuredClone(manifest);
    if (kind === 'content') updated.content_scripts.push({ js: [name] });
    else if (kind === 'background') updated.background.scripts.push(name);
    else updated.background.service_worker = name;
    await writeFile(join(fixtureResources, name), '// current script');
    await writeFile(join(fixtureResources, 'manifest.json'), JSON.stringify(updated));
    await cp(join(fixtureResources, 'manifest.json'), join(bundleResources, 'manifest.json'));
    await assert.rejects(verifySafariResources(fixtureResources, bundleResources), new RegExp(`Missing Safari resource: ${name.replace('.', '\\.')}`, 'u'));
    await writeFile(join(bundleResources, name), '// stale script');
    await assert.rejects(verifySafariResources(fixtureResources, bundleResources), new RegExp(`Stale Safari resource: ${name.replace('.', '\\.')}`, 'u'));
    await cp(join(fixtureResources, name), join(bundleResources, name));
    await verifySafariResources(fixtureResources, bundleResources);
  }
} finally { await rm(directory, { recursive: true, force: true }); }

const installer = await readFile(join(root, 'scripts/update-safari-extension.mjs'), 'utf8');
assert.match(installer, /await verifySafariResources\(/u);
assert.ok(installer.indexOf('await verifySafariResources(') < installer.indexOf("process.argv.includes('--install')"),
  'deployment must verify the built resources before staging an installation');
console.log('Safari manifest script membership and missing/stale deployment resources passed.');
