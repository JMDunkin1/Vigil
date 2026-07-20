# Vigil phone maintenance

The phone has two independent kinds of freshness:

- The implementation release in `ios/phone-release.json` covers native iOS code, the three built-in policy generators, social companion behavior, and the bundled adult blocklist. Every Vigil iOS app carries the same marketing version and build number on the phone.
- The live policy fingerprint covers the configuration generated from Vigil's current state. It can change without an implementation release when a session, limit, blocklist setting, or Normal/Soft Lock/Full Brick policy changes.

Use these commands from the repository root:

```sh
npm run ios:phone:status
npm run ios:phone:check
npm run ios:phone:audit
npm run ios:phone:update
```

`status` is read-only and explains drift. `check` reports the same state but exits nonzero when the phone or release is stale. `audit` builds the TypeScript runtime and validates generated Normal, Soft Lock, and Full Brick profiles. `update` bumps the patch/build only when implementation inputs changed, builds the Browser and combined Social app with that shared release, installs them in place, and replaces the live policy and stable launcher profiles. It does not reboot the phone.

Documentation and test-only edits are excluded from the implementation fingerprint. On an unsupervised personal iPhone, Apple transfers profiles but still requires their installation to be confirmed in Settings; rerun `status` or `check` after confirming them.

Xcode requires configuration profiles to have a CMS signature for command-line validation and installation. The suite uses the first local code-signing identity, or `VIGIL_IOS_PROFILE_SIGNING_IDENTITY` when set.

When more than one Xcode is installed, the suite automatically selects an iOS SDK new enough for the connected phone instead of relying on the global `xcode-select` setting.

The suite first attempts a full-capability build. If a Personal Team cannot provision Apple's Sensitive Content Analysis or App Group entitlements, it retries with a conservative entitlement set and records `personal-team-conservative` in the deployment receipt. The bundled domain blocklist, URL/search rules, text checks, and fail-closed media behavior remain active; a paid Apple development team is required for the on-device Sensitive Content Analysis capability.

The update command writes a local, ignored deployment receipt under `data/ios-phone-deployments/`. The authoritative version remains observable on the phone through each app and in the stamped configuration-profile name.

Useful options:

```sh
npm run ios:phone:status -- --device <CoreDevice UUID or iPhone UDID>
npm run ios:phone:update -- --no-policy
npm run ios:phone:update -- --server http://127.0.0.1:8787
npm run ios:phone:bump -- minor
```

The combined Social app serves Instagram, YouTube, and Snapchat from one signed app, keeping the Personal Team deployment below Apple's three-app limit. Legacy `tech.caseline.sentinel.*` apps and the older `tech.caseline.vigil.instagram`, `tech.caseline.vigil.youtube`, and `tech.caseline.vigil.snapchat` companions are reported but never silently removed; use `--replace-legacy` once to replace them, with the understanding that their app-local data cannot be recovered after uninstall.
