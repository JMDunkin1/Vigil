import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, lstat, readdir, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

const exec = promisify(execFile);
export const SAFARI_APP = '/Applications/Vigil Safari.app';
export const SAFARI_EXTENSION_ID = 'tech.caseline.vigil.safari.Extension';
export const SAFARI_EXTENSION_PATH = 'Contents/PlugIns/Vigil Safari Extension.appex';
const lsregister = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

export function registeredSafariExtensions(output) {
  return [...new Set(output.split('\n').flatMap(line => {
    const fields = line.split('\t');
    const path = fields.at(-1)?.trim();
    return /^tech\.caseline\.vigil\.safari\.Extension\([^)]+\)$/.test(fields[0]?.trim().replace(/^[+!-]\s*/, '') || '') && path?.startsWith('/')
      ? [path] : [];
  }))];
}

export function safariBuildBundle(extensionPath, sourceRoots) {
  const suffix = `${sep}${SAFARI_EXTENSION_PATH}`;
  if (!extensionPath.endsWith(suffix)) return null;
  const bundle = extensionPath.slice(0, -suffix.length);
  if (resolve(bundle) === SAFARI_APP) return null;
  for (const sourceRoot of sourceRoots) {
    for (const folder of ['safari', 'safari.noindex']) {
      const output = join(resolve(sourceRoot), 'dist.nosync', folder);
      if (bundle === join(output, 'DerivedData/Build/Products/Release/Vigil Safari.app')) return bundle;
      if (dirname(bundle) === output && /^previous-[a-f0-9-]+\.(?:app|backup)$/.test(basename(bundle))) return bundle;
    }
  }
  return null;
}

export async function archiveSafariBundle(bundle, archiveDirectory, run = exec) {
  if (resolve(bundle) === SAFARI_APP) throw new Error('Cannot archive the live Safari installation.');
  const info = await lstat(bundle);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Not a real Safari bundle directory: ${bundle}`);
  const id = (await run('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', join(bundle, SAFARI_EXTENSION_PATH, 'Contents/Info.plist')])).stdout.trim();
  if (id !== SAFARI_EXTENSION_ID) throw new Error(`Unexpected extension identity in ${bundle}`);
  await mkdir(archiveDirectory, { recursive: true, mode: 0o700 });
  const archive = join(archiveDirectory, `vigil-safari-${randomUUID()}.zip`);
  await run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', bundle, archive]);
  await run('/usr/bin/unzip', ['-tqq', archive]);
  // Raw .appex directories are rediscovered even inside .backup directories.
  // Keep a verified ZIP for rollback, then retire only this archived copy.
  const extension = join(bundle, SAFARI_EXTENSION_PATH);
  try { await run('/usr/bin/pluginkit', ['-r', extension]); }
  catch (error) {
    // A freshly moved backup may never have been registered. That is already
    // the desired state; all other registration errors must retain the bundle.
    if (error.code !== 1 || String(error.stderr || '').trim() !== `remove: no plugin at ${extension}`) throw error;
  }
  try { await run(lsregister, ['-u', bundle]); }
  catch (error) {
    // kLSApplicationNotFoundErr: an undiscovered .backup has no application
    // registration to remove. Do not suppress unrelated Launch Services errors.
    if (error.code !== 1 || !String(error.stderr || '').startsWith(`failed to scan ${bundle}: -10814\n`)) throw error;
  }
  await rm(bundle, { recursive: true });
  return archive;
}

export async function repairSafariRegistration(sourceRoots, archiveDirectory) {
  await exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', SAFARI_APP]);
  const listing = (await exec('/usr/bin/pluginkit', ['-m', '-A', '-D', '-v', '-i', SAFARI_EXTENSION_ID])).stdout;
  const candidates = new Set(registeredSafariExtensions(listing));
  // Also retire raw backups not yet discovered by Launch Services. Otherwise
  // they can reappear only after the next login, defeating today's check.
  for (const root of sourceRoots) {
    for (const folder of ['safari', 'safari.noindex']) {
      const output = join(root, 'dist.nosync', folder);
      let entries;
      try { entries = await readdir(output, { withFileTypes: true }); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      for (const entry of entries) {
        if (entry.isDirectory()) candidates.add(join(output, entry.name, SAFARI_EXTENSION_PATH));
      }
      candidates.add(join(output, 'DerivedData/Build/Products/Release/Vigil Safari.app', SAFARI_EXTENSION_PATH));
    }
  }
  const archives = [];
  for (const extension of candidates) {
    const bundle = safariBuildBundle(extension, sourceRoots);
    if (bundle) {
      try { archives.push(await archiveSafariBundle(bundle, archiveDirectory)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  await exec(lsregister, ['-f', SAFARI_APP]);
  await exec('/usr/bin/pluginkit', ['-a', join(SAFARI_APP, SAFARI_EXTENSION_PATH)]);
  const remaining = registeredSafariExtensions((await exec('/usr/bin/pluginkit', ['-m', '-A', '-D', '-v', '-i', SAFARI_EXTENSION_ID])).stdout);
  if (remaining.length !== 1 || remaining[0] !== join(SAFARI_APP, SAFARI_EXTENSION_PATH)) {
    throw new Error(`Safari still has unexpected extension registrations: ${remaining.join(', ')}`);
  }
  return { installed: SAFARI_APP, archivedCopies: archives.length, archives };
}
