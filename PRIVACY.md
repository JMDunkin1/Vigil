# Vigil privacy policy and data inventory

**Repository review date:** July 21, 2026

**Publication status:** disclosure draft; not yet approved for App Store Connect or a public policy URL

Vigil is designed as a local-first focus and restriction system. The audited default macOS configuration runs its service on loopback and stores rules, activity summaries, and intentional-use records on the Mac. No advertising SDK, analytics SDK, or general telemetry endpoint was found in this repository review.

This document records what the software currently handles and what must be settled before the publisher can issue a final privacy policy. It must not be represented as a completed hosted privacy policy until the publication blockers at the end are closed.

## Scope

This inventory covers the Vigil macOS app, its bundled Chromium companion, the optional Safari configuration profile, the native iOS Vigil Browser and Safari extension, focused-social iPhone companions, optional iPhone/MDM features, and optional hosted-account mode present in this repository. A shipping privacy disclosure must match the exact feature set and configuration of the submitted binary.

## Data handled by Vigil

| Data | Why it is used | Current handling |
| --- | --- | --- |
| Rules and configuration | Profiles, schedules, limits, blocked apps/sites, protection settings, keyholder settings, and maintenance state | Stored locally in Vigil's data directory. Most state is JSON protected by integrity seals, not confidentiality encryption. |
| App and website activity | Apply rules and calculate usage, opens, limits, and focus summaries | Vigil reads the frontmost app and, for supported browsers, the active URL. Persistent usage records contain app names, website hostnames, counters, timestamps, and timed segments; they do not contain page contents. Full URLs may be processed transiently for path-level rules and may appear in user-configured rules or event context. |
| Input-activity signals | Wake a browser-policy check promptly and measure idle time | The native helper reads aggregate key/mouse event counters and idle duration. It does not read characters, key codes, pointer coordinates, or event payloads. These aggregate wake signals are not stored as keystroke history. |
| Camera image | Scan a printed distance-key QR code when the user chooses **Scan** | The selected camera stream is processed locally for QR detection and stopped when scanning ends. The audited code does not record the video or send it to a Vigil publisher endpoint; users can type the key instead. |
| Wi-Fi network name | Activate schedules tied to a network | The current SSID is checked only when an enabled schedule names a Wi-Fi network and is stored in local environment state. |
| Intentional-use and journal content | Goals, plans, habits, check-ins, recovery/SOS records, moods, notes, and journal entries | Stored locally. Journal entries are encrypted with AES-256-GCM, but the encryption key is stored as a mode-600 file in the same data directory. This protects the journal archive from casual inspection, not from compromise of the user's macOS account. Other intentional-use fields remain in local state JSON. |
| Authentication data | Optional multi-user hosted mode | The normal local Mac mode needs no email or password. If an operator enables hosted accounts, Vigil stores name, email, role, creation time, password salt/hash, and session version on that Vigil host. Passwords are scrypt-derived rather than stored in plaintext. The host also uses the request IP address transiently for in-memory login rate limiting. |
| Local secrets and unlock material | Integrity checks, local API pairing, journal unlock, keyholder, distance key, and sessions | Random keys and salted hashes are stored locally with restrictive file permissions where implemented. A distance-key file path may be stored. Touch ID authentication is performed by macOS; Vigil does not receive fingerprint data. |
| Browser-companion data | Page-level blocking, local cleanup, and rule synchronization | The extension has tab, navigation, storage, declarative-rule, and broad HTTP/HTTPS page access. It sends page/rule events to Vigil's loopback service and keeps its connection settings in browser extension storage. The audited code does not send browsing data to a Vigil publisher endpoint. |
| Native iOS browser and Safari-extension data | Enforce URL rules and classify sensitive page media/text | The iOS browser uses persistent WebKit website storage, so provider cookies, caches, and site storage can remain on the device. Filter rules are stored in app-group preferences. Page scripts pass bounded text chunks and sampled image/video-frame data to native on-device classification code; the audited code does not persist those classification payloads or relay them to a Vigil publisher endpoint. Visited sites and search providers still receive normal web requests. |
| Focused-social companion activity | Optional focused Instagram and YouTube experiences on iPhone | The companion loads the selected service directly in a web view and modifies the page presentation to restrict distracting surfaces. Sign-in and service activity go to the selected social provider under that provider's policy; the audited code does not relay social credentials to a Vigil publisher endpoint. |
| iPhone and MDM data | Optional supervised-device policy and command delivery | May include device identifiers, serial/hardware identifiers, enrollment tokens, APNs tokens/topic, configuration profiles, command state, certificate payloads/passwords, and optional local backup/layout artifacts. These are sensitive administrative records stored by the configured Vigil/MDM operator. APNs receives the metadata needed to deliver an MDM wake; a third-party MDM such as ManageEngine follows that provider's terms and privacy practices. |
| Diagnostic exports | User-initiated troubleshooting | The app can generate a JSON diagnostic snapshot. Known tokens, passwords, device identifiers, certificate payloads, and journal entries are redacted, but app/site names, rules, timestamps, and other context can remain. The user should review an export before sharing it. |
| Setup and session state | Remember assistant progress and journal unlock state | Setup progress uses local Chromium storage. Journal unlock state uses session storage. Authenticated sessions use HTTP-only, SameSite cookies; the embedded app bridge marks its cookie Secure, and an external hosted deployment must use HTTPS for the hosted cookie to receive that protection. |

The expected packaged-app data root is `~/Library/Application Support/Vigil`, although an existing installation or managed deployment can configure another location. Optional profiles, blocklist snapshots, MDM exports, iPhone layout artifacts, logs, and update records can add files beneath that root or another explicitly configured directory.

Hosted mode changes this boundary. If an operator deploys Vigil on a remote host, shared state, usage, journals, device records, and account data reside on that operator's server and travel between the client and server. The operator may be able to access that material. A hosted deployment must not reuse the default build's “stays on this Mac” disclosure.

## Network connections

The audited default service listens on `127.0.0.1`. Normal local use does not require a Vigil cloud account. Network access can still occur in these user-visible cases:

- refreshing an adult-domain list from the selected HTTPS source (the source receives a normal request, including the user's network address, time, and the `Vigil adult-blocklist-refresh` user agent);
- opening a third-party attribution, license, or support page in the default browser;
- using a custom list URL chosen by the user;
- pairing the Chromium companion with the local service;
- using optional self-hosted MDM/APNs or a third-party MDM provider;
- signing into Instagram, YouTube, or another service reached through an optional focused-social companion;
- browsing or searching in the native iOS browser or Safari extension, which connects directly to the requested sites, search provider, and their resources;
- using hosted-account mode configured by an operator; or
- development/source-checkout update checks against the configured Git remote. The production Developer ID build is designed not to use that source updater as its public update mechanism.

The repository audit found no advertising, cross-app tracking, sale of data, or publisher analytics flow. This statement must be rechecked against every production dependency and deployed service before publication.

## Permissions and system access

Vigil can ask for or direct the user to approve:

- Accessibility/automation access to identify the frontmost app and control supported apps for enforcement;
- camera access only when the user chooses to scan a distance-key QR code;
- background/login operation so protection remains online when the window is hidden;
- administrator authorization when the user elects to install hosts/PF network rules;
- a visible Safari configuration profile when Safari rules require it; and
- broad page access for the optional Chromium companion.

The audited app does not request microphone, Contacts, Calendar, or precise Location access. Its camera use is limited to the user-initiated distance-key scanner described above, and its input helper observes only aggregate event counters and idle duration. Camera and Apple Events purpose strings are now present in the package configuration; the exact signed artifact, prompts, denials, and entitlements still need a release audit.

## Retention and deletion

Local state remains on the Mac while Vigil is installed. Some event, usage-segment, journal, check-in, and history collections have size caps, but there is no single time-based retention policy for all records. Individual journal entries and several user-created records can be deleted in the app.

There is currently no verified one-action **Erase all my data** flow, no in-app hosted-account deletion flow, and no public authenticated uninstall flow that removes Vigil data and system changes transactionally. Users must not be told to unload supervisors or manually remove enforcement files as a substitute. Those missing controls are release blockers.

Diagnostic files exist wherever the user saves or shares them and are then controlled by that destination. MDM providers and blocklist hosts apply their own retention policies to data they receive.

## Security characteristics

- Sensitive key files are generally created with owner-only permissions and the data directory is hardened to owner access where the relevant code path runs.
- State and usage seals detect modification; they do not encrypt the underlying values.
- Journal entries use authenticated encryption, with a local co-resident key as described above.
- Hosted passwords use salted scrypt hashes; session tokens are HMAC-signed.
- Local API and extension routes include loopback/origin and pairing controls, but any feature exposed beyond loopback changes the threat model and privacy disclosure.

No software can promise absolute security. Backups, diagnostic exports, administrator access, malware running as the user, optional third-party services, and custom deployment settings can expose data outside Vigil's normal local boundary.

## App Store privacy answers

Do not answer **“No, we do not collect data from this app”** in App Store Connect solely because Vigil is described as local-first. Apple requires answers to cover the exact submitted app and third-party partners. Before submission, the release owner must determine whether the store variant transmits hosted-account data, diagnostics, MDM/device data, usage data, or any other category off the device, and then complete the labels accordingly.

At minimum, perform separate reviews for:

- identifiers and contact information in hosted-account or MDM modes;
- product interaction and other usage data if any production service receives it;
- user content in diagnostics, journals, or support submissions;
- diagnostics if crash or support tooling is added; and
- third-party code, list providers, browser distribution, APNs, and MDM services.

Apple requires a privacy policy URL for App Store apps and requires the App Store privacy answers to remain accurate. See [Manage app privacy](https://developer.apple.com/help/app-store-connect/manage-app-information/manage-app-privacy/) and [App privacy reference](https://developer.apple.com/help/app-store-connect/reference/app-information/app-privacy/).

## Publication blockers

The publisher must complete all of the following before this becomes a public policy:

- approve the legal publisher/data-controller name and a monitored privacy contact;
- publish this policy at a stable, publicly accessible HTTPS URL and add the same link inside Vigil;
- decide and document supported countries, governing terms, minimum user age, and whether special-category journal/recovery content creates additional legal duties;
- define retention periods and ship supported erase-all, account-deletion (if account creation ships), export, and authenticated uninstall choices;
- audit the exact production binary, Electron/Chromium components, browser extension, update service, support tooling, and deployed MDM/hosted services;
- complete App Store privacy labels and validate the bundled `PrivacyInfo.xcprivacy` against the exact submitted target and every enabled service;
- document each third party that receives data and link its policy where appropriate; and
- obtain legal review appropriate to the markets where Vigil will be offered.

Apple's guidelines also require an easily accessible in-app privacy-policy link and, when an app supports account creation, in-app initiation of account deletion. See [App Review Guidelines 5.1](https://developer.apple.com/app-store/review/guidelines/) and [Offering account deletion in your app](https://developer.apple.com/support/offering-account-deletion-in-your-app/).
