import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';
import { youtubeBuildConfiguration, youtubeLocalEngine } from '../scripts/youtube-build-connection.mjs';

test('phone bundles a standalone ledger and preserves the migration seed without a server credential', async () => {
  const original = process.env.VIGIL_DATA_DIR;
  const directory = await mkdtemp(join(tmpdir(), 'vigil-youtube-local-'));
  process.env.VIGIL_DATA_DIR = directory;
  try {
    const configuration = JSON.parse(await readFile(await youtubeBuildConfiguration(), 'utf8'));
    assert.equal(configuration.mode, 'local');
    assert.equal(configuration.server, undefined);
    assert.equal(configuration.token, undefined);
    const action = runInNewContext(`${configuration.engine}\nvigilLocalAction`, { __uuid: randomUUID });
    const saved = JSON.parse(action('{}', JSON.stringify({ action: 'save', videoId: 'abcdefghijk', title: 'Real YouTube title' })));
    assert.equal(saved.reply.ok, true);
    assert.equal(saved.reply.slots[0].title, 'Real YouTube title');
    saved.state.youtubeLimits.usedMs = 7200000;
    saved.state.youtubeLimits.grace = { status: 'ended', videoId: null, usedMs: 1200000 };
    await writeFile(join(directory, 'state.json'), JSON.stringify(saved.state));
    const seeded = JSON.parse(await readFile(await youtubeBuildConfiguration(), 'utf8'));
    assert.deepEqual(seeded.seed, saved.state);
    const restoredAction = runInNewContext(`${seeded.engine}\nvigilLocalAction`, { __uuid: randomUUID });
    const blocked = JSON.parse(restoredAction(JSON.stringify(seeded.seed), JSON.stringify({ action: 'start', videoId: 'abcdefghijk', client: 'phone' })));
    assert.equal(blocked.reply.ok, false);
    assert.equal(blocked.reply.usedMs, 7200000);
  } finally {
    if (original === undefined) delete process.env.VIGIL_DATA_DIR;
    else process.env.VIGIL_DATA_DIR = original;
    await rm(directory, { recursive: true, force: true });
  }
});

test('the bundled phone engine persists account reconciliation and refuses a fifth save after reopening', async () => {
  const engine = await youtubeLocalEngine();
  const load = () => runInNewContext(`${engine}\nvigilLocalAction`, { __uuid: randomUUID });
  let action = load();
  let current = JSON.parse(action('{}', JSON.stringify({ action: 'watch-later-checkpoint' })));
  const ids = Array.from({ length: 4 }, (_, i) => `video${String(i).padStart(6, '0')}`);
  current = JSON.parse(action(JSON.stringify(current.state), JSON.stringify({ action: 'watch-later-sync',
    accountKey: 'a'.repeat(64), complete: true, revision: 0, day: current.reply.day,
    videoIds: ids, cards: ids.map(videoId => ({ videoId, title: videoId })) })));
  assert.equal(current.reply.ok, true);
  assert.equal(current.reply.slots.filter(Boolean).length, 4);
  assert.deepEqual(current.state.youtubeLimits.watchLater.videoIds, ids);
  action = load();
  const blocked = JSON.parse(action(JSON.stringify(current.state), JSON.stringify({ action: 'save', videoId: 'video000004' })));
  assert.equal(blocked.reply.ok, false);
  assert.deepEqual(blocked.state.youtubeLimits.watchLater, current.state.youtubeLimits.watchLater);
});
