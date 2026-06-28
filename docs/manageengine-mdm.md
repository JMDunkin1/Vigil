# Vigil + ManageEngine MDM Setup

This is the normal hosted-MDM path for a solo Vigil install. ManageEngine owns Apple APNs enrollment, device wakeups, profile assignment, and profile removal; Vigil exports the supervised iPhone policy as a custom configuration profile.

Use this path when Apple Business Manager is not available and you do not want to pay for Apple Developer Program MDM Vendor CSR access.

Official references:

- ManageEngine MDM Plus free edition: https://www.manageengine.com/mobile-device-management/free-mobile-device-management-software.html
- ManageEngine APNs certificate setup: https://www.manageengine.com/mobile-device-management/help/enrollment/mdm_creating_apns_certificate.html
- ManageEngine custom iOS configuration profile workflow: https://www.manageengine.com/mobile-device-management/how-to/mdm-create-custom-configuration-profile-creator.html
- ManageEngine API docs for later automation: https://www.manageengine.com/mobile-device-management/api/introduction/

## What Vigil Can Set Up Locally

Generate the final policy profile for ManageEngine:

```sh
npm run ios:manageengine:export
```

That writes:

- `data/manageengine/vigil-manageengine-policy.mobileconfig`
- `data/manageengine/vigil-manageengine-policy.summary.json`

Generate a temporary enrollment-window profile if the currently installed Vigil profile blocks installing new profiles:

```sh
npm run ios:manageengine:export -- --enrollment-window
```

That writes:

- `data/manageengine/vigil-manageengine-enrollment-window.mobileconfig`
- `data/manageengine/vigil-manageengine-enrollment-window.summary.json`

The enrollment-window profile keeps the Vigil policy enabled but turns off the profile-install and removal hardening that can block installing ManageEngine's enrollment profile. It does not save Vigil state.

If needed, apply the enrollment-window profile over USB to an already supervised phone:

```sh
npm run ios:apply-usb -- --profile data/manageengine/vigil-manageengine-enrollment-window.mobileconfig
```

Or start the watcher before plugging in the phone:

```sh
npm run ios:manageengine:apply-enrollment-window
```

That regenerates the enrollment-window profile, waits for one trusted USB iPhone, and installs it through the same guarded Vigil USB path.

Keep using the same `data/vigil-supervisor.keybag` or `VIGIL_SUPERVISOR_KEYBAG` that manages this supervised iPhone. This command still refuses to proceed if the phone is not supervised.

## ManageEngine Account Setup

1. Create a ManageEngine Mobile Device Manager Plus Cloud account and select the free edition when the trial ends.
2. In ManageEngine, create the APNs certificate:
   - download ManageEngine's signed CSR
   - upload it to Apple's Push Certificates Portal with your Apple Account
   - download the Apple push certificate
   - upload that certificate back into ManageEngine
3. Enroll the iPhone into ManageEngine.
   - If iOS refuses to install the enrollment profile, apply the Vigil enrollment-window profile over USB first.
   - Do not erase the phone for this path.
4. In ManageEngine, create an iOS custom configuration profile and upload `data/manageengine/vigil-manageengine-policy.mobileconfig`.
5. Assign that profile to the enrolled iPhone.
6. Confirm the policy is installed on the phone under Settings > General > VPN & Device Management.

## Operational Notes

- Treat Vigil's self-hosted MDM doctor as advanced diagnostic tooling only. It can still report APNs certificate blockers while the ManageEngine path is healthy, because ManageEngine, not Vigil, is the MDM server in normal use.
- The static Vigil USB profile can remain in place during setup. If ManageEngine reports a duplicate profile identifier conflict, apply the enrollment-window profile over USB, enroll, then push the final ManageEngine policy again.
- Re-export and re-upload the policy after changing Vigil's iPhone app/web targets.
- API automation should wait until the manual upload/assignment path works once. After that, wire the ManageEngine API using the tenant URL, OAuth token, device/group IDs, and the exact profile endpoint shape from your tenant.
