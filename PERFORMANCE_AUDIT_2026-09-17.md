# Vigil performance and correctness audit — September 17, 2026

The audit focused on avoidable CPU work, memory retention, browser rendering,
disk activity, and correctness while retaining Vigil's enforcement checks.
Existing workspace edits were preserved. This task did not run an installed-app
update, change phone supervision, or terminate Vigil.

## Fixes

| Area | Finding and change |
| --- | --- |
| Policy matching | Membership checks expanded, deduplicated, and sorted entire app/site target lists. They now stop when a matching target or alias is found, without caching mutable policy inputs. URL patterns are normalized once per check. |
| Domain matching | A terminal DNS dot could prevent a blocked domain or `.xxx` suffix from matching. Host normalization now removes the terminal root dot. |
| Monitor policy evaluation | A boundary comparison copied the full state eight times per side, including unrelated audit history. Each side now uses one private evaluation draft; committed state remains unchanged. Hardening fingerprints likewise share one evaluation draft. |
| Checkpoint recovery | A failed compact usage checkpoint could remain unretried after input stopped. Idle maintenance now honors the existing monotonic retry deadline and stops probing after recovery. |
| Daily limits | Limit and override expiry used the machine's current date instead of the supplied observation date. Both now expire on the evaluated local day. |
| Browser cleanup | Continuous mutations could repeatedly postpone cleanup. Mutation bursts retain the first deadline; urgent checks still advance it. |
| Window resizing | Interrupted drags retained listeners and resize state. Blur, cancellation, lost capture, and replacement drags now clean up; unrelated pointers are ignored. |
| Audio visualization | Stable waveform values were rewritten and duplicate view notifications restarted animation. Redundant style writes and restarts are skipped. |
| Native text classification | Immutable policy preparation repeated per scan; contextual matching formed a cross product of offsets. Policy is prepared once, exact terms use sets, and contextual matching uses an ordered scan. Unicode normalization retains the original grapheme whitespace semantics. |
| Browser media | Strong ID references retained detached DOM trees. Weak references preserve delayed verdict delivery without retaining discarded elements. Repeated inspections now attach one readiness/error listener pair per waiting element. |
| Browser text assembly | Incomplete text messages accumulated indefinitely. The buffer now bounds tracked frames and pending text, releases superseded/expired/completed assemblies, and resets on provisional navigation. A bounded missing-verdict retry lets valid static pages recover after dropped messages or a failed navigation; rejected content stays concealed. Old verdicts cannot reveal newly mutated content while its replacement scan is pending. |
| Extension readiness | The required companion version disagreed with the packaged manifest. The expected version now matches `0.3.11`. |
| iPhone deny capacity | Redundant trailing-slash path entries occupied scarce BuiltIn-filter slots. Four duplicate slots are reclaimed and the previous priority-domain breadth is retained when adding Kinklets. Checks across Normal, Soft Block, and Brick Mode, with bulk filtering on and off, found no lost effective deny coverage; the 500-entry cap and bulk reserve remain. |

## Measurements

These are local microbenchmarks, not whole-app energy or battery measurements.

- 10,000 first-target membership checks over 101 targets: app matching approximately
  179 ms → 2 ms; host matching 326 ms → 5 ms. Later matches and misses still scan
  the needed targets.
- Policy boundary selector with 1,000 synthetic audit events: median approximately
  72.8 ms → 66.3 ms. Hardening selector: 71.1 ms → 66.6 ms.
- Release-optimized native text classifier, 100 scans of a 27,500-character benign
  page with the generated policy: median 0.547 s → 0.512 s, about 6.4% faster.
  This supersedes the preliminary 25% result from a normalization variant that
  was rejected during review.
- A regression test verifies that 1,000 cleanup requests allocate one pending
  timer. Native media tests verify one readiness callback pair after 100 repeated
  inspections.

## Review and validation

Three subagents reviewed separate areas, followed by independent reviews of the
changes. Review caught a combining-mark normalization regression before delivery;
the final implementation passed native differential checks against the original.
Regression coverage includes policy mutation and aliases, exact expiry boundaries,
independent phone/computer sessions, malformed policies, Unicode text, delayed
media verdicts, pointer lifecycle, and enforcement under continuous mutations.

`npm run check` passed: lint, build, and all **158 test suites**. After the final
browser retry/debounce correction, the project was rebuilt and the affected
browser lifecycle and native assembly suites passed again.

The standalone browser passes an unsigned generic iOS Simulator build. Native
assembly tests cover 1.584 MB Unicode batches, byte accounting, supersession,
expiry, capacity recovery, and malformed messages. Browser tests cover bounded
retries, cancellation, dropped replies, and stale verdicts during mutation
debounce. The buffer retains at most 32 frame records and 4 MiB of incomplete
text, with 96 KB per-chunk and 2 MiB per-assembly limits.

## Limits of this audit

This is a source-level audit with regression tests and focused timing probes.
Whole-app RAM, CPU, GPU, disk traffic, and battery consumption have not been
measured under a controlled before/after workload on the Mac or iPhone.

The standalone VigilBrowser classification path can still admit concurrent
native analysis tasks without a global queue limit. The new incomplete-assembly
bound does not bound active media or completed-text classification tasks. A
bounded queue with retry and navigation cancellation needs its own implementation
and load validation; simply dropping work could leave valid media permanently
concealed. This remains a known resource-management follow-up, not a claimed fix.
