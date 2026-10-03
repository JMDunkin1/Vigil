// Keep this document-start guard shared with the Safari and native WebKit
// entry points. CSS matches newly parsed comments before an observer can scan
// them, and does not replace DOM nodes or change their accessible labels.
export function installYouTubeCommentAvatarMask(): void {
  // Authentication and consent documents must remain untouched, including
  // accounts.youtube.com helpers that share the YouTube domain suffix.
  const allowedHosts = new Set(["youtube.com", "www.youtube.com", "m.youtube.com"]);
  if (!allowedHosts.has(String(location.hostname || "").toLowerCase())) return;
  const styleID = "vigil-youtube-comment-avatars";
  if (document.getElementById(styleID)) return;

  // Reply expanders are siblings of the comment renderer and can show a
  // creator-thumbnail preview beside their show/hide replies controls.
  const comments = ":is(ytd-comment-renderer, ytd-comment-view-model, ytd-comment-replies-renderer, ytm-comment-renderer, ytm-comment-view-model, ytd-comment-simplebox-renderer, ytm-comment-simplebox-renderer, ytm-comments-entry-point-header-renderer, ytm-comments-entry-point-teaser-renderer)";
  const avatars = ":is(#author-thumbnail, #author-photo, #creator-thumbnail, .comment-icon-container, .comment-icon, .comment-author-thumbnail, .ytmCommentViewModelAuthorThumbnail, .ytmCommentViewModelAuthorAvatar, .ytmCommentViewModelAvatar, .yt-spec-avatar-shape, yt-avatar-shape)";
  const avatar = `${comments} ${avatars}`;
  const style = document.createElement("style");
  style.id = styleID;
  style.textContent = `
    ${avatar}, ${avatar} img, ${avatar} picture {
      background: #9e9e9e !important;
      border-radius: 50% !important;
      box-shadow: none !important;
      -webkit-mask-image: none !important;
      mask-image: none !important;
    }
    ${avatar}::before, ${avatar}::after {
      content: none !important;
      background-image: none !important;
    }
    ${avatar}:is(img), ${avatar} img {
      /* Move image pixels outside the existing image box. Intrinsic sizing,
         width/height, alt text, links, and focusability remain unchanged. */
      object-fit: none !important;
      object-position: 100000px 100000px !important;
      filter: none !important;
      content: normal !important;
    }
    ${avatar} :is(svg, canvas, video, object, embed) {
      opacity: 0 !important;
    }
  `;
  const install = (): void => {
    const root = document.head || document.documentElement;
    if (root && !style.isConnected) root.append(style);
  };
  // A document-start content script may precede <html>. Observe the document
  // immediately instead of waiting until DOMContentLoaded and the first paint.
  // Also restore the sheet if a SPA replaces <head> or removes the style node.
  new MutationObserver(install).observe(document, { childList: true, subtree: true });
  install();
}
