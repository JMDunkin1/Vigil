# Sentinel + ManageEngine MDM Setup

This is the normal hosted-MDM path for a solo Sentinel install. ManageEngine owns Apple APNs enrollment, device wakeups, profile assignment, and profile removal; Sentinel exports supervised iPhone profiles as custom configuration profiles. Exporting files locally does not upload, assign, or deploy them.

Use this path when Apple Business Manager is not available and you do not want to pay for Apple Developer Program MDM Vendor CSR access.

Official references:

- ManageEngine MDM Plus free edition: https://www.manageengine.com/mobile-device-management/free-mobile-device-management-software.html
- ManageEngine APNs certificate setup: https://www.manageengine.com/mobile-device-management/help/enrollment/mdm_creating_apns_certificate.html
- ManageEngine custom iOS configuration profile workflow: https://www.manageengine.com/mobile-device-management/how-to/mdm-create-custom-configuration-profile-creator.html
- ManageEngine API docs for later automation: https://www.manageengine.com/mobile-device-management/api/introduction/

## What Sentinel Can Set Up Locally

Generate the final policy profile for ManageEngine:

```sh
npm run ios:manageengine:export
```

That writes:

- `data/manageengine/sentinel-manageengine-policy.mobileconfig`
- `data/manageengine/sentinel-manageengine-policy.summary.json`
- `data/manageengine/sentinel-social-launchers.mobileconfig`
- `data/manageengine/sentinel-social-launchers.summary.json`

The social-launcher profile is static, has stable payload UUIDs, and never receives `DurationUntilRemoval`. Keep it assigned separately from the dynamic policy profile so Level changes cannot delete and recreate the Instagram, YouTube, and Snapchat launcher icons. The summary sidecars report `deployment.status: unverified` until an installed-profile observation proves the uploaded artifact is current.

The first migration from an older combined Sentinel profile is different: the Web Clip payload identifiers move from `com.local-screen-time.ios-lock.*` to `com.local-screen-time.ios-social-launchers.*`. iOS can remove and recreate those icons during that one-time handoff even when labels and URLs match. A current, complete layout checkpoint is mandatory before assigning the launcher profile or updating the old policy profile, and the rendered Home Screen must be compared after the migration before continuing.

To make deployment status verifiable, provide separate read-only observations for the dynamic and launcher profiles:

```json
{
  "observedAt": "2026-07-10T12:00:00.000Z",
  "installedProfileIdentifier": "com.local-screen-time.ios-lock",
  "installedProfileHash": "<sha256-of-the-exact-deployed-mobileconfig-bytes>",
  "effectiveProhibitAppInstall": false,
  "effectiveProhibitAppDelete": false
}
```

```sh
npm run ios:manageengine:export -- \
  --deployment-observation /path/to/policy-observation.json \
  --launcher-deployment-observation /path/to/launcher-observation.json
```

Use `com.local-screen-time.ios-social-launchers` in the launcher observation. A hash is comparable only when it was computed over the exact bytes ManageEngine deployed; if ManageEngine signs or reserializes the profile and those deployed bytes cannot be retrieved, omit the hash and keep the artifact status `unverified`. Effective restriction conflicts are reported separately from artifact staleness.

Generate a temporary enrollment-window profile if the currently installed Sentinel profile blocks installing new profiles:

```sh
npm run ios:manageengine:export -- --enrollment-window
```

That writes:

- `data/manageengine/sentinel-manageengine-enrollment-window.mobileconfig`
- `data/manageengine/sentinel-manageengine-enrollment-window.summary.json`

The enrollment-window profile keeps the Sentinel policy enabled but turns off the profile-install and removal hardening that can block installing ManageEngine's enrollment profile. It does not save Sentinel state.

Only after creating and validating a current, complete iPhone layout checkpoint, the enrollment-window profile can be applied over USB to an already supervised phone:

```sh
npm run ios:apply-usb -- --profile data/manageengine/sentinel-manageengine-enrollment-window.mobileconfig
```

Or start the watcher before plugging in the phone:

```sh
npm run ios:manageengine:apply-enrollment-window
```

That regenerates the enrollment-window profile, waits for one trusted USB iPhone, and installs it through the same guarded Sentinel USB path.

Keep using the same `data/sentinel-supervisor.keybag` or `SENTINEL_SUPERVISOR_KEYBAG` that manages this supervised iPhone. This command still refuses to proceed if the phone is not supervised.

## ManageEngine Account Setup

1. Create a ManageEngine Mobile Device Manager Plus Cloud account and select the free edition when the trial ends.
2. In ManageEngine, create the APNs certificate:
   - download ManageEngine's signed CSR
   - upload it to Apple's Push Certificates Portal with your Apple Account
   - download the Apple push certificate
   - upload that certificate back into ManageEngine
3. Enroll the iPhone into ManageEngine.
   - If iOS refuses to install the enrollment profile, apply the Sentinel enrollment-window profile over USB first.
   - Do not erase the phone for this path.
4. Build and install the signed `ios/SentinelSocial` companion app, then create a static iOS custom configuration profile and upload `data/manageengine/sentinel-social-launchers.mobileconfig`. The launchers target the companion bundle identifier.
5. Assign the static launcher profile once. Do not add a timed removal command to it.
6. Create a second iOS custom configuration profile and upload `data/manageengine/sentinel-manageengine-policy.mobileconfig`.
7. Assign the dynamic policy profile to the enrolled iPhone.
8. Confirm both profile identifiers are installed on the phone under Settings > General > VPN & Device Management.

Sentinel includes ManageEngine's iOS helper app bundle (`com.zohocorp.mdm`) in the app restrictions payload when app restrictions are enabled. That hides the visible vendor app without removing the managed profile, enrollment, or hosted remote-delivery channel.

## Operational Notes

- Treat Sentinel's self-hosted MDM doctor as advanced diagnostic tooling only. It can still report APNs certificate blockers while the ManageEngine path is healthy, because ManageEngine, not Sentinel, is the MDM server in normal use.
- The static Sentinel USB profile can remain in place during setup. If ManageEngine reports a duplicate profile identifier conflict, apply the enrollment-window profile over USB, enroll, then push the final ManageEngine policy again.
- Re-export and re-upload the dynamic policy after changing Sentinel's iPhone app/web targets. Re-upload the launcher profile only when launcher URLs, labels, icons, or the companion app target change.
- `appStoreAllowedByThisProfile: true` means the exported artifact omits App Store prohibition keys; it does not prove that an older installed profile stopped enforcing them. Use the deployment hash and effective-restriction check in the summary before calling the phone current.
- API automation should wait until the manual upload/assignment path works once. After that, wire the ManageEngine API using the tenant URL, OAuth token, device/group IDs, and the exact profile endpoint shape from your tenant.
