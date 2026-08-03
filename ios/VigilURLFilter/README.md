# Vigil iOS 26 URL Filter foundation

This isolated target is Vigil's system-wide path beyond the 500-entry managed
web-filter list. It uses Apple's iOS 26 `NEURLFilter` architecture and does not
change, restore, supervise, or update the connected phone.

## What is implemented

- An ExtensionKit URL Filter control provider using the current Xcode 26 SDK
  `fetchPrefilter(existingPrefilterTag:)` contract.
- Apple's `url-filter-provider` Network Extension entitlement and
  `com.apple.networkextension.url-filter-control` extension point.
- A fail-closed `NEURLFilterManager` configuration helper.
- A voluntary verdict helper for non-Apple networking clients that treats both
  deny and unknown as blocked.
- An integrity-checked artifact boundary: `url-filter-prefilter.vuf` carries a
  SHA-256-checked Bloom bitset and is rejected unless its snapshot hash, exact
  index payload hash, and domain count match `adult-blocklist.sdi`.
- Debug builds may omit both artifacts but the provider then fails to start.
  Release builds fail at build time if either artifact is absent.

The TypeScript packager in `src/iosUrlFilterPrefilter.ts` packages and validates
a prefilter produced by the PIR service. It intentionally does **not** generate
Bloom keys from domain names.

## What remains external

This is not production-ready until all of these exist:

1. Apple grants the URL Filter/OHTTP capability for the production distribution
   team and identifiers. Development-signed testing has different eligibility;
   it does not prove App Store or managed-distribution approval.
2. A production PIR service implements Apple's expected database and OHTTP
   contracts. Its canonical URL keys must be the same keys used to construct the
   Bloom prefilter. A local domain Bloom filter cannot safely substitute for it.
3. The service supplies a matching prefilter, database revision, server URL,
   optional Privacy Pass issuer URL, and short-lived authentication token.
4. Device validation proves fail-closed behavior and exact live fingerprints
   before this replaces any existing managed web-filter protection.

Apple networking stacks (WebKit, CFNetwork, Network.framework) receive system
verdicts. Apps using other networking stacks must voluntarily call
`NEURLFilter.verdict(for:)` and honor deny/unknown results; Vigil cannot claim
coverage for apps that bypass both paths.

## Development validation

With matching development artifacts available:

```sh
VIGIL_PHONE_BLOCKLIST=/absolute/path/adult-blocklist.sdi \
VIGIL_URL_FILTER_PREFILTER=/absolute/path/url-filter-prefilter.vuf \
xcodebuild -project ios/VigilURLFilter/VigilURLFilter.xcodeproj \
  -target VigilURLFilterHost -sdk iphonesimulator \
  CODE_SIGNING_ALLOWED=NO build
```

Do not install or enable the target until the PIR endpoint and artifact linkage
are real. The host app contains no disable/remove operation because Vigil's
continued enforcement is a safety boundary.
