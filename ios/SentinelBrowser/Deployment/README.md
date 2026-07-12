# Managed Safari deployment

`managed-extension.json` records the identifiers and access this extension needs. It deliberately is not a `.mobileconfig`: Apple changes managed Safari extension payload capabilities by OS release, and emitting an unverified payload would create a false security guarantee.

Before deployment:

1. Generate `data/adult-blocklist.sdi`. The Xcode targets copy it into both bundles. Debug builds retain the documented development fallback, but Release builds fail when the artifact is absent.
2. Build and sign the containing app and extension with the same development team, App Group capability, and Apple Sensitive Content Analysis entitlement.
3. Install the containing app through MDM.
4. Use the documented Safari extension management payload supported by the enrolled iOS version to force `tech.caseline.sentinel.browser.safari-filter` on and grant both host patterns.
5. Verify the extension is enabled in normal and Private Browsing, then exercise a blocked HTTPS host, an HTTP URL, and Apple-sensitive-content test media.
6. Fail the enrollment health check if the extension state, host access, compact blocklist, or sensitive-content analysis policy cannot be confirmed.

The browser works independently of Safari. Safari filtering cannot be fail-closed until MDM has installed the app, forced the extension on, and granted site access.
