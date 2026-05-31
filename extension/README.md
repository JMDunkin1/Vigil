# Local Screen Time Companion Extension

This optional unpacked browser extension gives the local app faster tab-level blocking than AppleScript polling alone.

## Install

1. Keep the local server running with `npm start`.
2. Open your Chromium browser's extensions page:
   - Chrome: `chrome://extensions`
   - Brave: `brave://extensions`
   - Edge: `edge://extensions`
   - Arc: open Chrome Extensions from Arc settings
3. Enable developer mode.
4. Choose Load unpacked and select this `extension` folder.

When the local app changes, reload this unpacked extension so its version matches the dashboard's required companion version.

The extension checks each tab against `http://127.0.0.1:8787` on this Mac. It uses the same profiles, strict sessions, schedules, App Locks, Time Limits, and Open Limits as the dashboard. It also sends active-tab pulses so browser time limits can work even when AppleScript URL access is unavailable.

It also keeps Chrome dynamic network rules synced for currently blocked domains, safe profile URL patterns, and active allowlist sessions such as Mac Brick, then reports the installed rule count back to the local app so Foolproof mode can detect stale or failed syncs.

When Browser cleanup is enabled in the dashboard, the extension also installs local dynamic request rules for common ad/tracker/noise domains and hides common cookie prompts and social widgets on the page.
