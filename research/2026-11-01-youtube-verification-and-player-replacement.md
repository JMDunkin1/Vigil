# Watch Later verification and replacement-player playback

## Watch Later verification

Verification is automatic. Each surface must be signed into the same YouTube account/channel. Vigil reads the account's complete Watch Later playlist and establishes its existing protected checkpoint; there is no separate verification code, reset, or manual authorization flag.

A diagnostic against signed-in Safari reproduced the failure. The first `ytcfg.set(...)` call in the response sets the string-valued `EMERGENCY_BASE_URL`. The account's JSON bootstrap appears later. Reading only the first call therefore misidentified a signed-in account as missing login information. The reader now merges JSON object configuration calls and parses only the immediate argument, without searching ahead into another call or evaluating page code.

The actual playlist also wraps its next-page command in `commandExecutorCommand.commands`, alongside an unrelated voting-popup command. Only the continuation command is followed. Private continuation requests require the signed-in session proof used by YouTube's web client: the diagnostic received no playlist actions with cookies alone, and received an authenticated `WL` append action with the session proof. Continuation requests now include that proof and the selected account/channel headers. The proof and underlying cookie stay inside YouTube's origin and are never persisted or passed to Vigil's companion. Redirects remain disallowed.

Complete pagination, account binding, stale-revision checks, existing used slots, completion, time accounting, and failure behavior remain enforced. A successful retry now dismisses its own stale verification error without clearing unrelated notices.

## Replacement video players

The limiter previously continued tracking a removed video element until a replacement emitted Play. Its periodic cleanup could pause the new visible video while the old element remained outside the document and continued producing audio. Reassigning the tracked element in the Play handler also failed to pause its predecessor. Removed elements do not bubble subsequent Play events through the document.

The limiter now selects the visible primary player rather than a hidden preview, observes player ownership directly, pauses retired media, and transfers an existing explicit Play intent when YouTube replaces the player. Transfer retains the same bounded lease and cumulative metering. It cannot resume after Pause, transfer to a different video, extend an expired authorization, or bypass native frame/text classification. A late Play on removed media is paused directly, even outside the document.

## Validation

- Before the playback fix, two focused regression cases failed: replacement via Play left the removed player running, and replacement without an initial Play event left the visible player paused.
- All 167 YouTube tests passed after the fixes, including current bootstrap/pagination formats, session-proof hashing and account headers, automatic error recovery, player replacement, removal of orphan audio, explicit Pause, route changes, native fullscreen resume, classification holds, and cumulative time accounting.
- The four additional Safari resource, background-traffic, native-message, and extension-parity checks passed (171 tests total).
- The owned native WebKit fixture in `tests/fixtures/youtube-player-replacement.swift` passed with a local media file and the actual bundled policy engine. Replacement frames advanced, removed media stopped, detached replay was blocked, and a later replacement did not undo Pause. It performs no network requests and does not use the installed Vigil service or a phone.
- Build, lint, and whitespace checks passed. No installed app or phone update was performed; deployment is deferred at the user's request.
