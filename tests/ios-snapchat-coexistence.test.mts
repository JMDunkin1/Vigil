import assert from 'node:assert/strict';
import { defaultState, SOFT_BLOCK_PROFILE_ID, BRICK_MODE_PROFILE_ID } from '../src/defaults.js';
import { iosPolicyTargets, normalizeIosSettings } from '../src/iosProfiles.js';
import { profileById } from '../src/policy.js';
const now = new Date('2026-09-13T20:00:00Z');
const state = defaultState();
state.deviceControls.ios.enabled = true;
state.settings.adultBlocklistEnabled = false;
for (const profileId of [null, SOFT_BLOCK_PROFILE_ID, BRICK_MODE_PROFILE_ID]) {
  state.activeSessions.phone = profileId ? {
    id: 'test-phone', title: 'Phone', mode: 'focus', profileId, lockLevel: 'light',
    startedAt: now.toISOString(), endsAt: new Date(now.getTime()+3600000).toISOString(),
    canEndEarly: true, source: 'manual', deviceTargets: ['phone'], profileSnapshot: profileById(state, profileId)
  } : null;
  state.deviceControls.ios.allowNativeSnapchat = false;
  const before = iosPolicyTargets(state, now);
  state.deviceControls.ios = normalizeIosSettings({allowNativeSnapchat: true}, state.deviceControls.ios);
  const after = iosPolicyTargets(state, now);
  assert.deepEqual(after.deniedUrls, before.deniedUrls);
  assert.deepEqual(after.allowedUrls, before.allowedUrls);
  assert.deepEqual(after.grayscale, before.grayscale);
  if (profileId === BRICK_MODE_PROFILE_ID) assert.deepEqual(after.appBundleIds, before.appBundleIds);
  else {
    assert.deepEqual(after.appBundleIds, before.appBundleIds.filter(id => id !== 'com.toyopagroup.picaboo'));
    assert.ok(!after.appBundleIds.includes('com.toyopagroup.picaboo'));
    assert.ok(after.appBundleIds.includes('com.google.ios.youtube'));
  }
  assert.equal(normalizeIosSettings({}, state.deviceControls.ios).allowNativeSnapchat, true);
  assert.equal(normalizeIosSettings({allowNativeSnapchat:false}, state.deviceControls.ios).allowNativeSnapchat, false);
}
console.log('Snapchat coexistence preserves other app restrictions, web filters, and full brick.');

state.activeSessions.phone = null;
state.deviceControls.ios.allowNativeSnapchat = true;
state.limitBlocks = [{
  id: 'snapchat-limit', ruleId: 'snapchat-limit', ruleName: 'Snapchat time', type: 'time', lockLevel: 'deep',
  apps: ['com.toyopagroup.picaboo', 'tech.caseline.vigil.snapchat'], sites: [], deviceTargets: ['phone'],
  createdAt: now.toISOString(), until: new Date(now.getTime()+3600000).toISOString()
}];
for (const mode of ['denylist', 'allowlist']) {
  state.deviceControls.ios.mode = mode;
  const limited = iosPolicyTargets(state, now);
  assert.ok(limited.appBundleIds.includes('com.toyopagroup.picaboo'));
  assert.ok(limited.appBundleIds.includes('tech.caseline.vigil.snapchat'));
  assert.equal(limited.appMode, 'denylist');
}
