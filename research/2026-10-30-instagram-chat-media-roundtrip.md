# Chat media disappearing after opening a photo — October 30, 2026

The earlier change cleared viewer concealment markers but did not establish
which DOM surface actually owned an incoming media route. Its test used a
non-playable video and checked visibility after cleanup, missing both the
transient disappearance and the lasting playback damage.

The new maintained WebKit regression reproduces the failure against the
pre-change adapter saved from commit `20f141d`. It runs the production reference
search guard, item guard, startup styles, compatibility script, and stable
adapter together with two actual H.264 Reel players and their poster images.
When History commits `/p/Photo123/` before the viewer mounts, `rememberShare()`
replaced the clicked origin with `null`. The item guard then accepted Direct's
retained dialog as the photo viewer. Other orderings promoted the document
itself when the viewer had closed but History still held the media URL.
The guard hid and paused the unrelated chat players. Clearing CSS labels later
could restore an image, but could not undo the playback/framework side effects.

The fix preserves the activation origin and chat boundary across the History
wrapper. The retained chat cannot be accepted as a media modal, and the guard
waits for the actual portal rather than classifying the document during mount
and dismissal gaps. Item navigation and native gesture containment remain
active while the media portal is pending; media classification requires an
owned concealment scope. A complete document replacement still uses normal
page classification once the original chat nodes have departed.

A separate rendering starvation bug was also found in the production audio
compatibility path. With sound disabled, setting `defaultMuted = true` on every
observed `muted` mutation generated another mutation, even when already true.
Mute synchronization now changes the property only when its value differs.
The sound-disabled cases exercise this path with real players, rather than
substituting mocked media properties.

Run `node scripts/test-instagram-chat-media-webkit.mjs` from the repository root.
An optional adapter-source path permits baseline checks. The shared HTML lives
in `VigilSocialTests.instagramChatMediaRoundtripHTML`; the iOS XCTest uses the
actual production document-start/end installation and generates its own video.
The desktop WebKit runner uses a locally generated, silent, 64×64 H.264 fixture
at `tests/fixtures/instagram-chat-reel.mp4`. Its 60 frames have a known changing
color, allowing tests to read decoded video pixels and verify advancing time.
No remote website, account, or remote media is used.

Validation:

- Sixteen WebKit cases cover URL-first, portal-first, unchanged Direct URLs,
  chat changes, sound enabled/disabled, and threads with/without dialog roles.
  Each repeats the roundtrip three times. Every transition/frame and pause
  event audits both players, their posters, and the photo thumbnail. Real
  decoded colors and advancing playback are checked after dismissal.
- Unselected media inside the viewer remains concealed. Wheel input and
  navigation to another Reel remain contained while the photo is open.
- The same maintained test fails against the previous adapter with both chat
  players hidden and paused before the photo portal even mounts.
- The nine existing Send/dismissal WebKit containment cases pass.
- Runtime build, lint, and nine reference/friendship/container/route test cases
  pass. The isolated fix also compiles the native iOS app and test target.
  Final isolation excluded concurrent notification and comments edits from
  other work in the shared checkout.
- Physical iPhone execution has not been verified. Deployment remains deferred
  under the user's earlier preference; use the normal combined
  `npm run agent:update:social` transaction when requested.

Logs: `data/instagram-chat-media-after.log`,
`data/instagram-chat-media-baseline-reproduced.log`,
`data/instagram-chat-media-send-regression.log`,
`data/instagram-chat-media-policy-tests.log`,
`data/instagram-chat-media-isolated-compile.log`, and
`data/instagram-chat-media-isolated-webkit.log`.

No enforcement, watchdog, supervision, signing, or phone-policy changes were
made for this fix. Concurrent work in other source areas is outside this change.
