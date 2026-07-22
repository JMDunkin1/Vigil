# App Store readiness and distribution decision

**Assessment date:** July 21, 2026

**Current verdict:** the full Vigil macOS build is not Mac App Store compliant. The repository has a credible Developer ID/notarized-DMG release foundation, but a public release still has operational, privacy, support, update, and clean-machine validation blockers.

## Recommended distribution decision

Ship the full enforcement product through the signed and notarized Developer ID DMG channel after the direct-release checklist is complete. If Mac App Store presence remains a goal, build a separate sandboxed target with a deliberately narrower feature set and store-managed updates.

Do not submit the current full build to App Review and do not describe a notarized DMG as “App Store approved.” Developer ID and notarization are Apple's outside-the-Mac-App-Store distribution path; Mac App Store apps have different packaging, sandbox, signing, and review requirements.

| Channel | Intended product | Installation | System authority | Update path |
| --- | --- | --- | --- | --- |
| Developer ID DMG | Full Vigil enforcement | Verified DMG copied to Applications, followed by the guided setup assistant | Can request administrator authorization for user-selected hosts/PF changes and can maintain Vigil's protected supervisor | Must use an authenticated production updater/maintenance flow; the source-checkout updater is not acceptable |
| Mac App Store target | Sandboxed Vigil companion/core | One-click App Store installation | Only sandbox entitlements and App Review-compliant APIs; no root escalation, direct `/etc` edits, or runtime-installed shared code | Mac App Store updates |

If removing the full-build capabilities would make the store variant misleading or ineffective, the honest decision is to omit the Mac App Store channel and make the notarized DMG experience excellent.

## Why the current full build cannot go to the Mac App Store

Apple requires Mac App Store apps to use App Sandbox. Guideline 2.4.5 also requires a self-contained single-app bundle, forbids root escalation, limits installation of code/resources into shared locations, and requires consent for login/background behavior. The current build conflicts with those requirements in several concrete ways:

1. **No App Sandbox entitlement.** `build/mac-entitlements.plist` and its inherited counterpart currently contain only `com.apple.security.cs.allow-jit`. There is no `com.apple.security.app-sandbox` entitlement or per-resource sandbox entitlement plan.
2. **Root-authorized system changes.** `src/server/localScripts.ts` invokes an administrator-authorized AppleScript, and `scripts/apply-hosts.mts` writes `/etc/hosts`, `/etc/pf.conf`, and `/etc/pf.anchors/com.vigil.block`. A Mac App Store target may not request escalation to root privileges.
3. **Runtime-installed persistence.** `app/main.ts` writes a supervisor marker, executable shell script, and plist beneath the user's Library and bootstraps a LaunchAgent. The store target needs an Apple-supported, consent-based background design packaged with the app; it cannot reproduce this generated shared-code installation.
4. **Quit/background semantics need a store-specific consent design.** Packaged Vigil intentionally hides instead of quitting and its supervisor relaunches it. That is a valid safety property for an opted-in enforcement product, but App Review must see clear consent, an authenticated supported maintenance/removal path, and behavior consistent with guideline 2.4.5(iii). The current app installs its supervisor before the first-run explanation is complete.
5. **Out-of-container access.** The full app reads or changes browser state, System Events, process state, `/etc`, `/Library`, `~/Library/LaunchAgents`, configuration profiles, optional Minecraft data, Git/source directories, and iPhone backup/MDM material. Every store feature must be removed, replaced with an approved API, or justified by a sandbox entitlement and user-selected access.
6. **The Apple Events entitlement plan is incomplete.** The package configuration now includes `NSAppleEventsUsageDescription`, but the current entitlements still do not grant Apple Events automation for a sandboxed store target. The retained automation targets, consent prompts, denials, and entitlements need a store-specific design and signed-build validation.
7. **No Mac App Store package/signing workflow.** The build has `dir` and `dmg` targets and a Developer ID notarization workflow. It has no `mas`/`mas-dev` configuration, Mac App Distribution identity/provisioning profile, store-specific nested-helper entitlements, installer/upload artifact, or App Store Connect upload validation.
8. **The Chromium companion's public listing is not yet verified.** Guided Setup now opens a fixed, allowlisted Chrome Web Store item in a consumer package only after the checked-in item ID matches the manifest key/runtime allowlist and publication is explicitly marked complete. Until the real dashboard item is created, ID-aligned, reviewed, and published, development builds retain a clearly non-consumer Finder fallback and the production release command fails closed.
9. **The updater is channel-incompatible.** A Mac App Store target must not use the source-checkout rebuild/updater. Remove that path and rely on App Store updates. The direct channel separately needs a production DMG updater that respects Vigil's authenticated maintenance transaction.

The repository now packages `build/PrivacyInfo.xcprivacy` with no tracking or collection declarations and proactive required-reason entries for app-local file timestamps, elapsed-time timers, low-disk behavior, and app-only defaults. That is useful preparatory work, not proof of final compliance: the full build also accesses external guardian/repository metadata and system or other-app defaults that do not fit those reasons. A store target must remove those paths and be validated against the exact Electron bundle, third-party code, enabled services, and App Store privacy answers.

Official references:

- [App Sandbox](https://developer.apple.com/documentation/security/app-sandbox)
- [App Review Guidelines, especially 2.4.5 and 5.1](https://developer.apple.com/app-store/review/guidelines/)
- [Apple Events entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.automation.apple-events)
- [`NSAppleEventsUsageDescription`](https://developer.apple.com/documentation/bundleresources/information-property-list/nsappleeventsusagedescription)
- [Adding a privacy manifest](https://developer.apple.com/documentation/bundleresources/adding-a-privacy-manifest-to-your-app-or-third-party-sdk)

## Direct Developer ID release checklist

Repository evidence already present is checked. Operational facts that cannot be proven from source remain unchecked.

### Artifact and signing

- [x] Stable product identity `tech.caseline.vigil`, product name, category, and macOS icon are configured.
- [x] A macOS privacy manifest with audited baseline required-reason entries and camera/Apple Events purpose strings is configured for packaging.
- [x] The current packaging and release commands request a universal build, and release verification requires `x86_64` and `arm64` slices in signed executable files.
- [x] The release script requires Developer ID credentials, hardened runtime, signing of nested code, notarization, stapling, Gatekeeper assessment, team/authority verification, and a SHA-256 checksum sidecar.
- [x] The tag workflow runs `npm run check` before publishing only the DMG and checksum sidecar.
- [ ] Configure and independently verify every release secret in the production repository; their existence cannot be inferred from workflow source.
- [ ] Build from an annotated version tag that exactly matches `package.json`, and archive the workflow logs and notarization submission ID.
- [ ] Install and exercise the universal artifact on real Intel and Apple silicon Macs; static slice checks do not replace clean-machine behavior tests.
- [ ] Declare and test the minimum supported macOS version for the entire Electron app, not only the native idle helper.
- [ ] Install the downloaded release artifact on clean Macs with no repository, Node.js, development certificate, or prior Vigil data.
- [ ] Verify first launch, Gatekeeper, stapling, nested signatures, app translocation behavior, and checksum instructions from the user's actual download location.

### Installation and lifecycle

- [x] A first-run, resumable assistant explains background protection, Accessibility, selected network protection, Safari coverage, and the optional Chromium companion, and verifies most resulting states.
- [x] Closing the window is presented as hiding the resident app rather than stopping enforcement.
- [ ] Make Safari assistant readiness require both Apple's active web-safety state and the installed Vigil profile's current rule signature; it currently checks only the former.
- [ ] Prove the guided flow on every supported macOS version with fresh Accessibility, Automation, background-item, administrator, and profile-consent state.
- [ ] Audit every required purpose string and entitlement, then verify the exact macOS prompts shown by the signed production bundle, including grant, denial, and later revocation.
- [ ] Create, ID-align, review, and publish the real Chrome Web Store item. The code already gates consumer packaging on that evidence and opens only its fixed allowlisted URL; unpacked loading remains development-only.
- [ ] Ship an authenticated, transactional production DMG upgrade flow. A distribution-signed install must never depend on a source checkout, Git, Node.js, or force quitting Vigil.
- [ ] Ship an authenticated uninstall/data-removal flow that reverts only Vigil-owned system changes while preserving availability until the transaction is authorized.
- [ ] Test upgrades from every supported prior data/schema version, including rollback after interrupted replacement.

### Privacy, support, and product operations

- [x] A repository-level data inventory and disclosure draft exists in [PRIVACY.md](PRIVACY.md).
- [ ] Approve the legal publisher name and monitored support/privacy contacts.
- [ ] Publish stable HTTPS support and privacy pages, link the privacy policy inside the app, and place the final URLs in release metadata. Do not use placeholder URLs.
- [ ] Define retention, erase-all, export, and account-deletion behavior; implement the choices promised by the policy.
- [ ] Audit licenses and attribution for bundled audio, saint artwork, icons, blocklists, Electron/Chromium, and any Minecraft-related functionality. Preserve proof of distribution rights.
- [ ] Create a support runbook that never instructs staff or users to defeat Vigil's supervisor or force quit the app.
- [ ] Define a vulnerability-reporting and release-revocation process.
- [ ] Run accessibility, keyboard navigation, reduced-motion, VoiceOver, contrast, localization, and small-window QA.
- [ ] Create signed release notes that identify version, architecture, macOS compatibility, known limitations, data migrations, and checksum verification.

The direct channel is ready only when every applicable unchecked item above has an owner, evidence, and a pass result for the exact artifact being published.

## Mac App Store target checklist

### Product boundary

- [ ] Decide in writing which features the store target retains and which full-enforcement features are direct-only.
- [ ] Choose a store-specific bundle identifier/product name if needed to prevent the App Store build from overwriting the full Developer ID build. Do not claim an identifier until it is registered.
- [ ] Define separate data containers and an explicit, user-authorized migration/import path. Never assume a sandboxed build can reuse the direct build's Application Support directory.
- [ ] Ensure marketing states the reduced enforcement boundary plainly.

### Engineering and packaging

- [ ] Create a separate `mas` target with App Sandbox enabled for the app and correctly inherited by every Electron helper.
- [ ] Minimize and document required entitlements, including only the network client/server and Apple Events capabilities actually retained.
- [ ] Remove root authorization, `/etc` and `/Library` writes, runtime-created executable scripts/plists, source rebuild/update code, and other non-store installation paths from the store artifact.
- [ ] Replace persistence with an Apple-supported, bundled, user-consented background mechanism, or remove background enforcement from the store target.
- [ ] Add accurate Info.plist purpose strings and test first-denial, later-grant, and revoked-permission behavior.
- [x] Package the audited baseline `PrivacyInfo.xcprivacy` in `Contents/Resources`.
- [ ] Validate the privacy manifest's declarations against the store feature set; audit Electron and every third-party component included in the final bundle.
- [ ] Configure Mac App Distribution signing, a Mac App Store Connect provisioning profile, Mac Installer Distribution signing where the upload package requires it, store-specific Electron helper entitlements, build number, package generation, validation, and App Store Connect upload.
- [ ] Verify the installed App Store receipt build and every nested signature/entitlement from a clean Mac.
- [ ] Remove direct-channel update controls from the store target and prove updates occur only through the Mac App Store.

### App Review and metadata

- [ ] Create the App Store Connect macOS record only after the bundle-ID/channel decision is final.
- [ ] Supply a real privacy-policy URL, real support URL, description, subtitle, keywords, category matching the bundle, copyright, territories, and pricing.
- [ ] Complete App Privacy answers against the exact store build and all production services.
- [ ] Complete the age-rating questionnaire honestly. Vigil includes adult-content blocking terminology and optional recovery/journal features; do not guess or minimize the resulting descriptors.
- [ ] Resolve export-compliance answers for AES-GCM, HMAC, TLS, and bundled Electron/Chromium cryptography.
- [ ] Upload one to ten truthful Mac screenshots at an Apple-supported 16:10 size; do not show capabilities removed from the store build.
- [ ] Add an in-app privacy-policy link and support access.
- [ ] If hosted account creation is enabled, add in-app account deletion and deletion of associated data. If accounts are not essential, retain the current usable local mode without login.
- [ ] Give App Review reproducible instructions for Accessibility/Automation/background consent, a short safe test scenario, and the authenticated maintenance path. Never give reviewers a hidden bypass or ask them to defeat the supervisor.
- [ ] Explain optional browser-extension, MDM, and profile dependencies accurately; all reviewed core functionality must work as submitted.
- [ ] Submit the exact validated build, answer review questions, and treat acceptance—not a successful upload—as the completion gate.

## Draft Mac App Store listing copy

This is working copy for a future sandboxed, reduced-capability edition. The App Store name is not known to be reserved, and none of this copy should be published until every described feature exists in the submitted build.

**Name:** Vigil

**Subtitle:** Deliberate focus, made clear

**Primary category:** Productivity

**Promotional text:** Plan focused time, add thoughtful friction to distractions, and review your progress with a local-first workspace that explains each permission before you grant it.

**Description:**

> Vigil helps you use your screen on purpose. Plan focus blocks, shape practical routines, set deliberate limits, and review on-device activity summaries from one calm workspace.
>
> A guided setup assistant explains each permission and verifies the resulting state. Journals and intentional-use tools help turn a blocked impulse into a useful next action. No Vigil account is required for the local Mac experience.
>
> The Mac App Store edition is sandboxed. It does not include the full system-level network hardening available in Vigil's separately distributed Developer ID edition.

**Draft keywords:** focus,productivity,screen time,habits,planner,limits,journal

Screenshot candidates, using the exact submitted store build, are the welcome/setup assistant, focus dashboard, planner, local activity summary, and journal privacy controls. Do not show root-authorized network protection, unpacked extension loading, direct-build supervision, or any other feature absent from the store target.

## Draft App Review notes

Use the following substance only after testing proves every statement. Put real contact and account details in App Store Connect's protected fields; do not paste dummy credentials or placeholder URLs into the submission.

- Identify the binary as the sandboxed Mac App Store edition and summarize the capabilities removed from the full Developer ID edition.
- State that local use requires no login. If hosted accounts ship, provide a working review account through App Store Connect and point to the in-app account-deletion control.
- Confirm that the reviewed binary does not request root, edit `/etc` or `/Library`, install a generated LaunchAgent/script, load an unpacked browser extension, or use the source-checkout updater.
- Give a short reproducible test: launch Vigil, walk through the setup assistant, create a two-minute focus block, observe the dashboard/status transition, end through the documented control, and inspect the local activity/journal views.
- For each retained Accessibility, camera, Apple Events, notification, or background capability, name the exact user action that triggers it, why it is needed, and what still works after denial.
- Explain resident/background behavior and the authenticated maintenance/removal control. Never give App Review a hidden bypass or instructions to defeat Vigil's supervisor.
- List any network calls the store build can make and explain whether data leaves the device. Make this agree with `PrivacyInfo.xcprivacy`, App Privacy answers, and the public privacy policy.
- Explain how App Review can reach every feature without an external MDM, unpublished browser extension, private configuration profile, or prior Vigil installation.
- Include any content-license context, unusual adult-content-blocking terminology, and age-rating context that could otherwise surprise the reviewer.

## External values and approvals that cannot be completed locally

Repository work can prepare fields and fail-closed validation, but it cannot truthfully supply or approve these values:

- [ ] A publicly accessible HTTPS privacy-policy URL containing the approved policy.
- [ ] A publicly accessible HTTPS support URL, monitored support contact, and monitored privacy contact.
- [ ] The approved legal seller/data-controller name, copyright holder, and any required trader or regional business information.
- [ ] Active Apple Developer Program membership, accepted current agreements, and the Account Holder/Admin actions needed for distribution.
- [ ] A final registered App ID/bundle ID, available App Store name, SKU, Apple-generated app record, and Team ID for the store edition.
- [ ] Valid Mac App Distribution and, where needed, Mac Installer Distribution certificates and their private keys.
- [ ] A Mac App Store Connect provisioning profile matching the final App ID and entitlements.
- [ ] App Store Connect API/upload credentials stored as repository or CI secrets; no credential belongs in source control.
- [ ] Apple approval for any restricted entitlement or provider capability selected during the store redesign.
- [ ] Final pricing, territories, tax/banking agreements if applicable, release mode, and public/private/unlisted distribution choice.
- [ ] The completed age-rating result, export-compliance determination, legal/privacy approval, and country-specific obligations.
- [ ] Production browser-store listing IDs/URLs and publisher verification for any companion extension.
- [ ] MDM-provider authorization, APNs/MDM certificates, topics, and third-party contracts if those services are part of the submitted experience.
- [ ] Documented distribution rights for all audio, art, icons, blocklists, and other third-party content.
- [ ] App Review acceptance and the final public App Store URL; neither exists merely because an upload succeeds.

Do not convert any unchecked item into a fabricated value. Record the real value in the release evidence only after the responsible external system or owner has supplied and verified it.

Apple's references cover [certificates](https://developer.apple.com/help/account/create-certificates/certificates-overview), [Mac App Store Connect provisioning profiles](https://developer.apple.com/help/account/provisioning-profiles/create-an-app-store-provisioning-profile), [uploading builds](https://developer.apple.com/help/app-store-connect/manage-builds/upload-builds), [privacy information](https://developer.apple.com/help/app-store-connect/manage-app-information/manage-app-privacy/), [Mac screenshot sizes](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications/), and [submitting an app](https://developer.apple.com/help/app-store-connect/manage-submissions-to-app-review/submit-an-app).

## Release gate summary

Use these definitions in planning and status reports:

- **DMG release candidate:** a tagged artifact for every advertised architecture has passed CI, signing/notarization/stapling, clean-machine installation, permission/onboarding, upgrade, rollback, and support/privacy checks.
- **DMG public-ready:** the release candidate also has live download, checksum, privacy, support, release-notes, authenticated update, and authenticated uninstall paths.
- **Mac App Store uploadable:** the separate store target passes sandbox/package validation and its App Store Connect record is complete.
- **Mac App Store ready:** Apple has accepted the exact submitted build and all operational/support promises are live.

None of those states should be inferred from `npm run build`, a local DMG, successful notarization alone, or the presence of this checklist.

## Apple distribution distinction

Apple describes Developer ID signing and notarization as the path for software distributed outside the Mac App Store. Notarization checks Developer ID software and issues a ticket Gatekeeper can evaluate; it is not App Review. See [Signing Mac Software with Developer ID](https://developer.apple.com/developer-id/) and [Notarizing macOS software before distribution](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution).
