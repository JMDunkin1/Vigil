# Vigil Safari for macOS

Install or update with `npm run agent:update:safari` while the installed Vigil is running.
The script discovers the active data directory from the supervisor LaunchAgent,
checks its authenticated YouTube endpoint, builds with an existing Apple Development
identity, verifies the signed package and shared resources, and installs the host app.
It never stops Vigil or enables unsigned extensions.

Open `/Applications/Vigil Safari.app`, open Safari Extension Settings, enable
**Vigil Focused Web Controls**, and allow its YouTube website access. Reload an
existing YouTube tab after granting access. Verify the allowance line appears,
a video without authorization cannot autoplay, Shorts are filtered, and an
allowed video can pause, resume, and change quality.

The JavaScript resources link directly to the iPhone extension sources. Safari
runs the controls in its isolated content world and calls the native message
handler; no page-world bridge is required for Safari. The Mac native handler
uses only the loopback Vigil endpoint, refuses redirects, and never sends the
credential to JavaScript. It uses the running desktop ledger, not a new ledger.
Generated credentials and build output remain under ignored `dist.nosync/safari`.

A signed/installed extension is not proof that Safari has enabled it or granted
website access. An extension that is disabled cannot enforce YouTube rules.
The iPhone extension is embedded in the Instagram companion and is deployed
through `npm run agent:update:instagram`, including the existing policy transaction.
Phone Safari uses its existing local ledger; this change does not introduce
cross-device or app/extension ledger synchronization.
