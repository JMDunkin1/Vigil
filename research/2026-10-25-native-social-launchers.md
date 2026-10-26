# Native social launchers

The Home Screen Instagram, YouTube and Snapchat icons used Shortcuts' URL/Open URLs actions. Shortcuts attributed these to Safari; an unavailable or stale app association could display Apple's placeholder icon in its Dynamic Island completion indicator.

Vigil now exposes `OpenVigilServiceIntent` and an App Shortcut with a preset for each of its eight services. The foreground action queues its selected service until the app's view can consume it, then uses the existing `SocialContainerStore.open` path. Migration readiness, fixed-service scope, commitments, system web policy and playback limits remain in that path. No new entitlements or paid services are needed.

The three existing shortcuts were edited in place on the iPhone to contain only **Open [service] in Vigil**. Their original workflow identifiers and Home Screen icons were preserved. All three now associate their icon with the installed Vigil bundle. Temporary trial shortcuts were removed.

Apple controls Shortcuts' Dynamic Island indicator. This change removes Safari and stale-app attribution; it does not claim an unsupported switch to suppress system indicators.

For future Home Screen launchers, use the native Vigil action. For existing icons, edit the original shortcut instead of importing a replacement: iCloud replacement can create a new workflow identifier and retain a renamed original. Do not change the supervised policy or use Web Clips to alter this cosmetic behavior.

Validation:

- Five focused iOS simulator tests passed: cold launch request retention/session reuse, commitment and fixed-service rejection, the existing Apps quick action, restricted-link rejection and launch handoff behavior.
- Installed with `npm run agent:update:social`: Personal release 0.3.216 (219). The transaction verified the exact supervised policy and all eight service launches, including the four required companions.
- Read-only verification of the synced shortcut records confirmed one native Vigil action per shortcut, the correct service parameter, the Vigil app association and all three original workflow identifiers.
- Instagram and Snapchat were opened from their existing Home Screen icons and reached their expected interfaces. YouTube selected its expected service; a separate page-readiness error was observed during the live check.
- Phone maintenance/build, renewal, marketplace print policy, query parsing, media catalog, broadened-search, browser parity and iOS Safari guard regressions passed in focused runs.
- Final `npm run check`: source lint/build passed and 230 of 231 runtime suites passed. `adversarial-search-policy` exceeded its native helper timeout, matching the separately documented existing adversarial-suite limitation in the print/poster audit. The earlier run overlapped parallel work and was superseded by this stable rerun.
- Final `npm run ios:phone:check` reports `Status: current`, matching installed and expected app versions and the exact live policy fingerprint.
