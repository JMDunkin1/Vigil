# Vigil computer/phone enforcement audit and roadmap

Audit date: 2026-08-01

## Bottom line

The Mac and iPhone do not currently enforce the same policy through the same
mechanism. The Mac can consult Vigil's complete adult-domain snapshot during a
browser navigation. The installed iPhone profile uses Apple's built-in web
content filter, whose explicit deny list is intentionally kept below 500
entries. Vigil's fixed Instagram companion adds full-document text and media
inspection, while the YouTube Web Clip uses the Safari content blocker and
ordinary-watch interaction extension carried by Instagram.

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
| YouTube | Browser extension modifies the normal site | A full-screen Web Clip named `YouTube` supplies the signed-in surface. Instagram contains the Safari Shorts blocker and an ordinary-watch miniplayer gesture extension, avoiding a second YouTube icon | Verify the Web Clip's signed-in surface, both enabled extensions, ordinary-video miniplayer gestures, and continued Shorts exclusion on the physical phone |

## What the comparison products establish

SocialLite's public material establishes that a focused YouTube surface, Shorts
removal, background audio, and Picture in Picture can be delivered in an iOS
companion, but it does not disclose its source code or exact sign-in mechanism.
Vigil uses the physically verified full-screen Web Clip for the YouTube surface.
The native Instagram package does not load YouTube; it is also the containing
app required to deliver the Safari content blocker and YouTube interaction
extension.

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

### 2. Verify the signed-in YouTube Web Clip

Enable `Vigil YouTube Shorts Filter` and `Vigil YouTube Controls` in Settings >
Apps > Safari > Extensions, granting the controls extension access only to the
three YouTube hosts declared in its manifest. Then verify Google account
sign-in, Home, Search, Subscriptions, Library, ordinary Watch pages, comments,
related videos, fullscreen, and edge-back. On ordinary videos, verify swipe-down
minimizes playback while browsing continues, tap or swipe-up restores it, and a
sideways swipe or Close dismisses it.
Verify that the companion refuses to open while the filter is disabled, Shorts
links and shelves are absent, and direct `/shorts` documents are blocked. The
Instagram app package embeds both extensions; the Home Screen YouTube surface
remains the separate full-screen Web Clip.

Once both extensions are enabled, use `npm run ios:youtube:develop` for routine
YouTube parity work. It performs an app-only Personal Team update and refuses
extension identity or permission-contract drift that could make Safari disable
the already-enabled controls extension. A new extension target or permission
change requires the documented offline maintenance transaction; it is never a
normal profile-replacement update.

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
