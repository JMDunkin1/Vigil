(() => {
  'use strict';

  if (window.top !== window || window.__vigilYouTubeParityInstalled) return;
  const allowedHosts = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com']);
  if (!allowedHosts.has(String(location.hostname || '').toLowerCase())) return;
  window.__vigilYouTubeParityInstalled = true;

  const MINI_ATTRIBUTE = 'data-vigil-youtube-miniplayer';
  const SHELL_ID = 'vigil-youtube-miniplayer-shell';
  const STYLE_ID = 'vigil-youtube-parity-style';
  const WATCH_SELECTOR = 'ytm-watch, ytd-watch-flexy, [page-subtype="watch"]';
  const PLAYER_SELECTOR = 'ytm-player, ytd-player, #player-container-id, #player';
  const SEEK_CONTROL_SELECTOR = [
    '[role="slider"]', '[aria-valuenow]', 'input[type="range"]',
    '.ytp-progress-bar', '.ytp-progress-list', '.ytp-scrubber-container'
  ].join(',');
  const FORM_CONTROL_SELECTOR = 'a, input, textarea, select';
  const EDGE_GESTURE_WIDTH = 24;
  const html = document.documentElement;

  let gesture = null;
  let miniPlayer = null;
  let miniVideo = null;
  let miniVideoID = '';
  let lastRoute = location.href;
  let suppressPlayerClickUntil = 0;

  const decodedPathname = () => {
    let pathname = String(location.pathname || '/');
    for (let pass = 0; pass < 3; pass += 1) {
      try {
        const decoded = decodeURIComponent(pathname);
        if (decoded === pathname) break;
        pathname = decoded;
      } catch {
        break;
      }
    }
    return pathname.replace(/\\+/g, '/').toLowerCase();
  };

  const isShortsRoute = () => /(?:^|\/)shorts(?:\/|$)/.test(decodedPathname());
  const isWatchRoute = () => decodedPathname() === '/watch';

  const recoverFromShorts = () => {
    if (!isShortsRoute()) return false;
    try {
      location.replace('https://m.youtube.com/');
    } catch {
      location.href = 'https://m.youtube.com/';
    }
    return true;
  };

  if (recoverFromShorts()) return;

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    html[${MINI_ATTRIBUTE}="true"] {
      --vigil-youtube-mini-height: 64px;
      --vigil-youtube-mini-bottom: calc(env(safe-area-inset-bottom, 0px) + 58px);
      scroll-padding-bottom: calc(var(--vigil-youtube-mini-height) + var(--vigil-youtube-mini-bottom) + 12px) !important;
    }
    html[${MINI_ATTRIBUTE}="true"] body {
      padding-bottom: calc(var(--vigil-youtube-mini-height) + 72px) !important;
    }
    html[${MINI_ATTRIBUTE}="true"] [data-vigil-youtube-active-player="true"] {
      position: fixed !important;
      z-index: 2147483646 !important;
      left: 8px !important;
      right: auto !important;
      top: auto !important;
      bottom: var(--vigil-youtube-mini-bottom) !important;
      width: 114px !important;
      height: var(--vigil-youtube-mini-height) !important;
      min-width: 114px !important;
      min-height: var(--vigil-youtube-mini-height) !important;
      max-width: 114px !important;
      max-height: var(--vigil-youtube-mini-height) !important;
      margin: 0 !important;
      border-radius: 10px 0 0 10px !important;
      overflow: hidden !important;
      background: #000 !important;
      box-shadow: 0 8px 24px rgba(0, 0, 0, .34) !important;
      transform: translate3d(var(--vigil-mini-drag-x, 0px), var(--vigil-mini-drag-y, 0px), 0) !important;
      transition: transform 180ms ease, opacity 180ms ease !important;
      touch-action: none !important;
    }
    html[${MINI_ATTRIBUTE}="true"] [data-vigil-youtube-active-player="true"] video {
      width: 100% !important;
      height: 100% !important;
      object-fit: cover !important;
    }
    html[${MINI_ATTRIBUTE}="true"] [data-vigil-youtube-active-player="true"] :is(
      #player-container-id, #player, .html5-video-player, .html5-video-container
    ) {
      position: absolute !important;
      inset: 0 !important;
      width: 100% !important;
      height: 100% !important;
      min-width: 0 !important;
      min-height: 0 !important;
      max-width: none !important;
      max-height: none !important;
    }
    html[${MINI_ATTRIBUTE}="true"] [data-vigil-youtube-active-player="true"] :is(
      .ytp-chrome-bottom, .ytp-chrome-top, .ytp-gradient-bottom, .ytp-gradient-top,
      .ytp-pause-overlay, .ytp-ce-element, .ytp-cued-thumbnail-overlay,
      .ytp-spinner, .ytp-bezel, .ytp-paid-content-overlay
    ) {
      display: none !important;
    }
    #${SHELL_ID} {
      all: initial;
      box-sizing: border-box;
      position: fixed;
      z-index: 2147483645;
      left: 8px;
      right: 8px;
      bottom: calc(env(safe-area-inset-bottom, 0px) + 58px);
      height: 64px;
      display: flex;
      align-items: center;
      padding: 0 6px 0 122px;
      border-radius: 10px;
      overflow: hidden;
      color: #fff;
      background: rgba(28, 28, 30, .98);
      box-shadow: 0 8px 24px rgba(0, 0, 0, .34);
      font: 500 13px/1.25 -apple-system, BlinkMacSystemFont, sans-serif;
      -webkit-user-select: none;
      user-select: none;
      touch-action: none;
      transform: translate3d(var(--vigil-mini-drag-x, 0px), var(--vigil-mini-drag-y, 0px), 0);
      transition: transform 180ms ease, opacity 180ms ease;
    }
    #${SHELL_ID} .vigil-youtube-mini-title {
      all: initial;
      box-sizing: border-box;
      min-width: 0;
      flex: 1;
      overflow: hidden;
      color: #fff;
      font: 500 13px/1.25 -apple-system, BlinkMacSystemFont, sans-serif;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    #${SHELL_ID} button {
      all: initial;
      box-sizing: border-box;
      width: 42px;
      height: 56px;
      display: grid;
      place-items: center;
      color: #fff;
      font: 500 24px/1 -apple-system, BlinkMacSystemFont, sans-serif;
      text-align: center;
      -webkit-tap-highlight-color: transparent;
    }
    #${SHELL_ID} button:focus-visible {
      outline: 2px solid #fff;
      outline-offset: -4px;
      border-radius: 8px;
    }
    :is(ytm-player, ytd-player),
    :is(ytm-player, ytd-player) :is(video, .html5-video-container, .ytp-cued-thumbnail-overlay-image) {
      touch-action: pan-x pinch-zoom !important;
    }
    @media (prefers-reduced-motion: reduce) {
      html[${MINI_ATTRIBUTE}="true"] [data-vigil-youtube-active-player="true"],
      #${SHELL_ID} { transition: none !important; }
    }
  `;

  const installStyle = () => {
    if (!document.getElementById(STYLE_ID)) {
      (document.head || document.documentElement).append(style);
    }
  };

  const videoID = () => new URL(location.href).searchParams.get('v') || '';

  const mainVideo = () => {
    const videos = Array.from(document.querySelectorAll('video'));
    return videos
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
  };

  const playerForVideo = video => {
    if (!video) return null;
    // Move the outer player host. Moving the inner #player leaves it clipped
    // by ytm-player's overflow/transform containment on the live mobile site.
    return video.closest('ytm-player')
      || video.closest('ytd-player')
      || video.closest('#player-container-id')
      || video.closest('#player')
      || video.parentElement;
  };

  const videoIsFullscreen = video => Boolean(
    document.fullscreenElement
      || document.webkitFullscreenElement
      || video?.webkitDisplayingFullscreen
  );

  const enterFullscreen = video => {
    if (!video || videoIsFullscreen(video)) return false;
    const player = playerForVideo(video);
    const control = player?.querySelector(
      '.ytp-fullscreen-button, button[aria-label*="full screen" i], button[title*="full screen" i]'
    );
    try {
      if (control instanceof HTMLElement) control.click();
      else if (typeof video.webkitEnterFullscreen === 'function') video.webkitEnterFullscreen();
      else if (typeof video.requestFullscreen === 'function') void video.requestFullscreen();
      else return false;
      return true;
    } catch {
      return false;
    }
  };

  const blocksPlayerGesture = (target, player, point) => {
    if (!target || !player || !point) return true;
    if (target.closest(SEEK_CONTROL_SELECTOR) || target.closest(FORM_CONTROL_SELECTOR)) return true;
    const button = target.closest('button, [role="button"]');
    if (!button || !player.contains(button)) return false;
    const buttonRect = button.getBoundingClientRect();
    const playerRect = player.getBoundingClientRect();
    // YouTube sometimes implements the whole video canvas as an invisible
    // button. Preserve real, compact controls but do not let that full-player
    // hit target make the swipe unreachable.
    return buttonRect.width < playerRect.width * .72
      || buttonRect.height < playerRect.height * .72;
  };

  const titleText = () => {
    const metadata = document.querySelector('meta[name="title"], meta[property="og:title"]');
    const heading = document.querySelector(`${WATCH_SELECTOR} h1, ytm-watch-metadata h1, h1.title`);
    return String(heading?.textContent || metadata?.content || document.title || 'YouTube')
      .replace(/\s+-\s+YouTube\s*$/i, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 160) || 'YouTube';
  };

  const relatedSurface = () => document.querySelector([
    'ytm-single-column-watch-next-results-renderer',
    'ytm-item-section-renderer:has(ytm-video-with-context-renderer)',
    'ytd-watch-next-secondary-results-renderer',
    '#related'
  ].join(','));

  const clearDrag = () => {
    for (const element of [miniPlayer, document.getElementById(SHELL_ID)]) {
      element?.style.removeProperty('--vigil-mini-drag-x');
      element?.style.removeProperty('--vigil-mini-drag-y');
      element?.style.removeProperty('opacity');
    }
  };

  const setDrag = (x, y) => {
    const shell = document.getElementById(SHELL_ID);
    for (const element of [miniPlayer, shell]) {
      if (!element) continue;
      element.style.setProperty('--vigil-mini-drag-x', `${x}px`);
      element.style.setProperty('--vigil-mini-drag-y', `${y}px`);
      if (Math.abs(x) > 18) {
        element.style.opacity = String(Math.max(.25, 1 - Math.abs(x) / Math.max(innerWidth, 320)));
      }
    }
  };

  const destroyShell = () => {
    document.getElementById(SHELL_ID)?.remove();
  };

  const exitMiniPlayer = () => {
    clearDrag();
    html.removeAttribute(MINI_ATTRIBUTE);
    miniPlayer?.removeAttribute('data-vigil-youtube-active-player');
    miniPlayer = null;
    miniVideo = null;
    miniVideoID = '';
    destroyShell();
  };

  const dismissMiniPlayer = () => {
    const video = miniVideo;
    exitMiniPlayer();
    try { video?.pause(); } catch {}
  };

  const syncPlayButton = () => {
    const button = document.querySelector(`#${SHELL_ID} .vigil-youtube-mini-play`);
    if (!(button instanceof HTMLButtonElement) || !miniVideo) return;
    const playing = !miniVideo.paused && !miniVideo.ended;
    button.textContent = playing ? '❚❚' : '▶';
    button.setAttribute('aria-label', playing ? 'Pause video' : 'Play video');
  };

  const togglePlayback = event => {
    event.preventDefault();
    event.stopPropagation();
    if (!miniVideo) return;
    try {
      if (miniVideo.paused) void miniVideo.play();
      else miniVideo.pause();
    } catch {}
    setTimeout(syncPlayButton, 0);
  };

  const createShell = () => {
    destroyShell();
    const shell = document.createElement('div');
    shell.id = SHELL_ID;
    shell.setAttribute('role', 'group');
    shell.setAttribute('aria-label', 'YouTube miniplayer');

    const title = document.createElement('div');
    title.className = 'vigil-youtube-mini-title';
    title.textContent = titleText();

    const play = document.createElement('button');
    play.className = 'vigil-youtube-mini-play';
    play.type = 'button';
    play.addEventListener('click', togglePlayback, true);

    const close = document.createElement('button');
    close.className = 'vigil-youtube-mini-close';
    close.type = 'button';
    close.textContent = '×';
    close.setAttribute('aria-label', 'Close miniplayer');
    close.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      dismissMiniPlayer();
    }, true);

    shell.append(title, play, close);
    shell.addEventListener('click', event => {
      if (event.target.closest('button')) return;
      exitMiniPlayer();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    document.documentElement.append(shell);
    syncPlayButton();
  };

  const enterMiniPlayer = () => {
    if (!isWatchRoute() || isShortsRoute()) return false;
    const video = mainVideo();
    const player = playerForVideo(video);
    if (!video || !player || videoIsFullscreen(video)) return false;
    installStyle();
    exitMiniPlayer();
    miniVideo = video;
    miniPlayer = player;
    miniVideoID = videoID();
    miniPlayer.setAttribute('data-vigil-youtube-active-player', 'true');
    html.setAttribute(MINI_ATTRIBUTE, 'true');
    createShell();
    video.addEventListener('play', syncPlayButton);
    video.addEventListener('pause', syncPlayButton);
    video.addEventListener('ended', dismissMiniPlayer, { once: true });
    requestAnimationFrame(() => {
      const related = relatedSurface();
      if (related) related.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
    return true;
  };

  const resetGesture = () => {
    const activeGesture = gesture;
    gesture = null;
    if (!html.hasAttribute(MINI_ATTRIBUTE)) {
      const player = activeGesture?.player
        || document.querySelector('[data-vigil-youtube-gesture-player="true"]');
      player?.removeAttribute('data-vigil-youtube-gesture-player');
      if (player && activeGesture?.mode === 'full') {
        player.style.transform = activeGesture.originalTransform;
        player.style.transition = activeGesture.originalTransition;
      }
    }
    clearDrag();
  };

  const beginGesture = (event, point, pointerID = null) => {
    if (!point || recoverFromShorts()) return;
    const target = event.target instanceof Element ? event.target : null;
    const shell = target?.closest(`#${SHELL_ID}`);
    const activePlayer = miniPlayer && (target === miniPlayer || miniPlayer.contains(target));

    if (html.getAttribute(MINI_ATTRIBUTE) === 'true') {
      if (!shell && !activePlayer) return;
      if (target?.closest('button')) return;
      gesture = {
        mode: 'mini', startX: point.clientX, startY: point.clientY,
        lastX: point.clientX, lastY: point.clientY, startedAt: performance.now(), moved: false,
        pointerID
      };
      return;
    }

    const video = mainVideo();
    const player = playerForVideo(video);
    if (!isWatchRoute() || videoIsFullscreen(video)
        || point.clientX <= EDGE_GESTURE_WIDTH
        || point.clientX >= innerWidth - EDGE_GESTURE_WIDTH
        || !video || !player
        || !(target === player || player.contains(target))
        || blocksPlayerGesture(target, player, point)) return;
    player.setAttribute('data-vigil-youtube-gesture-player', 'true');
    gesture = {
      mode: 'full', player, startX: point.clientX, startY: point.clientY,
      lastX: point.clientX, lastY: point.clientY, startedAt: performance.now(), moved: false,
      originalTransform: player.style.transform, originalTransition: player.style.transition,
      pointerID, video
    };
  };

  const moveGesture = (event, point, pointerID = null) => {
    if (!gesture || !point || (gesture.pointerID != null && gesture.pointerID !== pointerID)) return;
    const dx = point.clientX - gesture.startX;
    const dy = point.clientY - gesture.startY;
    gesture.lastX = point.clientX;
    gesture.lastY = point.clientY;

    if (gesture.mode === 'full') {
      if (Math.abs(dy) < Math.abs(dx) * 1.15) return;
      if (Math.abs(dy) >= 10) {
        gesture.moved = true;
        event.preventDefault();
        const progress = Math.max(-72, Math.min(dy, 150));
        const scale = dy >= 0
          ? Math.max(.76, 1 - progress / 625)
          : Math.min(1.04, 1 + Math.abs(progress) / 1800);
        gesture.player.style.transition = 'none';
        gesture.player.style.transform = `translate3d(0, ${progress}px, 0) scale(${scale})`;
      }
      return;
    }

    if (Math.max(Math.abs(dx), Math.abs(dy)) < 8) return;
    gesture.moved = true;
    if (Math.abs(dx) > Math.abs(dy) * 1.15) {
      event.preventDefault();
      setDrag(dx, 0);
    } else if (dy < 0) {
      event.preventDefault();
      setDrag(0, Math.max(-32, dy));
    }
  };

  const endGesture = (event, point, pointerID = null) => {
    if (!gesture || (gesture.pointerID != null && gesture.pointerID !== pointerID)) return;
    const dx = (point?.clientX ?? gesture.lastX) - gesture.startX;
    const dy = (point?.clientY ?? gesture.lastY) - gesture.startY;
    const elapsed = Math.max(1, performance.now() - gesture.startedAt);
    const verticalVelocity = dy / elapsed * 1000;
    const horizontalVelocity = dx / elapsed * 1000;
    const mode = gesture.mode;
    const moved = gesture.moved;

    if (mode === 'full') {
      const player = gesture.player;
      const video = gesture.video;
      const originalTransform = gesture.originalTransform;
      const originalTransition = gesture.originalTransition;
      player.style.transition = 'transform 180ms ease';
      player.style.transform = originalTransform;
      player.removeAttribute('data-vigil-youtube-gesture-player');
      gesture = null;
      setTimeout(() => {
        player.style.transition = originalTransition;
        player.style.transform = originalTransform;
      }, 190);
      if (dy >= 72 || verticalVelocity >= 520) {
        suppressPlayerClickUntil = performance.now() + 500;
        enterMiniPlayer();
      } else if (dy <= -72 || verticalVelocity <= -520) {
        // Invoke YouTube's own fullscreen control before suppressing the
        // synthetic click iOS may emit after the completed swipe.
        enterFullscreen(video);
        suppressPlayerClickUntil = performance.now() + 500;
      }
      return;
    }

    resetGesture();
    if (Math.abs(dx) >= 76 || Math.abs(horizontalVelocity) >= 650) {
      dismissMiniPlayer();
    } else if (dy <= -34 || !moved) {
      exitMiniPlayer();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  const cancelGesture = (pointerID = null) => {
    if (gesture?.pointerID != null && gesture.pointerID !== pointerID) return;
    resetGesture();
  };

  if ('PointerEvent' in window) {
    document.addEventListener('pointerdown', event => {
      if (!event.isPrimary || (event.pointerType && event.pointerType !== 'touch')) return;
      beginGesture(event, event, event.pointerId);
    }, { capture: true, passive: true });
    document.addEventListener('pointermove', event => {
      if (!event.isPrimary) return;
      moveGesture(event, event, event.pointerId);
    }, { capture: true, passive: false });
    document.addEventListener('pointerup', event => {
      if (!event.isPrimary) return;
      endGesture(event, event, event.pointerId);
    }, { capture: true, passive: true });
    document.addEventListener('pointercancel', event => cancelGesture(event.pointerId), true);
  } else {
    const touchPoint = event => event.changedTouches?.[0] || event.touches?.[0] || null;
    document.addEventListener('touchstart', event => {
      if (event.touches.length !== 1) return;
      beginGesture(event, touchPoint(event));
    }, { capture: true, passive: true });
    document.addEventListener('touchmove', event => {
      if (event.touches.length !== 1) return;
      moveGesture(event, touchPoint(event));
    }, { capture: true, passive: false });
    document.addEventListener('touchend', event => endGesture(event, touchPoint(event)), {
      capture: true, passive: true
    });
    document.addEventListener('touchcancel', () => cancelGesture(), true);
  }

  document.addEventListener('fullscreenchange', () => {
    if (document.fullscreenElement) exitMiniPlayer();
  });

  document.addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target : null;
    if (performance.now() < suppressPlayerClickUntil
        && target?.closest(PLAYER_SELECTOR)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    const link = target?.closest('a[href]');
    if (!(link instanceof HTMLAnchorElement)) return;
    let destination;
    try { destination = new URL(link.href, location.href); } catch { return; }
    if (allowedHosts.has(destination.hostname.toLowerCase())
      && /(?:^|\/)shorts(?:\/|$)/.test(destination.pathname.toLowerCase())) {
      event.preventDefault();
      event.stopImmediatePropagation();
      location.assign('https://m.youtube.com/');
    }
  }, true);

  const routeAudit = () => {
    if (recoverFromShorts()) return;
    const route = location.href;
    if (route === lastRoute) {
      if (html.hasAttribute(MINI_ATTRIBUTE) && !miniVideo?.isConnected) exitMiniPlayer();
      return;
    }
    const previousVideoID = miniVideoID;
    lastRoute = route;
    if (!html.hasAttribute(MINI_ATTRIBUTE)) return;
    if (isWatchRoute() && videoID() !== previousVideoID) {
      exitMiniPlayer();
    } else if (!miniVideo?.isConnected) {
      exitMiniPlayer();
    }
  };

  installStyle();
  new MutationObserver(routeAudit).observe(document.documentElement, {
    childList: true, subtree: true
  });
  addEventListener('popstate', routeAudit, true);
  addEventListener('pageshow', routeAudit, true);
  setInterval(routeAudit, 400);

  Object.defineProperty(window, '__vigilYouTubeParityTest', {
    configurable: false,
    enumerable: false,
    value: Object.freeze({
      enterMiniPlayer,
      exitMiniPlayer,
      dismissMiniPlayer,
      enterFullscreen,
      playerForVideo,
      isShortsRoute,
      isWatchRoute
    })
  });
})();
