// BEGIN GENERATED YOUTUBE COMMENT AVATARS
(() => {
// Keep this document-start guard shared with the Safari and native WebKit
// entry points. CSS matches newly parsed comments before an observer can scan
// them, and does not replace DOM nodes or change their accessible labels.
function installYouTubeCommentAvatarMask() {
    // Authentication and consent documents must remain untouched, including
    // accounts.youtube.com helpers that share the YouTube domain suffix.
    const allowedHosts = new Set(["youtube.com", "www.youtube.com", "m.youtube.com"]);
    if (!allowedHosts.has(String(location.hostname || "").toLowerCase()))
        return;
    const styleID = "vigil-youtube-comment-avatars";
    if (document.getElementById(styleID))
        return;
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
    const install = () => {
        const root = document.head || document.documentElement;
        if (root && !style.isConnected)
            root.append(style);
    };
    // A document-start content script may precede <html>. Observe the document
    // immediately instead of waiting until DOMContentLoaded and the first paint.
    // Also restore the sheet if a SPA replaces <head> or removes the style node.
    new MutationObserver(install).observe(document, { childList: true, subtree: true });
    install();
}

installYouTubeCommentAvatarMask();
})();
// END GENERATED YOUTUBE COMMENT AVATARS
(() => {
  'use strict';

  if (window.top !== window) return;
  const currentHost = String(location.hostname || '').toLowerCase().replace(/^www\./, '');
  const maturePlatform = currentHost === 'reddit.com' || currentHost.endsWith('.reddit.com') || currentHost === 'redd.it'
    ? 'reddit'
    : currentHost === 'x.com' || currentHost.endsWith('.x.com') || currentHost === 'twitter.com' || currentHost.endsWith('.twitter.com')
      ? 'x'
      : null;
  if (maturePlatform) {
    installMatureContentInterlock(maturePlatform);
    return;
  }

  if (window.__vigilYouTubeParityInstalled) return;
  const allowedHosts = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com']);
  if (!allowedHosts.has(String(location.hostname || '').toLowerCase())) return;
  window.__vigilYouTubeParityInstalled = true;

  function installMatureContentInterlock(platform) {
    if (window.__vigilMatureContentInterlockInstalled) return;
    window.__vigilMatureContentInterlockInstalled = true;
    const normalizedText = value => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const ageGateRoute = value => {
      try {
        const url = new URL(String(value || ''), location.href);
        const host = url.hostname.toLowerCase().replace(/^www\./, '');
        return (host === 'reddit.com' || host.endsWith('.reddit.com')) && /^\/over18(?:\/|$)/i.test(url.pathname);
      } catch { return false; }
    };
    const safeDestination = platform === 'reddit' ? 'https://www.reddit.com/' : 'https://x.com/home';
    if (ageGateRoute(location.href)) {
      location.replace(safeDestination);
      return;
    }
    const markerText = value => /^(?:nsfw|18\+|mature content|adult content|sensitive content|this (?:media|post|profile|community) may contain sensitive (?:content|material))\.?$/i.test(normalizedText(value));
    const xMarkerText = value => /^(?:sensitive content|this (?:media|post|profile) may contain sensitive (?:content|material))\.?$/i.test(normalizedText(value));
    const revealText = value => {
      const text = normalizedText(value);
      return [
        /\b(?:show|display|view|reveal|see|allow|enable)\s+(?:(?:potentially\s+)?(?:sensitive|mature|adult|nsfw))(?:\s+(?:content|media|posts?|communities|profiles?|images?))?\b/i,
        /\bdisplay\s+media\s+that\s+may\s+contain\s+sensitive\s+(?:content|material)\b/i,
        /\b(?:yes[,]?\s*)?(?:i(?:'|’)m|i am)\s+(?:over\s+)?18\b/i,
        /\bcontinue(?:\s+to)?\s+(?:18\+|mature|adult|nsfw)\b/i,
        /\bshow\s+mature\s*\(?18\+\)?\s*content\b/i
      ].some(pattern => pattern.test(text));
    };
    const safeSelect = (selector, scope = document) => {
      const matches = [];
      try {
        if (scope instanceof HTMLElement && scope.matches(selector)) matches.push(scope);
        matches.push(...scope.querySelectorAll(selector));
      } catch {}
      return matches;
    };
    const contentContainer = element => {
      const selectors = platform === 'reddit'
        ? ['shreddit-post', 'article', '.thing', "[data-testid='post-container']", "[role='article']", '.Post', "[data-click-id='background']", "[role='dialog']"]
        : ['article', "[data-testid='cellInnerDiv']", "[role='article']", "[role='dialog']"];
      for (const selector of selectors) {
        const container = element.closest?.(selector);
        if (container instanceof HTMLElement) return container;
      }
      return null;
    };
    const markContent = marker => {
      const container = contentContainer(marker) || marker;
      if (!(container instanceof HTMLElement)) return;
      container.setAttribute('data-vigil-mature-content', 'blocked');
      container.querySelectorAll('video, audio').forEach(media => {
        try { media.pause(); } catch {}
      });
    };
    const controlDescriptor = element => {
      const values = [
        element.getAttribute?.('aria-label'), element.getAttribute?.('title'),
        element.getAttribute?.('data-testid'), element.getAttribute?.('name'),
        element.getAttribute?.('value'), element.textContent
      ];
      if (element instanceof HTMLInputElement) {
        for (const label of element.labels || []) values.push(label.textContent);
      }
      return normalizedText(values.filter(Boolean).join(' ').slice(0, 900));
    };
    const revealControl = element => {
      const descriptor = controlDescriptor(element);
      if (revealText(descriptor)) return true;
      if (!/^(?:show|view|continue|yes|enable|allow)$/i.test(descriptor)) return false;
      const context = element.closest?.("[role='dialog'], [role='menuitem'], label, li, form, article");
      return Boolean(context && /\b(?:nsfw|18\+|mature|adult|sensitive)\b/i.test(String(context.textContent || '').slice(0, 900)));
    };
    const blockControl = control => {
      if (!(control instanceof HTMLElement)) return;
      control.setAttribute('data-vigil-mature-control', 'blocked');
      control.setAttribute('aria-disabled', 'true');
      control.setAttribute('aria-hidden', 'true');
      control.setAttribute('tabindex', '-1');
      if (control instanceof HTMLButtonElement || control instanceof HTMLInputElement) control.disabled = true;
      if (control instanceof HTMLInputElement && (control.type === 'checkbox' || control.type === 'radio')) control.checked = false;
      const container = contentContainer(control);
      if (container && !control.closest("label, [role='menuitem'], form")) markContent(container);
    };
    let scanning = false;
    const scan = (scope = document) => {
      if (scanning || !document.documentElement) return;
      scanning = true;
      try {
        const structured = platform === 'reddit'
          ? ['shreddit-post[nsfw]', 'shreddit-post[over-18]', '.thing.over18', "[data-nsfw='true' i]", "[data-over-18='true' i]", "[data-over18='true' i]"]
          : ["[data-testid*='sensitiveMedia' i]", "[data-testid*='sensitive_media' i]", "[aria-label*='sensitive content' i]", "[aria-label*='sensitive media' i]"];
        for (const selector of structured) safeSelect(selector, scope).slice(0, 400).forEach(markContent);
        const textSelector = platform === 'reddit'
          ? ".thing .nsfw-stamp, [data-testid='post-container'] [class*='badge' i], shreddit-post [slot*='flair' i], [class*='nsfw' i], [data-testid*='label' i]"
          : "article span, [role='dialog'] span, [data-testid*='sensitive' i]";
        safeSelect(textSelector, scope)
          .slice(0, 800)
          .forEach(marker => { if (platform === 'x' ? xMarkerText(marker.textContent) : markerText(marker.textContent)) markContent(marker); });
        safeSelect("a[href], button, input, label, [role='button'], [role='switch'], [role='menuitem']", scope)
          .slice(0, 800)
          .forEach(control => { if (revealControl(control)) blockControl(control); });
      } finally { scanning = false; }
    };
    const install = () => {
      const root = document.documentElement;
      if (!root) return;
      root.setAttribute('data-vigil-mature-interlock', platform);
      if (!document.getElementById('vigil-mature-content-style')) {
        const style = document.createElement('style');
        style.id = 'vigil-mature-content-style';
        style.textContent = `
          html[data-vigil-mature-interlock] [data-vigil-mature-control="blocked"] { display: none !important; visibility: hidden !important; pointer-events: none !important; }
          html[data-vigil-mature-interlock] [data-vigil-mature-content="blocked"] img,
          html[data-vigil-mature-interlock] [data-vigil-mature-content="blocked"] picture,
          html[data-vigil-mature-interlock] [data-vigil-mature-content="blocked"] video,
          html[data-vigil-mature-interlock] [data-vigil-mature-content="blocked"] audio,
          html[data-vigil-mature-interlock] [data-vigil-mature-content="blocked"] canvas,
          html[data-vigil-mature-interlock] [data-vigil-mature-content="blocked"] iframe,
          html[data-vigil-mature-interlock] [data-vigil-mature-content="blocked"] object,
          html[data-vigil-mature-interlock] [data-vigil-mature-content="blocked"] embed,
          html[data-vigil-mature-interlock] [data-vigil-mature-content="blocked"] svg[role="img"],
          html[data-vigil-mature-interlock] [data-vigil-mature-content="blocked"] [style*="background-image" i] { display: none !important; visibility: hidden !important; pointer-events: none !important; background-image: none !important; }
          html[data-vigil-mature-interlock] [data-vigil-mature-content="blocked"]::before { content: "Mature media removed by Vigil"; display: block !important; box-sizing: border-box !important; margin: 8px 0 !important; padding: 14px 16px !important; border: 1px solid rgba(183,121,82,.55) !important; border-radius: 10px !important; background: #211d1a !important; color: #eadfd7 !important; font: 600 14px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif !important; text-align: center !important; }
        `;
        root.append(style);
      }
      scan();
      const guard = event => {
        if (event instanceof KeyboardEvent && event.key !== 'Enter' && event.key !== ' ') return;
        const target = (event.composedPath?.() || []).find(value => value instanceof HTMLElement)
          || (event.target instanceof HTMLElement ? event.target : null);
        if (!target) return;
        const control = target.closest("a[href], button, input, label, [role='button'], [role='switch'], [role='menuitem'], form") || target;
        const anchor = control.closest?.('a[href]');
        if (!control.closest("[data-vigil-mature-control='blocked']") && !revealControl(control) && !ageGateRoute(anchor?.href || '')) return;
        if (event.cancelable) event.preventDefault();
        event.stopImmediatePropagation();
        blockControl(control);
        if (anchor && ageGateRoute(anchor.href)) location.replace(safeDestination);
        scan();
      };
      for (const eventName of ['pointerdown', 'mousedown', 'touchstart', 'click', 'submit', 'change', 'input', 'keydown']) document.addEventListener(eventName, guard, true);
      new MutationObserver(records => {
        const scopes = new Set();
        for (const record of records) {
          if (record.target instanceof HTMLElement) scopes.add(record.target);
          else if (record.target.parentElement) scopes.add(record.target.parentElement);
          for (const node of record.addedNodes) {
            if (node instanceof HTMLElement) scopes.add(node);
            else if (node.parentElement) scopes.add(node.parentElement);
          }
        }
        if (scopes.size > 40) scan();
        else scopes.forEach(scan);
      }).observe(root, {
        childList: true, subtree: true, characterData: true, attributes: true,
        attributeFilter: ['aria-label', 'aria-checked', 'data-testid', 'href', 'nsfw', 'over-18', 'data-nsfw', 'data-over-18', 'data-over18', 'title']
      });
      addEventListener('pageshow', () => scan(), true);
      addEventListener('popstate', () => ageGateRoute(location.href) ? location.replace(safeDestination) : scan(), true);
      setInterval(() => ageGateRoute(location.href) ? location.replace(safeDestination) : scan(), 1500);
    };
    if (document.documentElement) install();
    else document.addEventListener('DOMContentLoaded', install, { once: true });
  }


  const STYLE_ID = 'vigil-youtube-parity-style';
  const MORE_VIDEOS_ATTRIBUTE = 'data-vigil-youtube-more-videos';
  const PLAYER_SELECTOR = 'ytm-player, ytd-player, #player-container-id, #player';
  const SEEK_CONTROL_SELECTOR = [
    '[role="slider"]', '[aria-valuenow]', 'input[type="range"]',
    '.ytp-progress-bar', '.ytp-progress-list', '.ytp-scrubber-container'
  ].join(',');
  const AD_PLAYER_STATE_SELECTOR = '.ad-showing, .ad-interrupting';
  const AD_SKIP_SELECTOR = [
    '.ytp-ad-skip-button', '.ytp-ad-skip-button-modern', '.ytp-skip-ad-button',
    '.ytp-ad-skip-button-container button', 'button[aria-label^="Skip ad" i]',
    'button[aria-label^="Skip ads" i]'
  ].join(',');
  const EDGE_GESTURE_WIDTH = 24;
  const html = document.documentElement;
  const focusedEntryURL = 'https://m.youtube.com/feed/subscriptions';
  let gesture = null;
  let adAuditTimer = 0;
  let adEpochPlayer = null;
  let attemptedSkipControl = null;
  let observedMoreVideosPlayerState = [];
  let moreVideosPlayerStateObserver = null;
  let suppressPlayerClickUntil = 0;

  const decodedPath = value => {
    let pathname = String(value || '/');
    for (let pass = 0; pass < 3; pass += 1) {
      try {
        const decoded = decodeURIComponent(pathname);
        if (decoded === pathname) break;
        pathname = decoded;
      } catch { break; }
    }
    return pathname.replace(/\\+/g, '/').toLowerCase();
  };
  const isShortsPath = pathname => /(?:^|\/)shorts(?:\/|$)/.test(decodedPath(pathname));
  const isShortsRoute = () => isShortsPath(location.pathname);
  const isWatchRoute = () => decodedPath(location.pathname) === '/watch';
  const recoverFromShorts = () => {
    if (!isShortsRoute()) return false;
    try { location.replace(focusedEntryURL); } catch { location.href = focusedEntryURL; }
    return true;
  };
  if (recoverFromShorts()) return;

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    ytd-comments, ytd-comments-header-renderer, ytd-comment-thread-renderer,
    ytd-item-section-renderer[section-identifier="comment-item-section"],
    ytm-comments-entry-point-header-renderer, ytm-comments-header-renderer,
    ytm-comment-section-renderer,
    ytm-engagement-panel-section-list-renderer[target-id*="comments" i],
    [section-identifier="comments-entry-point"], #comments, #comments-button,
    a[href*="#comments" i], button[aria-label*="comment" i],
    ytm-promoted-sparkles-web-renderer, ytd-promoted-sparkles-web-renderer,
    ytm-companion-ad-renderer, ytd-companion-slot-renderer,
    ytm-display-ad-renderer, ytd-display-ad-renderer,
    ytm-promoted-video-renderer, ytd-promoted-video-renderer,
    ytm-ad-slot-renderer, ytd-ad-slot-renderer,
    ytm-in-feed-ad-layout-renderer, ytd-in-feed-ad-layout-renderer,
    ytd-banner-promo-renderer, #masthead-ad {
      display: none !important; visibility: hidden !important; pointer-events: none !important;
    }
    html:not([${MORE_VIDEOS_ATTRIBUTE}="allowed"]) :is(
      ytm-player, ytd-player, .html5-video-player
    ) :is(
      .ytp-more-videos-button, .ytp-more-videos-view, .ytp-fullscreen-grid,
      .ytp-pause-overlay, .ytp-pause-overlay-container, .ytp-endscreen-content
    ),
    html:not([${MORE_VIDEOS_ATTRIBUTE}="allowed"]) :is(
      ytm-fullscreen-related-videos-entry-point-view-model,
      .ytmFullscreenRelatedVideosEntryPointViewModelHost,
      .fullscreen-watch-next-entrypoint-wrapper, .fullscreen-more-videos-endpoint,
      .fullscreen-recommendations-wrapper, .fullscreen-recommendation,
      .ytFullscreenVideoRecommendationsHost,
      .ytFullscreenVideoRecommendationsRecommendation
    ) {
      visibility: hidden !important; opacity: 0 !important; pointer-events: none !important;
    }
    :is(ytm-player, ytd-player),
    :is(ytm-player, ytd-player) :is(video, .html5-video-container, .ytp-cued-thumbnail-overlay-image) {
      touch-action: pan-x pan-down pinch-zoom !important;
    }
  `;
  const installStyle = () => {
    if (!document.getElementById(STYLE_ID)) (document.head || html).append(style);
  };
  const mainVideo = () => Array.from(document.querySelectorAll('video'))
    .filter(video => {
      const rect = video.getBoundingClientRect();
      return rect.width >= 180 && rect.height >= 90;
    })
    .sort((left, right) => {
      const leftRect = left.getBoundingClientRect();
      const rightRect = right.getBoundingClientRect();
      const leftPlayer = left.closest(PLAYER_SELECTOR) ? 10_000_000 : 0;
      const rightPlayer = right.closest(PLAYER_SELECTOR) ? 10_000_000 : 0;
      return (rightPlayer + rightRect.width * rightRect.height)
        - (leftPlayer + leftRect.width * leftRect.height);
    })[0] || null;
  let seekBurst = null, tapStart = null, lastPlayerTap = null;
  let suppressSeekClickUntil = 0;
  const seekBy = (video, seconds) => {
    if (!video || !Number.isFinite(video.currentTime)
        || video.closest('.ad-showing, .ad-interrupting')) return false;
    const now = performance.now();
    // WebKit may still expose the pre-seek position during consecutive taps.
    // Accumulate against our last requested target until that burst ends.
    const base = seekBurst?.video === video && now - seekBurst.at < 600
      ? seekBurst.position : video.currentTime;
    const maximum = Number.isFinite(video.duration) ? Math.max(0, video.duration - .01) : Infinity;
    const position = Math.max(0, Math.min(maximum, base + seconds));
    try { video.currentTime = position; } catch { return false; }
    seekBurst = { video, position, at: now };
    return true;
  };
  const seekControlDelta = target => {
    const control = target?.closest('button, [role="button"]');
    if (!control?.closest(PLAYER_SELECTOR)) return 0;
    const label = `${control.getAttribute('aria-label') || ''} ${control.getAttribute('title') || ''}`.trim();
    if (!/\b10\s*(?:seconds?|s)\b/i.test(label)) return 0;
    if (/\b(?:forward|ahead)\b/i.test(label)) return 10;
    if (/\b(?:backward|back|rewind)\b/i.test(label)) return -10;
    return 0;
  };
  const playerForVideo = video => video?.closest('ytm-player')
    || video?.closest('ytd-player') || video?.closest('#player-container-id')
    || video?.closest('#player') || video?.parentElement || null;
  const videoIsFullscreen = video => Boolean(
    document.fullscreenElement || document.webkitFullscreenElement || video?.webkitDisplayingFullscreen
  );
  const moreVideosAllowedForState = (fullscreen, width, height) => Boolean(
    fullscreen && Number(width) > Number(height) && Number(height) > 0
  );
  const playerIsExpandedFullscreen = video => videoIsFullscreen(video)
    || Boolean(video?.closest(
      '.html5-video-player.ytp-fullscreen, ytm-player[fullscreen], ytd-player[fullscreen]'
    ));
  const observeMoreVideosPlayerState = video => {
    const candidates = [video?.closest('.html5-video-player'), video?.closest('ytm-player'),
      video?.closest('ytd-player')].filter((value, index, all) => value && all.indexOf(value) === index);
    if (candidates.length === observedMoreVideosPlayerState.length
        && candidates.every((value, index) => value === observedMoreVideosPlayerState[index])) return;
    moreVideosPlayerStateObserver?.disconnect();
    observedMoreVideosPlayerState = candidates;
    moreVideosPlayerStateObserver = new MutationObserver(scheduleMoreVideosAvailability);
    candidates.forEach(value => moreVideosPlayerStateObserver.observe(value, {
      attributes: true, attributeFilter: ['class', 'fullscreen']
    }));
  };
  const updateMoreVideosAvailability = () => {
    const video = mainVideo();
    observeMoreVideosPlayerState(video);
    const width = Number(window.visualViewport?.width || innerWidth || 0);
    const height = Number(window.visualViewport?.height || innerHeight || 0);
    const allowed = moreVideosAllowedForState(playerIsExpandedFullscreen(video), width, height);
    const value = allowed ? 'allowed' : 'suppressed';
    if (html.getAttribute(MORE_VIDEOS_ATTRIBUTE) !== value) html.setAttribute(MORE_VIDEOS_ATTRIBUTE, value);
    return allowed;
  };
  let moreVideosUpdatePending = false;
  function scheduleMoreVideosAvailability() {
    if (moreVideosUpdatePending) return;
    moreVideosUpdatePending = true;
    requestAnimationFrame(() => {
      moreVideosUpdatePending = false;
      installStyle(); updateMoreVideosAvailability();
    });
  }
  const enterFullscreen = video => {
    if (!video || videoIsFullscreen(video)) return false;
    const control = playerForVideo(video)?.querySelector(
      '.ytp-fullscreen-button, button[aria-label*="full screen" i], button[title*="full screen" i]'
    );
    try {
      if (control instanceof HTMLElement) control.click();
      else if (typeof video.webkitEnterFullscreen === 'function') video.webkitEnterFullscreen();
      else if (typeof video.requestFullscreen === 'function') void video.requestFullscreen();
      else return false;
      return true;
    } catch { return false; }
  };
  const visibleElement = element => {
    if (!(element instanceof Element) || !element.isConnected) return false;
    const computedStyle = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return computedStyle.display !== 'none' && computedStyle.visibility !== 'hidden'
      && rect.width > 0 && rect.height > 0;
  };
  const suppressYouTubeAds = () => {
    const player = Array.from(document.querySelectorAll(AD_PLAYER_STATE_SELECTOR))
      .find(value => value.querySelector('video'));
    if (!player) { adEpochPlayer = null; attemptedSkipControl = null; return false; }
    if (player !== adEpochPlayer) { adEpochPlayer = player; attemptedSkipControl = null; }
    const skip = Array.from(player.querySelectorAll(AD_SKIP_SELECTOR))
      .find(value => visibleElement(value) && !value.matches(':disabled, [aria-disabled="true"]'));
    if (!(skip instanceof HTMLElement)) {
      if (attemptedSkipControl && (!visibleElement(attemptedSkipControl)
          || attemptedSkipControl.matches(':disabled, [aria-disabled="true"]'))) {
        attemptedSkipControl = null;
      }
      return false;
    }
    if (skip === attemptedSkipControl) return false;
    attemptedSkipControl = skip;
    try { skip.click(); return true; } catch { attemptedSkipControl = null; return false; }
  };
  const scheduleAdAudit = () => {
    if (adAuditTimer) return;
    adAuditTimer = setTimeout(() => { adAuditTimer = 0; suppressYouTubeAds(); }, 80);
  };
  const blocksPlayerGesture = (target, player) => {
    if (!target || !player) return true;
    if (target.closest(SEEK_CONTROL_SELECTOR)
        || target.closest('a, input, textarea, select')) return true;
    const button = target.closest('button, [role="button"]');
    if (!button || !player.contains(button)) return false;
    const buttonRect = button.getBoundingClientRect();
    const playerRect = player.getBoundingClientRect();
    return buttonRect.width < playerRect.width * 0.72
      || buttonRect.height < playerRect.height * 0.72;
  };
  const resetGesture = () => {
    const active = gesture;
    gesture = null;
    active?.player.removeAttribute('data-vigil-youtube-gesture-player');
    if (active) {
      active.player.style.transform = active.originalTransform;
      active.player.style.transition = active.originalTransition;
    }
  };
  const beginGesture = (event, point, pointerID = null) => {
    const target = event.target instanceof Element ? event.target : null;
    const video = mainVideo();
    const player = playerForVideo(video);
    if (!point || !isWatchRoute() || videoIsFullscreen(video) || !video || !player
        || point.clientX <= EDGE_GESTURE_WIDTH || point.clientX >= innerWidth - EDGE_GESTURE_WIDTH
        || !(target === player || player.contains(target)) || blocksPlayerGesture(target, player)) return;
    player.setAttribute('data-vigil-youtube-gesture-player', 'true');
    gesture = {
      player, video, pointerID, startX: point.clientX, startY: point.clientY,
      lastX: point.clientX, lastY: point.clientY, startedAt: performance.now(),
      originalTransform: player.style.transform, originalTransition: player.style.transition
    };
  };
  const moveGesture = (event, point, pointerID = null) => {
    if (!gesture || !point || (gesture.pointerID != null && gesture.pointerID !== pointerID)) return;
    const dx = point.clientX - gesture.startX;
    const dy = point.clientY - gesture.startY;
    gesture.lastX = point.clientX;
    gesture.lastY = point.clientY;
    // Downward movement belongs to YouTube/WebKit. Only upward fullscreen is custom.
    if (dy >= 0 || Math.abs(dy) < Math.abs(dx) * 1.15 || Math.abs(dy) < 10) return;
    event.preventDefault();
    const progress = Math.max(-72, dy);
    gesture.player.style.transition = 'none';
    gesture.player.style.transform = `translate3d(0, ${progress}px, 0)`;
  };
  const endGesture = (event, point, pointerID = null) => {
    if (!gesture || (gesture.pointerID != null && gesture.pointerID !== pointerID)) return;
    const active = gesture;
    const dx = (point?.clientX ?? active.lastX) - active.startX;
    const dy = (point?.clientY ?? active.lastY) - active.startY;
    const velocity = dy / Math.max(1, performance.now() - active.startedAt) * 1000;
    resetGesture();
    if (Math.abs(dy) > Math.abs(dx) * 1.15 && (dy <= -72 || velocity <= -520)
        && enterFullscreen(active.video)) suppressPlayerClickUntil = performance.now() + 500;
  };
  const cancelGesture = pointerID => {
    if (gesture?.pointerID != null && gesture.pointerID !== pointerID) return;
    resetGesture();
  };

  if ('PointerEvent' in window) {
    document.addEventListener('pointerdown', event => {
      if ((!event.pointerType || event.pointerType === 'touch') && event.isPrimary) {
        beginGesture(event, event, event.pointerId);
      }
    }, { capture: true, passive: true });
    document.addEventListener('pointermove', event => {
      if (event.isPrimary) moveGesture(event, event, event.pointerId);
    }, { capture: true, passive: false });
    document.addEventListener('pointerup', event => {
      if (event.isPrimary) endGesture(event, event, event.pointerId);
    }, { capture: true, passive: true });
    document.addEventListener('pointercancel', event => cancelGesture(event.pointerId), true);
  } else {
    const point = event => event.changedTouches?.[0] || event.touches?.[0] || null;
    document.addEventListener('touchstart', event => {
      if (event.touches.length === 1) beginGesture(event, point(event));
    }, { capture: true, passive: true });
    document.addEventListener('touchmove', event => {
      if (event.touches.length === 1) moveGesture(event, point(event));
    }, { capture: true, passive: false });
    document.addEventListener('touchend', event => endGesture(event, point(event)), {
      capture: true, passive: true
    });
    document.addEventListener('touchcancel', () => cancelGesture(), true);
  }

  document.addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target : null;
    if (event.isTrusted && target?.closest(PLAYER_SELECTOR)) {
      if (performance.now() < suppressSeekClickUntil) {
        event.preventDefault(); event.stopImmediatePropagation(); return;
      }
      const delta = seekControlDelta(target);
      if (delta && seekBy(mainVideo(), delta)) {
        event.preventDefault(); event.stopImmediatePropagation(); return;
      }
    }
    if (performance.now() < suppressPlayerClickUntil && target?.closest(PLAYER_SELECTOR)) {
      event.preventDefault(); event.stopImmediatePropagation(); return;
    }
    const link = target?.closest('a[href]');
    if (!(link instanceof HTMLAnchorElement)) return;
    let destination;
    try { destination = new URL(link.href, location.href); } catch { return; }
    if (allowedHosts.has(destination.hostname.toLowerCase()) && isShortsPath(destination.pathname)) {
      event.preventDefault(); event.stopImmediatePropagation(); location.assign(focusedEntryURL);
    }
  }, true);

  // Handle completed taps rather than waiting for YouTube's seek animation.
  // Sliders, controls, edge gestures, drags and multiple fingers stay native.
  document.addEventListener('touchstart', event => {
    tapStart = null;
    if (!event.isTrusted || event.touches.length !== 1 || !isWatchRoute()) return;
    const target = event.target instanceof Element ? event.target : null;
    const video = mainVideo(), player = playerForVideo(video);
    const point = event.touches[0];
    if (!player || !target || !player.contains(target) || blocksPlayerGesture(target, player)) return;
    const rect = video.getBoundingClientRect();
    if (point.clientX <= EDGE_GESTURE_WIDTH || point.clientX >= innerWidth - EDGE_GESTURE_WIDTH
        || point.clientY < rect.top || point.clientY > rect.bottom) return;
    const fraction = (point.clientX - rect.left) / rect.width;
    const side = fraction < .4 ? -1 : fraction > .6 ? 1 : 0;
    if (side) tapStart = { video, side, x: point.clientX, y: point.clientY, at: performance.now() };
  }, { capture: true, passive: true });
  document.addEventListener('touchend', event => {
    const tap = tapStart; tapStart = null;
    const point = event.changedTouches?.[0], now = performance.now();
    if (!event.isTrusted || !tap || !point || event.touches.length || now - tap.at > 300
        || Math.hypot(point.clientX - tap.x, point.clientY - tap.y) > 12) { lastPlayerTap = null; return; }
    const consecutive = lastPlayerTap?.video === tap.video && lastPlayerTap.side === tap.side
      && now - lastPlayerTap.at < 350;
    lastPlayerTap = { video: tap.video, side: tap.side, at: now };
    if (consecutive && seekBy(tap.video, tap.side * 10)) {
      suppressSeekClickUntil = now + 400;
      event.preventDefault(); event.stopImmediatePropagation();
    }
  }, { capture: true, passive: false });
  document.addEventListener('touchcancel', () => { tapStart = null; lastPlayerTap = null; }, true);
  document.addEventListener('seeking', event => {
    // A timeline drag supersedes the accumulated button/double-tap target.
    if (event.target === seekBurst?.video && performance.now() - seekBurst.at >= 600) seekBurst = null;
  }, true);

  installStyle();
  updateMoreVideosAvailability();
  const mutationChangesPlayerTopology = mutation => {
    const selector = `${PLAYER_SELECTOR}, video`;
    return [...mutation.addedNodes, ...mutation.removedNodes].some(node => (
      node instanceof Element && (node.matches(selector) || node.querySelector(selector))
    ));
  };
  new MutationObserver(mutations => {
    if (mutations.some(value => [...value.addedNodes].some(node => node instanceof Element))) scheduleAdAudit();
    if (mutations.some(mutationChangesPlayerTopology)) {
      scheduleMoreVideosAvailability();
    }
    recoverFromShorts();
  }).observe(html, { childList: true, subtree: true });
  for (const name of [
    'popstate', 'pageshow', 'yt-navigate-finish', 'yt-page-data-updated',
    'state-navigateend', 'state-navigatecomplete', '__vigilRouteChanged'
  ]) {
    addEventListener(name, recoverFromShorts, true);
    document.addEventListener(name, recoverFromShorts, true);
  }
  for (const name of ['fullscreenchange', 'webkitfullscreenchange',
    'webkitbeginfullscreen', 'webkitendfullscreen']) {
    document.addEventListener(name, scheduleMoreVideosAvailability, true);
  }
  addEventListener('resize', scheduleMoreVideosAvailability);
  addEventListener('orientationchange', scheduleMoreVideosAvailability);
  window.visualViewport?.addEventListener('resize', scheduleMoreVideosAvailability);
  document.addEventListener('play', scheduleAdAudit, true);
  document.addEventListener('durationchange', scheduleAdAudit, true);
  suppressYouTubeAds();
  setInterval(() => {
    installStyle(); suppressYouTubeAds(); updateMoreVideosAvailability(); recoverFromShorts();
  }, 1000);

  Object.defineProperty(window, '__vigilYouTubeParityTest', {
    configurable: false,
    enumerable: false,
    value: Object.freeze({
      suppressYouTubeAds, moreVideosAllowedForState, updateMoreVideosAvailability,
      enterFullscreen, playerForVideo, isShortsRoute, isWatchRoute, seekBy
    })
  });
})();
