# Instagram bottom navigation inbox badge

The report concerns the Messages arrow in Instagram's bottom bar. The arrow's
badge is distinct from Vigil's opt-in iOS foreground text alerts and from the
Instagram activity/Notifications page.

The captured Instagram client renders the same `IGDBadgeIconOffMsys` component
in mobile bottom navigation and desktop navigation. Its `IGDBadgeCountOffMsys`
query starts with 15 threads in the INBOX folder and sets up Instagram's own
mailbox subscription. The count hook filters the loaded connection to unread,
unmuted threads and excludes certain hidden Meta AI threads. A zero count
produces no badge. This establishes ways the badge can differ from the inbox
but does not establish what caused the reported instance.

The phone had Vigil Social 0.3.248 (251) installed and its status file showed
Instagram alerts enabled, iOS authorization granted, and the monitor waiting.
The paired inspector did not expose an Instagram page. Inspect a gray arrow
before navigating: check whether a badge is present but hidden, and compare
the loaded inbox connection's aggregate unread/muted counts and resolver
results. If possible, compare the same counts after opening the inbox without
opening any individual conversation. Do not record conversation or message
identifiers or text. This distinguishes rendering, stale or limited mailbox
data, mute filtering, and an incorrect resolver result.

The 13 existing unread and message-alert tests and the document-start WebKit
regression passed. No app, policy, or phone installation changes were made.
