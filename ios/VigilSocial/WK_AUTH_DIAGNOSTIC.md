# YouTube WKWebView authentication diagnostic

This harness exists only to confirm how Google responds to an honest embedded
WebKit client. It is not a YouTube product surface and must not be installed as
the normal phone release.

Safety properties:

- The code is compiled only in `DEBUG` builds.
- It appears only when the YouTube target receives the explicit
  `--vigil-youtube-wk-auth-diagnostic` launch argument.
- By default it starts without loading a page and requires a deliberate button
  press. Credential-free simulator tracing requires a second explicit opt-in.
- It uses WebKit's persistent default website-data store but never enumerates,
  exports, prints, or copies cookies.
- It installs no user scripts or native message bridge on any page.
- Logs contain only HTTPS host names, HTTP response codes, navigation types,
  and error domain/code pairs. Paths, queries, fragments, page text, localized
  errors, form values, and credentials are excluded.
- Navigation remains restricted to Vigil's existing YouTube and Google-auth
  allowlist plus YouTube's exact `accounts.youtube.com/accounts/SetSID` session
  handoff endpoint. `about:blank` is permitted only for a subframe; main-frame
  and popup navigation remain strict. Shorts routes remain blocked.
- It never opens Safari or another app.

By default, the harness leaves WebKit's user agent untouched. Enable it with
this launch argument:

```text
--vigil-youtube-wk-auth-diagnostic
```

For a credential-free simulator trace, pass both that argument and the
separate auto-load opt-in:

```text
--vigil-youtube-wk-auth-diagnostic
--vigil-youtube-wk-auth-diagnostic-autoload
```

The auto-load flag does nothing without the primary diagnostic flag. It loads
only the public YouTube `ServiceLogin` entry document; it does not submit a
form or interact with the page.

To exercise YouTube's own first-party entry point instead of beginning directly
at Google, add a third route selector:

```text
--vigil-youtube-wk-auth-diagnostic
--vigil-youtube-wk-auth-diagnostic-autoload
--vigil-youtube-wk-auth-diagnostic-youtube-entry
```

That route begins at `https://m.youtube.com/signin` and follows ordinary server
redirects through the same host-only logger. The route selector does nothing
unless both diagnostic and auto-load flags are also present.

See `WK_AUTH_DIAGNOSTIC_TRACE.md` for the credential-free iOS 27 simulator
result and its deliberately limited interpretation.

TinyTube publicly documents an unsupported comparison configuration that adds
`Version/17.0 Safari/605.1.15` through WebKit's
`applicationNameForUserAgent`. It can be tested only by adding a fourth flag to
the three-flag YouTube-entry invocation:

```text
--vigil-youtube-wk-auth-diagnostic-safari-suffix
```

The suffix flag does nothing without both the primary diagnostic and auto-load
flags. The diagnostic flag is unavailable in Release builds, never replaces
`customUserAgent`, and is visibly labelled unsupported in the diagnostic UI and
logs. The production YouTube-only WK configuration now independently applies
the same documented suffix as an intentional unsupported compatibility
exception. That does not make it a Google-supported sign-in path, and this
credential-free diagnostic did not validate authenticated success.

Run it from the `VigilSocial` scheme in a simulator Debug build. Do not enter
account credentials: press **Load YouTube sign-in route**, observe Google's
first-party `ServiceLogin` result and the sanitized host/status trace, then stop
the run.
