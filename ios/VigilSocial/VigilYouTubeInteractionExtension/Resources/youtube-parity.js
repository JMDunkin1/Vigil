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
  const PLAYER_SELECTOR = 'ytm-player, #player-container-id, #player, ytd-player';
  const SEEK_CONTROL_SELECTOR = [
    '[role="slider"]', '[aria-valuenow]', 'input[type="range"]',
    '.ytp-progress-bar', '.ytp-progress-list', '.ytp-scrubber-container'
  ].join(',');
  const INTERACTIVE_SELECTOR = `${SEEK_CONTROL_SELECTOR}, button, a, input, textarea, select`;
  const html = document.documentElement;

  let gesture = null;
  let miniPlayer = null;
  let miniVideo = null;
  let miniVideoID = '';
  let lastRoute = location.href;

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
      touch-action: pan-y;
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
    return video.closest(PLAYER_SELECTOR) || video.parentElement;
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

  const goToBrowseSurface = () => {
    const home = document.querySelector('a[href="/"], ytm-pivot-bar-item-renderer a[href="/"]');
    if (home instanceof HTMLElement) {
      home.click();
      return;
    }
    location.assign('https://m.youtube.com/');
  };

  const dismissMiniPlayer = () => {
    const video = miniVideo;
    exitMiniPlayer();
    try { video?.pause(); } catch {}
    goToBrowseSurface();
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
    if (!isWatchRoute() || isShortsRoute() || document.fullscreenElement) return false;
    const video = mainVideo();
    const player = playerForVideo(video);
    if (!video || !player) return false;
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

  const touchPoint = event => event.changedTouches?.[0] || event.touches?.[0] || null;

  document.addEventListener('touchstart', event => {
    if (event.touches.length !== 1 || recoverFromShorts()) return;
    const point = touchPoint(event);
    if (!point) return;
    const target = event.target instanceof Element ? event.target : null;
    const shell = target?.closest(`#${SHELL_ID}`);
    const activePlayer = miniPlayer && (target === miniPlayer || miniPlayer.contains(target));

    if (html.getAttribute(MINI_ATTRIBUTE) === 'true') {
      if (!shell && !activePlayer) return;
      if (target?.closest('button')) return;
      gesture = {
        mode: 'mini', startX: point.clientX, startY: point.clientY,
        lastX: point.clientX, lastY: point.clientY, startedAt: performance.now(), moved: false
      };
      return;
    }

    if (!isWatchRoute() || document.fullscreenElement || target?.closest(INTERACTIVE_SELECTOR)) return;
    const video = mainVideo();
    const player = playerForVideo(video);
    if (!video || !player || !(target === player || player.contains(target))) return;
    player.setAttribute('data-vigil-youtube-gesture-player', 'true');
    gesture = {
      mode: 'full', player, startX: point.clientX, startY: point.clientY,
      lastX: point.clientX, lastY: point.clientY, startedAt: performance.now(), moved: false,
      originalTransform: player.style.transform, originalTransition: player.style.transition
    };
  }, { capture: true, passive: true });

  document.addEventListener('touchmove', event => {
    if (!gesture || event.touches.length !== 1) return;
    const point = touchPoint(event);
    if (!point) return;
    const dx = point.clientX - gesture.startX;
    const dy = point.clientY - gesture.startY;
    gesture.lastX = point.clientX;
    gesture.lastY = point.clientY;

    if (gesture.mode === 'full') {
      if (dy < 0 || Math.abs(dy) < Math.abs(dx) * 1.15) return;
      if (dy >= 10) {
        gesture.moved = true;
        event.preventDefault();
        const progress = Math.min(dy, 150);
        const scale = Math.max(.76, 1 - progress / 625);
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
  }, { capture: true, passive: false });

  document.addEventListener('touchend', event => {
    if (!gesture) return;
    const point = touchPoint(event);
    const dx = (point?.clientX ?? gesture.lastX) - gesture.startX;
    const dy = (point?.clientY ?? gesture.lastY) - gesture.startY;
    const elapsed = Math.max(1, performance.now() - gesture.startedAt);
    const verticalVelocity = dy / elapsed * 1000;
    const horizontalVelocity = dx / elapsed * 1000;
    const mode = gesture.mode;
    const moved = gesture.moved;

    if (mode === 'full') {
      const player = gesture.player;
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
      if (dy >= 72 || verticalVelocity >= 520) enterMiniPlayer();
      return;
    }

    resetGesture();
    if (Math.abs(dx) >= 76 || Math.abs(horizontalVelocity) >= 650) {
      dismissMiniPlayer();
    } else if (dy <= -34 || !moved) {
      exitMiniPlayer();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }, { capture: true, passive: true });

  document.addEventListener('touchcancel', resetGesture, true);
  document.addEventListener('fullscreenchange', () => {
    if (document.fullscreenElement) exitMiniPlayer();
  });

  document.addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target : null;
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
    if (route === lastRoute) return;
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
      isShortsRoute,
      isWatchRoute
    })
  });
})();
