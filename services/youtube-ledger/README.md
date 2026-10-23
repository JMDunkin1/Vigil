# Shared YouTube allowance — prepared, not deployed

This service keeps the existing four-slot, 120-minute and single-video 20-minute overtime rules in one authority. The phone app, phone Safari and Mac contact it directly. It does not require the Mac to stay online. There is no configured endpoint or cloud credential in this checkout, and no device has been switched to this service.

## Prepared implementation

`src/youtubeSharedWorker.ts` runs the existing `youtubeAction` engine inside one named SQLite Durable Object storage transaction. A response grants nothing until its write succeeds. Concurrent saves cannot allocate a fifth slot. Status and rejected/no-op requests do not rewrite storage. There is no reset endpoint, deletion endpoint, or empty-ledger fallback. HTTPS, a private 256-bit bearer credential, bounded bodies, no redirects and no response caching are required. Native/browser page code never receives the service credential.

The Mac relay and both native phone containers support an optional `shared` connection. Once established, the Mac's existing state seal protects the authority selection: losing the configuration fails closed instead of silently reverting to the older independent allowance. The phone's signed configuration has the same no-fallback behavior. An Internet/service outage pauses playback until the shared authority is reachable; it does not issue an independent offline bucket.

Cloudflare currently includes SQLite Durable Objects on its Workers Free plan. Exceeding free limits produces errors instead of charges on that plan. Do not upgrade the account as part of activation. Sources: [pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), [transactions](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).

## Activation prerequisites — deliberately not performed

1. Obtain actual deployment access to a Workers Free account. Use the checked-in Wrangler configuration; do not invent a service URL.
2. Pause YouTube on all surfaces. Export and validate all three protected current ledgers: Mac state, iOS app container and iOS Safari extension container. Preserve originals and verify their hashes. A missing export is a blocker, never an empty ledger.
3. Run the compiled `scripts/prepare-youtube-shared-ledger.mjs` with those three export paths and a new private output directory. It archives originals and emits `seed.json` plus hashes. It combines consumed time conservatively, deduplicates saved IDs, preserves locks, and exhausts all four slots if the previous independent ledgers already contain more than four unique selections. Review that conflict before activation. Backups retain all original selections. The script never changes live state or deploys anything.
4. Set Worker secrets `LEDGER_TOKEN` (32 random bytes encoded as 64 hex characters) and `LEDGER_SEED_JSON` (the verified seed). They must stay out of source, logs, shell arguments and URLs. Deploy only after the user authorizes deployment. The durable state ignores seed changes after initialization.
5. Verify the actual authenticated endpoint, concurrency, existing usage and restart persistence. Write the real endpoint and credential to the active data directory's private `youtube-shared-connection.json` as `{"endpoint":"<actual HTTPS origin>/api/youtube","token":"<secret>"}`. No template URL may be used as a running configuration.
6. Complete supported verified Mac and combined phone app-and-policy updates. Verify that Mac, app and Safari all see the same day/slots/time, reject save five, and retain policy supervision, extensions and companion launches. Do not claim sharing is active before these checks pass.

Before activation, retain a secure backup/recovery plan for durable state and credentials. Never remove a pinned authority or replace an unreadable durable ledger with an empty one to restore access.

## Alternative investigated: use the YouTube account itself

The user's metadata idea is plausible with the official API, but not directly with Watch Later:

- YouTube explicitly rejects official API reads of Watch Later with `watchLaterNotAccessible`. Existing web-page membership checks do not make that API available. [PlaylistItems.list](https://developers.google.com/youtube/data/reference/rest/v3/playlistItems/list)
- A separate private playlist has editable description metadata. An individual ordinary playlist item also supports a 280-character note. A compact day-and-four-slots record could fit, without changing video titles. [Playlists.update](https://developers.google.com/youtube/data/reference/rest/v3/playlists/update), [PlaylistItems](https://developers.google.com/youtube/data/reference/rest/v3/playlistItems)
- Google documents ETags and `If-Match` to reject updates based on an old version. That means the earlier assumption that YouTube cannot provide conflict protection was too broad. Read the fixed private ledger resource, compute the change, update with its exact ETag, and retry after a conflict. Reserve a slot before allowing YouTube's normal Watch Later save. [ETag overwrite protection](https://developers.google.com/youtube/data/getting-started#using-etags)
- This needs a real Google Cloud API project and supported OAuth authorization on each surface. A YouTube website login alone is not an API credential. All surfaces must use the same fixed ledger/account, with a protected identity pin; switching accounts, deleting metadata, or a failed read must not create a fresh bucket. Bootstrap must provision one fixed playlist ID rather than racing to create daily playlists. [Setup and authorization](https://developers.google.com/youtube/data/getting-started)
- A playlist update costs 50 quota units. A handful of daily save/lock changes is plausible; writing every playback lease would be impractical. This option should synchronize saves only, retaining local playback clocks. A live OAuth prototype must demonstrate conflict rejection and persistence across app/Safari/Mac before adoption. [Update quota](https://developers.google.com/youtube/data/reference/rest/v3/playlists/update)

No Google Cloud project, OAuth application or private playlist was created, and no live API authorization or conflict test was performed. The account-only option is researched, not proven or enabled. It avoids separate hosting, but still relies on Google's online API and has more authorization and account-identity work than the prepared standalone ledger.
