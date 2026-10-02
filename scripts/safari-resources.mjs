import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const resources = [
  'blocked-navigation.js', 'reddit-review-background.js', 'reddit-review-guard.js',
  'reddit-review-blocked.html', 'blocked.html', 'blocked.css', 'search-guard.js',
  'manifest.json', 'reddit-child-lock.js', 'media-child-lock.js', 'youtube-parity.js',
  'youtube-limits.js', 'youtube-bridge.js', 'youtube-background.js', 'youtube-player-response.js',
  'status.html', 'status.js', 'icons/icon-16.png', 'icons/icon-32.png',
  'icons/icon-48.png', 'icons/icon-128.png', 'icons/toolbar.png'
];

export function safariManifestScripts(manifest) {
  return [...new Set([
    ...(manifest.content_scripts || []).flatMap(script => script.js || []),
    ...(manifest.background?.scripts || []),
    ...(manifest.background?.service_worker ? [manifest.background.service_worker] : [])
  ])];
}

export async function verifySafariResources(sourceResources, bundleResources) {
  const manifest = JSON.parse(await readFile(join(sourceResources, 'manifest.json'), 'utf8'));
  // Derive all executable resources from the manifest as well as checking the
  // canonical assets, so adding a script cannot silently omit deployment checks.
  const names = new Set([...resources, ...safariManifestScripts(manifest)]);
  for (const name of names) {
    const source = await readFile(join(sourceResources, name));
    let bundled;
    try { bundled = await readFile(join(bundleResources, name)); }
    catch (error) {
      if (error.code === 'ENOENT') throw new Error(`Missing Safari resource: ${name}`, { cause: error });
      throw error;
    }
    if (!source.equals(bundled)) throw new Error(`Stale Safari resource: ${name}`);
  }
}
