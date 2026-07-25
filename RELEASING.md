# Releasing Vigil

Local development packages intentionally retain the ad-hoc/Apple Development signing path. Those builds may use the source-checkout updater and must never be presented as production releases.

Production releases use a separate fail-closed path:

1. Build `npm run package:extension`, upload it as a draft Chrome Web Store item, copy the dashboard public key into `extension/manifest.json`, and align the resulting item ID with `build/browser-store.json` and Vigil's built-in allowlist. After that exact version passes review and is publicly installable, set the checked-in `published` gate to `true`, set `publishedVersion` to the matching `extension/manifest.json` version, and confirm `npm run package:extension:release` succeeds. Reset the gate whenever the manifest version changes until that version is public.
2. Create and push an annotated version tag matching `package.json` (for example, `v0.1.0`).
3. The release workflow passes its monotonically increasing GitHub run number as `VIGIL_MAC_BUILD_VERSION`. The packaging scripts validate this as an Apple-compatible numeric/dotted build version and write it to `CFBundleVersion`. A local package defaults to build `1`, but the production release command fails closed unless this variable is explicitly set.
4. The release workflow imports a Developer ID Application certificate, enables hardened runtime, signs every nested component, submits the app for Apple notarization, staples the ticket to the DMG, and verifies both Gatekeeper and the signature. It also refuses to create the consumer Mac release while the browser-store gate remains incomplete or its item ID diverges from Vigil's trusted companion origin.
5. The workflow publishes only the stapled DMG and `release-checksums.json`. This release manifest binds the exact clean Git commit, marketing version, macOS build version, app/team identifiers, artifact filename, byte length, and SHA-256 digest.
6. To enable prebuilt updates, publish those two unchanged files in the same credential-free HTTPS directory, with no redirects, and provide that manifest's URL to the supported Vigil launch environment as `VIGIL_PREBUILT_UPDATE_MANIFEST_URL`. Vigil accepts it only when its commit is the exact selected upstream commit. It privately streams bounded bytes, verifies the DMG hash, Gatekeeper, notarization, Developer ID continuity, packaged metadata, CodeDirectory identity, and embedded runtime before the existing authenticated transaction can activate anything.
7. Without an explicitly configured prebuilt manifest URL, local development builds retain the source-checkout rebuild path. Distribution-signed installs reject that fallback by design; they require a verified complete prebuilt release.

The repository never contains release credentials. Configure these GitHub Actions secrets:

- `CSC_LINK`: base64 PKCS#12 Developer ID certificate (or an electron-builder-supported secure link)
- `CSC_KEY_PASSWORD`: certificate password
- `APPLE_API_KEY`: App Store Connect API private key contents; the workflow writes these to a temporary mode-600 p8 file and always removes it
- `APPLE_API_KEY_ID`: App Store Connect key ID
- `APPLE_API_ISSUER`: App Store Connect issuer ID
- `APPLE_TEAM_ID`: the exact Apple Developer team identifier expected on the app and every nested executable

For a local `npm run release:mac`, set `VIGIL_MAC_BUILD_VERSION` to a value greater than the last published build, such as `42` or `2026.7.21`. It accepts one to three decimal components: major `1`-`9999` and optional minor/patch `0`-`99`. `APPLE_API_KEY` must be the path to a mode-600 p8 file and `APPLE_TEAM_ID` is mandatory. The command refuses a dirty checkout, staples the DMG, hashes it through a pinned file descriptor, validates Gatekeeper and notarization before mounting, requires exactly one root app, and verifies the app identifier, version, build, clean commit metadata, Developer ID team, and relevant nested executables. Cleanup failures remain fatal, and the final manifest is written only after the DMG still matches the trusted digest.
# ManageEngine export snapshots

ManageEngine exports publish an immutable generation plus `manifest.json`, then atomically switch the `data/manageengine/current` locator. A consumer that needs a profile and its summary together must call `pinManageEngineCurrentGeneration`, use only the returned generation paths and hashes, and release the pin after all reads finish. The fixed `.mobileconfig` and `.summary.json` symlinks are compatibility paths for single-artifact tools only; separate reads through those fixed paths are not a snapshot-consistent multi-file API.
