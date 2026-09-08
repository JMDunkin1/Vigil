# Intentional YouTube viewing

Status: implemented in source, with behavioral tests and simulator builds. Installation on live devices is a separate verified update transaction.

Implementation: `src/youtubeLimits.ts` owns the sealed daily ledger; the
`/api/extension/youtube` route serializes and persists actions before responding.
The shared `youtube-limits.js` player runs in the desktop extension, iPhone
companion, and Safari interaction extension. Desktop extension version 0.3.7 is
required. The tests cover slots, timing, renewal, grace, feeds, and authentication.

Phone builds receive a private `youtube-connection.json` resource through the
normal build/update wrapper. The authority generates its credential in the
private data directory and exposes only the authenticated YouTube route on
local-network port 8789. The default address is the Mac's `.local` hostname.
No paid membership, hosted service, App Group, or production entitlement is
required. The Mac must be awake and reachable; playback pauses when an existing
short authorization expires without renewal. Unsettled credit after a crash is
conservatively retained, up to the outstanding two-second reservation.

Release through `npm run agent:update`, then the independent
`npm run agent:update:youtube` transaction. The changed Safari extension is
packaged with Instagram and uses `npm run agent:update:instagram`, including
its existing offline Safari-extension maintenance checks. Do not bypass those
checks or install either app outside its app-and-policy transaction. Refresh
or install the packaged desktop extension as version 0.3.7. Direct Xcode builds
must provide `VIGIL_YOUTUBE_CONNECTION_FILE` or use the generated default resource;
the standard build wrapper provisions it automatically.

Current implementation choices: daily feeds use compact static title cards;
embedded players are stopped unless opened in the controlled top-level viewer;
existing stronger feature/content blocks still take precedence. Safari tracks external link navigation in extension-owned storage; ambiguous
entry provenance requires saving. Native iPhone link handoffs and desktop
external-link clicks have explicit external-entry grants.

## Daily experience

Show a small persistent summary: **Watch Later · 2 of 4 slots used** and
**Playback · 48 min of 2 hr**. Opening Watch Later shows exactly four slot
positions, with empty, saved, or locked states. Explain once: “You can replace a
saved video until you’ve watched more than 15 seconds. After that, its slot
stays used today.” Show precise time near a boundary instead of rounding into
an apparently premature block.

Home and Subscriptions each show a fixed daily selection of at most 20 videos.
Use static thumbnails and a “Save to Watch Later” action. Selecting a discovery
video opens its details and save action without starting media. Once saved,
show “Play” and “Remove”; replacement opens a picker containing only unlocked
slots. Saving never starts playback automatically.

After the last daily feed card, show exactly:

> You’ve reached today’s feed.

Search remains available, with the same save-before-play requirement. All
YouTube discovery routes, including channel pages, related videos, playlists,
and notifications, use that requirement so alternate routes cannot evade it.
Existing stricter content restrictions still apply; a daily allowance does not
re-enable a blocked feed or video.

## Four Watch Later slots

The quota belongs to the Vigil owner across devices, tabs, and YouTube accounts.
“Occupied” includes both a saved unlocked slot and any locked slot, including a
locked slot whose video was removed. Slot allocation and replacement are atomic.

| State | Visible content | Permitted actions | Quota effect |
| --- | --- | --- | --- |
| Empty | “Save a video” | Save | Available |
| Saved, unlocked | Video; “Replaceable” | Play, remove, replace | Occupied; removal releases it |
| Saved, locked | Video; “Used today” | Play, remove | Used until daily reset |
| Removed, locked | “Used today” | None | Used until daily reset |

Saving an already saved video is idempotent and never consumes another slot.
An unlocked slot becomes locked only when its video's cumulative actual
playback today is **strictly greater than 15 seconds**. Exactly 15 seconds is
still replaceable. Sum playback across starts, devices, and tabs; seeking,
reopening, removing, or replacing does not erase the video's daily history.
A short video that finishes at or below 15 seconds remains replaceable.

Removing a locked video hides its card but retains its slot and video identity.
Saving that same video again restores its original locked slot. It cannot
consume a second slot or release the first. Saving a video whose earlier
playback today already exceeded 15 seconds locks its slot immediately, including
earlier playback through an external link.

When a save would require a fifth slot:

- If at least one occupied slot is unlocked, show exactly:
  **“Watch Later is full. Replace an unwatched video to save this one.”**
- If all four slots are locked, show exactly:
  **“You’ve used all four Watch Later slots today.”**

For this required copy, “unwatched” means replaceable, including up to 15 seconds
of playback. Label those picker rows “Replaceable” to make the threshold clear.
Revalidate the selected slot when committing a replacement: if another device
has just locked it, preserve the original video and explain that the slot is
now used. Never remove the original unless the replacement succeeds.

Vigil's four-slot list is the playback authority. A larger existing YouTube
Watch Later playlist must not become an alternate playback gate. Integration
with YouTube's playlist must not delete unrelated existing entries.

## External links

A video received from outside YouTube may play directly after an explicit Play
action. It consumes playback time, including its first 15 seconds, but never
allocates a Watch Later slot. If already saved, its playback also advances that
video's slot-lock threshold. External Shorts remain blocked.

Bind an external-entry grant to the normalized video ID using a trusted native
link handoff or browser navigation provenance. A query parameter, absent
referrer, pasted URL, reload, or a YouTube-generated new tab is not proof of
external receipt. A genuine external entry remains valid for reopening that
same video during the day; it cannot authorize its recommendations or playlist
neighbors. Ambiguous entries offer saving instead of silently granting an
exemption. Validate the final video identity after redirects.

## Playback budget and grace

The daily allowance is **7,200 seconds of actual playback** across every
supported YouTube surface. Count foreground, background, muted, and fullscreen
playback whenever otherwise allowed. Exclude pauses, buffering, loading, and
seeking. Count elapsed playing time, not media position: 30 seconds at 2× speed
uses 30 seconds, and seeking forward an hour does not consume an hour.

At 7,200 seconds, atomically capture the currently playing video's identity and
enter grace with **1,200 playback seconds remaining**. If no video is playing,
there is no grace recipient. No new video may start, including an already saved
video or a fresh external link.

Show: **“You’ve reached 2 hours today. You can finish this video with up to
20 more minutes.”** During grace show its remaining playback time.

| Event during grace | Result |
| --- | --- |
| Continue current video | Deduct actual playback from the one shared remaining balance |
| Pause, buffer, close, crash, or reopen same video | Preserve identity and remaining balance; no refill |
| Move same video to another tab or device | Transfer playback ownership; retain the same balance |
| Request playback of a different video | End grace permanently for the day; deny the requested playback |
| Browse, search, or inspect another video's details without requesting playback | Preserve grace |
| Current video ends, or grace reaches zero | End grace permanently for the day |
| Replay after the video ends | Deny; finishing consumes the grace opportunity |

Show **“You’ve reached today’s watch time.”** after grace ends. At the budget
boundary, split a playback interval precisely between base time and grace;
never discard the excess or grant a new 20 minutes after each reconnect.
Seeking within the current video does not reset grace. A livestream without a
natural end stops when grace expires. If the video ends exactly at 7,200
seconds, it is already finished and cannot receive replay grace.

Proposed concurrency rule: one active YouTube playback owner at a time across
devices and tabs. An explicit handoff pauses the prior owner before the next
starts. This gives “the current video” one unambiguous identity at the limit
and prevents concurrent players from overspending a shared allowance.

## Daily feeds and reset

Persist separate ordered ID sets for Home and Subscriptions under the same
daily owner record. Freeze each set on its first successful load using the
first 20 eligible unique ordinary videos, or fewer if fewer are available.
Commit the snapshot before showing its cards. A failed load does not commit
an empty day. Concurrent initial loads accept only the first committed set.

Reloads, app restarts, account changes, and other devices use the same IDs and
order. Do not append, rotate, refill, or replace deleted/unavailable cards that
day. An unavailable card may show a placeholder. A video can belong to both
sets; each feed has its own 20-video limit. Disable continuation loading and
pull-to-refresh replacement, not just the visual scrollbar. Other feeds cannot
act as alternate Home or Subscriptions pagination.

Use the owner's configured Vigil timezone and an authority-issued calendar-day
ID. Proposed reset: midnight in that timezone; timezone/device-clock changes
must not create extra resets. The next day gets four empty slots, fresh feed
sets, zero base time, and no inherited grace. Keep yesterday's list available
as read-only history with an explicit “Save for today” action; no automatic
slot allocation or playback. A video still playing at midnight must obtain the
new day's authorization; an internal video must be saved for today before it
continues. Never use reset as an autoplay trigger.

## Shared enforcement design

Use one durable, transactional owner ledger containing:

- Day ID, timezone, revision, and policy version.
- Four slot records: video ID, visibility, and irreversible daily lock flag.
- Per-video accumulated playback, retained after removal or replacement.
- Base playback milliseconds; grace status (`not_started`, `active`, `ended`),
  video ID, and remaining milliseconds.
- Frozen Home and Subscriptions ID arrays with initialization status.
- External-entry grants, active playback owner, and deduplicated event sequences.

All clients request save, replacement, playback start, ownership transfer, and
playback settlement through the authority. Serialize mutations, persist before
acknowledging, and make retries idempotent. Page scripts render the ledger and
report media state; DOM state, local storage, and the YouTube account are not
the source of truth. The native/browser controller must reject a start before
media becomes audible or visible, including SPA navigation and new players.

Use bounded playback authorizations backed by durably reserved time. The
controller stops at their playback limit, reports elapsed playing time using a
monotonic clock, and settles each authorization once. Reserve against both the
base budget and grace, splitting at their boundary. An unsettled reservation
cannot be reissued to another client; reconciliation can release proven unused
time. This bounds loss and prevents a crash/reconnect from duplicating credit.
Slot threshold updates and time settlement belong in the same transaction.

The design requires an authenticated shared authority reachable by every
participating device. A user-owned local Vigil host is the proposed free path;
remote connectivity must be validated before promising use away from home.
Do not assume iCloud/App Groups/paid entitlements provide this authority, invent
a service endpoint, or require a developer subscription.

When disconnected, finish only an already authorized bounded playback segment,
then pause until synchronization returns. Do not issue independent offline
budgets, grant external exemptions, allocate slots, or finalize replacement
locally. Explain: **“Connect to Vigil to continue watching.”** Cached daily feed
cards and saved-list details can remain visible. Strict shared limits and
unrestricted offline playback cannot both be guaranteed by this design.

## Permanent media controls

Keep Shorts removed from navigation, cards, search results, direct URLs, and
embedded surfaces. Disable hover/feed previews, muted inline playback,
next-video autoplay, playlist advancement, end-screen automatic starts, and
automatic playback after navigation everywhere. Every start requires an
explicit action plus authorization. Keep ordinary controls available for
authorized playback. Existing content-safety checks, supervised policy,
watchdogs, authentication exclusions, and availability protections stay in force.

## Repository integration and completion criteria

Implement the ledger and policy transitions in the local service/store, with
authenticated clients for desktop extension and Personal Team iPhone companion.
Wire desktop interception through `extension/content.ts` and
`extension/background.ts`; integrate the native companion's media and navigation
guards through `ios/VigilSocial/VigilSocial/DOMAdapters.swift` and its web-view
controller. Audit the Safari interaction path in
`ios/VigilSocial/VigilYouTubeInteractionExtension/Resources/youtube-parity.js`
as well. A surface without reliable authorization and accounting must not be
reported as covered. Update the parity contract when enforcement is implemented.

Required acceptance cases before reporting enforcement complete:

1. Four saves succeed; a fifth shows the exact replace message. All four locked
   produces the exact used-slots message. Duplicate saves consume one slot.
2. Removal/replacement works at 0 and exactly 15 seconds. At 15.001 seconds,
   removal or completion cannot release the slot. Two plays of 8 seconds lock
   it, including across removal/re-save and devices.
3. Concurrent saves/replacements cannot allocate a fifth slot or replace a slot
   locked by concurrent playback. Re-saving a removed locked video restores it.
4. Search, Home, Subscriptions, other discovery, new tabs, and playlist
   neighbors cannot start unsaved. Verified external links can; URL spoofing
   and missing-referrer navigation cannot create external grants.
5. The first 15 seconds count. Pauses/buffering/seeks do not. Playback-rate
   changes, muted playback, and background playback use real playing time.
6. At 7,200 seconds only the captured current video can continue. It stops at
   natural completion or 1,200 additional seconds, whichever occurs first.
7. Pause/reopen/reload/crash/handoff retains remaining grace; requesting another
   video ends it. Ending, replaying, and external links cannot restart grace.
8. Duplicate/out-of-order settlements, reconnects, process restarts, concurrent
   tabs, and authority failure cannot duplicate time or playback ownership.
9. Both feeds retain at most 20 IDs independently through reload, restart,
   account changes, and cross-device access. No infinite scroll or refill;
   each ends with the exact feed message.
10. Midnight, clock rollback, timezone changes, and playback spanning reset
    produce exactly one new daily ledger and require fresh authorization.
11. Preview/autoplay attempts, SPA transitions, fullscreen, and embeds never
    bypass authorization; Shorts and existing stronger policies remain blocked.
12. Validate on desktop and a connected paired Personal Team iPhone. Any later
    companion deployment uses the verified `npm run agent:update:youtube`
    app-and-policy transaction, with no supervision/layout restore changes.
