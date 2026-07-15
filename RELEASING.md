# Releasing Vigil

Local development packages intentionally retain the ad-hoc/Apple Development signing path. Those builds may use the source-checkout updater and must never be presented as production releases.

Production releases use a separate fail-closed path:

1. Create and push an annotated version tag matching `package.json` (for example, `v0.1.0`).
2. The release workflow imports a Developer ID Application certificate, enables hardened runtime, signs every nested component, submits the app for Apple notarization, staples the ticket to the DMG, and verifies both Gatekeeper and the signature.
3. The workflow publishes only the stapled DMG and `release-checksums.json`. This checksum sidecar records the artifact byte length and SHA-256 digest; it is not an automatic update feed.
4. Distribution-signed installs are updated by installing a complete published DMG. The source-checkout updater rejects them by design; it is not a production update mechanism.

The repository never contains release credentials. Configure these GitHub Actions secrets:

- `CSC_LINK`: base64 PKCS#12 Developer ID certificate (or an electron-builder-supported secure link)
- `CSC_KEY_PASSWORD`: certificate password
- `APPLE_API_KEY`: App Store Connect API private key contents; the workflow writes these to a temporary mode-600 p8 file and always removes it
- `APPLE_API_KEY_ID`: App Store Connect key ID
- `APPLE_API_ISSUER`: App Store Connect issuer ID
- `APPLE_TEAM_ID`: the exact Apple Developer team identifier expected on the app and every nested executable

For a local `npm run release:mac`, `APPLE_API_KEY` must be the path to a mode-600 p8 file and `APPLE_TEAM_ID` is mandatory. The command staples the DMG, mounts it read-only, requires exactly one root app, verifies the root and relevant nested executables against the expected Developer ID authority/team and minimal entitlements, validates Gatekeeper and notarization, always unmounts in cleanup, and only then computes the checksum. A release operator should independently compare the downloaded DMG to the published checksum sidecar before installation.
# ManageEngine export snapshots

ManageEngine exports publish an immutable generation plus `manifest.json`, then atomically switch the `data/manageengine/current` locator. A consumer that needs a profile and its summary together must call `pinManageEngineCurrentGeneration`, use only the returned generation paths and hashes, and release the pin after all reads finish. The fixed `.mobileconfig` and `.summary.json` symlinks are compatibility paths for single-artifact tools only; separate reads through those fixed paths are not a snapshot-consistent multi-file API.
