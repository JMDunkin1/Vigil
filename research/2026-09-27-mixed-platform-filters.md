# Reddit protections adapted to mixed-content platforms

The shared browser filter now covers X/Twitter, Bluesky, Pixiv, Patreon, itch.io (including creator subdomains), and Discord. Existing contextual art/community sites receive the applicable DOM protections too. Existing whole-site comic blocks and Reddit's dedicated single-post review flow remain unchanged.

| Protection | Application |
| --- | --- |
| Explicit search detection | Shared desktop policy and Chrome/Safari search guard; query parameters, encoded text, tags, hashtags, Pixiv R-18 ranking mode, itch.io adult tags |
| Adult post/card removal | Semantic post containers, Discord message containers, itch.io game cards, explicit labels and structured age markers |
| Account filtering | Explicit author attributes/labels, X profile paths, Bluesky profile paths, Patreon creator paths; hide the containing post where identifiable |
| Age gates and settings | Prevent adult confirmation, reveal controls, and changes to sensitive-content and Safe Search controls; do not pretend to change server-side account preferences |
| Dynamic content | Mutation observers, open shadow roots, synchronous checks before pointer, keyboard, submit, change, or playback events |
| Media | Conceal marked cards and pause associated video/audio |

These are browser label, text, URL, and DOM checks. They do not classify unlabeled images, inspect encrypted messages, change native app behavior, or guarantee coverage of every website layout. Browser code cannot infer an opaque post's contents from its URL. Ordinary messaging, safe creator pages, spoilers, educational searches, and unrelated identifiers are retained in regression coverage.

## Verification

- Build, source lint, and nine targeted suites passed, covering contextual search, media titles, browser health reporting, Reddit age/search/review protections, explicit-content policy, Safari generated parity, and whole-platform comic bans.
- An initial Chromium fixture run passed on all six platforms plus Twitter and itch.io creator hosts. Added author/shadow handling subsequently passed the X fixture and predicate regressions. Later standalone Electron reruns exited with SIGKILL or a navigation error; the cause was not established and enforcement was not altered. These are synthetic fixtures, not authenticated production-site coverage.
- Relevant suites passed again after tightening the fallback to avoid hiding an entire unstructured feed.
- The live Mac policy blocks explicit searches on all six platforms. Mac liveness and readiness were healthy after the protected update.
- Installed Mac policy and media-filter bytes matched the tested build. The signed Safari update completed, verified its resources, and installed the canonical extension.
- Phone release 0.3.149 (152) built and installed the combined app. Its required launch verification was denied because iOS reported the phone locked. The app-and-policy transaction is pending unlock; no successful full-phone deployment is claimed.
