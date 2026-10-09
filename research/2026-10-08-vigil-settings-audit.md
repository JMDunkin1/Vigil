# Vigil settings and enforcement audit

> Implementation update: the Mac cleanup is installed. This audit records the previous configuration; current delivery status is recorded at the end.


Vigil still contains the original Instagram and YouTube 20/20 limits alongside the newer permanent feed bans and YouTube allowance. The old limits remain enabled and can enforce whole-service blocks. Ten of the 59 desktop setting keys have no behavioral consumer, and several larger feature families survive behind APIs after their desktop interfaces were removed.

The proposed cleanup keeps filtered social access, Full Brick, Panic, permanent content restrictions, the YouTube allowance, supervised phone policy, and the protected updater and watchdogs. It retires proven no-ops, separates required protection from optional preferences, and migrates legacy restrictions deliberately rather than deleting their controls alone.

Snapshot: October 8, 2026, approximately 4:55 PM America/New_York. This audit added only this report and made no changes to application source, installed configuration, or enforcement policy.

## Scope and evidence

The inventory covers all 59 keys in `AppSettings`, their references across `src`, `public`, `app`, `extension`, and `scripts`, the desktop settings forms, saved rule families, iPhone policy settings, and the current Swift settings interface. Reference searches were followed by reads of enforcement, migration, API, and sealing code to distinguish a real consumer from a schema or diagnostic reference.

The running Mac uses `/Users/jamesdunkin/Library/Application Support/Vigil`, as confirmed by its supervisor configuration. The repository's `data/state.json` is a different state and should not be used to decide what is installed. Live `/api/state` and `/api/health` agree with the installed state: enforcement and restart supervision are running, and the current baseline is `normal`.

The read-only phone status command found a paired wireless iPhone, the combined Vigil app, a live policy profile, and no retired launcher or YouTube Web Clip profiles. Its signing and deployment verification need attention, described below. Individual on-phone preferences were traced in source, but their installed values were not copied from the phone. Source capability is therefore distinguished from observed use.

There are substantial pre-existing tracked and untracked changes in the checkout. This audit treats the current files as the proposed current implementation; it does not assume every file already matches the installed app or phone.

The working tree and installed runtime also changed independently while the audit was underway. A follow-up read of the later runtime generation confirmed the same 59 setting keys, enabled legacy time limits, and two permanent app locks. Source references and installed diagnostics are snapshots, not a claim that every concurrent change has been deployed.

## Findings that affect removal

1. **The old limits are active code.** `instagram-20-20-template` is enabled and targets Instagram app identifiers and `instagram.com`, excluding Soft Lock. `soft-lock-youtube-20-20-template` is enabled but requires Soft Lock. Its displayed usage is not proof that its block currently applies: the baseline is Normal. The disabled `social-open-template` adds only clutter in the observed installation. [Built-in defaults](</Users/jamesdunkin/Documents/Local Automations/Vigil/src/defaults.ts:680>), [limit evaluator](</Users/jamesdunkin/Documents/Local Automations/Vigil/src/limits.ts:23>).
2. **Deleting the old limit rows alone is temporary.** `normalizeLimitRules` adds every missing built-in back during state loading. Retirement must change defaults and migration behavior together, then handle existing rules and any still-active limit blocks. [State migration](</Users/jamesdunkin/Documents/Local Automations/Vigil/src/store.ts:1130>), [built-in merging](</Users/jamesdunkin/Documents/Local Automations/Vigil/src/store.ts:1630>).
3. **The app-lock engine carries important permanent protections.** The disabled `social-app-lock-template` is unused, but `permanent-webtoonguide-com` and `permanent-chrome-safari-parity` are enabled strict locks with zero unlocks. They also contribute to protected-edit gates. Preserve their exact targets and safety behavior before considering removal of generic app-lock editing or unlock machinery. [App-lock enforcement](</Users/jamesdunkin/Documents/Local Automations/Vigil/src/appLocks.ts>), [protected-edit blockers](</Users/jamesdunkin/Documents/Local Automations/Vigil/src/protection.ts:114>).
4. **Nine audio settings are dead configuration.** No current playback path reads any `focusSound*` setting. References are confined to defaults, types, setting mutations, and tests for those mutations. Existing sacred, Minecraft, and other audio assets may serve block pages and must be audited separately rather than deleted with these fields. [Settings API](</Users/jamesdunkin/Documents/Local Automations/Vigil/src/server/settingsRoutes.ts:213>), [frontend contract](</Users/jamesdunkin/Documents/Local Automations/Vigil/tests/frontend-dom-contract.test.mts:45>).
5. **`hostsBlockingEnabled` is a misleading no-op.** Its references outside defaults and mutations are sealing and tests. Actual hosts and PF behavior follows `systemNetworkBlockingEnabled`. The obsolete field must be deprecated without breaking existing protected-state seals or touching hosts enforcement. [Real network switch](</Users/jamesdunkin/Documents/Local Automations/Vigil/src/systemNetworkBlock.ts:16>), [sealed settings](</Users/jamesdunkin/Documents/Local Automations/Vigil/src/seal.ts:56>).
6. **Several hidden features have real consumers or history.** Intentional-use pauses remain enabled and run in browser and app enforcement. Saved state has 18 ledger days and 13 outcomes. Habit tracking has seven behavior records and 19 check-ins. The planner has two lists but no items or blocks; recovery and SOS records are empty; accountability is disabled. An encrypted journal container exists, but its entry count was not inferred or decrypted. Remove these features only through a deliberate data-preserving decision. [Pause consumers](</Users/jamesdunkin/Documents/Local Automations/Vigil/src/extensionPolicy.ts:302>), [monitor consumers](</Users/jamesdunkin/Documents/Local Automations/Vigil/src/monitor.ts:2629>).
7. **The current YouTube bucket is separate from 20/20.** The source implements four daily Watch Later slots, a two-hour playback budget, up to 20 additional minutes for the current video, and capped Home/subscription feed pools. The phone persists its own ledger before granting playback; it does not require a nearby Mac. Search/direct-link playback and watched-slot locking are also part of this engine. Keep this entire path. [YouTube authority](</Users/jamesdunkin/Documents/Local Automations/Vigil/src/youtubeLimits.ts>), [phone persistence](</Users/jamesdunkin/Documents/Local Automations/Vigil/ios/VigilSocial/VigilSocial/YouTubeLimitsConnection.swift:23>), [feed filtering](</Users/jamesdunkin/Documents/Local Automations/Vigil/ios/VigilSocial/VigilYouTubeInteractionExtension/Resources/youtube-limits.js:462>).
8. **Old terminology does not always mean dead code.** `forceWebClips` now controls the managed companion path. Feed records remain in use despite an older comment about a discarded custom-card feed. Guardian protocol history, signed policy transactions, state migration, retired-profile detection, container backups, and Home Screen checkpoints protect updates and recovery. Retain these compatibility boundaries. [Companion routing](</Users/jamesdunkin/Documents/Local Automations/Vigil/src/socialFeatureFilters.ts:352>), [feed authority](</Users/jamesdunkin/Documents/Local Automations/Vigil/src/youtubeLimits.ts:108>).
9. **The Reels ban has a deliberate shared-link exception.** The permanent route restriction bans plural `/reels`, while individual `/reel/{id}` links shared in Direct remain reachable. Preserve this current distinction unless “fully banned” should also cover individual shared videos. [Reels definition](</Users/jamesdunkin/Documents/Local Automations/Vigil/src/socialFeatureFilters.ts:93>).

## Desktop settings inventory

“Internal” means retain behavior but remove routine user-facing adjustment. “Decision” means the feature works but its place in the smaller product needs a choice. Values come from the installed Mac snapshot. Units are stated where relevant.

| Setting | Observed value | Consumer and proposed disposition |
| --- | --- | --- |
| `protectedBrowsersOnly` | true | Browser enforcement in monitor and policy. Keep as required protection. |
| `pollIntervalMs` | 3000 | Monitor safety cadence. Keep internal; preserve the saved cadence. |
| `idleUsageTrackingEnabled` | true | Idle usage accounting. Keep internal. |
| `idleUsageThresholdSeconds` | 120 seconds | Idle accounting threshold. Keep internal. |
| `strictByDefault` | true | Defaults for generic sessions and schedules. Keep strict behavior; remove an ordinary weakening toggle. |
| `emergencyTokensPerWeek` | 3 | Emergency request budget. Keep protected/internal. |
| `emergencyDelaySeconds` | 45 seconds | Emergency cooldown, including adaptive delay. Keep protected/internal. |
| `panicLockDurationMinutes` | 3 minutes | Panic duration. Keep; align fixed three-minute UI text with any supported adjustment. |
| `intentReasonEnabled` | true | Reason checks for protected actions. Keep required. |
| `intentReasonMinLength` | 20 characters | Reason validation. Keep protected/internal unless customization is useful. |
| `focusSoundEnabled` | false | No behavioral consumer. Retire. |
| `focusSoundMode` | focus | No behavioral consumer. Retire. |
| `focusSoundActivity` | deep-work | No behavioral consumer. Retire. |
| `focusSoundPreset` | bach-italian-concerto | No behavioral consumer. Retire setting; retain any independently used audio asset. |
| `focusSoundIntensity` | medium | No behavioral consumer. Retire. |
| `focusSoundTimerMode` | infinite | No behavioral consumer. Retire. |
| `focusSoundTimerMinutes` | 50 minutes | No behavioral consumer. Retire. |
| `focusSoundBreakMinutes` | 5 minutes | No behavioral consumer. Retire. |
| `focusSoundVolume` | 35 | No behavioral consumer. Retire. |
| `typingChallengeEnabled` | true | Protected confirmation challenges. Keep required. |
| `interventionEnabled` | true | Adaptive emergency friction after repeated blocked attempts. Keep protection. |
| `interventionWindowMinutes` | 10 minutes | Adaptive friction window. Keep internal. |
| `interventionThreshold` | 3 attempts | Adaptive friction threshold. Keep internal. |
| `interventionExtraDelaySeconds` | 45 seconds | Added delay per strike. Keep internal. |
| `interventionMaxExtraDelaySeconds` | 300 seconds | Added-delay cap. Keep internal. |
| `intentionalUseEnabled` | true | Real app/browser pause rules with recorded outcomes. Decision; not dead code. |
| `baselineDailyMinutes` | 300 minutes | Focus-report scoring only, not an enforcement budget. Retire with unused report calculations, or retain if reports are wanted. |
| `focusScoreGoal` | 80 | Focus reports and streaks, absent from the current desktop interface. Same decision as reports. |
| `activeProfileId` | default | Generic session fallback, limits, usage classification, and phone policy. Keep internal until those consumers migrate. |
| `baselineProfileId` | normal | Always-active baseline policy. Keep. |
| `foolproofModeEnabled` | false | Strict preflight and hardening-drift attestation. Keep its safeguards; review the mode before replacing it with fixed behavior. It is not the watchdog on/off switch. |
| `appQuitEscalationSeconds` | 10 seconds | Escalates blocked-app enforcement. Keep internal; do not lengthen. |
| `siteRedirectEnabled` | true | Browser fallback enforcement and blocked-page handling. Keep required; the label “Blocked-page explanation” understates its role. |
| `contentFilterEnabled` | true | Content and browser policy. Already normalized to true. Show status instead of a disabled switch. |
| `sketchySiteMaxAgeDays` | 14 days | Suspicious-domain handling and extension policy. Keep as a meaningful protected threshold, or use a fixed internal value. |
| `adultBlocklistEnabled` | true | Actual blocklist loading and matching. Keep required. |
| `adultBlocklistSourceId` | blocklistproject-porn | Chooses the real downloaded source. Keep internal/admin configuration. |
| `adultBlocklistCustomUrl` | empty | Real custom-source path, inactive. Retire custom-source support if the maintained source is the sole supported path. |
| `adultBlocklistPreloadLimit` | 100 | Blocklist integration with bounded system policy capacity. Keep internal. |
| `browserNoiseBlockingEnabled` | true | Browser cleanup and extension policy. Keep current cleanup behavior; not an unused preference. |
| `appQuitEnabled` | true | Actual blocked-app enforcement. Keep required. |
| `strictBypassProtectionEnabled` | true | Bypass-tool and browser restrictions. Already normalized to true. Show status. |
| `processSweepEnabled` | true | Enforcement against background blocked processes. Keep required. |
| `processSweepIntervalSeconds` | 15 seconds | Background enforcement cadence. Keep internal; do not lengthen. |
| `systemSleepLockEnabled` | false | Screen relocking for strict sleep sessions. Decision. Panic screen locking is separately enforced and must remain. |
| `systemSleepLockIntervalSeconds` | 60 seconds | Sleep screen-lock cadence. Retire if that optional feature retires; preserve Panic behavior. |
| `focusShortcutEnabled` | false | macOS Focus shortcut execution. Decision. |
| `focusShortcutOnName` | Vigil Focus On | Active shortcut name if enabled. Same decision. |
| `focusShortcutOffName` | Vigil Focus Off | Inactive shortcut name if enabled. Same decision. |
| `systemNetworkBlockingEnabled` | true | Real hosts/PF enforcement. Keep required. |
| `safariUrlFilterEnabled` | true | Safari policy and enforcement. Already normalized to true. Show status. |
| `externalNetworkBlockEnabled` | false | Manual DNS/router domain export summary; no automatic delivery or enforcement. Retire unused optional integration. |
| `externalNetworkBlockProvider` | manual | Only supported choice, used by the manual summary. Retire with that integration. |
| `hostsBlockingEnabled` | false | No behavioral consumer; sealed legacy field. Deprecate with explicit seal compatibility. |
| `protectedEditsEnabled` | true | Protected-edit and maintenance gates. Keep required. |
| `protectedEditDelaySeconds` | 300 seconds | Maintenance cooldown. Keep protected/internal. |
| `protectedEditWindowMinutes` | 10 minutes | Maintenance authorization window. Keep protected/internal. |
| `runtimeGapLockdownSeconds` | 120 seconds | Runtime interruption response. Keep internal. |
| `clockTamperLockdownSeconds` | 90 seconds | Clock-tampering response. Keep internal. |

The main consumers are [monitor policy](</Users/jamesdunkin/Documents/Local Automations/Vigil/src/monitor/policy.ts>), [monitor timing](</Users/jamesdunkin/Documents/Local Automations/Vigil/src/monitor/timing.ts>), [content policy](</Users/jamesdunkin/Documents/Local Automations/Vigil/src/extensionPolicy.ts>), [intervention](</Users/jamesdunkin/Documents/Local Automations/Vigil/src/intervention.ts>), [reports](</Users/jamesdunkin/Documents/Local Automations/Vigil/src/reports.ts>), and [integrity recovery](</Users/jamesdunkin/Documents/Local Automations/Vigil/src/integrityLockdown.ts>).

## Other desktop controls and saved feature families

| Family | Observed use | Proposed treatment |
| --- | --- | --- |
| Normal and Full Brick profiles | Present; Normal is the baseline; protection-level changes exist in recent history. | Keep the current two levels. |
| Panic | Supported by the current UI; no active Panic at the snapshot. | Keep the non-interruptible lock and independent screen locking. |
| Default focus and Soft Lock profiles | Present; referenced by fallback session logic and the old conditional YouTube limit. | Consider retiring the old profile choices after consumers and any persisted references migrate. |
| Custom profile editor | No custom profile records in the installed snapshot. | Decision about customization; it is working code. A smaller product can keep built-in policies and retire generic editing. |
| Schedules | No saved desktop schedules. | Keep ordinary scheduling if wanted; do not equate an empty current list with a discarded product direction. |
| Session cycles | Supported by the generic session API; absent from the current main interface. | Candidate for retiring work/break cycling with the old product model. Preserve non-cycling sessions and commitments. |
| Time and open limits | Only the three built-in templates; two enabled. | Retire old templates and generic editors if approved; existing live blocks need deliberate handling. |
| App locks | One disabled template, two active permanent protections. | Remove unused template. Present permanent protections directly. Migrate equivalent enforcement before removing the engine. |
| Grayscale | Soft Lock grayscale false, no grayscale schedules. | Decision; fully implemented, not dead. |
| Keyholder | Disabled. | Optional safeguard. Retain if useful, but do not present absence as failure of the normal setup. |
| Distance key | Disabled. | Optional safeguard with functioning backend and emergency inputs. Same treatment. |
| Intentional-use pauses | One enabled built-in rule; 18 ledger days and 13 outcomes. | Decision because removal changes current access friction. |
| Habits | Seven records and 19 check-ins; no current desktop habit interface. | Preserve history. Restore or retain deliberately, or archive and retire. |
| Journal | Encrypted container exists; no current desktop journal interface. | Preserve encrypted data and unlock compatibility if archived. No entry-count claim. |
| Planner | Two lists, zero items, zero blocks. | Strong retirement candidate; ensure no future/saved policy commitments are discarded on another state. |
| Recovery and SOS | Zero saved records. | Strong retirement candidate. Do not remove shared content restrictions or emergency safeguards. |
| Accountability | Disabled. | Strong retirement candidate. |
| Focus score and reports | Calculated for every state payload; no current desktop report consumer. | Retire unused calculations and response fields if no supported client needs them. Retain usage required by restrictions and diagnostics. |
| Appearance | Icon themes and sacred portrait navigation have current UI consumers. | Keep. |
| Account interface | Current local account/sign-in controls. | Keep unless separately changing the account model. |
| Updates and maintenance | Current API and UI, authenticated guardian transaction, cooldown and challenge. | Keep. |

[Desktop interface](</Users/jamesdunkin/Documents/Local Automations/Vigil/public/index.html>), [desktop handlers](</Users/jamesdunkin/Documents/Local Automations/Vigil/public/app.ts>), [session API](</Users/jamesdunkin/Documents/Local Automations/Vigil/src/server/sessionRoutes.ts>), [feature API inventory](</Users/jamesdunkin/Documents/Local Automations/Vigil/src/server/apiRoutes.ts>).

## iPhone policy settings

The desktop settings page currently edits six phone fields. Saving them changes local desired policy; with self-hosted MDM disabled, that save does not prove the phone received and installed the exact new policy. The page should distinguish desired configuration from verified live installation. [Save handler](</Users/jamesdunkin/Documents/Local Automations/Vigil/public/app.ts:1444>), [device routes](</Users/jamesdunkin/Documents/Local Automations/Vigil/src/server/deviceRoutes.ts:44>).

| Fields | Observed Mac policy configuration | Proposed treatment |
| --- | --- | --- |
| `enabled`, `blockApps`, `blockWeb`, `hardenRemoval` | All true. | Required supported policy; show installation status and protected maintenance controls. Combined Social refuses disabling app or web restrictions. |
| `restrictInstallAndErase` | false | Real policy choice. Preserve the current verified policy; do not silently enable or remove it during settings cleanup. |
| `allowSafariHistoryClearing` | true | Real Safari restriction choice. Keep only if useful as a protected preference. |
| `mode`, `webMode` | denylist, denylist | Real generation choices. Keep internally; retire allowlist configuration only if unsupported as a deliberate product decision. |
| `blockedAppBundleIds`, `allowedAppBundleIds` | Current native-app/browser restrictions and companion compatibility. | Keep required policy data; avoid a generic weakening editor. |
| `deniedUrls`, `allowedUrls` | Both custom lists empty. | Keep policy support where needed for verified exceptions and restrictions; generic customization is a product choice. |
| `socialContainer` | true | Current combined installation. Treat as the required installation model. |
| `allowNativeSnapchat` | false | Already retired; input cannot re-enable it. Keep minimal migration compatibility, not a setting. |
| `focusedSocial.enabled` | true | Current browser/companion policy. Keep required. |
| `focusedSocial.forceWebClips` | true | Live companion selection under an obsolete name. Rename the public model to companion apps with a compatibility reader; do not delete behavior. |
| Instagram `enabled`, `reels`, `explore`, `suggested`, `shopping`, `ads` | All true. | Keep current bans and cleanup. Reels is permanent. Any remaining tunable cleanup should be justified explicitly. |
| YouTube `enabled`, `shorts`, `home`, `explore`, `suggested`, `ads` | All true. | Keep Shorts ban, bucket/feed restrictions, and current player cleanup. The allowance is fixed engine policy, not the old time-limit editor. |
| Snapchat `enabled`, `spotlight`, `stories`, `explore`, `suggested`, `ads` | All true. | Keep current filtered companion behavior. |
| LinkedIn `enabled`, `shorts`, `explore`, `suggested`, `ads` | First two true; last three normalized false. | Immersive-video blocking is permanent. Normalized filler fields are candidates for a platform-specific schema without fake toggles. |
| Facebook, X, TikTok, Reddit `enabled`, `shorts`, `explore`, `suggested`, `ads` | All true. | Current expanded service source, not evidence of an abandoned feature. Preserve permanent guards and companion compatibility. |
| `removalPassword` | Set; value not exposed. | Keep installation secret, never a routine settings control. |
| `status`, `lastGeneratedAt`, `manageEngineGeneration`, optional `profileId` | Runtime/generation metadata. | Keep evidence fields that prove the published policy; not user preferences. |
| `mdm` | Disabled; no enrolled devices or pending commands. | Retire unused self-hosted MDM from the supported Personal product if desired. Do not delete local-supervision installation, signed policy generation, or currently used ManageEngine export transaction evidence with it. |

[Policy normalization](</Users/jamesdunkin/Documents/Local Automations/Vigil/src/iosProfiles.ts:135>), [focused social definitions and compatibility](</Users/jamesdunkin/Documents/Local Automations/Vigil/src/socialFeatureFilters.ts>), [phone transaction](</Users/jamesdunkin/Documents/Local Automations/Vigil/scripts/ios-phone-suite.mjs>).

The MDM model contains real integration fields, not empty UI placeholders: enablement and `publicBaseUrl`; APNs `topic`; identity UUID, certificate payload, and password; push certificate payload and password; access rights, message signing, development APNs, and checkout behavior; enrollment secret/tokens, device and command records; and enrollment/check-in/queue/push/policy/grayscale timestamps, status, errors, and hashes. These all belong to the unused self-hosted integration as a family. Removing it requires auditing `/mdm` handlers, queue hooks, exported types, and tests together. No credentials were read into this report.

## Settings in the current phone source

These controls have concrete Swift or web consumers. Their installed values were not verified, and some files are part of the pre-existing uncommitted work.

| Control or state | Consumer | Proposed treatment |
| --- | --- | --- |
| Startup service | Container startup and service selection. | Keep preference if useful. |
| Haptics | Selection feedback. | Keep ordinary preference. |
| Additional accounts and selected account per service | Separate sign-in stores; Instagram retains its existing container. | Keep; account switching must not reset allowance or restrictions. |
| YouTube background audio | External playback lifecycle and ongoing authorization. | Keep; uses existing checks and allowance. |
| YouTube picture-in-picture | Web/native player presentation and lifecycle. | Keep; uses existing checks and allowance. |
| Service notification preferences and system authorization | Local notifications for opened supported web sessions. | Keep if wanted; no paid push service required. |
| Posting service and countdown | Opens a supported composer, returns to Apps after ten minutes. | Optional current convenience; grants no filter exception. |
| Routine name, services, weekdays, start/end minute | Scheduled service pauses, including overnight and daylight-saving handling. | Keep if scheduling remains in scope; active pauses cannot be shortened. |
| Sleep-until time | All-service pause with no early stop. | Keep if phone Sleep Mode remains in scope. Distinct from the disabled Mac screen-relock setting. |
| Saved-record version and unreadable flag | Persistence validation; unreadable restrictions keep services paused. | Keep internal. |
| Help | Explains the supported current feature set. | Revise after feature decisions. |

[Phone settings view](</Users/jamesdunkin/Documents/Local Automations/Vigil/ios/VigilSocial/VigilSocial/SocialSettingsView.swift>), [phone preferences and restriction gates](</Users/jamesdunkin/Documents/Local Automations/Vigil/ios/VigilSocial/VigilSocial/SocialPreferences.swift>), [playback consumers](</Users/jamesdunkin/Documents/Local Automations/Vigil/ios/VigilSocial/VigilSocial/SocialWebViewStore.swift:127>), [notifications](</Users/jamesdunkin/Documents/Local Automations/Vigil/ios/VigilSocial/VigilSocial/SocialNotifications.swift>).

## Proposed settings page

Use four main destinations: Social protection, iPhone, Appearance, and Health and maintenance. Keep Schedules as a top-level destination if scheduling is retained. Show the current Normal, Full Brick, and Panic controls on Home.

Social protection should explain the permanent Instagram Reels, YouTube Shorts, other short-form and content restrictions, the current YouTube allowance, and any permanent service/app blocks. The old “Limits and app locks” destination should disappear if generic limits are retired. Only meaningful retained preferences should be editable.

iPhone should show combined-app version, Personal Team signing freshness, supervision, non-removable profile verification, exact live policy match, and service launch evidence. A local configuration save or profile download should not imply successful installation. Supported changes and repairs should use the verified app-and-policy update path.

Health and maintenance should show actual safeguard health separately from optional conveniences. Currently the core-protection badge is only a count of six switches, including disabled optional sleep locking. The audit also treats absent keyholder, distance key, Focus shortcuts, and sleep relocking as failures, and the obsolete extension requirement reports a newer extension as needing a downgrade. This makes optional or stale checks look like core enforcement failures. Improve applicability and version reporting without declaring stale real policy checks healthy.

The installed `foolproofModeEnabled` is false. The runtime watchdog and supervised restrictions still run, but the named mode is a stricter preflight and drift-attestation policy with additional account, keyholder, and distance-key requirements. Decide its intended supported contract before making it unconditional or removing it. [Preflight](</Users/jamesdunkin/Documents/Local Automations/Vigil/src/foolproof.ts:81>), [drift attestation](</Users/jamesdunkin/Documents/Local Automations/Vigil/src/integrityLockdown.ts:250>), [current switch-count badge](</Users/jamesdunkin/Documents/Local Automations/Vigil/public/app.ts:1411>).

## Implementation sequence and verification

1. Remove the nine no-op audio settings from defaults, types, API mutations, and irrelevant tests. Migrate persisted keys after ordinary state/seal validation. Preserve separately used audio assets. Tests for atomic settings mutation should use settings with real consumers.
2. Deprecate `hostsBlockingEnabled` and the unused manual DNS/router integration with explicit protected-seal compatibility. Keep real system network, hosts, and PF enforcement.
3. Stop inserting retired built-in limits. Identify legacy rules by their known identity and expected shape so customized rules are not silently lost. Archive the retired definitions and usage history; preserve or deliberately complete any already-active lock rather than resetting it accidentally.
4. Preserve the permanent WebtoonGuide and Chrome restrictions with equivalent enforcement, extension rules, network targets where applicable, and protected-edit behavior. Then remove unused app-lock templates, generic editors, and unused unlock paths if no supported custom locks remain.
5. Retire approved hidden feature families and their routes, schemas, summaries, clients, assets, and tests together. Preserve encrypted journal and habit records in an explicit archive. Keep usage ledgers needed for restriction accounting, adaptive friction, and diagnostics.
6. Simplify the settings interface and revise help text. Required protection becomes status, optional preferences stay editable, and installation evidence is separate from desired configuration.
7. Validate state/seal migration, unchanged permanent deny behavior, YouTube accounting and slot limits, Full Brick/Panic behavior, protected edits, browser enforcement, startup continuity, and guardian/update transactions. Verify the rendered settings page and draft persistence. Use isolated test state rather than the live data root.
8. Deliver only through `npm run agent:update` for Mac and `npm run agent:update:social` for phone. Phone delivery must preserve the combined container, YouTube ledger, signed non-removable profile, BuiltIn filtering, priority deny rules, and all required service launches. A changed non-removable policy may require USB even though read-only pairing currently works wirelessly.

## Maintenance findings separate from settings retirement

The Mac health endpoint reports a live, healthy enforcement monitor and restart supervisor. The more detailed hardening audit also reports stale hosts/PF and Safari policy evidence, a missing source seal, and a required extension version of 0.3.13 while the observed extension reports 0.3.14. A later source read shows the requirement has already been raised to 0.3.14, while the observed installed runtime still returns the old version warning. These findings need applicability/freshness checks and appropriate repair; the healthy monitor alone does not prove all policies are current.

The phone status command reports installed Vigil 0.3.165 (168), a live profile labeled 0.3.167 (170), changed phone-facing sources, and deployment receipts that do not prove the current implementation. Its recorded Personal Team signing expired on October 5, 2026, at about 7:07 PM America/New_York. The check could not resolve the generated live policy for a freshness comparison. Treat the source settings inventory as current source capability and the phone status as incomplete deployment verification; do not report a successful current phone update from these records.

These were read-only findings. Cleanup should not replace the verified installation transaction with an app-only install, start new supervision, restore the phone, retire backups/checkpoints, or stop either watchdog.

## Product decisions requested

1. Retire the old Instagram/YouTube 20/20 rules and generic time/open-limit editors, or keep custom limits as an advanced feature? Recommendation: retire the old model and preserve permanent service blocks plus the current YouTube allowance.
2. Which of habits, journal, planner, recovery/SOS, accountability, and intentional-use pauses should remain? Several are hidden or empty, but habit and intentional-use history exists. Archive preserved data if the features retire.
3. Retire disabled grayscale schedules, macOS Focus shortcuts, and Mac sleep-session relocking, or keep them under advanced settings? Phone routines, phone Sleep Mode, and Panic are separate functioning paths.
4. Keep the current individual Reel shared-link exception, or block those links as well?
5. Retire generic custom-profile editing, hidden focus-score reports, and unused self-hosted MDM, or retain them as advanced tooling? Recommendation: retire them while keeping built-in protection levels, scheduling, local phone supervision, and verified updates.

Further cleanup can keep the current Home levels, scheduling, appearance, meaningful phone preferences, and enforcement maintenance by default. The exact contract of the stricter Foolproof preflight needs review before its toggle becomes fixed policy.

## Delivery status — October 8, 2026

The Mac cleanup was installed through `npm run agent:update -- --allow-local`. Live readiness, aggregate health, and the enforcement monitor were healthy afterward. The original YouTube ledger and both permanent Chrome/WebtoonGuide lock records were unchanged. Retired history was saved under the private `retired-features` directory before migration; legacy templates and sound settings are absent from live state.

The settings page now shows Social protection, Social lock, Core protection, Unlock safeguards, iPhone & devices, Appearance, and Health & maintenance. Old feature creation endpoints return 410. Compatibility readers retain existing timed blocks and planner commitments until they complete. Recovery cannot restore retired pause allowances.

The phone Social lock implementation supports Instagram or every Vigil service, timed or permanent commitments, no shortening or cancellation, and independent Keychain storage. The native build and commitment-engine regression tests passed. Full simulator XCTest execution was blocked by Apple's simulator service. The supported phone updater could not reach the paired iPhone, so no phone app or supervised policy was installed. Phone delivery still requires the reachable USB connection for the protected app-and-policy update.
