# Received Snapchat stickers

Snapchat Support documents holding a chat sticker and choosing Add to Favorites:
https://help.snapchat.com/hc/en-us/articles/7012378954388-What-can-I-send-in-Chat-on-Snapchat

The public Snapchat Web bundle served on 2026-11-01
(`https://cf-st.sc-cdn.net/dw/02365173525f5f81a3c6.js`) renders received
stickers but does not expose that Favorites action. Its composer accepts image
files through its existing `onPaste` handler and stages an attachment before
the user presses Send.

Vigil therefore keeps a phone-local collection, using the Snapchat website
data store's identity to separate Vigil account profiles. Save sticker appears
under the verified `.KB4Aq .p8r1z` Bitmoji and creative-tool image renderers
(`img.qHVR1`, `.rBYFf img.pjJv3`). Avatars, quoted previews, reactions, Snap
viewers, cameras and ordinary photo attachments are excluded. Unknown layouts
receive no save control. Reuse stages a transparent PNG attachment rather than
creating an account-level Snapchat Favorite. Animation is flattened to a still.

Save/use recheck the document, current chat/source, page/media verdicts,
foreground visibility, privacy shields, and native service access. Native
classification runs before saving or reusing. Thumbnails use the existing media
inspector. Storage validates PNG dimensions, SHA-256 identity, safe filenames,
64-item/32-MiB collection limits and 4-MiB individual limits.

Validation: `node scripts/test-snapchat-stickers-webkit.mjs` exercises WebKit
save/CORS fallback, drawer, image-file paste, removal, privacy denial and a source
change during saving. Native XCTest cases cover persistence, transparency,
account-profile isolation, quotas and the production bridge. The local XCTest
runner could not establish its simulator test-daemon connection; the production
storage class was additionally compiled and run directly in the iOS simulator,
where persistence, exact bytes, deduplication, isolation, invalid paths/images,
quota and removal passed. iOS app/test compilation, lint, build, and targeted
social route/restriction regressions passed.
