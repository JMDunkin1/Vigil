import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureYouTubeConnection, youtubeConnectionPath, youtubeTokenMatches } from '../src/youtubeConnection.js';
import { apiRequestGuard, publicHostGuard } from '../src/apiSecurity.js';
test('phone credential persists privately and authorizes only the YouTube endpoint', async () => {
  const original = process.env.VIGIL_DATA_DIR;
  const directory = await mkdtemp(join(tmpdir(), 'vigil-youtube-auth-'));
  process.env.VIGIL_DATA_DIR = directory;
  try {
    const connection = await ensureYouTubeConnection();
    assert.deepEqual(await ensureYouTubeConnection(), connection);
    assert.equal((await stat(youtubeConnectionPath())).mode & 0o777, 0o600);
    assert.equal(youtubeTokenMatches(connection.token), true);
    assert.equal(youtubeTokenMatches('0'.repeat(64)), false);
    const headers = { host: 'owner.local:8789', 'x-vigil-extension-token': connection.token, 'content-type': 'application/json' };
    const request = { headers, method: 'POST', remoteAddress: '192.168.1.2', path: '/api/extension/youtube' };
    assert.equal(publicHostGuard(request).ok, true);
    assert.equal(apiRequestGuard(request).ok, true);
    assert.equal(publicHostGuard({ ...request, path: '/api/state' }).ok, false);
    assert.equal(apiRequestGuard({ ...request, path: '/api/extension/pause/skip' }).ok, false);
    assert.equal(publicHostGuard({ ...request, headers: { host: headers.host } }).ok, false);
  } finally {
    if (original === undefined) delete process.env.VIGIL_DATA_DIR;
    else process.env.VIGIL_DATA_DIR = original;
    await rm(directory, { recursive: true, force: true });
  }
});
