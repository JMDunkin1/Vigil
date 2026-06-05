import assert from "node:assert/strict";
import { defaultState, SOFT_BLOCK_PROFILE_ID } from "../../src/defaults.js";
import { authorizeIosMdmRequest, buildIosMdmEnrollmentProfile, buildIosMdmPushRequest, handleIosMdmCheckIn, handleIosMdmConnect, iosMdmSummary, normalizeIosMdmSettings, queueIosMdmPolicyRefresh } from "../../src/iosMdm.js";
import { buildIosConfigurationProfile } from "../../src/iosProfiles.js";
import { parsePlist, plistData, toPlist } from "../../src/plist.js";
import { profileById } from "../../src/policy.js";
import { must, now, recordValue, stringValue } from "./test-helpers.mjs";

{
  const state = defaultState();
  const disabledProfile = buildIosConfigurationProfile(state, now);
  assert.doesNotMatch(disabledProfile, /blockedAppBundleIDs/);
  assert.doesNotMatch(disabledProfile, /allowAppInstallation/);
  assert.doesNotMatch(disabledProfile, /PayloadRemovalDisallowed<\/key>\s*<true/);

  state.deviceControls.ios.enabled = true;
  const enabledProfile = buildIosConfigurationProfile(state, now);
  assert.doesNotMatch(enabledProfile, /blockedAppBundleIDs/);
  assert.match(enabledProfile, /pornhub\.com/);
  assert.match(enabledProfile, /allowAppInstallation/);

  state.activeSessions.phone = {
    id: "phone-strict",
    title: "Phone strict",
    mode: "focus",
    profileId: "default",
    lockLevel: "deep",
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    canEndEarly: false,
    source: "manual",
    deviceTargets: ["phone"]
  };
  const activePhoneProfile = buildIosConfigurationProfile(state, now);
  assert.match(activePhoneProfile, /blockedAppBundleIDs/);
  assert.match(activePhoneProfile, /com\.google\.ios\.youtube/);

  state.activeSessions.phone = {
    id: "phone-soft-ios",
    title: "Phone Soft Block",
    mode: "focus",
    profileId: SOFT_BLOCK_PROFILE_ID,
    lockLevel: "light",
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    canEndEarly: true,
    source: "manual",
    deviceTargets: ["phone"],
    profileSnapshot: profileById(state, SOFT_BLOCK_PROFILE_ID)
  };
  const softPhoneProfile = buildIosConfigurationProfile(state, now);
  assert.doesNotMatch(softPhoneProfile, /blockedAppBundleIDs/);
  assert.match(softPhoneProfile, /com\.apple\.webClip\.managed/);
  assert.match(softPhoneProfile, /Sentinel Instagram/);
  assert.match(softPhoneProfile, /instagram\.com\/direct\/inbox/);
  assert.match(softPhoneProfile, /instagram\.com\/reel/);
  assert.doesNotMatch(softPhoneProfile, /instagram\.com\/explore/);
}

{
  const roundTrip = recordValue(parsePlist(toPlist({
    MessageType: "TokenUpdate",
    Count: 2,
    Enabled: true,
    Token: plistData(Buffer.from("hello"))
  })), "round-trip plist");
  assert.equal(roundTrip.MessageType, "TokenUpdate");
  assert.equal(roundTrip.Count, 2);
  assert.equal(roundTrip.Enabled, true);
  assert.equal(recordValue(roundTrip.Token, "plist token").__plistData, Buffer.from("hello").toString("base64"));

  const state = defaultState();
  state.deviceControls.ios.enabled = true;
  state.deviceControls.ios.mdm = {
    ...state.deviceControls.ios.mdm,
    enabled: true,
    publicBaseUrl: "https://mdm.example.test",
    topic: "com.apple.mgmt.Example",
    identityCertificateUuid: "11111111-2222-3333-4444-555555555555",
    identityCertificatePayloadBase64: Buffer.from("identity").toString("base64")
  };
  const summary = iosMdmSummary(state, now);
  assert.equal(summary.enrollmentReady, true);
  assert.equal(summary.ready, false);
  assert.equal(summary.status, "queue-only");
  assert.match(summary.enrollmentUrl, /^https:\/\/mdm\.example\.test\/mdm\/enroll\.mobileconfig\?token=/);

  state.deviceControls.ios.mdm.pushCertificatePayloadBase64 = Buffer.from("push-cert").toString("base64");
  const pushReadySummary = iosMdmSummary(state, now);
  assert.equal(pushReadySummary.ready, true);
  assert.equal(pushReadySummary.pushSupported, true);

  const enrollment = buildIosMdmEnrollmentProfile(state);
  const profileToken = enrollment.match(/token=([^<]+)/)?.[1] || "";
  assert.equal(authorizeIosMdmRequest(state, new URL(`https://mdm.example.test/mdm/checkin?token=${profileToken}`)), true);
  assert.match(enrollment, /com\.apple\.mdm/);
  assert.match(enrollment, /https:\/\/mdm\.example\.test\/mdm\/connect/);
  assert.match(enrollment, /com\.apple\.mgmt\.Example/);

  const checkIn = handleIosMdmCheckIn(state, {
    MessageType: "TokenUpdate",
    UDID: "iphone-udid-1",
    Topic: "com.apple.mgmt.Example",
    PushMagic: "push-magic",
    Token: plistData(Buffer.from("push-token"))
  }, now);
  assert.equal(checkIn.messageType, "TokenUpdate");
  assert.equal(state.deviceControls.ios.mdm.devices.length, 1);
  assert.equal(state.deviceControls.ios.mdm.commands.some((command) => command.requestType === "InstallProfile"), true);
  assert.equal(state.deviceControls.ios.mdm.devices[0].tokenHex, Buffer.from("push-token").toString("hex"));
  const mdmSettings = normalizeIosMdmSettings({}, state.deviceControls.ios.mdm);
  const enrolledDevice = must(mdmSettings.devices[0], "enrolled MDM device");
  const pushRequest = buildIosMdmPushRequest(mdmSettings, enrolledDevice);
  assert.equal(pushRequest.endpoint, "https://api.push.apple.com");
  assert.equal(pushRequest.path, `/3/device/${Buffer.from("push-token").toString("hex")}`);
  assert.equal(pushRequest.headers["apns-topic"], "com.apple.mgmt.Example");
  assert.equal(pushRequest.headers["apns-push-type"], "mdm");
  assert.equal(pushRequest.payload, JSON.stringify({ mdm: "push-magic" }));

  const nextCommandOfType = (requestType: string) => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const command = handleIosMdmConnect(state, { UDID: "iphone-udid-1", Status: "Idle" }, now);
      assert.equal(command.empty, false);
      const commandBody = recordValue(must(command.body, "MDM command body"), "MDM command body");
      const payload = recordValue(commandBody.Command, "MDM command");
      const commandUuid = stringValue(commandBody.CommandUUID, "sent command UUID");
      if (payload.RequestType === requestType) return { commandBody, payload, commandUuid };
      handleIosMdmConnect(state, {
        UDID: "iphone-udid-1",
        Status: "Acknowledged",
        CommandUUID: commandUuid
      }, now);
    }
    throw new Error(`Expected queued ${requestType} command.`);
  };

  const { payload: installCommand, commandUuid: sentCommandUuid } = nextCommandOfType("InstallProfile");
  assert.equal(installCommand.RequestType, "InstallProfile");
  const acknowledged = handleIosMdmConnect(state, {
    UDID: "iphone-udid-1",
    Status: "Acknowledged",
    CommandUUID: sentCommandUuid
  }, now);
  assert.equal(must(state.deviceControls.ios.mdm.commands.find((item) => item.commandUuid === sentCommandUuid), "acknowledged MDM command").status, "acknowledged");
  assert.equal(acknowledged.empty, false);

  const duplicate = queueIosMdmPolicyRefresh(state, "test-refresh", now, { udids: ["iphone-udid-1"] });
  assert.equal(duplicate.queued >= 0, true);

  state.deviceControls.ios.enabled = false;
  const removePolicy = queueIosMdmPolicyRefresh(state, "disable-ios", now, { udids: ["iphone-udid-1"] }) as { profileQueued?: number };
  assert.equal(removePolicy.profileQueued, 1);
  const { payload: removePayload } = nextCommandOfType("RemoveProfile");
  assert.equal(removePayload.RequestType, "RemoveProfile");
  assert.equal(removePayload.Identifier, "com.local-screen-time.ios-lock");
}
