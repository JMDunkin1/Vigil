# Vigil phone maintenance

## Personal and Enhanced editions

Vigil has two explicit phone editions:

- **Personal** is the default and requires no paid Apple membership. It installs
  the supervised, removal-disallowed restrictions profile; Apple's BuiltIn
  automatic adult-content filter; the 500 highest-priority explicit deny URLs;
  and the fixed Instagram and YouTube companions with the exact bundled adult
  blocklist and generated explicit-content policy. It deliberately uses the
  conservative Personal Team entitlement set.
- **Enhanced** contains every Personal protection and also requires the signed
  Vigil system URL Filter, its matching Bloom prefilter/PIR database, public
  HTTPS service, Privacy Pass issuer, deployment manifest, and Apple's
  `url-filter-provider` entitlement. It refuses a partial or unreachable
  deployment.

The selected edition is persisted in private runtime data. A missing selection
defaults to Personal. Enhanced never silently downgrades when its service is
missing, and replacing an installed Enhanced receipt with Personal requires the
explicit `--allow-edition-downgrade` flag.

The phone has two independent kinds of freshness:

- The implementation release in `ios/phone-release.json` covers the four built-in policy generators and bundled enforcement inputs. The same manifest also gives Instagram and YouTube independent app versions, builds, and source fingerprints.
- The live policy fingerprint covers the configuration generated from Vigil's current state. It can change without an implementation release when a session, limit, blocklist setting, or Normal/Soft Lock/Full Brick/Panic policy changes.

Use these commands from the repository root:

```sh
npm run ios:phone:status
npm run ios:phone:check
npm run ios:phone:audit
npm run ios:phone:update
npm run ios:phone:update:personal
npm run ios:phone:update:enhanced
```

`status` is read-only and explains drift. `check` reports the same state but exits nonzero when the phone or release is stale. If CoreDevice cannot inspect configuration profiles on the connected phone, both commands report profile verification as unavailable instead of treating the live policy as missing or crashing. `audit` builds the TypeScript runtime and validates generated Normal, Soft Lock, Full Brick, and Panic profiles for the selected edition. `update` bumps each companion's patch/build only when that app's inputs changed, then builds and installs only companions whose installed version is stale. Shared app inputs correctly advance both versions; Instagram's embedded Safari YouTube extension is tracked as an Instagram input. The command also replaces the live policy profile when required. Enhanced additionally builds, installs, and live-verifies Vigil URL Filter. It does not build or install a Vigil browser, create Home Screen Web Clips, or reboot the phone.

Both editions require a valid `adult-blocklist.sdi` before they can bump or mutate the phone. The live installed Vigil data copy takes priority over a stale repository copy. For the default Block List Project source, “valid” means at least 600,000 domains with intact format and payload hashes; a tiny test fixture cannot pass. Each built app must contain the exact artifact at its bundle root. The suite re-reads that bundled copy, compares its domain count, snapshot hash, and whole-artifact hash, and records the proof per app in the deployment receipt. The same gate checks that `ExplicitContentPolicy.json` is freshly generated and byte-identical inside the companion. `status` compares the adult artifact to the enabled live snapshot, reports the real domain count, source, and hashes, and reports whether both generated artifacts were proven by the last deployment.

Adult-list refreshes retain cumulative and currently non-resolving domains, reject syntactically invalid rows, report unrecognized TLDs without deleting them, and remove only child rows already covered by a listed parent. The generated v2 artifact includes a protected precomputed sparse index; the iOS reader remains compatible with v1 artifacts while installed companions are rolled forward.

Documentation, tests, and the retired `ios/VigilBrowser` project are excluded from the implementation fingerprint. On an unsupervised personal iPhone, Apple transfers profiles but still requires their installation to be confirmed in Settings; rerun `status` or `check` after confirming them.

Xcode requires configuration profiles to have a CMS signature for command-line validation and installation. The suite uses the first local code-signing identity, or `VIGIL_IOS_PROFILE_SIGNING_IDENTITY` when set.

When more than one Xcode is installed, the suite automatically selects an iOS SDK new enough for the connected phone instead of relying on the global `xcode-select` setting.

Personal always uses the conservative entitlement set and records `personal-team-conservative` in the deployment receipt. That keeps profile-based domain and URL rules and page-text inspection active, but reveals media that the unavailable Sensitive Content Analysis framework cannot classify. Enhanced first attempts the fuller companion capability set and inspects the actual signed entitlements instead of trusting requested build settings; a mixed result is recorded explicitly. Enhanced separately requires the system URL Filter entitlement and rejects an inert build.

The update command writes a local, ignored deployment receipt under `data/ios-phone-deployments/`. Each companion's authoritative version remains observable independently on the phone; the separate implementation version remains in the stamped configuration-profile name.

Useful options:

```sh
npm run ios:phone:status -- --device <CoreDevice UUID or iPhone UDID>
npm run ios:phone:status -- --edition personal
npm run ios:phone:status -- --edition enhanced
npm run ios:phone:update -- --no-policy
npm run ios:phone:update -- --server http://127.0.0.1:8787
npm run ios:phone:update -- --replace-legacy
npm run ios:phone:bump -- minor
```

`--no-policy` is limited to reinstalling an already deployed implementation
fingerprint. If phone-facing sources changed, especially the YouTube companion's
exact authentication routes, the suite refuses the app-only update and requires
the normal companion-plus-policy transaction first.

Personal Team provisioning profiles expire after seven days. Re-run the
Personal update while the paired phone is connected before the companions
expire. The supervised configuration profile is independent of that companion
app signing window and remains installed.

The supported companions are two fixed apps:

- `tech.caseline.vigil.instagram` displays as Instagram, cannot switch to another service, and carries the Safari YouTube blocker and controls extensions as a fallback surface.
- `tech.caseline.vigil.youtube` displays as YouTube, cannot switch to another service, and uses one persistent YouTube-only `WKWebView` with the shared Shorts guard and ordinary-watch miniplayer behavior. Its documented Safari application-name suffix is an unsupported compatibility exception; it is not a guarantee that Google will continue to permit embedded sign-in.

Snapchat remains subject to the managed phone policy but is not built as a Vigil companion. Browser restrictions are likewise delivered by the managed phone policy rather than through a dedicated Vigil browser app.

Obsolete `tech.caseline.sentinel.*`, `tech.caseline.vigil.browser`, `tech.caseline.vigil.social`, and `tech.caseline.vigil.snapchat` installations are reported but never silently removed. The retired `tech.caseline.vigil.ios-social-launchers` launcher profile and the former `tech.caseline.vigil.youtube-webclip-experiment` YouTube Web Clip profile are also reported because they would duplicate the installed surfaces. Instagram and YouTube are updated in place. Use `--replace-legacy` only when you intentionally want to uninstall obsolete bundles and remove those retired profiles; app-local data from uninstalled bundles cannot be recovered.

ManageEngine exports now contain the live policy and its JSON summary only. The summary lists the fixed companion labels and bundle identifiers as installed apps; no social-launcher profile or managed Web Clip payload is generated or assigned. A successful export removes stale local `vigil-social-launchers.mobileconfig` and `vigil-social-launchers.summary.json` compatibility artifacts so they cannot be uploaded accidentally.
