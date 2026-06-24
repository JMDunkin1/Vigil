# Vigil

A local-first focus enforcement app for this Mac. It borrows the strongest ideas from modern focus enforcement tools: desktop-controlled blocking, locked sessions, schedules, rehab mode, content filtering, usage reports, streaks, app limits, allow/block modes, emergency unlock limits, and optional tamper resistance.

Vigil is Apple-first. Integrations are expected to work across Apple products: macOS locally, Safari/Chromium browsers on Mac, and supervised iPhone/iPad device-management paths. Android integrations are not part of the supported product direction.

## Quick Start

```sh
npm start
```

Open `http://127.0.0.1:8787`.

To run Vigil as a Mac app during development:

```sh
npm run app
```

To build an unsigned local `.app` bundle:

```sh
npm run build:mac
```

The app bundle is written to `dist/mac/mac-arm64/Vigil.app` on Apple Silicon. The packaged app stores local state in `~/Library/Application Support/Vigil` instead of the repository `data/` folder.

For release signing, keep using the unsigned commands for local checks and run the signed commands only on a Mac that has your own Apple Developer ID Application certificate available to electron-builder:

```sh
npm run dist:mac:signed
```

Notarization is the next release step after a signed DMG exists. Provide notarization credentials through your local release environment or keychain; do not commit Apple IDs, app-specific passwords, API keys, or team secrets to this repo.

The app works best after granting Accessibility permission to the terminal or app that runs it:

1. Open System Settings.
2. Go to Privacy & Security > Accessibility.
3. Enable your terminal app, Codex, or the future packaged app.

## What Works Now

- Local app views for focus, sleep, rehab, and Mac Brick sessions.
- Shift/Brick-style Mac Brick profile and one-tap strict commitment lock that allowlists only essential apps and approved work sites.
- Weekly Focus Report with focus score trends, distraction averages, streaks, culprit apps/sites, and milestones.
- Strict sessions that cannot be ended early without spending an emergency unlock.
- Commitment locks for deep focus, rehab, or schedules that refuse ordinary emergency unlocks.
- Opal-style focus cycles with automatic work phases and short unblocked breaks.
- Freedom-style local focus sounds with noise, bundled nature recordings, binaural beat, isochronic tone, and bundled CC0 Baroque recordings during active locks.
- Optional bedtime screen lock that repeatedly locks the Mac during strict sleep sessions.
- Optional macOS Shortcuts hooks that can turn a Focus/Do Not Disturb mode on during active locks and off when the lock clears.
- Opal-style Time Limits that lock a target group after daily cumulative use.
- Opal-style Open Limits that lock a target group after too many daily opens.
- Opal-style App Locks that keep selected apps/sites locked except for limited daily unlock windows.
- Blocked-page intentional breaks with a server-enforced reason gate, cooldown, keyholder confirmation, and return-to-site flow.
- Adaptive friction that adds emergency-unlock delay after repeated blocked app/site attempts.
- Random typing challenges on emergency, App Lock, and maintenance confirmations.
- Configurable intent-reason minimums for emergency unlocks, App Lock unlocks, and protected maintenance windows.
- Brick-style distance key that can be typed, stored as a removable key file, or printed as a scannable QR key for emergency, App Lock, and maintenance confirmations.
- Supervised iPhone profile generation for desktop-managed app and web restrictions.
- Experimental local iPhone MDM server scaffolding with enrollment profiles, check-in/connect endpoints, enrolled-device tracking, and queued InstallProfile policy refreshes.
- Optional unpacked browser extension companion for faster tab-level blocking and browser time-limit tracking.
- Browser extension dynamic block rules that redirect active blocked domains, safe URL patterns, and allowlist/Brick Mode misses at request time while acknowledging installed rule counts to Foolproof mode.
- Content feature filters that block short-form and infinite-scroll surfaces such as YouTube Shorts, Instagram Reels, Reddit Popular, X Explore, and TikTok during active locks while keeping regular Instagram pages such as DMs and Stories available.
- Custom URL pattern blocking for paths and keywords such as `youtube.com/shorts`, `/reels`, or `casino`.
- Protected edits: strict active protections block weakening config changes until a maintenance cooldown completes.
- Local API mutation hardening blocks cross-site localhost POSTs, requires JSON mutations, and adds clickjacking protection headers.
- Optional strict-lock bypass guard for common escape tools such as Activity Monitor, App Store, installers, app managers, and device/profile utilities.
- Strict-lock network bypass guard for VPN, proxy, DNS, packet-inspection, and firewall-configuration apps such as Tailscale, Cloudflare WARP, WireGuard, Proxyman, Charles, Wireshark, Little Snitch, LuLu, and AdGuard.
- Strict site locks also quit unsupported browsers and embedded-browser apps such as Firefox, Tor Browser, LibreWolf, DuckDuckGo Browser, Chromium, Slack, Teams, Telegram, Discord, and Steam when tab-level blocking cannot inspect them.
- Strict locks redirect supported-browser control pages such as `chrome://extensions`, `chrome://settings`, and `chrome://flags` so the companion cannot be disabled mid-session.
- Optional Foolproof mode that blocks strict session starts until hardening checks are ready.
- Mac account hardening check that warns when the app is running from an admin account instead of a standard daily account.
- Tamper-evident state seal with fail-closed integrity lockdown when protected blocker settings, sessions, profiles, limits, unlocks, or device policies are edited outside the app.
- Opt-in source integrity seal for trusted app code, public UI, scripts, and extension files.
- Runtime watchdog that enters integrity lockdown after unexplained service downtime during strict locks.
- Clock tamper watchdog that compares wall-clock time with monotonic runtime and enters integrity lockdown if the system clock jumps during a protected lock.
- Hardening drift watchdog that enters integrity lockdown if Foolproof-mode protections such as source integrity, hosts, LaunchAgent, Accessibility, or extension rules weaken during a strict lock.
- Optional keyholder passcode for emergency, App Lock unlock, and maintenance confirmation.
- Background watcher for the active macOS app, with forced-kill escalation and background process sweeping for blocked apps.
- New manual locks queue an immediate foreground check and process sweep as soon as the session is saved.
- Strict allowlist sessions also sweep already-running non-allowed user apps while leaving macOS support processes alone.
- App alias matching catches common helper/variant process names such as Discord Helper, Steam Helper, EpicWebHelper, and alternate browser names.
- Browser tab detection and redirect blocking for Safari, Chrome, Edge, Brave, Arc, Vivaldi, Opera, and Orion where AppleScript access is available.
- Distraction domain aliases, so blocking a site also catches common alternate domains like `youtu.be`, `redd.it`, `fb.com`, and `discord.gg`.
- Preset block categories for Social, Video, Games, News, Shopping, and Rehab lists.
- Daily usage analytics for apps and sites.
- Blocklist and allowlist profiles.
- Recurring schedules, including overnight schedules and optional Wi-Fi gates.
- Emergency unlock cooldowns and weekly token limits.
- Optional LaunchAgent installer to keep the service running after login.
- Optional network blocker preview/apply script for harder domain fallback blocking: `/etc/hosts` DNS denial plus a Vigil PF firewall anchor for resolved target IPs.

## Hardening

Run this to install the app as a LaunchAgent:

```sh
npm run install:agent
```

You can also install the login agent from the Settings view. The LaunchAgent uses a runner process that waits when Vigil is already open and starts the local server if it goes down.

Run this to preview system network rules. This is the preferred Safari and across-app site blocker: whole-site domains are denied by macOS instead of rewriting the browser tab to a localhost block page. Path-only and keyword URL patterns stay in browser/app-side enforcement, while host/path patterns such as `youtube.com/shorts` can add their hostname to the harder fallback when that profile allows broad network fallback:

```sh
npm run network:preview
```

Run this to apply them. macOS will ask for your password because `/etc/hosts`, `/etc/pf.conf`, and `/etc/pf.anchors` are protected:

```sh
npm run network:apply
```

You can also apply the network block from the Settings view. The app will ask macOS for administrator approval and keeps the copyable Terminal command as a fallback. The PF layer is a SelfControl-style IP fallback: it helps catch cached DNS and direct-IP paths for resolved domains. URL paths and fast-changing CDN targets still need browser/app-side precision unless you accept broad whole-domain blocking for those patterns.

For Safari path rules, such as blocking YouTube Shorts while leaving normal YouTube videos alone, generate the macOS Safari filter profile:

```sh
npm run safari:apply
```

This writes `vigil-safari-url-filter.mobileconfig` and opens it for approval in System Settings. Safari gets native path-level blocking without the localhost redirect/back-button churn, while Chrome, Brave, Edge, and Arc keep using the browser companion extension for tab-level precision and cleanup. Reapply the Safari profile after changing URL-pattern rules so the installed profile matches the current Vigil policy.

If the state seal detects protected local state tampering, or if the runtime/clock watchdog detects unexplained downtime or clock changes during a strict lock, the app enters integrity lockdown using code-defined default distractions and bypass tools. The state seal ignores repairable bookkeeping-only drift such as runtime heartbeats and event history, then refreshes the seal on the next clean save.

Enable Sleep screen lock in the Hardening panel if sleep-mode locks should lock the entire Mac login session and keep re-locking while the bedtime window is active.

To mute notifications during locks, create two macOS Shortcuts that set your desired Focus mode on and off, then enter their names in the Hardening panel's Notification Focus fields. The app runs those local shortcuts when a lock becomes active or clears.

Run this to audit whether the local hardening layer and Foolproof readiness checklist are installed and current:

```sh
npm run doctor
```

After reviewing local code changes, seal the trusted app source for Foolproof mode:

```sh
npm run seal:source
```

Source/code edits are handled by the source seal, not the state tamper alarm. A reviewed Codex or developer change should be tested, then sealed with `npm run seal:source`; Foolproof mode treats unsealed source changes as a hardening issue during strict locks, but ordinary source edits do not by themselves mean someone tried to bypass the blocker.
When a trusted source edit is the only hardening drift, `npm run seal:source` also clears that source-seal drift after writing the new trusted seal. Other hardening drift, such as hosts, firewall, LaunchAgent, Accessibility, or extension-rule failures, remains locked until fixed and cleared separately.

To add the browser companion, load the `extension` folder as an unpacked extension in Chrome, Brave, Edge, or Arc while the local server is running. Use the extension Options page for alternate local ports or a shared extension token; see `extension/README.md`.

## iPhone / MDM

The iPhone controls are modeled after desktop-owned phone blockers such as SHIFT: the Mac decides the policy, and the phone is only the managed endpoint. For a supervised iPhone, the Devices view can generate:

- a static restrictions profile at `/api/devices/ios/profile.mobileconfig`
- an experimental MDM enrollment profile at `/api/devices/ios/mdm/enrollment.mobileconfig`
- public MDM endpoints under `/mdm/enroll.mobileconfig`, `/mdm/checkin`, `/mdm/connect`, and `/mdm/policy.mobileconfig`

Before any SHIFT-style local setup, create a local layout checkpoint while the phone still looks correct:

```bash
npm run ios:checkpoint
```

The checkpoint is stored under ignored `data/ios-checkpoints` by default. It creates a local iPhone backup, then verifies the backup manifest includes SpringBoard/Home Screen layout records. If the Mac does not have enough space, pass an external volume with `-- --output=/Volumes/External/vigil-ios-checkpoints`. For encrypted backups, pass `-- --password ...` or set `IOS_BACKUP_PASSWORD`; do not print the password into tickets, logs, or handoffs.

Then use the USB apply script:

```bash
npm run ios:apply-usb
```

This installs a local `pymobiledevice3` helper under ignored `data/ios-tools`, verifies the phone over USB, repairs the supervised pairing channel when needed, and applies the generated Vigil iPhone profile directly when the device is already supervised. The USB path requires the keybag for the same supervision identity that already supervises the phone; place it at ignored `data/vigil-supervisor.keybag`, set `VIGIL_SUPERVISOR_KEYBAG`, or pass `-- --supervisor-keybag /path/to/supervisor.keybag`. The script fails early when that matching keybag is absent because a newly created Vigil identity cannot manage a phone supervised by Apple Configurator, SHIFT, or another existing identity. Add `-- --require-checkpoint /path/to/checkpoint` when applying after a layout-sensitive setup; the apply script rechecks that checkpoint for `Manifest.db` plus SpringBoard/Home Screen layout records before it proceeds. If the connected iPhone is already activated but not supervised, iOS rejects supervised app and web restriction payloads; the script stops before erasing or partial-restoring anything. Do not add a no-erase supervision path here unless it first creates a local backup/layout recovery checkpoint and proves that Home Screen layout, Apple ID setup state, and app organization survive the flow.

For a phone that is not supervised yet and must keep its current app/folder order, use the heavier layout-preserving supervision flow instead:

```bash
npm run ios:supervise-preserve-layout -- --yes-supervise-and-restore
```

This is the slow, no-data-loss path. Like commercial phone-shifting tools, it chooses verification, local backups, layout recovery, and user prompts over speed. Before starting, turn Find My off, keep the phone on power or well charged, keep it cabled, leave time for full backup/restore passes, and be ready to unlock and accept Trust after each restore.

That flow creates and verifies a full local backup with SpringBoard/Home Screen layout records, creates or reuses `data/vigil-supervisor.keybag`, builds a tiny pre-supervision restore payload from the verified checkpoint, and restores only these live-proven setup-state files before no-erase supervision:

- `SysSharedContainerDomain-systemgroup.com.apple.configurationprofiles/Library/ConfigurationProfiles/CloudConfigurationDetails.plist`
- `HomeDomain/Library/Preferences/com.apple.purplebuddy.plist`

After that tiny restore, Vigil waits until the phone is visible again and `pymobiledevice3 profile cloud-configuration` is null or empty. Only then does it supervise the phone without erasing, using the persistent Vigil identity. It then restores the full checkpoint with system/settings/app placement recovery flags so app placeholders and folders return to their previous grid positions. If the full restore clears supervision, the script re-runs no-erase supervision, pairs the supervised channel, and applies the static Vigil profile. If backup verification, tiny-payload verification, cloud-configuration clearing, supervision, restore, or post-restore supervision verification fails, it stops before installing the restrictions profile. Pass `-- --output=/Volumes/External/vigil-ios-checkpoints` for large phones or low internal disk space, `-- --password ...` when the device backup password is required, and `-- --udid ...` when multiple USB devices are connected.

If a known-good local backup already restored the current layout, reuse it instead of creating a fresh checkpoint:

```bash
npm run ios:supervise-preserve-layout -- --yes-supervise-and-restore --checkpoint /path/to/checkpoint-or-UDID-backup-folder
```

The existing-checkpoint path must either contain the connected phone's UDID folder or be that UDID-named backup folder itself. Vigil verifies `Manifest.db`, complete backup metadata, the backup device identity when present, and SpringBoard/Home Screen layout records before it supervises or restores anything. For encrypted backups, also pass `-- --password ...` or set `IOS_BACKUP_PASSWORD`.

Remote MDM is a separate integration boundary. The layout-preserving USB flow ends with the static Vigil profile installed locally; it does not set up remote APNs-backed MDM by itself.

Real iOS MDM enrollment requires Apple supervision plus a public HTTPS URL, an APNs MDM topic and push certificate, and an identity certificate or SCEP payload. The current server handles enrollment/check-in, queues policy-profile installs for enrolled devices, and uses the saved APNs MDM push certificate to wake devices with queued commands. On first enrollment, the device's TokenUpdate queues the current policy and immediately attempts the APNs wake-up; later policy changes follow the same queue-and-push flow.

Phone usage can be synced into the same dashboard totals by posting daily snapshots to `/api/devices/usage` with the local app intent header or the iOS device token (`x-vigil-device-token` header or `?token=` query). A snapshot such as `{ "device": "phone", "date": "2026-05-28", "totalSeconds": 3600, "apps": { "Instagram": 1200 }, "sites": { "reddit.com": 300 } }` replaces the phone bucket for that day, then dashboard summaries, weekly reports, and limit progress merge it with Mac usage.

Apple reality check for Instagram Reels: public iOS APIs can shield whole apps, web domains, and supervised web content, but they do not let Vigil inspect or rewrite the official Instagram app's internal Reels screen. Reels-only filtering on Apple platforms must therefore happen in browser/Safari-extension or controlled-web-app flows unless Apple or Meta exposes a native app-level content control. When Phone Soft Block is active, Vigil leaves the native Instagram app unblocked for notifications, adds Reels URL denials to managed web, and installs a "Vigil Instagram" managed web clip that can be used as the target for an iOS Shortcuts automation that redirects Instagram opens into the filtered web experience.

## Tests

```sh
npm test
```

## Development

Vigil source is TypeScript. App, server, public UI, and extension code live as `.ts`; Node scripts and tests live as `.mts` so the compiled runtime keeps `.mjs` script entrypoints. `npm run build` writes runnable JavaScript to `dist/runtime`, and the normal npm commands build first before running the server, app, scripts, or tests. `npm run dev` watches the source tree and rebuilds before restarting the compiled server.

## Reality Check

No normal local app can be perfectly foolproof on an admin-owned Mac. A determined admin can stop processes, edit files, remove permissions, or boot another environment. The app is designed to make the helpful path easy and the impulsive path slower. For stronger guarantees, run daily work from a standard macOS account, keep admin credentials away from the desk, and use the doctor/Foolproof account check. The next milestones are:

- optional menu bar companion with hardened runtime
- signed/notarized releases
- optional DNS or router integration for Apple networks
- deeper iPhone/iPad companion flows through Apple Screen Time, Shortcuts, Safari extension, or managed-device profiles
