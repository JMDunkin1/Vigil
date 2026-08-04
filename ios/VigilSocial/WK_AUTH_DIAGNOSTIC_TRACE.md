# WKWebView authentication simulator trace

Captured on 2026-08-03 from a fresh iOS 27.0 iPhone 17 Pro simulator. The
Debug app was launched with all three diagnostic flags so navigation began at
YouTube's own `m.youtube.com/signin` entry. No credentials were entered and no
UI automation, Safari handoff, DOM access, page-text access, or cookie access
occurred.

The unified-log timestamp, process ID, and thread ID prefixes are omitted
below. These are the complete messages emitted by the probe's
`WKAuthDiagnostic` category:

```text
ready agent=default-webkit store=persistent scripts=none
autoload enabled=true
requested host=m.youtube.com
allowed host=m.youtube.com frame=main kind=other
allowed host=accounts.google.com frame=main kind=other
server-redirect host=accounts.google.com
allowed host=accounts.google.com frame=main kind=other
server-redirect host=accounts.google.com
allowed host=accounts.google.com frame=main kind=other
server-redirect host=accounts.google.com
response host=accounts.google.com status=200 main=true
allowed host=accounts.google.com frame=subframe kind=other
response host=accounts.google.com status=200 main=false
finished host=accounts.google.com
allowed host=invalid frame=subframe kind=other
allowed host=invalid frame=subframe kind=other
```

The two `invalid` labels are the permitted `about:blank` subframes. The logger
deliberately emits no scheme/path/query label for them.

This trace proves only that an honest default-identity `WKWebView` can follow
YouTube's unauthenticated sign-in entry to Google and receive the public login
document with HTTP 200. It does **not** prove that Google will accept account
credentials in the embedded user agent, and it does not establish a YouTube
session because the credential and `accounts.youtube.com/accounts/SetSID`
stages were intentionally never reached.

## Unsupported Safari-suffix comparison

The same simulator was then relaunched with the additional explicit
`--vigil-youtube-wk-auth-diagnostic-safari-suffix` flag. The sanitized trace
was:

```text
ready agent=unsupported-safari-suffix store=persistent scripts=none
autoload enabled=true
requested host=m.youtube.com
allowed host=m.youtube.com frame=main kind=other
allowed host=accounts.google.com frame=main kind=other
server-redirect host=accounts.google.com
allowed host=accounts.google.com frame=main kind=other
server-redirect host=accounts.google.com
allowed host=accounts.google.com frame=main kind=other
server-redirect host=accounts.google.com
response host=accounts.google.com status=200 main=true
finished host=accounts.google.com
cancelled host=accounts.youtube.com frame=subframe kind=other reason=allowlist
allowed host=accounts.google.com frame=subframe kind=other
response host=accounts.google.com status=200 main=false
allowed host=invalid frame=subframe kind=other
allowed host=invalid frame=subframe kind=other
```

This comparison also reached Google's public login document with HTTP 200. It
additionally requested an `accounts.youtube.com` subframe outside the probe's
single exact `accounts/SetSID` exception, so the strict allowlist cancelled it.
Because the probe intentionally records no paths and no credentials were used,
the trace neither identifies that subframe route nor demonstrates successful
authentication. The suffix remains an unsupported diagnostic observation, not
a production recommendation.
