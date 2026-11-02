# Instagram Notifications page recovery — November 1, 2026

The reported screen is Instagram's own `/notifications/` error boundary.
Read-only inspection on the paired iPhone reproduced the page failure after
opening the real Notifications link. `ErrorPubSub` recorded a fatal
`Destination is null for activity feed story` from `PolarisStoryDestination`,
through `PolarisStoryTemplateConfigForSystemEntry` and
`usePolarisActivityFeedStoryTemplates`. This was an activity-list rendering
failure; the screenshot does not diagnose iOS push delivery.

The public Instagram bundle confirmed that a missing or unparseable destination
throws, while the enclosing template list already supports null entries.
A temporary, exact-error wrapper on the system-entry renderer restored the
actual phone page when navigating Home → Notifications.

The permanent document-start compatibility script subscribes to Instagram's
lazy system-entry module before use. It preserves the renderer's arguments,
receiver, return values, and valid destinationless notification types. Only the
observed exact destination error, on the canonical Notifications route, returns
null for that one entry. Unrelated exceptions and other routes retain their
original behavior. It does not invent destinations, change notification data,
intercept requests, or modify navigation, media, or supervised policy rules.
Its in-memory diagnostics contain only installation state and a skipped count.

Validation passed: the new mixed-entry and delayed-loader regression, existing
notification bridge checks, 48 native ambiguous-route probes, social build
checks, TypeScript build, source lint, and whitespace checks. A separate real
WebKit document-start fixture also passed: its parser introduces the module
loader after the user script, loads the renderer, and immediately renders a
mixed list; the malformed entry is skipped on that first render.

Concurrent Snapchat edits appeared during diagnosis. The reviewed Instagram
change and its regression are also held in the isolated checkout at
`/Users/jamesdunkin/.codex/worktrees/vigil-notifications-fix` so the supported
updater can deploy stable sources without including unfinished work.

Deployment is pending: the permanent update stopped before installation when
the USB device became unavailable to Xcode. The original supervised policy
`7d0ab7c4016d` remained installed. The temporary phone-session repair is not a
verified permanent deployment or a cold-document bootstrap check.

## Recurrence: native script loss and verified permanent repair

The 6:32 PM recurrence followed a completed combined update, so missing source
delivery was no longer an adequate explanation. Live inspection of the updated
app showed both activity-feed and outgoing-unread document-start compatibility
objects absent, while the document-end guards were present.

`SocialMessageNotificationBridge.install` retained `controller.userScripts`,
cleared the controller, then prepended its notification scripts and re-added the
retained list. WebKit exposes a live bridged NSArray: a native reproduction
reported two saved scripts before removal and zero afterward. Adding scripts
before iterating that live view can also make the loop append to its own input.
The installer now materializes an owned Swift array with `map` before removal,
preserving the existing scripts, their order, timing, frame scope and worlds.

An independent startup race was also reproduced. Mutation observers and
`requireLazy` callbacks can run after the first renderer consumer. The activity
repair now uses Instagram's module-factory hook to wrap only the exact system
entry module before its exports reach a consumer. It preserves factory arity,
arguments, receiver, return exports and errors, chains existing hooks, and
restores the site's hook after installation. Its factory subscription survives
the polling deadline for a later SPA visit. The exact destination exception and
Notifications-only scope remain unchanged.

Validation:

- The previous activity repair fails the same-task first-render fixture; the
  correction passes with Instagram's captured real module loader.
- The WebKit regression compiles the production native bridge installation
  method, injects the full Instagram startup script, and checks the first cold
  render, consumer-before-lazy ordering and a first SPA visit after 16 seconds.
  All three pass. The old native bridge fails this test; fixture script
  additions are bounded so the broken live-array loop cannot exhaust memory.
- Eighteen focused runtime test results pass. Repository lint, runtime build,
  whitespace checks and the iOS Simulator app/test build pass. A native XCTest
  additionally covers initial script preservation, two document recreations and
  isolated-world protection; it was compiled, not run on an iOS Simulator.
- The normal combined updater installed Vigil Social 0.3.241 (244), phone suite
  0.3.262 (265), verified signing, all protected service launches and the exact
  live supervised policy `7d0ab7c4016d`.
- On the physical phone, Home → Notifications rendered the list with 113
  visible profile links and skipped three malformed entries. A full page reload
  independently installed the compatibility repair, skipped two malformed
  entries and rendered the list again. Both checks showed the Notifications
  heading, no error page, no fatal renderer errors, and the policy/single-item
  guards present; restricted Reels navigation remained absent.

Meta's logger still emits its destination diagnostic before throwing; the
exact compatibility catch prevents that malformed entry from crashing the list.
This is distinct from the absence of an error boundary and fatal render errors.
Ignored verification logs are `/tmp/vigil-notifications-v3-*`; no session-only
JavaScript repair was injected during the physical acceptance checks.
