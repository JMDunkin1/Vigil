# Snapchat photo groups and Camera Roll export

## Supported Snapchat paths

The request is to save a photo dump already saved in a chat, with a control
attached to the pictures. The permanent native save bar from `5f57228` was
removed by `86fbde1` after user feedback; it must not return. Preserve the
working opened-photo save and camera behavior.

- [Snapchat: saved Snaps in Chat](https://help.snapchat.com/hc/en-gb/articles/7012354501524-When-I-save-a-Snap-in-Chat-where-is-it-stored)
  says saved chat media lives on Snapchat's servers and may be exported to
  Camera Roll. This does not document a Web bulk-export interface.
- [Snapchat: download from Memories](https://help.snapchat.com/hc/en-gb/articles/7047492542484-How-do-I-download-a-Snap-from-Memories)
  documents selecting multiple Memories and exporting them together. Memories
  is a different collection from photos saved in a conversation.
- [Snapchat: My Data](https://help.snapchat.com/hc/en-us/articles/7012305371156-How-do-I-download-my-data-from-Snapchat)
  lists Saved Chat History and documents bulk downloading Memories. It does
  not promise an archive of every original photo in saved chats. Do not sell
  this as a guaranteed solution to chat photo dumps.
- [Snapchat: connected apps](https://help.snapchat.com/hc/en-us/articles/7012393350676-How-do-I-remove-a-connected-app-from-Snapchat)
  limits external partner account-data requests to Display Name and Bitmoji.
  There is no documented Snap Kit chat-photo export API in this supported
  integration. [Its third-party-app guidance](https://help.snapchat.com/hc/en-us/articles/7012343686932-Can-I-use-third-party-apps-or-plugins-with-Snapchat)
  also makes clear that an added feature is not thereby Snapchat authorized.

Therefore this implementation is a Vigil compatibility feature, **not an
officially approved Snapchat exporter**. It does not use credentials, private
messaging APIs, undocumented export endpoints, or synthetic save notifications.
No authenticated account, conversation, or actual photo was accessed during
research or testing.

## Web-client evidence

Inspected the public [Snapchat Web entry point](https://www.snapchat.com/web/)
and its returned [production client](https://cf-st.sc-cdn.net/dw/14a374cb957e6774b9f0.js)
and [stylesheet](https://cf-st.sc-cdn.net/dw/eceeacedbecc23dae201.css)
on October 28, 2026. The same bundle inspected in the October 26 research still
renders an external-media message as `.ET_CR`: one direct `div` per attachment.
Each attachment has its own media player and original photo/caption layers.
The stylesheet makes this a wrapping flex group. The context menu offers
save-in-chat/reply/reactions; the camera's download action exports the current
capture. Neither establishes a chat-group Camera Roll action.

The existing exporter only resolves an opened lightbox or camera preview. A
group must export each attachment separately; flattening every image in the
message into one canvas would stack unrelated photos on top of each other.

## Implementation

The original group gains **Save N photos to Camera Roll** immediately beneath
its pictures, inside that message. There is no permanent bar or feed-wide save
control. Single-photo opening/export stays available. Video attachments are
excluded from the count and export. Incomplete attachment trees wait for
Snapchat to mount their media before offering a group action.

Only the selected, currently mounted group is processed. This does not fetch
conversation history, recover expired media, or open private mobile surfaces.
It depends on Snapchat continuing to expose the observed attachment structure.

Each photo retains its own complete frame and approved image caption/sticker
layers. A group uses one canvas/payload/Photos transaction at a time, with the
existing 32 MiB and 80-million-pixel limits per photo. Canvas backing storage
is released after encoding. Offscreen attachments enter the ordinary media
classifier through a narrow inspection event, without scrolling or changing
their verdicts. Unknown/sensitive photos cannot export; the final composed
image is also classified natively.

Progress counts only confirmed Photos completions. Stop prevents further
writes, with the usual limit that a Photos transaction already committed may
finish. Retry within an unchanged mounted group skips successful photos.
Source, membership, route, privacy-screen, page-verdict, focus, foreground, and
document checks remain required. Backgrounding/navigation stops the group.
The normal Photos permission sheet may temporarily take focus; foreground and
policy are checked again after authorization.

Native queue ownership is released before acknowledging a photo, so an
immediate next request cannot be silently discarded. Each native save refreshes
a stale access receipt through the real policy check, including after a long
group or permission prompt. A slow Photos operation retains its pending
request instead of reporting a timeout failure that could cause a duplicate
retry. [Apple's add-only access](https://developer.apple.com/documentation/photos/phaccesslevel/addonly)
and [asynchronous change completion](https://developer.apple.com/documentation/photos/phphotolibrary/performchanges(_:completionhandler:))
remain the Photos integration; no photo-library reading permission is added.

## Validation and limits

Six focused native WebKit tests passed, with zero skipped. They cover:

- A 64-photo group, a mixed video attachment, all 64 independent output frames,
  and exact original-edge and caption/sticker pixels in every output.
- A partial Photos failure followed by a retry of only unwritten photos;
  unchanged-source/membership checks; unknown caption layers; away/screenshot
  shields; page restrictions; route changes; stopping after an already-committed
  photo; and simulated background/return without automatically resuming.
- Twenty sequential writes to the simulator's real Photos library through the
  actual bridge, including offscreen classification, a tappable contextual
  control, and live policy refresh after explicitly invalidating the receipt.
- Existing opened-photo native Photos saving, original photo/caption pixel
  preservation and privacy rejection, and absence of a permanent save bar.

Seven focused runtime suites passed: Snapchat media, authentication and
coexistence, social build/container, route boundaries, and orientation. Runtime
build/type checking, repository source lint, and the unsigned combined iPhone
build also passed. The simulator UI completion attachment was inspected.

The first beta-Xcode attempts could not connect to the selected installed
runtime. Xcode.app ran the tests successfully. Disabling verbose test diagnostic
collection avoided a subsequent diagnostic-collection stall after passing tests.
The final result bundle reports six passed, zero failed, zero skipped.

Fixtures use generated, fictional PNGs and a classifier stub. They establish
export integration and safety gating, not the classifier model's accuracy.
Authenticated Snapchat behavior and a physical-phone photo dump still require
device verification. No phone install, policy/profile replacement, supervision
operation, production-app termination, or watchdog change is part of this work.
