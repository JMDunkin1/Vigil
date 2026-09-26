import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const root = basename(runtimeRoot) === 'runtime' ? dirname(dirname(runtimeRoot)) : runtimeRoot;
const { registeredSafariExtensions, safariBuildBundle, archiveSafariBundle, SAFARI_APP, SAFARI_EXTENSION_ID, SAFARI_EXTENSION_PATH } = await import(pathToFileURL(join(root, 'scripts/safari-installation.mjs')).href);
const canonical = join(SAFARI_APP, SAFARI_EXTENSION_PATH);
const build = join(root, 'dist.nosync/safari/DerivedData/Build/Products/Release/Vigil Safari.app');
const backup = join(root, 'dist.nosync/safari/previous-1234-abcd.backup');
assert.deepEqual(registeredSafariExtensions([
  ` + ${SAFARI_EXTENSION_ID}(1.0)\tuuid\tdate\t${canonical}`,
  `   ${SAFARI_EXTENSION_ID}(2.3)\tuuid\tdate\t${join(build, SAFARI_EXTENSION_PATH)}`,
  ` - ${SAFARI_EXTENSION_ID}(1.0)\tuuid\tdate\t${canonical}`,
  `   unrelated.Extension(1.0)\tuuid\tdate\t/Applications/Other.app`,
  '(3 plug-ins)'
].join('\n')), [canonical, join(build, SAFARI_EXTENSION_PATH)]);
assert.equal(safariBuildBundle(canonical, [root]), null, 'the live installation cannot be retired');
assert.equal(safariBuildBundle(join(build, SAFARI_EXTENSION_PATH), [root]), build);
assert.equal(safariBuildBundle(join(backup, SAFARI_EXTENSION_PATH), [root]), backup);
assert.equal(safariBuildBundle(join(backup.replace('/safari/', '/safari.noindex/'), SAFARI_EXTENSION_PATH), [root]), backup.replace('/safari/', '/safari.noindex/'));
assert.equal(safariBuildBundle(join('/unrelated/previous-1234.backup', SAFARI_EXTENSION_PATH), [root]), null);
assert.equal(safariBuildBundle(join(root, 'important.app', SAFARI_EXTENSION_PATH), [root]), null);
await assert.rejects(archiveSafariBundle(SAFARI_APP, '/tmp/unused'), /live Safari installation/);

const directory = await mkdtemp(join(tmpdir(), 'vigil-safari-archive-test-'));
try {
  const bundle = join(directory, 'previous-1234.backup');
  await mkdir(bundle);
  const operations: string[] = [];
  await assert.rejects(archiveSafariBundle(bundle, join(directory, 'archives'), async (command: string) => {
    operations.push(basename(command));
    if (command.endsWith('/unzip')) throw new Error('archive verification failed');
    return { stdout: command.endsWith('/plutil') ? SAFARI_EXTENSION_ID : '' };
  }), /archive verification failed/);
  assert.equal((await stat(bundle)).isDirectory(), true, 'an unverifiable archive must not destroy the original backup');
  assert.deepEqual(operations, ['plutil', 'ditto', 'unzip'], 'registration is preserved until the archive is verified');

  await assert.rejects(archiveSafariBundle(bundle, join(directory, 'archives'), async (command: string) => {
    if (command.endsWith('/pluginkit')) throw Object.assign(new Error('permission denied'), { code: 1, stderr: 'permission denied' });
    return { stdout: command.endsWith('/plutil') ? SAFARI_EXTENSION_ID : '' };
  }), /permission denied/);
  assert.equal((await stat(bundle)).isDirectory(), true, 'unexpected registration failures retain the archived original');

  await archiveSafariBundle(bundle, join(directory, 'archives'), async (command: string) => {
    if (command.endsWith('/pluginkit')) throw Object.assign(new Error('unregistered'), {
      code: 1, stderr: `remove: no plugin at ${join(bundle, SAFARI_EXTENSION_PATH)}\n`
    });
    if (command.endsWith('/lsregister')) throw Object.assign(new Error('unregistered'), {
      code: 1, stderr: `failed to scan ${bundle}: -10814\n from spotlight`
    });
    return { stdout: command.endsWith('/plutil') ? SAFARI_EXTENSION_ID : '' };
  });
  await assert.rejects(stat(bundle), { code: 'ENOENT' }, 'verified raw backups are retired even before discovery');
} finally { await rm(directory, { recursive: true, force: true }); }

const installer = await readFile(join(root, 'scripts/update-safari-extension.mjs'), 'utf8');
assert.match(installer, /if \(backup\) await archiveSafariBundle\(backup, archives\)/);
assert.match(installer, /await archiveSafariBundle\(app, archives\)/);
assert.match(installer, /await repairSafariRegistration/);
console.log('Safari duplicate discovery, live-install protection, and verified-backup tests passed.');
