import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dataDir = await mkdtemp(join(tmpdir(), 'vigil-context-'));
process.env.VIGIL_DATA_DIR = dataDir;
const [{ defaultState }, store, { RuntimeMutationCoordinator }] = await Promise.all([
  import('../src/defaults.js'), import('../src/store.js'), import('../src/server/mutationCoordinator.js')
]);
try {
  const state = defaultState();
  const coordinator = new RuntimeMutationCoordinator(state, {});
  let deferred: Promise<void> = Promise.resolve();
  let effectCompleted = false;
  await coordinator.run(async () => {
    deferred = new Promise<void>((resolve, reject) => {
      setImmediate(() => {
        const followup = coordinator.run(async context => {
          context.state.settings.siteRedirectEnabled = false;
          context.afterCommit(async () => {
            await coordinator.run(async next => { next.state.settings.siteRedirectEnabled = true; });
            effectCompleted = true;
          });
        });
        void followup.then(() => resolve(), reject);
      });
    });
  });
  await deferred;
  assert.equal(effectCompleted, true, 'a monitor callback inherited from a completed transaction must commit and run its effects');
  assert.equal(state.settings.siteRedirectEnabled, true);
  // Detached late writes must still be rejected; only coordinated work gets a
  // new transaction boundary, never arbitrary descendants of a saved draft.
  let lateSave: Promise<void> = Promise.resolve();
  await store.withStagedPersistence(async () => {
    lateSave = new Promise<void>((resolve, reject) => {
      setImmediate(() => { void store.saveState(state).then(resolve, reject); });
    });
    await assert.rejects(store.withStagedPersistence(async () => {}), /Nested Vigil/);
  });
  await assert.rejects(lateSave, /transaction is closed/);
  console.log('Persistence context recovery regression passed');
} finally { await rm(dataDir, { recursive: true, force: true }); }
