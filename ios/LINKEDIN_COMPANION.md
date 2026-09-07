# Independent LinkedIn companion

`VigilLinkedIn` is a separate application target with bundle identifier
`tech.caseline.vigil.linkedin`, display name LinkedIn, its own icon, and its own
persistent WebKit data store in its app sandbox. It uses LinkedIn's real mobile
website. It is not a reimplementation of the proprietary native app.

The companion preserves ordinary posts, profiles, jobs, messages, and the
first-party login form. Native navigation, document-start DOM filtering, SPA
history guards, and embedded-frame guards remove the immersive video
experience. Known video-discovery carousels and navigation controls are hidden;
media inside those surfaces is paused. Ordinary post video and composer upload
controls remain available, matching the distinction between YouTube watch pages
and the Shorts feed.

LinkedIn can change its markup. Simulator fixtures verify the current adapter's
supported selectors and routes; a signed-in physical-device check is still
needed before claiming coverage of the owner's current feed.

## Build and maintenance

```sh
npm run ios:social:build -- linkedin --unsigned --destination 'generic/platform=iOS Simulator'
npm run agent:update:linkedin
```

The independent updater retains the existing app-and-policy transaction,
artifact verification, supervised profile verification, and launch checks. The
default `agent:update:phone` path remains the existing three companions;
LinkedIn is explicitly selected with `--app linkedin`.

Apple's free Personal Team permits only three installed apps per device. When
Instagram, YouTube, and Snapchat already occupy those slots, the LinkedIn
updater stops before installing anything or changing the phone policy. It does
not delete another companion or require a paid membership. The fourth target
can still be built and tested in the simulator.

Native LinkedIn replacement is **off until installation**. The independent
updater prepares the matching policy, installs the companion, and verifies that
it launches before saving the native-app restriction through Vigil's settings
API. It adds `com.linkedin.LinkedIn` to the permanent configured app deny list,
removes it from the app allow list, and permits `tech.caseline.vigil.linkedin`
under ordinary policy. It then installs and verifies the matching supervised
profile. Existing Full Brick and Panic restrictions still apply to the companion.

This saved setting survives later policy generation and unrelated companion
updates. A failed launch never activates the replacement. Settings or profile
installation failures report an incomplete transaction; `--no-policy` is not
accepted for LinkedIn replacement. An existing explicit block on the companion
is preserved, rather than silently removed. Snapchat-only updates do not activate
LinkedIn replacement.

The existing Apple BuiltIn deny-list budget is already full. LinkedIn's
immersive-video routes are enforced inside its companion; they do not displace
existing priority adult/proxy blocks. This does not filter LinkedIn in other
browsers. Existing explicit-content protection remains active in the companion.

## References

- [SocialLite](https://sociallite.app/) describes a filtered social-web experience.
- [LinkedIn's vertical-video help](https://www.linkedin.com/help/linkedin/answer/a6828545)
  describes the immersive feed and video tab.
- [Apple Personal Team limits](https://developer.apple.com/help/account/basics/about-your-developer-account)
  documents the three-app device limit.

## Local verification (September 7, 2026)

- Both standalone app targets built for the iOS 27 simulator.
- LinkedIn displayed its first-party sign-in form.
- Snapchat displayed its first-party login form directly after cold launch;
  its download-shell recovery button was also exercised successfully.
- Four targeted XCTest cases passed: JavaScript parsing, LinkedIn route policy,
  LinkedIn DOM filtering/control preservation, and untouched Snapchat login.
- Six runtime suites passed: Snapchat authentication, LinkedIn companion,
  phone updater, social feature probes, iOS MDM, and ManageEngine export.
- The broader `ios-social-build` source-contract suite still fails an existing
  Instagram empty-feed-container assertion in the pre-existing Instagram edits.
  Those unrelated edits were preserved.
- No physical deployment occurred: the paired iPhone was unreachable. Signed-in
  chat/feed behavior is not yet verified on the owner's phone.
