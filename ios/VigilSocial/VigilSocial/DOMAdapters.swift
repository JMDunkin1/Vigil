import Foundation

enum DOMAdapters {
    static var contentFilterBootstrap: String {
        contentFilterBootstrap(for: .conceal)
    }

    static func contentFilterBootstrap(for unclassifiedMediaPolicy: UnclassifiedMediaPolicy) -> String {
        let unclassifiedMediaCSS = unclassifiedMediaPolicy.concealsUnclassifiedMedia ? #"""
        canvas, object, embed, input[type="image"],
        svg image, svg foreignObject { visibility: hidden !important; }
        *, *::before, *::after {
          background-image: none !important;
          border-image-source: none !important;
          list-style-image: none !important;
        }
        """# : ""
        let policy = unclassifiedMediaPolicy.rawValue
        return #"""
    (() => {
      if (window.__vigilContentBootstrapInstalled) return;
      window.__vigilContentBootstrapInstalled = true;
      const style = document.createElement('style');
      style.id = 'vigil-content-safety-style';
      style.textContent = `
        img, video {
          filter: blur(32px) !important;
        }
        UNCLASSIFIED_MEDIA_CSS
        [data-vigil-media-verdict="safe"] { filter: none !important; }
        [data-vigil-media-verdict="sensitive"] {
          filter: blur(48px) !important;
          visibility: hidden !important;
        }
        html[data-vigil-page-verdict="sensitive"] body,
        html[data-vigil-page-verdict="unknown"] body {
          visibility: hidden !important;
        }
      `;
      (document.head || document.documentElement).appendChild(style);
      document.documentElement.dataset.vigilUnclassifiedMediaPolicy = 'UNCLASSIFIED_MEDIA_POLICY';
      document.documentElement.dataset.vigilPageVerdict = 'unknown';
    })();
    """#
            .replacingOccurrences(of: "UNCLASSIFIED_MEDIA_CSS", with: unclassifiedMediaCSS)
            .replacingOccurrences(of: "UNCLASSIFIED_MEDIA_POLICY", with: policy)
    }

    static func script(for service: SocialService, audioEnabled: Bool) -> String {
        common(audioEnabled: audioEnabled) + lockdownProbe(service) + serviceScript(service)
    }

    private static func lockdownProbe(_ service: SocialService) -> String {
        let probePath: String
        let serviceDomain: String
        switch service {
        case .instagram:
            probePath = "/reels/?__vigil_policy_probe__=1"
            serviceDomain = "instagram.com"
        case .youtube:
            probePath = "/feed/explore?__vigil_policy_probe__=1"
            serviceDomain = "youtube.com"
        }
        return #"""
        (() => {
          if (window.__vigilPolicyProbeInstalled) return;
          window.__vigilPolicyProbeInstalled = true;
          let request = 0;
          const publish = (tier) => {
            if (!['normal', 'soft'].includes(tier)) return;
            if (document.documentElement.dataset.vigilPolicyTier === tier) return;
            document.documentElement.dataset.vigilPolicyTier = tier;
            document.dispatchEvent(new CustomEvent('__vigilPolicyTierChanged', { detail: { tier } }));
          };
          const probe = async () => {
            const current = ++request;
            if (!navigator.onLine) { publish('soft'); return; }
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 6000);
            try {
              const requestedURL = new URL('PROBE_PATH', location.href);
              const response = await fetch(requestedURL.href, {
                method: 'HEAD',
                cache: 'no-store',
                credentials: 'same-origin',
                redirect: 'follow',
                signal: controller.signal
              });
              let responseURL = null;
              try { responseURL = response.url ? new URL(response.url) : null; } catch (_) {}
              const responseHost = String(responseURL?.hostname || '').toLowerCase();
              const isServiceHost = responseHost === 'SERVICE_DOMAIN'
                || responseHost.endsWith('.SERVICE_DOMAIN');
              const accepted = response.ok
                && response.status >= 200 && response.status < 300
                && responseURL !== null
                && responseURL.protocol === 'https:'
                && isServiceHost
                && responseURL.pathname === requestedURL.pathname
                && responseURL.searchParams.get('__vigil_policy_probe__') === '1';
              if (current === request) publish(accepted ? 'normal' : 'soft');
            } catch (_) {
              // The managed device filter rejects this Level 2-only URL before
              // it reaches the service. Network uncertainty fails restrictive.
              if (current === request) publish('soft');
            } finally {
              clearTimeout(timeout);
            }
          };
          publish('soft');
          probe();
          addEventListener('online', probe);
          addEventListener('focus', probe);
          setInterval(probe, 15000);
        })();
        """#
            .replacingOccurrences(of: "PROBE_PATH", with: probePath)
            .replacingOccurrences(of: "SERVICE_DOMAIN", with: serviceDomain)
    }

    private static func common(audioEnabled: Bool) -> String {
        let preference = audioEnabled ? "true" : "false"
        return #"""
        (() => {
          const bridge = (payload) => {
            try { window.webkit.messageHandlers.vigil.postMessage(payload); } catch (_) {}
          };
          window.__vigilBridge = bridge;

          if (!window.__vigilCommonInstalled) {
            window.__vigilCommonInstalled = true;
            window.__vigilAudioPreferred = AUDIO_PREFERENCE;

            const applyAudioPreference = () => {
              const hasGesture = !navigator.userActivation || navigator.userActivation.hasBeenActive;
              document.querySelectorAll('video, audio').forEach((media) => {
                const shouldMute = !window.__vigilAudioPreferred;
                media.defaultMuted = shouldMute;
                media.muted = shouldMute;
                if (window.__vigilAudioPreferred && hasGesture) {
                  media.defaultMuted = false;
                  media.muted = false;
                }
              });
            };

            window.__vigilSetAudioPreference = (enabled) => {
              window.__vigilAudioPreferred = Boolean(enabled);
              applyAudioPreference();
              bridge({ type: 'audio', enabled: Boolean(enabled) });
            };

            window.__vigilPauseAllMedia = () => {
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
              let id = element.dataset.vigilMediaId;
              if (!id) {
                id = String(nextMediaID++);
                element.dataset.vigilMediaId = id;
                element.dataset.vigilMediaVerdict = 'unknown';
                mediaElements.set(id, element);
              }
              if (element instanceof HTMLImageElement && element.dataset.vigilMediaFingerprint === fingerprint) return;
              if (element.dataset.vigilMediaFingerprint !== fingerprint) {
                element.dataset.vigilMediaFingerprint = fingerprint;
                element.dataset.vigilMediaVerdict = 'unknown';
              }
              const token = String(nextMediaToken++);
              element.dataset.vigilMediaToken = token;
              const dataURL = captureImage(element);
              bridge({
                type: 'mediaCandidate',
                id,
                token,
                kind: element instanceof HTMLVideoElement ? 'videoFrame' : 'image',
                dataURL: dataURL || '',
                captureFailed: !dataURL
              });
            };

            window.__vigilResolveMedia = (id, token, verdict) => {
              const element = mediaElements.get(String(id));
              if (!element || element.dataset.vigilMediaToken !== String(token)
                  || !['safe', 'sensitive', 'unknown'].includes(verdict)) return;
              // A sensitive result is sticky. Unknown stays blurred until a later
              // sample for the same media is explicitly classified as safe.
              if (element.dataset.vigilMediaVerdict === 'sensitive') return;
              if (verdict === 'sensitive') element.dataset.vigilMediaVerdict = 'sensitive';
              else element.dataset.vigilMediaVerdict = 'unknown';
              if (verdict === 'safe') element.dataset.vigilMediaVerdict = 'safe';
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

            window.__vigilResolvePageText = (revision, verdict) => {
              if (String(revision) !== String(textRevision)) return;
              if (['safe', 'sensitive', 'unknown'].includes(verdict)) {
                document.documentElement.dataset.vigilPageVerdict = verdict;
              }
            };

            const scheduleInspection = () => {
              document.documentElement.dataset.vigilPageVerdict = 'unknown';
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
                  delete media.dataset.vigilMediaFingerprint;
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
            window.__vigilSetAudioPreference(AUDIO_PREFERENCE);
          }
        })();
        """#.replacingOccurrences(of: "AUDIO_PREFERENCE", with: preference)
    }

    private static func serviceScript(_ service: SocialService) -> String {
        switch service {
        case .instagram: instagram
        case .youtube: youtube
        }
    }

    private static let youtube = #"""
    (() => {
      if (window.__vigilYouTubeInstalled) return;
      window.__vigilYouTubeInstalled = true;

      const style = document.createElement('style');
      style.id = 'vigil-youtube-style';
      style.textContent = `
        a[href^="/shorts"], a[href*="youtube.com/shorts"],
        ytm-reel-shelf-renderer, ytd-reel-shelf-renderer,
        ytm-reel-item-renderer, ytd-reel-video-renderer,
        ytm-shorts-lockup-view-model, ytm-shorts-lockup-view-model-v2,
        [is-shorts], ytd-rich-section-renderer:has(a[href*="/shorts"]),
        ytm-pivot-bar-item-renderer:has(a[href*="/shorts"]),
        ytd-guide-entry-renderer:has(a[href*="/shorts"]),
        ytm-rich-section-renderer:has(a[href*="/shorts"]) {
          display: none !important;
        }
        html[data-vigil-policy-tier="soft"] a[href*="/feed/explore"],
        html[data-vigil-policy-tier="soft"] a[href*="/feed/trending"],
        html[data-vigil-policy-tier="soft"] ytm-related-item-section-renderer,
        html[data-vigil-policy-tier="soft"] ytm-watch-next-secondary-results-renderer,
        html[data-vigil-policy-tier="soft"] ytm-promoted-sparkles-web-renderer,
        html[data-vigil-policy-tier="soft"] ytm-companion-ad-renderer,
        html[data-vigil-policy-tier="soft"] [data-is-ad="true"] {
          display: none !important;
        }
        html[data-vigil-policy-tier="soft"][data-vigil-youtube-home="true"] ytm-rich-grid-renderer,
        html[data-vigil-policy-tier="soft"][data-vigil-youtube-home="true"] ytm-browse {
          visibility: hidden !important;
        }
        [data-vigil-soft-hidden="true"] {
          display: none !important;
        }
      `;
      document.documentElement.appendChild(style);

      const blockShorts = (event) => {
        const link = event.target?.closest?.('a[href]');
        if (!link) return;
        try {
          const target = new URL(link.href, location.href);
          const path = target.pathname.toLowerCase();
          if (path === '/shorts' || path.startsWith('/shorts/')) {
            event.preventDefault();
            event.stopImmediatePropagation();
            window.__vigilBridge({
              type: 'health',
              state: 'degraded',
              detail: 'YouTube Shorts is intentionally unavailable.'
            });
          }
        } catch (_) {}
      };
      document.addEventListener('click', blockShorts, true);

      const enforceShortsLocation = () => {
        const path = location.pathname.toLowerCase();
        if (path !== '/shorts' && !path.startsWith('/shorts/')) return;
        window.__vigilBridge({
          type: 'health',
          state: 'degraded',
          detail: 'YouTube Shorts is intentionally unavailable.'
        });
        location.replace('/');
      };
      for (const name of ['pushState', 'replaceState']) {
        const original = history[name];
        history[name] = function(...args) {
          const result = original.apply(this, args);
          queueMicrotask(enforceShortsLocation);
          return result;
        };
      }
      addEventListener('popstate', enforceShortsLocation);
      enforceShortsLocation();

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
          window.__vigilBridge({ type: 'playbackRequest', service: 'youtube', key });
        }
        if (attachedVideo === video) return;
        attachedVideo = video;
        video.addEventListener('timeupdate', () => {
          const now = Date.now();
          if (now - lastSavedAt < 4000 || !Number.isFinite(video.currentTime)) return;
          lastSavedAt = now;
          window.__vigilBridge({
            type: 'playback',
            service: 'youtube',
            key: videoKey(),
            position: video.currentTime
          });
        });
      };

      window.__vigilRestorePlayback = (key, position) => {
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
        document.documentElement.dataset.vigilYoutubeHome = String(location.pathname === '/' || location.pathname === '');
        document.querySelectorAll('[data-vigil-soft-hidden="true"]')
          .forEach((node) => node.removeAttribute('data-vigil-soft-hidden'));
        document.querySelectorAll('a[href^="/shorts"], a[href*="youtube.com/shorts"], ytm-reel-shelf-renderer, ytd-reel-shelf-renderer, ytm-reel-item-renderer, ytd-reel-video-renderer, ytm-shorts-lockup-view-model, ytm-shorts-lockup-view-model-v2, [is-shorts]')
          .forEach((node) => {
            const container = node.closest('ytm-pivot-bar-item-renderer, ytm-pivot-bar-item, ytd-guide-entry-renderer, [role="tab"]') || node;
            container.style.setProperty('display', 'none', 'important');
          });
        document.querySelectorAll('ytm-pivot-bar-item-renderer, ytm-pivot-bar-item, [role="tab"]').forEach((node) => {
          const label = String(node.textContent || node.getAttribute('aria-label') || '').trim().toLowerCase();
          if (label === 'shorts' || label.startsWith('shorts ')) node.style.setProperty('display', 'none', 'important');
          if (document.documentElement.dataset.vigilPolicyTier === 'soft'
              && (label === 'explore' || label === 'trending')) {
            node.dataset.vigilSoftHidden = 'true';
          }
        });
        if (document.documentElement.dataset.vigilPolicyTier === 'soft') {
          document.querySelectorAll('ytm-promoted-sparkles-web-renderer, ytm-companion-ad-renderer, ytm-item-section-renderer, ytm-rich-item-renderer')
            .forEach((node) => {
              const label = String(node.textContent || node.getAttribute('aria-label') || '').trim().toLowerCase();
              if (label.includes('sponsored') || label.includes('suggested for you')) {
                node.dataset.vigilSoftHidden = 'true';
              }
            });
        }
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
      document.addEventListener('__vigilPolicyTierChanged', scheduleReconcile);

      const reportHealth = () => {
        const text = String(document.body?.innerText || '').toLowerCase();
        if (/disallowed_useragent|this browser or app may not be secure|couldn.t sign you in/.test(text)) {
          window.__vigilBridge({
            type: 'health',
            state: 'unsupported',
            detail: 'Google rejected embedded WebKit sign-in. This authentication path is unavailable in the YouTube companion.'
          });
          return;
        }
        const content = document.querySelector('video, ytm-rich-item-renderer, ytm-compact-video-renderer, ytm-playlist-video-renderer');
        const signIn = document.querySelector('a[href*="accounts.google.com"], a[href*="ServiceLogin"], a[href*="/signin"]');
        if (!content) {
          window.__vigilBridge({
            type: 'health',
            state: 'degraded',
            detail: signIn
              ? 'YouTube is signed out. Google may reject embedded WebKit sign-in for this companion.'
              : 'YouTube has not loaded a usable subscription or video surface yet.'
          });
          return;
        }
        window.__vigilBridge({ type: 'health', state: 'ready', detail: '' });
      };
      setTimeout(reportHealth, 750);
      setTimeout(reportHealth, 3500);
    })();
    """#

    private static let instagram = #"""
    (() => {
      if (window.__vigilInstagramInstalled) return;
      window.__vigilInstagramInstalled = true;

      const style = document.createElement('style');
      style.id = 'vigil-instagram-style';
      style.textContent = `
        html, body, #react-root, main, main > div, div[role="main"] {
          width: 100% !important;
          max-width: none !important;
          min-width: 0 !important;
        }
        html, body { max-width: 100% !important; touch-action: pan-x pan-y pinch-zoom; }
        article { max-width: min(100vw, 680px) !important; margin-inline: auto !important; }
        html[data-vigil-policy-tier="soft"] a[href^="/reel"],
        html[data-vigil-policy-tier="soft"] a[href^="/reels"],
        html[data-vigil-policy-tier="soft"] a[href^="/explore"],
        html[data-vigil-policy-tier="soft"] a[href^="/shop"],
        html[data-vigil-policy-tier="soft"] a[href^="/shopping"],
        html[data-vigil-policy-tier="soft"] a[href^="/live"],
        html[data-vigil-policy-tier="soft"] [aria-label="Reels" i],
        html[data-vigil-policy-tier="soft"] [aria-label="Explore" i] {
          display: none !important;
        }
        [data-vigil-soft-hidden="true"] {
          display: none !important;
        }
      `;
      document.documentElement.appendChild(style);

      const reconcile = () => {
        document.querySelectorAll('[data-vigil-soft-hidden="true"]')
          .forEach((node) => node.removeAttribute('data-vigil-soft-hidden'));
        if (document.documentElement.dataset.vigilPolicyTier !== 'soft') return;
        document.querySelectorAll('article, div[role="presentation"], div[role="button"]')
          .forEach((node) => {
            const label = String(node.textContent || node.getAttribute('aria-label') || '').trim().toLowerCase();
            if (!label.includes('sponsored') && !label.includes('suggested for you')) return;
            const container = node.closest('article') || node;
            container.dataset.vigilSoftHidden = 'true';
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
      document.addEventListener('__vigilPolicyTierChanged', scheduleReconcile);
      window.__vigilBridge({ type: 'health', state: 'ready', detail: '' });
    })();
    """#

}
