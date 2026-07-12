import Foundation

enum DOMAdapters {
    static let contentFilterBootstrap = #"""
    (() => {
      if (window.__sentinelContentBootstrapInstalled) return;
      window.__sentinelContentBootstrapInstalled = true;
      const style = document.createElement('style');
      style.id = 'sentinel-content-safety-style';
      style.textContent = `
        img, video {
          filter: blur(32px) !important;
        }
        [data-sentinel-media-verdict="safe"] { filter: none !important; }
        [data-sentinel-media-verdict="sensitive"] {
          filter: blur(48px) !important;
          visibility: hidden !important;
        }
        html[data-sentinel-page-verdict="sensitive"] body,
        html[data-sentinel-page-verdict="unknown"] body {
          visibility: hidden !important;
        }
      `;
      (document.head || document.documentElement).appendChild(style);
      document.documentElement.dataset.sentinelPageVerdict = 'unknown';
    })();
    """#

    static func preflightScript(for service: SocialService) -> String? {
        guard service == .snapchat else { return nil }
        return #"""
        (() => {
          const define = (target, key, value) => {
            try { Object.defineProperty(target, key, { configurable: true, get: () => value }); } catch (_) {}
          };
          define(Navigator.prototype, 'platform', 'MacIntel');
          define(Navigator.prototype, 'vendor', 'Google Inc.');
          define(Navigator.prototype, 'maxTouchPoints', 0);
          define(Navigator.prototype, 'webdriver', false);
        })();
        """#
    }

    static func script(for service: SocialService, audioEnabled: Bool) -> String {
        common(audioEnabled: audioEnabled) + serviceScript(service)
    }

    private static func common(audioEnabled: Bool) -> String {
        let preference = audioEnabled ? "true" : "false"
        return #"""
        (() => {
          const bridge = (payload) => {
            try { window.webkit.messageHandlers.sentinel.postMessage(payload); } catch (_) {}
          };
          window.__sentinelBridge = bridge;

          if (!window.__sentinelCommonInstalled) {
            window.__sentinelCommonInstalled = true;
            window.__sentinelAudioPreferred = AUDIO_PREFERENCE;

            const applyAudioPreference = () => {
              const hasGesture = !navigator.userActivation || navigator.userActivation.hasBeenActive;
              document.querySelectorAll('video, audio').forEach((media) => {
                const shouldMute = !window.__sentinelAudioPreferred;
                media.defaultMuted = shouldMute;
                media.muted = shouldMute;
                if (window.__sentinelAudioPreferred && hasGesture) {
                  media.defaultMuted = false;
                  media.muted = false;
                }
              });
            };

            window.__sentinelSetAudioPreference = (enabled) => {
              window.__sentinelAudioPreferred = Boolean(enabled);
              applyAudioPreference();
              bridge({ type: 'audio', enabled: Boolean(enabled) });
            };

            window.__sentinelPauseAllMedia = () => {
              document.querySelectorAll('video, audio').forEach((media) => media.pause());
            };

            const mediaElements = new Map();
            let nextMediaID = 1;
            let nextMediaToken = 1;
            const maximumImageBytes = 4 * 1024 * 1024;
            const captureImage = (element) => {
              try {
                const width = Math.max(1, Math.min(1024, element.naturalWidth || element.videoWidth || element.clientWidth || 1));
                const height = Math.max(1, Math.min(1024, element.naturalHeight || element.videoHeight || element.clientHeight || 1));
                if (width < 32 || height < 32) return null;
                const scale = Math.min(1, 1024 / Math.max(width, height));
                const canvas = document.createElement('canvas');
                canvas.width = Math.max(1, Math.round(width * scale));
                canvas.height = Math.max(1, Math.round(height * scale));
                canvas.getContext('2d', { alpha: false })?.drawImage(element, 0, 0, canvas.width, canvas.height);
                const dataURL = canvas.toDataURL('image/jpeg', 0.82);
                return dataURL.length <= maximumImageBytes * 1.38 ? dataURL : null;
              } catch (_) { return null; }
            };

            const submitMedia = (element) => {
              if (!(element instanceof HTMLImageElement || element instanceof HTMLVideoElement)) return;
              const fingerprint = element instanceof HTMLVideoElement
                ? String(element.currentSrc || element.poster || '')
                : String(element.currentSrc || element.src || '');
              let id = element.dataset.sentinelMediaId;
              if (!id) {
                id = String(nextMediaID++);
                element.dataset.sentinelMediaId = id;
                element.dataset.sentinelMediaVerdict = 'unknown';
                mediaElements.set(id, element);
              }
              if (element instanceof HTMLImageElement && element.dataset.sentinelMediaFingerprint === fingerprint) return;
              if (element.dataset.sentinelMediaFingerprint !== fingerprint) {
                element.dataset.sentinelMediaFingerprint = fingerprint;
                element.dataset.sentinelMediaVerdict = 'unknown';
              }
              const token = String(nextMediaToken++);
              element.dataset.sentinelMediaToken = token;
              const dataURL = captureImage(element);
              bridge({
                type: 'mediaCandidate',
                id,
                token,
                kind: element instanceof HTMLVideoElement ? 'videoFrame' : 'image',
                sourceURL: element instanceof HTMLVideoElement
                  ? String(element.poster || '')
                  : String(element.currentSrc || element.src || ''),
                dataURL: dataURL || '',
                captureFailed: !dataURL
              });
            };

            window.__sentinelResolveMedia = (id, token, verdict) => {
              const element = mediaElements.get(String(id));
              if (!element || element.dataset.sentinelMediaToken !== String(token)
                  || !['safe', 'sensitive', 'unknown'].includes(verdict)) return;
              // A sensitive result is sticky. Unknown stays blurred until a later
              // sample for the same media is explicitly classified as safe.
              if (element.dataset.sentinelMediaVerdict === 'sensitive') return;
              if (verdict === 'sensitive') element.dataset.sentinelMediaVerdict = 'sensitive';
              else element.dataset.sentinelMediaVerdict = 'unknown';
              if (verdict === 'safe') element.dataset.sentinelMediaVerdict = 'safe';
            };

            let textRevision = 0;
            let inspectionScheduled = false;
            const extractPageText = (limit) => {
              if (!document.body) return { text: '', wasTruncated: false };
              const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
                acceptNode: (node) => {
                  const parent = node.parentElement;
                  if (!parent || ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(parent.tagName)) {
                    return NodeFilter.FILTER_REJECT;
                  }
                  return NodeFilter.FILTER_ACCEPT;
                }
              });
              const pieces = [];
              let length = 0;
              let wasTruncated = false;
              for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                const value = String(node.nodeValue || '').replace(/\s+/g, ' ').trim();
                if (!value) continue;
                if (length + value.length + 1 > limit) {
                  pieces.push(value.slice(0, Math.max(0, limit - length)));
                  wasTruncated = true;
                  break;
                }
                pieces.push(value);
                length += value.length + 1;
              }
              return { text: pieces.join('\n'), wasTruncated };
            };
            const inspectDocument = () => {
              inspectionScheduled = false;
              document.querySelectorAll('img, video').forEach((element) => {
                if (element instanceof HTMLImageElement && !element.complete) {
                  element.addEventListener('load', () => submitMedia(element), { once: true });
                } else if (element instanceof HTMLVideoElement && element.readyState < 2) {
                  element.addEventListener('loadeddata', () => submitMedia(element), { once: true });
                } else submitMedia(element);
              });

              const maximumTextLength = 512000;
              const chunkLength = 24000;
              const extracted = extractPageText(maximumTextLength);
              const wasTruncated = extracted.wasTruncated;
              const text = extracted.text;
              const revision = String(++textRevision);
              const total = Math.max(1, Math.ceil(text.length / chunkLength));
              for (let index = 0; index < total; index += 1) {
                bridge({
                  type: 'pageText', revision, index, total, wasTruncated,
                  text: text.slice(index * chunkLength, (index + 1) * chunkLength)
                });
              }
            };

            window.__sentinelResolvePageText = (revision, verdict) => {
              if (String(revision) !== String(textRevision)) return;
              if (['safe', 'sensitive', 'unknown'].includes(verdict)) {
                document.documentElement.dataset.sentinelPageVerdict = verdict;
              }
            };

            const scheduleInspection = () => {
              document.documentElement.dataset.sentinelPageVerdict = 'unknown';
              if (inspectionScheduled) return;
              inspectionScheduled = true;
              setTimeout(inspectDocument, 120);
            };
            new MutationObserver(scheduleInspection).observe(document.documentElement, {
              childList: true, subtree: true, characterData: true,
              attributes: true, attributeFilter: ['src', 'srcset', 'poster']
            });
            document.addEventListener('loadeddata', scheduleInspection, true);
            scheduleInspection();

            // Re-check moving media. Frames that cannot be captured remain blurred.
            setInterval(() => {
              document.querySelectorAll('video, img').forEach((media) => {
                if (media instanceof HTMLVideoElement && !media.paused && media.readyState >= 2) submitMedia(media);
                else if (media instanceof HTMLImageElement && media.complete && /\.(gif|webp)(?:$|[?#])/i.test(media.currentSrc || media.src || '')) {
                  delete media.dataset.sentinelMediaFingerprint;
                  submitMedia(media);
                }
              });
            }, 2000);

            let audioRefreshScheduled = false;
            const scheduleAudioRefresh = () => {
              if (audioRefreshScheduled) return;
              audioRefreshScheduled = true;
              requestAnimationFrame(() => {
                audioRefreshScheduled = false;
                applyAudioPreference();
              });
            };

            document.addEventListener('pointerup', applyAudioPreference, true);
            document.addEventListener('play', applyAudioPreference, true);
            new MutationObserver(scheduleAudioRefresh).observe(document.documentElement, {
              childList: true,
              subtree: true
            });
          } else {
            window.__sentinelSetAudioPreference(AUDIO_PREFERENCE);
          }
        })();
        """#.replacingOccurrences(of: "AUDIO_PREFERENCE", with: preference)
    }

    private static func serviceScript(_ service: SocialService) -> String {
        switch service {
        case .instagram: instagram
        case .youtube: youtube
        case .snapchat: snapchat
        }
    }

    private static let youtube = #"""
    (() => {
      if (window.__sentinelYouTubeInstalled) return;
      window.__sentinelYouTubeInstalled = true;

      const style = document.createElement('style');
      style.id = 'sentinel-youtube-style';
      style.textContent = `
        a[href^="/shorts"], a[href*="youtube.com/shorts"],
        ytm-reel-shelf-renderer, ytd-reel-shelf-renderer,
        ytm-pivot-bar-item-renderer:has(a[href*="/shorts"]),
        ytd-guide-entry-renderer:has(a[href*="/shorts"]),
        ytm-rich-section-renderer:has(a[href*="/shorts"]) {
          display: none !important;
        }
      `;
      document.documentElement.appendChild(style);

      const blockShorts = (event) => {
        const link = event.target?.closest?.('a[href]');
        if (!link) return;
        try {
          const target = new URL(link.href, location.href);
          if (target.pathname.startsWith('/shorts')) {
            event.preventDefault();
            event.stopImmediatePropagation();
            window.__sentinelBridge({
              type: 'health',
              state: 'degraded',
              detail: 'YouTube Shorts is intentionally unavailable.'
            });
          }
        } catch (_) {}
      };
      document.addEventListener('click', blockShorts, true);

      let attachedVideo = null;
      let lastSavedAt = 0;
      let requestedKey = '';
      const videoKey = () => {
        try {
          const url = new URL(location.href);
          return url.searchParams.get('v') || '';
        } catch (_) { return ''; }
      };

      const attachPlayback = () => {
        const video = document.querySelector('video');
        const key = videoKey();
        if (!video || !key) return;
        if (requestedKey !== key) {
          requestedKey = key;
          window.__sentinelBridge({ type: 'playbackRequest', service: 'youtube', key });
        }
        if (attachedVideo === video) return;
        attachedVideo = video;
        video.addEventListener('timeupdate', () => {
          const now = Date.now();
          if (now - lastSavedAt < 4000 || !Number.isFinite(video.currentTime)) return;
          lastSavedAt = now;
          window.__sentinelBridge({
            type: 'playback',
            service: 'youtube',
            key: videoKey(),
            position: video.currentTime
          });
        });
      };

      window.__sentinelRestorePlayback = (key, position) => {
        const restore = () => {
          const video = document.querySelector('video');
          if (!video || videoKey() !== key || !Number.isFinite(position) || position < 2) return;
          const apply = () => {
            if (!Number.isFinite(video.duration) || position < video.duration - 2) video.currentTime = position;
          };
          if (video.readyState >= 1) apply();
          else video.addEventListener('loadedmetadata', apply, { once: true });
        };
        restore();
        setTimeout(restore, 750);
      };

      const reconcile = () => {
        document.querySelectorAll('a[href^="/shorts"], a[href*="youtube.com/shorts"], ytm-reel-shelf-renderer, ytd-reel-shelf-renderer')
          .forEach((node) => {
            const container = node.closest('ytm-pivot-bar-item-renderer, ytm-pivot-bar-item, ytd-guide-entry-renderer, [role="tab"]') || node;
            container.style.setProperty('display', 'none', 'important');
          });
        document.querySelectorAll('ytm-pivot-bar-item-renderer, ytm-pivot-bar-item, [role="tab"]').forEach((node) => {
          const label = String(node.textContent || node.getAttribute('aria-label') || '').trim().toLowerCase();
          if (label === 'shorts' || label.startsWith('shorts ')) node.style.setProperty('display', 'none', 'important');
        });
        attachPlayback();
      };
      let reconcileScheduled = false;
      const scheduleReconcile = () => {
        if (reconcileScheduled) return;
        reconcileScheduled = true;
        requestAnimationFrame(() => {
          reconcileScheduled = false;
          reconcile();
        });
      };
      reconcile();
      new MutationObserver(scheduleReconcile).observe(document.documentElement, { childList: true, subtree: true });

      const reportHealth = () => {
        const text = String(document.body?.innerText || '').toLowerCase();
        if (/disallowed_useragent|this browser or app may not be secure|couldn.t sign you in/.test(text)) {
          window.__sentinelBridge({
            type: 'health',
            state: 'unsupported',
            detail: 'Google rejected embedded WebKit sign-in. This authentication path is not verified; Level 1 restores the native YouTube app.'
          });
          return;
        }
        const content = document.querySelector('video, ytm-rich-item-renderer, ytm-compact-video-renderer, ytm-playlist-video-renderer');
        const signIn = document.querySelector('a[href*="accounts.google.com"], a[href*="ServiceLogin"], a[href*="/signin"]');
        if (!content) {
          window.__sentinelBridge({
            type: 'health',
            state: 'degraded',
            detail: signIn
              ? 'YouTube is signed out. Embedded Google sign-in may be rejected; if that happens, use native YouTube in Level 1.'
              : 'YouTube has not loaded a usable subscription or video surface yet.'
          });
          return;
        }
        window.__sentinelBridge({ type: 'health', state: 'ready', detail: '' });
      };
      setTimeout(reportHealth, 750);
      setTimeout(reportHealth, 3500);
    })();
    """#

    private static let instagram = #"""
    (() => {
      if (window.__sentinelInstagramInstalled) return;
      window.__sentinelInstagramInstalled = true;

      const style = document.createElement('style');
      style.id = 'sentinel-instagram-style';
      style.textContent = `
        html, body, #react-root, main, main > div, div[role="main"] {
          width: 100% !important;
          max-width: none !important;
          min-width: 0 !important;
        }
        html, body { overflow-x: hidden !important; touch-action: pan-y pinch-zoom; }
        article { max-width: min(100vw, 680px) !important; margin-inline: auto !important; }
      `;
      document.documentElement.appendChild(style);
      window.__sentinelBridge({ type: 'health', state: 'ready', detail: '' });
    })();
    """#

    private static let snapchat = #"""
    (() => {
      if (window.__sentinelSnapchatInstalled) return;
      window.__sentinelSnapchatInstalled = true;

      const style = document.createElement('style');
      style.id = 'sentinel-snapchat-style';
      style.textContent = `
        a[href*="/spotlight"], a[href*="/stories"],
        [data-testid*="spotlight" i], [data-testid*="stories" i],
        [aria-label*="Spotlight" i], [aria-label*="Stories" i] {
          display: none !important;
        }
      `;
      document.documentElement.appendChild(style);

      const reconcile = () => {
        document.querySelectorAll('a[href*="/spotlight"], a[href*="/stories"], [data-testid*="spotlight" i], [data-testid*="stories" i], [aria-label*="Spotlight" i], [aria-label*="Stories" i]')
          .forEach((node) => { node.style.setProperty('display', 'none', 'important'); });
      };

      document.addEventListener('click', (event) => {
        const link = event.target?.closest?.('a[href]');
        if (!link) return;
        const href = String(link.getAttribute('href') || '').toLowerCase();
        if (href.includes('/spotlight') || href.includes('/stories')) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      }, true);

      const reportHealth = () => {
        const text = String(document.body?.innerText || '').toLowerCase();
        const unsupported = /browser (isn't|is not) supported|unsupported browser|use snapchat on your computer|only available on desktop|download snapchat/.test(text);
        if (unsupported) {
          window.__sentinelBridge({
            type: 'health',
            state: 'unsupported',
            detail: 'Snapchat rejected its experimental desktop web client. Level 1 restores the native app; public iOS APIs cannot remove Spotlight or Stories inside that native app.'
          });
          return;
        }
        const recognizable = document.querySelector('canvas, video, nav, [role="navigation"], input[type="password"]');
        window.__sentinelBridge({
          type: 'health',
          state: recognizable ? 'ready' : 'degraded',
          detail: recognizable ? '' : 'Snapchat web is experimental and has not reached a recognized login or chat screen yet.'
        });
      };

      let reconcileScheduled = false;
      const scheduleReconcile = () => {
        if (reconcileScheduled) return;
        reconcileScheduled = true;
        requestAnimationFrame(() => {
          reconcileScheduled = false;
          reconcile();
        });
      };
      reconcile();
      new MutationObserver(scheduleReconcile).observe(document.documentElement, { childList: true, subtree: true });
      setTimeout(reportHealth, 1500);
      setTimeout(reportHealth, 8000);
    })();
    """#
}
