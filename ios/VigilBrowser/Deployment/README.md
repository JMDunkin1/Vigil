# Managed Safari deployment

`managed-extension.json` records the identifiers and access this extension needs. It deliberately is not a `.mobileconfig`: Apple changes managed Safari extension payload capabilities by OS release, and emitting an unverified payload would create a false security guarantee.

Before deployment:

1. Generate `data/adult-blocklist.sdi`. The Xcode targets copy it into both bundles. Debug builds retain the documented development fallback, but Release builds fail when the artifact is absent.
2. Build and sign the containing app and extension with the same development team, App Group capability, and Apple Sensitive Content Analysis entitlement.
3. Install the containing app through MDM.
4. Use the documented Safari extension management payload supported by the enrolled iOS version to force `tech.caseline.vigil.browser.safari-filter` on and grant both host patterns.
5. Verify the extension is enabled in normal and Private Browsing, then exercise a blocked HTTPS host, an HTTP URL, and Apple-sensitive-content test media.
6. Fail the enrollment health check if the extension state, host access, compact blocklist, or sensitive-content analysis policy cannot be confirmed.

The browser works independently of Safari. Safari filtering cannot be fail-closed until MDM has installed the app, forced the extension on, and granted site access.

## Protection contract

When Vigil's iPhone protection is enabled, the managed baseline is intended to stay active even when no timed focus session is running:

- Apple's automatic adult-site filter and Vigil's compact domain index block known explicit sites.
- Explicit search terms are rejected before navigation, and Google, Bing, and DuckDuckGo receive strict SafeSearch parameters.
- Images and video frames stay concealed until on-device Sensitive Content Analysis returns a safe verdict; unknown and failed verdicts remain concealed.
- Known unfiltered browser and native social bundle IDs are hidden with a targeted denylist. Vigil does not use an all-app allowlist for this baseline, and it leaves the App Store and unrelated apps available.
- The profile is removal-disallowed and carries a generated removal password. The supervised/MDM enrollment must also disallow user unenrollment for the phone to be unable to remove protection locally.

Do not report this contract as deployed until MDM confirms the containing app, the extension in normal and Private Browsing, host access, the current policy-profile hash, and non-removable enrollment on the target phone.
