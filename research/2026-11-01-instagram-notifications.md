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
