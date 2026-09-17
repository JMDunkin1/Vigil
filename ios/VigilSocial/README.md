# Vigil Social

The phone release contains Instagram, YouTube, Snapchat, and LinkedIn in one
Personal Team app. Each service retains its fixed `SocialWebViewStore`, DOM
adapters, navigation rules, media controls, and persistent page instance.
There is no floating home button: double-tap with three fingers to open the
picker. The accessibility action **Return to apps** provides an alternative
when an accessibility feature reserves that gesture.

Home Screen shortcuts can use the **Open URLs** action with:

- `vigilsocial://instagram`
- `vigilsocial://youtube`
- `vigilsocial://snapchat`
- `vigilsocial://linkedin`
- `vigilsocial://home`

A service shortcut resumes its page; it does not reset navigation or usage.
Only these four compiled services are supported. Add future services through
the service registry and its policy, storage, build, and migration tests.

## Build and update

`npm run ios:social:build -- all --unsigned --destination 'generic/platform=iOS Simulator'`
builds the combined shell. The old single-service build targets remain for
regression testing. The installed release uses `VigilInstagram` as its build
target and `tech.caseline.vigil.instagram` as its bundle ID, preserving the
existing Safari extension identities.

`npm run agent:update:social` runs the verified phone transaction. The legacy
per-service update commands point at the same combined app. The installed Mac
runtime must support `socialContainer` before the first phone migration.

Before first migration, the updater archives installed companion data under
`data/ios-social-migrations/` in a private directory, with a file hash manifest.
It copies and reads back the original YouTube ledger without resetting it.
Conflicting existing ledgers stop migration. Instagram retains its data in
place. The other services have new isolated WebKit stores and may require
signing in again; their old containers stay archived. Archives contain private
session data and must never be committed or uploaded.

The new shell stays behind a migration screen until ledger transfer and the
exact live policy installation have completed. Separate companions are only
removed after all four direct launch routes and their WebKit access checks
succeed. An unavailable phone, failed login/access check, or failed policy
verification leaves migration incomplete and keeps the separate companions.

## Restrictions

Full Brick and Panic block the combined binary. Individual legacy companion
app blocks become service-domain blocks in Apple's supervised BuiltIn web
filter, while priority deny rules and existing content adapters remain active.
A foreground WebKit HEAD probe, isolated from page scripts, checks access on
entry and every five seconds so cached pages do not remain usable indefinitely
after a policy change. An unverifiable connection closes that service until it
can confirm access again. These checks need live device verification; simulator
tests cannot prove Apple's supervised filtering behavior.

The combined mode cannot be switched off by an unrelated settings edit, and
requires both app and web restrictions. App-only installs are not supported.
