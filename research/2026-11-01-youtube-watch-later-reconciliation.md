# Shared Watch Later selections through the YouTube account

Safari on Mac, Safari on iPhone, and Vigil's built-in YouTube browser now reconcile the same signed-in YouTube Watch Later playlist. This path uses the account's existing playlist, the existing companion transport, and the existing local policy engine. It requires no new server, paid membership, account API credentials, or signing entitlement.

## Behavior

- Read a fresh complete playlist on opening YouTube, changing routes, returning focus/visibility, idle allowance polling, and before a native save. Confirm the account change after the native save/remove control runs. Overlapping reads in one document share a request.
- Import newly observed account saves into the existing four-slot daily ledger before accepting another native save. First reconciliation conservatively counts existing playlist members against the current day, while preserving existing local slots, playback totals, completion, and grace state.
- Keep one checkpoint containing a hash of the account/channel identity and the current playlist's video IDs, capped at 5,000 entries. Replace it rather than appending a history. Retain it across midnight so unchanged old entries and reordered lists do not count as new saves. Metadata in a reconciliation request is limited to the four candidates plus the current day's slots/current video.
- Bind each ledger to its original account/channel. A different account does not produce a new allowance. All three surfaces need to be signed into the same YouTube account/channel.
- Fetch outside HTTP caches. Read only the playlist renderer and its continuations, excluding recommendations. Reject signed-out pages, unknown shapes, malformed/duplicate entries, cyclic or failed/incomplete pagination, stale checkpoint revisions, and snapshots crossing midnight. Verification failures cannot approve new saves or replace the checkpoint.
- Preserve local used slots when an entry disappears remotely. Native local removal retains the existing rule: unwatched slots can be released, while slots watched beyond fifteen seconds stay consumed. An observed overflow saturates new saves until the next day even if entries are subsequently removed. Existing permitted playback can start without waiting behind a slow account request.

## Limits

This is account snapshot reconciliation, not a transactional shared daily ledger. Simultaneous saves on different installations can still race. A video saved and removed elsewhere before another surface checks is absent from that surface's evidence. Watch time and completion remain local; this change does not claim to synchronize them through YouTube. Additions made during multiple missed days are conservatively counted when next observed, because Watch Later does not supply a verified per-day event log here. Remote removals do not automatically refund local reservations.

The checkpoint stores only the latest playlist membership, not a permanent save history. It does not prune or delete the user's actual YouTube playlist. A prepared optional shared authority remains supported and cannot silently fall back to independent local allowances.

## Validation

Tests exercise alternating saves across three independent ledgers, import of existing saves, local usage/completion preservation, restart and midnight behavior, reordering, overflow, account mismatch, malformed/stale/incomplete snapshots, complete pagination, exclusion of recommendations, HTTP cache policy, homepage/focus refresh, a remote fourth save blocking a local fifth, network failure, bundled phone-engine persistence, and the bounded optional shared-authority transport. Existing YouTube playback, direct-link, feed, completion, and phone-suite regression checks remain applicable.
