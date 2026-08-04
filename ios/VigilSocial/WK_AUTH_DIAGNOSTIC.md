# YouTube WKWebView authentication diagnostic

This harness exists only to confirm how Google responds to an honest embedded
WebKit client. It is not a YouTube product surface and must not be installed as
the normal phone release.

Safety properties:

- The code is compiled only in `DEBUG` builds.
- It appears only when the YouTube target receives the explicit
  `--vigil-youtube-wk-auth-diagnostic` launch argument.
- It starts without loading a page and requires a deliberate button press.
- It uses WebKit's persistent default website-data store but never enumerates,
  exports, prints, or copies cookies.
- It installs no user scripts or native message bridge on any page.
- Logs contain only HTTPS host names, HTTP response codes, navigation types,
  and error domain/code pairs. Paths, queries, fragments, page text, localized
  errors, form values, and credentials are excluded.
- Navigation remains restricted to Vigil's existing YouTube and Google-auth
  allowlist plus YouTube's exact `accounts.youtube.com/accounts/SetSID` session
  handoff endpoint. Shorts routes remain blocked.
- It never opens Safari or another app.

The harness leaves WebKit's user agent untouched. Enable it with this launch
argument:

```text
--vigil-youtube-wk-auth-diagnostic
```

There is intentionally no custom-user-agent or application-name variant.
Spoofing or modifying browser identity would violate the parity contract and
would not establish a supported Google sign-in path.

Run it from the `VigilSocial` scheme in a simulator Debug build. Do not enter
account credentials: press **Load YouTube sign-in route**, observe Google's
first-party `ServiceLogin` result and the sanitized host/status trace, then stop
the run.
