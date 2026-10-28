# Phone and Mac performance/resource audit — October 28, 2026

The audit found five avoidable costs in the phone code and fixed them. It covered the eight combined-app services: Instagram, YouTube, Snapchat, LinkedIn, Facebook, X, TikTok, and Reddit. Mac startup, hidden-window behavior, dashboard refresh, policy evaluation, and persistence were also reviewed. No Mac implementation change was justified by the evidence collected.

## Changes

| Area | Finding | Change |
| --- | --- | --- |
| Picker and launch artwork | SwiftUI body evaluation reopened PNGs, including 1024px artwork displayed at 104pt or smaller. The home view updates every second. | Decode display-sized thumbnails once and reuse them in a count/cost-limited `NSCache`. The same cache serves launch covers and can be reclaimed under memory pressure. |
| YouTube native UI | The external-playback monitor republished unchanged availability every 200ms, invalidating SwiftUI during steady playback. | Publish only availability transitions. Sampling, WebKit permission updates, authorization, and revocation checks retain their existing cadence. |
| Live access probes | A fallback GET fetched a social document solely to check its response headers but left the response body downloading. | Cancel the unused body immediately after validating status and exact response URL. Cancellation does not delay or determine the policy decision. |
| Native text policy | Each opened service/account could separately read and compile the same immutable bundled policy. | Share one lazily initialized compiled classifier per process. Injected test policies remain independent; unavailable policy still fails closed. |
| Shared YouTube transport | Each shared-authority request created and invalidated an ephemeral URLSession. | Reuse a session in each app/extension process. Disable response caching, cookie storage, cookie setting, and credential storage; retain the redirect guard and fresh authenticated requests. The local ledger is still read and durably written as before. |

## Measured artwork footprint

Using ImageIO on the actual eight source PNGs, at a 3× display scale:

- Full-resolution decoded image payload: **9,696,384 bytes**.
- Display-sized decoded thumbnails: **2,086,528 bytes**.
- Reduction: **78.5%** for the artwork payload, approximately 7.3 MiB.

This is an image-payload measurement, not a claim that whole-app RAM falls by 78.5%. Reusing decoded images also removes repeated image creation during picker/splash updates. Cache limits are eight entries and a 4 MiB cost budget; `NSCache` limits are advisory and allow eviction.

## Existing efficient behavior retained

- The combined picker creates no website engines until a service is opened. Switching reuses the existing service engine, page, history, and login container.
- Hidden services pause media, and their foreground access-poll tasks stop. Permitted YouTube background playback retains its separate live policy and credit checks.
- Native media classification already bounds concurrent work, pending work, retries, and deadlines. The phone blocklist uses a mapped compact index rather than expanding the full list into individual strings.
- The Mac monitor is event driven, with coalesced usage checkpoints and bounded full persistence. The renderer throttles in the background, and dashboard presentation polling stops while hidden.
- A short process sample showed low Mac CPU consumption; this was a spot check, not a controlled before/after CPU or leak benchmark.
- The workspace's roughly 148 GiB `data` directory was dominated by approximately 106 GiB of supervision/layout checkpoints and 33 GiB of phone build artifacts. These development/recovery files are distinct from the installed app's working set. No checkpoint, container backup, or migration record was removed.

## Validation and limits

The TypeScript/runtime build and ten selected runtime suites passed: runtime efficiency, disk I/O efficiency, dashboard refresh, usage timeline efficiency, policy target efficiency, combined social container, social route boundaries, phone browser guards, local YouTube ledger, and phone resource graph.

All **nine selected native tests passed** on a dedicated iOS 27 simulator using Xcode 27.1. They cover decoded image reuse and resource bounds across all eight service names, unchanged playback samples without view invalidations, immediate publication of revocations, cache-free shared transport configuration, isolated/fail-closed access checks, fallback response cancellation, eight retained service engines, cached-service viewport stability, and text-classifier fail-closed behavior. The first artwork fixture assumed the standalone test host bundled all eight icons; it was corrected to supply the two combined-app-only images in an isolated fixture bundle.

The **combined iPhone Release build also passed**, unsigned, with the repository builder's `all` configuration and matching app/extension identifiers. Its bundled `VigilService` value was verified as `all`. This was build validation only, without installation or policy mutation.

This pass does not establish real-device cold-launch times, frame-rate percentiles, GPU energy consumption, battery savings, or whole-app RAM deltas. Third-party network latency, authentication, and page implementations still affect startup and navigation. Retaining opened web sessions deliberately trades memory for fast switching and preservation of in-progress pages. Simulator runs also emit an existing SDK warning about synchronous audio-session transitions; no controlled trace established a user-visible stall, and their enforcement-sensitive ordering was preserved.

All changes are source changes. No phone installation, policy transaction, supervision operation, live Mac update, or deployment was performed as part of this audit. Existing unrelated working-tree edits were preserved.
