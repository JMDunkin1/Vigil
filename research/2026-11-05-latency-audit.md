# Vigil latency audit — November 5, 2026

The measured improvement is in shared text classification and browser media scanning. On the approximately 6,400-element native WebKit fixture, a complete health scan takes about **24 ms instead of 36 ms**, saving approximately **12 ms (33%)**. These are fixture measurements, not real-page or iPhone interaction percentiles.

## Scope and changes

Reviewed Mac foreground/browser observation, immediate redirects, policy checks, extension request handling, shared browser scanners, dashboard transport/refresh/diagnostics, sealed persistence, phone service access and media classification. Read the earlier October 28 resource and October 31 Safari audits before changing anything. Preserved the pre-existing working-tree edits, including Instagram story/inbox work, phone release metadata, defaults and their tests.

The CPU profile of the browser fixture identified repeated normalization and classification work alongside DOM inspection. Changes:

- `src/explicitMediaContext.ts`: ordinary ASCII text avoids per-letter Unicode decomposition. Non-ASCII input retains Latin-only accent folding, Japanese voicing marks, Korean syllables, Arabic normalization, invisible-character handling and mixed-script checks.
- The contextual classifier reuses its normalized input for keyword membership and phrase checks. Previously an ordinary decision normalized the same text twice.
- Additional explicit keywords use one process-local `Set`, replacing construction and search of a complete keyword array for every token. This is immutable built-in vocabulary; no live policy decision is cached.
- The shared media guard gives its mixed-platform and general inspectors the same complete element enumeration. Both inspectors still run; each full health check enumerates the document once instead of twice. New shadow roots still join the current inspection pass.
- Label construction avoids unnecessary mapping, empty label-reference parsing and intermediate child-node arrays. All text, accessible labels, form labels, attributes and direct text are still inspected.
- Regenerated the shared Chrome/Safari guard resources using the normal build. No handwritten edits were made to generated matcher sections.

No enforcement delay, watchdog, lease, live phone access check, policy fingerprint, protected transaction, restriction, heartbeat or scan cadence was relaxed. The change adds no policy-result cache and does not defer unsafe interactions to a later scan.

## Measurements

### Native WebKit

Desktop (`www.youtube.com`) and mobile (`m.youtube.com`) layouts load local HTML with a YouTube base URL and the production media guard. Each page has 100 cards, approximately 6,400 elements and ordinary astronomy labels. Each measured batch invokes five complete focus/health checks. Two batches warm the engine; eleven batches supply the median. Runs were ordered baseline, updated, updated, baseline. Measurements divide batch duration by five, so these are batch-mean scan durations, not individual-request percentiles.

| Layout | Baseline median, two runs | Updated median, two runs | Saved per scan |
| --- | --- | --- | --- |
| Desktop | 35.8 / 35.8 ms | 24.4 / 24.0 ms | 11.4–11.8 ms |
| Mobile layout | 36.0 / 36.0 ms | 24.4 / 24.2 ms | 11.6–11.8 ms |

Across each run's 65 checks, contextual classifications remain **6,565** for both implementations. Complete element enumerations fall from **130 to 65**. The deterministic count reduction concerns duplicate enumeration, not omission of either inspection. The original and updated guards pass the expanded native enforcement fixture.

The normal checked-in fixture can be compiled and run with:

```sh
xcrun swiftc tests/fixtures/youtube-media-performance.swift -o /tmp/vigil-media-performance -framework AppKit -framework WebKit
/tmp/vigil-media-performance ios/VigilSocial/VigilYouTubeInteractionExtension/Resources/media-child-lock.js
```

The repeated timing experiment used that same fixture with its five-check sample expanded to thirteen batches, discarding the first two; the baseline assertion expects two enumerations per check.

### Shared classifier

`tests/explicit-media-benchmark.mts` provides a reproducible benchmark and optional differential comparison. It performs two warmup batches and eleven measured batches, alternating old/new execution order. Each reported value is the median batch mean per classification, not an end-to-end interaction percentile.

| Input group | Baseline | Updated | Reduction |
| --- | --- | --- | --- |
| Short ordinary labels | 0.0433 ms | 0.0203 ms | 53% |
| Mixed existing policy corpus | 0.0548 ms | 0.0270 ms | 51% |
| A 30-line ordinary card label | 0.6799 ms | 0.2141 ms | 69% |

**34,272 comparisons** across eight public helpers produced identical baseline/current results. Inputs include the existing legitimate, explicit, adversarial and multilingual corpora, uppercase and decomposed forms, Latin accents, Cyrillic substitutions, combining marks, invisible characters and long ordinary text.

After building, run:

```sh
node dist/runtime/tests/explicit-media-benchmark.mjs
```

Pass the path to a standalone pre-change `explicitMediaContext.mjs` as the first argument to repeat the differential comparison and paired timings. The benchmark imports no production state, starts no server and performs no policy installation.

### Running Mac, read-only spot checks

Seven sequential HTTP requests per endpoint, consuming the full body, with the first reported separately from the six warm samples:

| Endpoint | First request | Warm median | Largest warm sample |
| --- | --- | --- | --- |
| `/api/health` | 40.3 ms | 1.61 ms | 3.58 ms |
| `/api/state` | 443.0 ms | 99.0 ms | 129.1 ms |

The dashboard response was approximately 366 KB. These measurements describe the installed runtime before this audit's source changes, include HTTP/body transfer and concurrent runtime activity, and do not isolate a cause for dashboard latency. The first dashboard sample may include diagnostic-cache misses; that is an inference, not a traced attribution. The native app normally also supports an in-process request bridge, so HTTP timing is not a measurement of its full UI path.

A process snapshot showed 0.0% CPU for the installed main app, helpers, renderer and human-idle helper at that instant. This is not an energy or sustained CPU benchmark.

## Remaining costs and choices

- **Dashboard:** roughly 99 ms warm HTTP response remains a measured cost. It assembles isolated state/usage snapshots, summaries, policy and hardening diagnostics. No snapshot isolation, diagnostic freshness or strict preflight check was weakened to shorten that number. Profiling the installed in-process dashboard path is needed before attributing or claiming a reduction here.
- **Browser observation:** immediate exact-tab redirects already bypass slow serialized monitor work. Observation uses a persistent native helper, event-driven wakes, shared in-flight probes and bounded catch-up. The existing timing bounds and target-atomic redirect checks were retained.
- **Persistence:** compact usage checkpoints and coalesced full snapshots already avoid repeated full writes. Durable admission/outbox ordering remains intact. This audit does not claim faster fsync or storage latency.
- **Phone access:** live policy-filtered WebKit HEAD/GET requests still require actual network results. Their 2-second/4-second deadlines are failure ceilings, not fixed sleeps on successful requests. Unused GET bodies are already cancelled. Cached authority or speculative access would change enforcement, so it was not introduced.
- **Phone media:** bounded classifier concurrency, deadlines, current-document/token checks, decode work off the main actor, retained service engines and shared compiled policy remain in place. No paid entitlement or alternate policy path was introduced.
- **iPhone:** CoreDevice lists the physical device as unavailable. No real-device cold-launch, network, playback, frame-time or battery measurement was possible. No phone installation, supervision, profile or layout operation was attempted.

## Validation

- TypeScript/runtime build, repository lint and whitespace checks pass.
- The full runtime run executed **251 suites**. Its initial results were 248 passes and three failures. The new efficiency test had an incorrect expected capitalization for ordinary words after fullwidth normalization; that test expectation was corrected, and the suite passes on rerun. No production semantic change was needed.
- The remaining two failures concern untouched existing workspace behavior: `ios-instagram-story-position.test.mts` expects a restore without the new fourth argument used by the pre-existing story edits; `safari-status.test.mts` omits the existing Watch Later control from its DOM fixture and throws before its status assertions. They are outside the latency changes and were left intact. The aggregate after the corrected-test rerun is **249 passing suites, two existing workspace failures**.
- Native WebKit desktop/mobile checks pass, including immediate changed-content clicks, split titles, external accessible/form labels, alt changes, new and changing shadow content, periodic full checks and safe neighboring content. Baseline and updated guards pass the same expanded fixture.
- Chromium's baseline profiling fixture completed. Subsequent Electron attempts failed with disposed/closed render targets before a valid updated result; no Chromium timing or updated Chromium pass is claimed. Live enforcement was not stopped or reconfigured to make the harness run.
- The new work-count regression requires one automatic normalization per ordinary contextual decision and zero ASCII diacritic decompositions, while checking that accented inputs still take the Unicode path.

## Installation

`npm run agent:update` returned a verified no-update result (`updated: false`, `noUpdate: true`). No main-app source installation is claimed.

`npm run agent:update:safari` built and installed the signed Mac Safari extension through the supported updater. The live Vigil connection was verified before installation. After installation, `/Applications/Vigil Safari.app` passed strict/deep signature verification and every canonical/manifest resource matched current source byte for byte. The installed guard also passed the native WebKit fixture. Existing Safari documents must reload to receive the new scripts. No Safari or Vigil process was terminated, and watchdog/enforcement policy remained online.

The standalone Mac runtime/Chrome source changes and phone resource changes remain in the working tree. The phone was unreachable, so no phone app-and-policy transaction or supervision operation occurred.
