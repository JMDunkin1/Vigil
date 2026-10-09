# Vigil agent rules

Help develop and update Vigil without weakening its restrictions. Never terminate Vigil, disable its watchdog/relaunch protections, or create enforcement workarounds. Closing the interface means hiding its window while enforcement stays online.

## Updates

- Mac: `npm run agent:update`. Phone: `npm run agent:update:social`.
- Instagram, YouTube, Snapchat, LinkedIn, and phone update aliases target the same combined Vigil Social installation, retaining the Instagram bundle identifier and Safari extensions.
- Preserve verified app-and-policy transactions. First migration must back up original containers, preserve the YouTube ledger, verify the exact live supervised policy and all four service launches, then retire separate apps. Never substitute app-only installs.
- Paired CoreDevice connections may be wired or wireless. Require USB when a changed non-removable policy needs the supervisor-keybag installer.
- Keep the supported phone path free: Xcode Personal Team signing and local supervision, without required paid memberships, production-only entitlements, or paid hosting. Never fabricate endpoints or entitlements or bypass signing rules. Preserve and verify the non-removable supervised profile, BuiltIn web filtering, priority deny rules, restrictions payload, and compatible companions.

## No-erase iPhone supervision

1. Deep-validate the existing checkpoint and Home Screen records. While unlocked, save trusted pairing with an `EscrowBag`; retain the persistent Vigil supervisor keybag.
2. Restore once using one pruned payload containing setup-state and all verified SpringBoard/Home Screen/widget layout records. After reconnecting, do not ask the user to unlock the phone.
3. Through escrow-backed pairing, wait for `profile cloud-configuration` to return `null`; immediately supervise without erasing using the same keybag.
4. Verify `IsSupervised=true`, pair using the supervisor keybag, install the signed non-removable profile, verify the exact live policy fingerprint, and launch-test every companion before reporting success or re-enabling Find My.

Never restore the full checkpoint (`backup2 restore --system`) or run standalone Home Screen restore on a supervised phone: these clear supervision. While a verified checkpoint exists, do not start new enrollment, repeat restores, or ask the user to rebuild the Home Screen.

## Minimal block-page diagnostics

Block pages show only “Blocked” and “Back”. The small corner code uses `V1-SOURCE-KIND-FINGERPRINT`; it is a diagnostic label, never an authorization token. Sources: `MAC` = Vigil's companion server, `CHR` = Chrome content guard, `SAF` = Safari content guard, `IOS` = Vigil Browser, `EXT` = a static extension fallback. Native phone access gates use `V1-SOC-SERVICE-CATEGORY` and retain the full restriction in their accessibility hint. Kind labels and the stable target/policy fingerprint are defined in `src/blockPageDiagnostics.ts`. For a screenshot, read that code to identify the surface and block category. Full target, rule ID, expiry, and explanation remain in `#vigilBlockDetails` JSON; correlate with existing local blocked-event logs when more context is needed. Do not infer a specific target from a screenshot code alone when its metadata or matching local evidence is unavailable.
