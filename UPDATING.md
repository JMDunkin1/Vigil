# Updating Vigil

Run this from any terminal folder:

```sh
vigil update phone
```

`vigil update` does the same thing. Connect your paired iPhone by USB or make it
reachable on the local network. A changed non-removable policy requires USB.
You do not need to ask an agent or open a chat.

The command shows progress and elapsed time, keeps the complete output in
`~/Library/Logs/Vigil/updates`, and exits unsuccessfully if verification fails.
It returns early when the installed app, signing receipt, all service receipts,
current sources and exact live supervised policy are already verified.

Changed updates reuse Xcode's incremental build cache in
`~/Library/Caches/Vigil/phone-builds`. The first build with an empty cache takes
longer. Build-tool reuse checks the contents of both source and compiled output;
editing policy code or deleting/changing a compiled module invalidates it.
Signing renewal still checks the app and every extension, and performs a clean
rebuild if Xcode has to replace stale provisioning profiles. Changed updates
still validate all four protection levels, the live policy and every service.
If source edits land while an update is building or verifying, it retries the
verified transaction with the incremental cache, up to three attempts. Changes
detected before installation stop that attempt before it touches the phone.

If Apple needs app verification, the command waits up to three minutes while you
open **Settings → General → VPN & Device Management → your developer → Verify
App**. If verification fails on Wi-Fi, try cellular. The command continues
automatically once iOS accepts the app. This does not bypass Apple's checks.

Other commands:

```sh
vigil status phone             # Read-only phone status
vigil update mac               # Vigil's protected Mac updater
vigil status mac               # Read-only Mac updater status
vigil update phone --verbose   # Full build output
vigil update phone --force     # Fresh release/reinstall and full verification
```

Install the terminal command once on another Mac, from the repository:

```sh
npm run install:cli
```

The installer writes `~/.local/bin/vigil`. That directory must be on your PATH.
The existing `npm run agent:update:social` and service-specific update aliases
use the same streamlined app-and-policy transaction.

Measured on this Mac on November 1, 2026: a changed-app update, installation and
full verification completed in 44.6 seconds; an already-current check completed
in 6.9 seconds. Warm build/signing alone took 3.9 seconds when no Swift changes
needed recompilation. Cold caches, source edits, network access and Apple's
verification can add time. All measurements used the normal protected update.
