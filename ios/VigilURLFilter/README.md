# Vigil iOS URL Filter

This is Vigil Enhanced edition's paid system URL-filter path for iOS 26 and
later. It uses Apple's `NEURLFilter` architecture and does not change
supervision, restore a backup, or modify the phone's Home Screen. Personal
edition deliberately omits this plug-in and uses the supervised BuiltIn web
filter, priority deny rules, restrictions, and fixed companions instead.

## Complete local path

- `npm run ios:url-filter:prepare` decodes the integrity-checked
  `adult-blocklist.sdi` and generates Apple's Bloom prefilter and PIR textpb
  database from the same ordered domain set.
- The generator matches Apple's published Swift Bloom implementation and test
  vector byte-for-byte. The artifact records the exact-index snapshot and
  payload hashes, PIR database hash and revision, Bloom parameters, and tag.
- The ExtensionKit control provider rejects a missing, corrupt, or mismatched
  exact index or prefilter. It stages the Bloom bitset as a protected temporary
  file instead of loading another copy into the provider's heap.
- The managed profile uses `FilterType=Plugin`, `FilterURLs=true`, a 45-minute
  minimum fetch interval, and `URLFilterFailClosed=true`. The bounded BuiltIn
  payload remains a simultaneous layer for Vigil's changing timed rules; it is
  not a fallback for the full adult-domain dataset.
- The Enhanced phone release builds, signs, installs, receipts, and version-
  checks `tech.caseline.vigil.url-filter`. It verifies the provider entitlement,
  bundled artifacts, profile parameters, and paired PIR revision. `--no-policy`
  is rejected because installing the app without its exact managed
  configuration would create a partial deployment.
- Server, MDM, and ManageEngine delivery follow the persisted edition. Personal
  emits the BuiltIn profile without this service. Enhanced requires
  `data/ios-url-filter/service.json` and fails closed if it is absent or invalid.

## Generate and deploy the paired database

First generate the prefilter and PIR inputs:

```sh
npm run ios:url-filter:prepare -- \
  --pir-server-url https://your-pir-service.example/ \
  --privacy-pass-issuer-url https://your-issuer.example/ \
  --deployment-manifest-url https://your-pir-service.example/vigil-url-filter-deployment.json
```

This writes private files below `data/ios-url-filter/`:

- `url-filter-prefilter.vuf` for the control provider;
- `pir/input.txtpb`, `pir/url-config.json`, and `pir/service-config.json` for
  Apple's `PIRProcessDatabase` and `PIRService` tools;
- `service.json` for Vigil's app/profile/release path; and
- `manifest.json`, which binds all hashes and revisions.

Process `pir/input.txtpb` with Apple's `PIRProcessDatabase`, deploy every
generated shard and parameter file, then run `npm run ios:url-filter:finalize`
to hash and bind the processed outputs. Deploy those files and the generated
`pir/deployment-manifest.json` behind the configured public HTTPS/OHTTP service,
and keep the generated authentication token
synchronized. Then run `npm run ios:phone:audit -- --edition enhanced`; only a
clean audit may proceed to `npm run ios:phone:update:enhanced`.

## External production gate

Apple's production URL Filter/OHTTP capability, service registration, public
HTTPS deployment, and Privacy Pass issuer are account/infrastructure
prerequisites. Development signing does not prove production eligibility.
Enhanced intentionally refuses release/update when those real values are absent
or when any local hash/revision differs. There is no placeholder endpoint or
implicit downgrade path. Personal remains independently releasable without
these paid prerequisites.
