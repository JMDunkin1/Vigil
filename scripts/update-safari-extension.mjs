#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, rename, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
const exec = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(root, 'dist.nosync', 'safari');
await mkdir(output, { recursive: true, mode: 0o700 });
const { launchAgentDataDirFromPlist } = await import('../dist/runtime/src/dataPaths.js');
let dataDir = process.env.VIGIL_DATA_DIR;
if (!dataDir) {
  const plist = await readFile(join(homedir(), 'Library/LaunchAgents/tech.caseline.vigil.supervisor.plist'), 'utf8');
  dataDir = launchAgentDataDirFromPlist(plist).dataDir;
}
if (!dataDir) throw new Error('Cannot identify the running Vigil data directory.');
const connection = JSON.parse(await readFile(join(dataDir, 'youtube-connection.json'), 'utf8'));
if (!/^[a-f0-9]{64}$/.test(connection.token || '')) throw new Error('Invalid Vigil connection credential.');
const response = await fetch('http://127.0.0.1:8789/api/extension/youtube', {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'x-vigil-extension-token': connection.token },
  body: JSON.stringify({ action: 'status' }), signal: AbortSignal.timeout(5000)
});
if (!response.ok || !(await response.json()).ok) throw new Error('The running Vigil did not accept the Safari connection. No app was installed.');
const configuration = join(output, 'youtube-connection.json');
await writeFile(configuration, JSON.stringify({ token: connection.token }), { mode: 0o600 });
const identities = (await exec('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'])).stdout;
const identity = identities.match(/\b([A-F0-9]{40}) "Apple Development:[^"]+"/u)?.[1];
if (!identity) throw new Error('An Apple Development signing identity is required. Unsigned Safari extensions are not an enforcement deployment.');
try {
  await exec('/usr/bin/xcodebuild', [
    '-project', join(root, 'macos/Vigil Safari/Vigil Safari.xcodeproj'),
    '-scheme', 'Vigil Safari', '-configuration', 'Release',
    '-derivedDataPath', join(output, 'DerivedData'), '-destination', 'generic/platform=macOS',
    'CODE_SIGN_STYLE=Manual', `CODE_SIGN_IDENTITY=${identity}`, 'DEVELOPMENT_TEAM=3RY7A22U4L',
    `VIGIL_SAFARI_CONNECTION_FILE=${configuration}`, 'build'
  ], { timeout: 480000, maxBuffer: 24 * 1024 * 1024 });
} catch (error) {
  await writeFile(join(output, 'build.log'), `${error.stdout || ''}\n${error.stderr || ''}`);
  throw new Error(`Safari build failed. See ${join(output, 'build.log')}`, { cause: error });
}
const app = join(output, 'DerivedData/Build/Products/Release/Vigil Safari.app');
await exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
const resources = join(app, 'Contents/PlugIns/Vigil Safari Extension.appex/Contents/Resources');
for (const name of ['search-guard.js', 'manifest.json', 'reddit-child-lock.js', 'media-child-lock.js', 'youtube-parity.js', 'youtube-limits.js', 'youtube-bridge.js', 'youtube-background.js', 'status.html', 'status.js', 'icons/icon-16.png', 'icons/icon-32.png', 'icons/icon-48.png', 'icons/icon-128.png', 'icons/toolbar.png']) {
  const source = await readFile(join(root, 'ios/VigilSocial/VigilYouTubeInteractionExtension/Resources', name));
  if (!source.equals(await readFile(join(resources, name)))) throw new Error(`Stale Safari resource: ${name}`);
}
console.log('Signed Safari package built; running Vigil connection verified.');
if (process.argv.includes('--install')) {
  const destination = '/Applications/Vigil Safari.app';
  const staged = `/Applications/.Vigil Safari-${randomUUID()}.app`;
  await exec('/usr/bin/ditto', [app, staged]);
  await exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', staged]);
  let backup = null;
  try {
    await stat(destination);
    backup = join(output, `previous-${randomUUID()}.backup`);
    await rename(destination, backup);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { await rename(staged, destination); }
  catch (error) {
    if (backup) await rename(backup, destination);
    throw error;
  }
  await exec('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-f', destination]);
  await exec('/usr/bin/pluginkit', ['-a', join(destination, 'Contents/PlugIns/Vigil Safari Extension.appex')]);
  await exec('/usr/bin/pluginkit', ['-r', join(app, 'Contents/PlugIns/Vigil Safari Extension.appex')]);
  console.log('Installed /Applications/Vigil Safari.app. Enable its extension and YouTube website access in Safari settings, then verify a YouTube page.');
}
