# Vigil phone maintenance

The phone has two independent kinds of freshness:

- The implementation release in `ios/phone-release.json` covers the two fixed iOS companions, the four built-in policy generators, companion behavior, and the bundled adult blocklist. Instagram and YouTube carry the same marketing version and build number on the phone.
- The live policy fingerprint covers the configuration generated from Vigil's current state. It can change without an implementation release when a session, limit, blocklist setting, or Normal/Soft Lock/Full Brick/Panic policy changes.

Use these commands from the repository root:

```sh
npm run ios:phone:status
npm run ios:phone:check
npm run ios:phone:audit
npm run ios:phone:update
```

`status` is read-only and explains drift. `check` reports the same state but exits nonzero when the phone or release is stale. If CoreDevice cannot inspect configuration profiles on the connected phone, both commands report profile verification as unavailable instead of treating the live policy as missing or crashing. `audit` builds the TypeScript runtime and validates generated Normal, Soft Lock, Full Brick, and Panic profiles. `update` bumps the patch/build only when implementation inputs changed, builds fixed Instagram and YouTube companions with that shared release, installs them in place, and replaces only the live policy profile. It does not build or install a Vigil browser, create Home Screen Web Clips, or reboot the phone.

Documentation, tests, and the retired `ios/VigilBrowser` project are excluded from the implementation fingerprint. On an unsupervised personal iPhone, Apple transfers profiles but still requires their installation to be confirmed in Settings; rerun `status` or `check` after confirming them.

Xcode requires configuration profiles to have a CMS signature for command-line validation and installation. The suite uses the first local code-signing identity, or `VIGIL_IOS_PROFILE_SIGNING_IDENTITY` when set.

When more than one Xcode is installed, the suite automatically selects an iOS SDK new enough for the connected phone instead of relying on the global `xcode-select` setting.

The suite first attempts a full-capability build, which keeps unclassified media concealed. If a Personal Team cannot provision Apple's Sensitive Content Analysis entitlement, it retries with a reduced entitlement set and records `personal-team-conservative` in the deployment receipt. That explicit fallback keeps profile-based domain and URL rules and page-text inspection active, but reveals media that the unavailable analyzer cannot classify. A paid Apple development team is required for the fail-closed on-device media-analysis build.

The update command writes a local, ignored deployment receipt under `data/ios-phone-deployments/`. The authoritative version remains observable on the phone through each app and in the stamped configuration-profile name.

Useful options:

```sh
npm run ios:phone:status -- --device <CoreDevice UUID or iPhone UDID>
npm run ios:phone:update -- --no-policy
npm run ios:phone:update -- --server http://127.0.0.1:8787
npm run ios:phone:update -- --replace-legacy
npm run ios:phone:bump -- minor
```

The supported companions are two independent fixed apps:

- `tech.caseline.vigil.instagram` displays as Instagram and cannot switch to another service.
- `tech.caseline.vigil.youtube` displays as YouTube and cannot switch to another service.

Snapchat remains subject to the managed phone policy but is not built as a Vigil companion. Browser restrictions are likewise delivered by the managed phone policy rather than through a dedicated Vigil browser app.

Obsolete `tech.caseline.sentinel.*`, `tech.caseline.vigil.browser`, `tech.caseline.vigil.social`, and `tech.caseline.vigil.snapchat` installations are reported but never silently removed. The retired `tech.caseline.vigil.ios-social-launchers` configuration profile is also reported because its Web Clips would duplicate the two installed companion icons. The current Instagram and YouTube bundle identifiers are not obsolete and are updated in place. Use `--replace-legacy` only when you intentionally want to uninstall the obsolete bundles and remove the retired launcher profile; app-local data from uninstalled bundles cannot be recovered.

ManageEngine exports now contain the live policy and its JSON summary only. The summary lists the two fixed companion labels and bundle identifiers as installed apps; no social-launcher profile or managed Web Clip payload is generated or assigned. A successful export removes stale local `vigil-social-launchers.mobileconfig` and `vigil-social-launchers.summary.json` compatibility artifacts so they cannot be uploaded accidentally.
