# Vigil

A local-first focus enforcement app for this Mac. It borrows the strongest ideas from modern focus enforcement tools: desktop-controlled blocking, locked sessions, schedules, rehab mode, content filtering, usage reports, streaks, app limits, allow/block modes, emergency unlock limits, and optional tamper resistance.

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

The app works best after granting Accessibility permission to the terminal or app that runs it:

1. Open System Settings.
2. Go to Privacy & Security > Accessibility.
3. Enable your terminal app, Codex, or the future packaged app.

## What Works Now

- Local app views for focus, sleep, rehab, and Mac Brick sessions.
- Shift/Brick-style Mac Brick profile and one-tap strict commitment lock that allowlists only essential apps and approved work sites.
- Weekly Focus Report with focus score trends, streaks, saved-time projections, culprit apps/sites, and milestones.
- Strict sessions that cannot be ended early without spending an emergency unlock.
- Commitment locks for deep focus, rehab, or schedules that refuse ordinary emergency unlocks.
- Opal-style focus cycles with automatic work phases and short unblocked breaks.
- Freedom-style local focus sounds with brown-noise, rain, and ocean presets during active locks.
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
- Optional Android ADB companion blocking for selected phone packages during locks.
- Supervised iPhone profile generation for desktop-managed app and web restrictions.
- Experimental local iPhone MDM server scaffolding with enrollment profiles, check-in/connect endpoints, enrolled-device tracking, and queued InstallProfile policy refreshes.
- Optional unpacked browser extension companion for faster tab-level blocking and browser time-limit tracking.
- Browser extension dynamic block rules that redirect active blocked domains, safe URL patterns, and allowlist/Brick Mode misses at request time while acknowledging installed rule counts to Foolproof mode.
- Content feature filters that block short-form and infinite-scroll surfaces such as YouTube Shorts, Instagram Reels, Reddit Popular, X Explore, and TikTok during active locks.
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
- Optional hosts-file blocker preview/apply script for harder domain fallback blocking, including current blocklist sites, enabled app-lock sites, and safe host/path URL-pattern hosts.

## Hardening

Run this to install the app as a LaunchAgent:

```sh
npm run install:agent
```

You can also install the login agent from the Settings view. The LaunchAgent uses a runner process that waits when Vigil is already open and starts the local server if it goes down.

Run this to preview hosts-file rules. Path-only and keyword URL patterns stay in the browser extension, while host/path patterns such as `youtube.com/shorts` add their hostname to this harder fallback:

```sh
npm run hosts:preview
```

Run this to apply them. macOS will ask for your password because `/etc/hosts` is protected:

```sh
npm run hosts:apply
```

You can also apply the hosts block from the Settings view. The app will ask macOS for administrator approval and keeps the copyable Terminal command as a fallback.

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

To add the browser companion, load the `extension` folder as an unpacked extension in Chrome, Brave, Edge, or Arc while the local server is running.

## iPhone / MDM

The iPhone controls are modeled after desktop-owned phone blockers such as SHIFT: the Mac decides the policy, and the phone is only the managed endpoint. For a supervised iPhone, the Devices view can generate:

- a static restrictions profile at `/api/devices/ios/profile.mobileconfig`
- an experimental MDM enrollment profile at `/api/devices/ios/mdm/enrollment.mobileconfig`
- public MDM endpoints under `/mdm/enroll.mobileconfig`, `/mdm/checkin`, `/mdm/connect`, and `/mdm/policy.mobileconfig`

Real iOS MDM enrollment requires Apple supervision plus a public HTTPS URL, an APNs MDM topic/certificate, and an identity certificate or SCEP payload. The current server handles enrollment/check-in and queues policy-profile installs for enrolled devices; APNs push delivery is still the next piece needed for wireless wakeups after the phone is already enrolled.

## Tests

```sh
npm test
```

## Reality Check

No normal local app can be perfectly foolproof on an admin-owned Mac. A determined admin can stop processes, edit files, remove permissions, or boot another environment. The app is designed to make the helpful path easy and the impulsive path slower. For stronger guarantees, run daily work from a standard macOS account, keep admin credentials away from the desk, and use the doctor/Foolproof account check. The next milestones are:

- optional menu bar companion with hardened runtime
- signed/notarized releases
- optional DNS or router integration
- optional mobile companion through Android ADB or managed-device profiles
