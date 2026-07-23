# Install Vigil from a signed DMG

This guide is for an official Vigil macOS release delivered as a Developer ID-signed, Apple-notarized DMG. It is not for a source checkout, an ad-hoc build, or an Apple Development-signed build.

## Before you start

Use only a release that provides both of these files together:

- one `.dmg` installer image; and
- `release-checksums.json`, naming that exact DMG and its SHA-256 digest.

The release notes must state the supported macOS versions and processor architecture. The current release tooling is configured to produce a universal DMG and verify both Intel (`x86_64`) and Apple silicon (`arm64`) slices; rely on that claim only for a published artifact whose release checks passed.

Basic installation does not need a Vigil account. Full system-network protection asks for a macOS administrator credential. Accessibility, background operation, Safari-profile approval, and the browser companion are separate, visible setup steps.

Opening the current packaged app enables its resident login/restart protection as part of first launch, before the setup assistant has finished. Continue only if you intend to enable Vigil's always-on protection on this Mac. A consent-first ordering remains a general-release and Mac App Store requirement.

## 1. Verify the download

1. Download the DMG and `release-checksums.json` from the same publisher release.
2. Open `release-checksums.json` and confirm its `artifact` value is the filename you downloaded.
3. In Terminal, type `shasum -a 256 `, including the trailing space, drag the DMG from Finder into the Terminal window, and press Return.
4. Compare the entire digest with the `sha256` value in `release-checksums.json`.
5. Type `stat -f %z `, drag the DMG into Terminal again, and press Return. Compare the number with the manifest's `bytes` value.

Do not open the DMG if the filename, byte count, or digest differs. Delete the download and obtain it again from the publisher. A matching sidecar proves only that the two downloaded files are consistent; publisher authenticity also depends on obtaining them through the trusted release channel and on the Developer ID signature and notarization checks.

## 2. Install the app

1. Double-click the verified DMG.
2. Drag **Vigil** into **Applications**.
3. Eject the Vigil disk image.
4. Open **Vigil** from the Applications folder.
5. Accept macOS's normal confirmation that the app was downloaded from the internet only when macOS identifies the expected signed app.

Stop if macOS says the developer cannot be verified, the app is damaged, or Apple cannot check it for malicious software. Do not bypass Gatekeeper with `xattr`, a quarantine-removal command, or an override for an unverified build. Report the exact message through the support channel published with the release.

## 3. Complete the setup assistant

Vigil opens a step-by-step assistant on first launch. Each step is marked ready only after Vigil checks the resulting system state. It is safe to choose **Finish later**; the assistant and live checklist can be reopened from Vigil.

### Background protection

Vigil is designed to remain active when its window is hidden. Follow the assistant's **Enable at login** or **Repair protection** action if this step is not already ready. macOS may show Vigil under **System Settings > General > Login Items & Extensions**.

Do not Force Quit Vigil or disable its background item to troubleshoot setup. Automatic restart is part of the protection the user chose, not a stuck-process condition.

### Foreground app access

1. Choose **Open Accessibility** in the assistant.
2. In **System Settings > Privacy & Security > Accessibility**, allow Vigil.
3. Return to Vigil and wait for the assistant to report that foreground-app detection is healthy.

This permission lets Vigil recognize the frontmost app and enforce the schedules and limits the user configures. Vigil's local activity handling is described in [PRIVACY.md](PRIVACY.md).

### System network protection

When this protection is selected, choose **Apply Network Block**. macOS displays its administrator authorization dialog because Vigil updates protected hosts and PF firewall configuration. Read the prompt, authorize it, and return to Vigil. The step is complete only when both checks report current.

Do not enter an administrator password into a web page or a custom Vigil form. The expected credential prompt belongs to macOS.

### Safari protection

This step appears as required only when the current rules need Safari coverage.

1. Choose **Apply Safari Filter**.
2. macOS opens a locally generated configuration profile.
3. Review the profile in System Settings and approve it there.
4. Return to Vigil and wait for Apple's web-safety check to become ready.

The profile is generated from the local Vigil rules. Approval never occurs silently inside the app. The current assistant's Safari **Ready** state confirms Apple's general web-safety state, but does not yet prove that the installed Vigil profile has the current rule signature. Before relying on path-level Safari rules, also check the detailed hardening status and confirm that the Vigil profile is installed, current, and not stale.

### Chromium browser companion

An official consumer release must use the reviewed Chrome Web Store item:

1. Choose **Install Companion** in Vigil.
2. Confirm the browser opens Vigil's fixed, verified Chrome Web Store listing.
3. Choose the store's normal **Add to Chrome** action and approve its disclosed permissions.
4. Open the companion's options and pair it with the local Vigil service if prompted.
5. Return to Vigil and confirm that the companion check-in and dynamic rules are ready.

If **Install Companion** reveals a folder instead, the Mac app is a development or pre-release build whose browser-store publication gate is not complete. Developer Mode and **Load unpacked** are for development only and are not an acceptable consumer installation path.

The companion requests access to HTTP and HTTPS pages so it can apply local path filters and remove configured distracting elements. It communicates with Vigil on this Mac. The repository can build the store upload, but the external listing must be created, ID-matched, reviewed, and published before the consumer Mac release gate opens; see [APP_STORE_READINESS.md](APP_STORE_READINESS.md).

### Optional and advanced steps

Chrome SafeSearch device-management profiles, DNS/router sync, a standard daily macOS account, and supervised iPhone coverage are not required for a basic Mac installation. Use them only when the setup assistant identifies them as relevant to the intended protection model.

## 4. Confirm setup

Finish only after every selected **Core protection** step reports **Ready**. The full checklist remains the authoritative status view; completing a macOS dialog is not, by itself, proof that the protection took effect. For Safari, also confirm the detailed profile/signature state described above until the assistant incorporates that check.

Closing Vigil's window hides it. Reopen it from the menu-bar item. Hiding the window does not stop enforcement.

## Updates and removal

Use only Vigil's authenticated maintenance/update controls or a release-specific procedure expressly provided by the publisher. Do not force quit the app, unload its supervisor, delete its LaunchAgent, or replace its bundle while protection is active.

The current production release design accepts complete published DMGs but does not yet provide a finished, public, authenticated DMG-upgrade and uninstall experience. If a production-signed installation reports that in-app updating is unsupported, the release is not upgrade-ready; contact the publisher rather than manually disabling protection. This is an explicit release blocker, not an invitation to work around Vigil's safeguards.

## Troubleshooting

- **The assistant reappears:** at least one selected core check is still pending or has drifted. Read the live detail and use its matching action.
- **A button was clicked but the step is not ready:** return from System Settings, allow a few seconds for verification, then reopen the assistant. The verified result controls the status.
- **Vigil is not in the Dock:** reopen the installed app from Applications or Spotlight. Current builds keep both the Dock icon and menu-bar companion available.
- **Checksum or Gatekeeper verification fails:** stop. Do not weaken macOS security to continue.
- **Background protection appears unhealthy:** use **Repair protection** inside Vigil. Preserve the running watchdog while it repairs the app.
- **Support is needed:** use the verified support contact supplied on the official release page. A stable public support URL still must be published before general release.
