# Vigil computer/phone enforcement audit and roadmap

Audit date: 2026-08-01

## Bottom line

The Mac and iPhone do not currently enforce the same policy through the same
mechanism. The Mac can consult Vigil's complete adult-domain snapshot during a
browser navigation. The installed iPhone profile uses Apple's built-in web
content filter, whose explicit deny list is intentionally kept below 500
entries. Vigil's fixed Instagram companion adds full-document text and media
inspection. The maintained YouTube companion uses a persistent, YouTube-only
`WKWebView`, the same Shorts guard, and focused ordinary-watch controls;
Instagram still carries the Safari extensions as a fallback web surface.

The selected adult source now contains 952,054 active domains and has a compact
phone artifact. Shipping that artifact is necessary, but it does not by itself
make Apple's built-in `DeniedURLs` array system-wide. System-wide 600k+ coverage
requires either:

1. a replacement browser with all other browser escape routes disabled (the
   architecture SHIFT publicly describes), or
2. the iOS 26 Network Extension URL Filter, using Apple's Bloom prefilter plus
   PIR/OHTTP confirmation.

Vigil should use the second path. It preserves normal browsers and provides
system-wide WebKit/URLSession coverage without trying to place 952,054 strings
in a configuration profile.

## Current enforcement matrix

| Layer | Mac | iPhone today | Target iPhone |
| --- | --- | --- | --- |
| Explicit site/URL rules | Hosts, firewall, Safari/extension rules, and live Vigil checks | Supervised `com.apple.webcontent-filter`; 317-425 denied URL entries by tier | Keep as the always-on bootstrap/fallback |
| 952,054-domain adult list | Full snapshot is available to Vigil's live URL matcher; OS/browser preload lists remain bounded | Compact `.sdi` can be bundled and used by Vigil-owned apps, but the profile cannot express the whole list | iOS 26 URL Filter with Bloom + PIR/OHTTP |
| Text inspection | Browser/extension policy paths | VigilSocial scans the full bounded document, DOM mutations, open shadow roots, and periodic visible-page audits | Generated shared phrase/context policy in every companion release |
| Image/video inspection | Browser-specific enforcement | Sensitive Content Analysis when the entitlement is provisioned; the current Personal Team fallback reveals unclassified media while retaining text/profile rules | Paid team/capability build that keeps unclassified media concealed |
| YouTube | Browser extension modifies the normal site | A fixed `tech.caseline.vigil.youtube` companion supplies one persistent YouTube-only WK surface with the shared Shorts guard and focused ordinary-watch controls. The previous full-screen Web Clip is retired | Verify Google sign-in persistence, exact auth-route containment, ordinary-video playback/fullscreen controls, and continued Shorts exclusion on the physical phone |

## What the comparison products establish

SocialLite's public material establishes that a focused YouTube surface, Shorts
removal, background audio, and Picture in Picture can be delivered in an iOS
companion, but it does not disclose its source code or exact sign-in mechanism.
Vigil's maintained YouTube surface is now the fixed native companion. It starts
at `m.youtube.com`, keeps a persistent first-party WebKit data store, and uses
the unsupported Safari application-name suffix documented by TinyTube. That
compatibility exception is not an official Google-supported sign-in mechanism
and may stop working. The native Instagram package does not load YouTube; it
remains the containing app for the Safari content blocker and interaction
extension used by the fallback browser surface.

SHIFT publicly describes a different large-list strategy: it blocks Safari and
other browsers, then makes SHIFT Web the filtered browsing route. That explains
how it can advertise 600k+ sites without putting 600k entries in Apple's legacy
deny-list payload. Vigil does not need to copy that product compromise now that
iOS 26 offers a system URL Filter.

## Implementation sequence

### 1. Keep release state truthful

Run:

```sh
npm run adult:blocklist:refresh
npm run ios:content-policy:check
npm run ios:phone:status
npm run ios:phone:check
```

`status` and `check` must report the blocklist source, count, snapshot hash,
artifact hash, and signing capability. A missing, stale, corrupt, or undersized
default artifact must fail `check` and every Release/update path. A Release app
must contain the byte-identical `adult-blocklist.sdi` and generated explicit-text
policy that the release fingerprint describes.

### 2. Verify the signed-in YouTube companion

Build the fixed YouTube target and verify that only its WK configuration gets
the documented compatibility suffix, its website-data store is persistent,
popup requests stay in the same view, and authentication helpers are limited to
the exact paths in the parity audit. Do not import cookies or credentials.

On the physical phone, start sign-in from YouTube's site-generated route and
verify Google account sign-in, relaunch persistence, Home, Search,
Subscriptions, Library, ordinary Watch pages, comments, related videos,
fullscreen, swipe-up fullscreen, and edge-back. Verify that downward player
gestures remain owned by YouTube/WebKit and never create a second browsing web
view or detach the active video surface.
Verify that Shorts links and shelves remain absent and direct `/shorts`
documents recover to the focused browse surface.

Use `npm run ios:youtube:develop` for routine YouTube parity work. It performs an
Personal Team update of both fixed companions and the freshly generated
supervised profile in one transaction; the native sign-in flow's exact auth
routes make an app-only update unsafe. Because Instagram still contains the
fallback Safari controls extension, the command also refuses extension identity
or permission-contract drift that could make Safari disable an already-enabled
extension. A new extension target or permission change requires the documented
offline maintenance transaction.

Current status: the restored native YouTube WK path has source-contract,
policy, and local-build coverage only. It has not been installed on the
physical phone, no credentials were entered in the diagnostic probe, and
successful Google sign-in is not yet claimed. A future authorized phone update
must remove `tech.caseline.vigil.youtube-webclip-experiment` only through the
explicit `--replace-legacy` migration before reporting one canonical YouTube
icon.

### 3. Exercise the 952,054-domain artifact locally

Build the companion and verify the bundled artifact hashes before installing
anything. Exercise parent-domain and subdomain matches, malformed/corrupt index
rejection, and allowlist behavior. Keep the supervised profile as the fallback
for explicit URLs and Apple's automatic adult classification.

### 4. Complete the iOS 26 URL Filter development build

Use the foundation under `ios/VigilURLFilter/` to add the URL Filter provider
target and containing app to the maintained phone build. Generate Apple's
required Bloom dataset from the same normalized active-domain snapshot. The
provider supplies that data to `NEURLFilterManager`; the system performs the
actual URL checks.

For development, configure Apple's sample PIR server stack and test a small
known deny/allow corpus before loading the full snapshot. Confirm Safari,
third-party WebKit browsers, and `URLSession` traffic. Apps that use other
networking stacks must voluntarily call `NEURLFilter` and honor its verdict, so
keep the supervised app restrictions for known escape routes.

### 5. Obtain production capabilities

Request Apple's URL Filter provider/OHTTP distribution capability, deploy the
PIR service and gateway, and provision the containing app plus extension with a
paid development team. Separately obtain the Sensitive Content Analysis
entitlement if fail-closed visual filtering is required. Until those approvals
exist, report the URL Filter as development-only and media analysis as the
Personal Team fallback.

### 6. Deploy without touching supervision/layout

Only after the simulator, artifact, entitlement, and signed-build checks pass,
run the normal in-place phone update. Do not repeat enrollment, restore a
checkpoint, restore the Home Screen separately, or alter the proven supervision
keybag. After installation, verify supervision, non-removable profile state,
exact policy fingerprint, both companion launches, URL Filter enabled state,
and representative blocked/allowed URLs on Wi-Fi and cellular.
