import Foundation

enum DOMAdapters {
    static var contentFilterBootstrap: String {
        contentFilterBootstrap(for: .conceal)
    }

    static func contentFilterBootstrap(for unclassifiedMediaPolicy: UnclassifiedMediaPolicy) -> String {
        let unclassifiedMediaCSS = unclassifiedMediaPolicy.concealsUnclassifiedMedia ? #"""
        canvas, object, embed, input[type="image"],
        svg image, svg foreignObject { visibility: hidden !important; }
        [data-vigil-background-verdict="unknown"],
        [data-vigil-background-verdict="sensitive"],
        [data-vigil-background-verdict="none"],
        [data-vigil-background-verdict="unknown"]::before,
        [data-vigil-background-verdict="unknown"]::after,
        [data-vigil-background-verdict="sensitive"]::before,
        [data-vigil-background-verdict="sensitive"]::after,
        [data-vigil-background-verdict="none"]::before,
        [data-vigil-background-verdict="none"]::after {
          background-image: none !important;
        }
        *, *::before, *::after {
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
        frameSafetyScript(audioEnabled: audioEnabled) + controlsScript(for: service)
    }

    static func frameSafetyScript(audioEnabled: Bool) -> String {
        common(audioEnabled: audioEnabled)
    }

    static func controlsScript(for service: SocialService) -> String {
        lockdownProbe(service) + serviceScript(service)
    }

    private static func lockdownProbe(_ service: SocialService) -> String {
        let featureKeys: String
        let allowedHosts: String
        switch service {
        case .instagram:
            featureKeys = "['reels', 'explore', 'suggested', 'shopping', 'ads']"
            allowedHosts = "['instagram.com', 'www.instagram.com']"
        case .youtube:
            featureKeys = "['home', 'explore', 'suggested', 'ads']"
            allowedHosts = "['youtube.com', 'www.youtube.com', 'm.youtube.com']"
        }
        return #"""
        (() => {
          if (window.__vigilPolicyProbeInstalled) return;
          const pageHost = String(location.hostname || '').toLowerCase();
          const allowedHosts = ALLOWED_HOSTS;
          if (!allowedHosts.includes(pageHost)) return;
          window.__vigilPolicyProbeInstalled = true;
          let request = 0;
          const featureKeys = FEATURE_KEYS;
          const blockedFeatures = new Map(featureKeys.map((key) => [key, null]));
          const publish = (key, blocked) => {
            if (!blockedFeatures.has(key)) return;
            const normalized = Boolean(blocked);
            if (blockedFeatures.get(key) === normalized
                && document.documentElement.getAttribute(`data-vigil-feature-${key}`)) return;
            blockedFeatures.set(key, normalized);
            document.documentElement.setAttribute(
              `data-vigil-feature-${key}`,
              normalized ? 'blocked' : 'available'
            );
            const tier = [...blockedFeatures.values()].some((value) => value !== false) ? 'soft' : 'normal';
            document.documentElement.dataset.vigilPolicyTier = tier;
            document.dispatchEvent(new CustomEvent('__vigilPolicyFeaturesChanged', {
              detail: { key, blocked: normalized, tier }
            }));
          };
          featureKeys.forEach((key) => {
            document.documentElement.setAttribute(`data-vigil-feature-${key}`, 'pending');
          });
          document.documentElement.dataset.vigilPolicyTier = 'soft';

          const probe = async () => {
            const current = ++request;
            if (!navigator.onLine) {
              featureKeys.forEach((key) => publish(key, true));
              return;
            }
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 6000);
            try {
              const results = await Promise.all(featureKeys.map(async (key) => {
                const requestedURL = new URL('/', location.origin);
                requestedURL.searchParams.set('__vigil_feature', key);
                try {
                  const response = await fetch(requestedURL.href, {
                    method: 'HEAD',
                    cache: 'no-store',
                    credentials: 'include',
                    redirect: 'follow',
                    signal: controller.signal
                  });
                  let responseURL = null;
                  try { responseURL = response.url ? new URL(response.url) : null; } catch (_) {}
                  const responseHost = String(responseURL?.hostname || '').toLowerCase();
                  const isServiceHost = allowedHosts.includes(responseHost);
                  const accepted = response.ok
                    && response.status >= 200 && response.status < 300
                    && responseURL !== null
                    && responseURL.protocol === 'https:'
                    && isServiceHost
                    && responseURL.searchParams.get('__vigil_feature') === key;
                  return [key, !accepted];
                } catch (_) {
                  return [key, true];
                }
              }));
              if (current === request) results.forEach(([key, blocked]) => publish(key, blocked));
            } catch (_) {
              // The managed device filter rejects feature probes before they
              // reach the service. Network uncertainty also fails restrictive.
              if (current === request) featureKeys.forEach((key) => publish(key, true));
            } finally {
              clearTimeout(timeout);
            }
          };
          probe();
          addEventListener('online', probe);
          addEventListener('focus', probe);
          setInterval(probe, 15000);
        })();
        """#
            .replacingOccurrences(of: "FEATURE_KEYS", with: featureKeys)
            .replacingOccurrences(of: "ALLOWED_HOSTS", with: allowedHosts)
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
            const documentID = (() => {
              try { return crypto.randomUUID(); } catch (_) {}
              return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
            })();
            const frameCommandChannel = '__vigilFrameCommandV1';
            const sendFrameCommand = (frame, command, value = null) => {
              try {
                frame.contentWindow?.postMessage({ channel: frameCommandChannel, command, value }, '*');
              } catch (_) {}
            };
            const relayFrameCommand = (command, value = null) => {
              document.querySelectorAll('iframe').forEach((frame) => sendFrameCommand(frame, command, value));
            };

            const applyAudioPreference = () => {
              document.querySelectorAll('video, audio').forEach((media) => {
                const shouldMute = !window.__vigilAudioPreferred;
                if (shouldMute) {
                  if (media.dataset.vigilMutedByPreference !== 'true') {
                    media.dataset.vigilMutedByPreference = 'true';
                    media.dataset.vigilPreviousMuted = String(media.muted);
                    media.dataset.vigilPreviousDefaultMuted = String(media.defaultMuted);
                  }
                  media.defaultMuted = true;
                  media.muted = true;
                } else if (media.dataset.vigilMutedByPreference === 'true') {
                  media.muted = media.dataset.vigilPreviousMuted === 'true';
                  media.defaultMuted = media.dataset.vigilPreviousDefaultMuted === 'true';
                  delete media.dataset.vigilMutedByPreference;
                  delete media.dataset.vigilPreviousMuted;
                  delete media.dataset.vigilPreviousDefaultMuted;
                }
              });
            };

            window.__vigilSetAudioPreference = (enabled) => {
              window.__vigilAudioPreferred = Boolean(enabled);
              applyAudioPreference();
              relayFrameCommand('audio', window.__vigilAudioPreferred);
              bridge({ type: 'audio', enabled: Boolean(enabled) });
            };

            window.__vigilPauseAllMedia = () => {
              document.querySelectorAll('video, audio').forEach((media) => media.pause());
              relayFrameCommand('pause');
            };
            addEventListener('message', (event) => {
              if (event.source !== window.parent) return;
              const payload = event.data;
              if (!payload || payload.channel !== frameCommandChannel) return;
              if (payload.command === 'audio' && typeof payload.value === 'boolean') {
                window.__vigilAudioPreferred = payload.value;
                applyAudioPreference();
                relayFrameCommand('audio', payload.value);
              } else if (payload.command === 'pause') {
                document.querySelectorAll('video, audio').forEach((media) => media.pause());
                relayFrameCommand('pause');
              }
            });

            let lastAppearance = null;
            let appearanceScheduled = false;
            const reportAppearance = () => {
              appearanceScheduled = false;
              const colors = [document.body, document.documentElement]
                .filter(Boolean)
                .map((element) => getComputedStyle(element).backgroundColor)
                .filter((value) => value && value !== 'transparent' && value !== 'rgba(0, 0, 0, 0)');
              let dark = matchMedia('(prefers-color-scheme: dark)').matches;
              for (const value of colors) {
                const match = value.match(/rgba?\(\s*([\d.]+)[, ]+\s*([\d.]+)[, ]+\s*([\d.]+)/i);
                if (!match) continue;
                const red = Number(match[1]);
                const green = Number(match[2]);
                const blue = Number(match[3]);
                dark = (red * 0.2126 + green * 0.7152 + blue * 0.0722) < 128;
                break;
              }
              if (lastAppearance === dark) return;
              lastAppearance = dark;
              bridge({ type: 'appearance', dark });
            };
            const scheduleAppearance = () => {
              if (appearanceScheduled) return;
              appearanceScheduled = true;
              requestAnimationFrame(reportAppearance);
            };
            new MutationObserver(scheduleAppearance).observe(document.documentElement, {
              childList: true, subtree: true, attributes: true,
              attributeFilter: ['class', 'style', 'data-theme']
            });
            matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', scheduleAppearance);
            addEventListener('pageshow', scheduleAppearance);
            scheduleAppearance();

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
              if (!id || (mediaElements.has(id) && mediaElements.get(id) !== element)) {
                id = String(nextMediaID++);
                element.dataset.vigilMediaId = id;
                element.dataset.vigilMediaVerdict = 'unknown';
                mediaElements.set(id, element);
              } else if (!mediaElements.has(id)) {
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
                documentID,
                id,
                token,
                kind: element instanceof HTMLVideoElement ? 'videoFrame' : 'image',
                dataURL: dataURL || '',
                captureFailed: !dataURL
              });
            };

            window.__vigilResolveMedia = (resolvedDocumentID, id, token, verdict) => {
              if (String(resolvedDocumentID) !== documentID) return;
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

            const backgroundURLs = (value) => [...String(value || '').matchAll(/url\((['"]?)(.*?)\1\)/gi)]
              .map((match) => String(match[2] || '').trim())
              .filter(Boolean);
            const isTrustedChromeBackground = (element, urls) => {
              const rect = element.getBoundingClientRect();
              if (rect.width < 1 || rect.height < 1 || rect.width > 144 || rect.height > 144) return false;
              if (!element.closest('button, a, nav, header, [role="button"], [role="tab"], [role="navigation"]')) return false;
              return urls.every((value) => {
                if (/^data:image\/svg\+xml[,;]/i.test(value)) return true;
                try {
                  const url = new URL(value, location.href);
                  const host = url.hostname.toLowerCase();
                  const path = url.pathname.toLowerCase();
                  if ((host === 'www.gstatic.com' || host === 'ssl.gstatic.com') && path.includes('/youtube/')) return true;
                  if (host.endsWith('.fbcdn.net') && path.includes('/rsrc.php')) return true;
                  if (host === 'static.cdninstagram.com' && path.includes('/rsrc.php')) return true;
                  if (['instagram.com', 'www.instagram.com', 'youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(host)
                      && (path.startsWith('/s/') || path.startsWith('/static/'))) return true;
                } catch (_) {}
                return false;
              });
            };
            const inspectBackgroundMedia = (root = document.body) => {
              if (!(root instanceof Element) || !root.isConnected) return;
              [root, ...root.querySelectorAll('*')].forEach((element) => {
                if (!element.dataset) return;
                // Probe past our own fail-closed CSS synchronously. JavaScript
                // runs to completion before WebKit can paint the probe state.
                element.dataset.vigilBackgroundVerdict = 'inspecting';
                const backgrounds = [
                  getComputedStyle(element).backgroundImage,
                  getComputedStyle(element, '::before').backgroundImage,
                  getComputedStyle(element, '::after').backgroundImage
                ];
                const urls = backgrounds.flatMap(backgroundURLs);
                if (!urls.length) {
                  // CSS gradients and other generated backgrounds contain no
                  // externally sourced pixels. Preserve them as interface
                  // chrome; applying the `none` verdict would erase gradients.
                  const hasGeneratedBackground = backgrounds.some((value) => value && value !== 'none');
                  element.dataset.vigilBackgroundVerdict = hasGeneratedBackground ? 'safe' : 'none';
                  return;
                }
                element.dataset.vigilBackgroundVerdict = isTrustedChromeBackground(element, urls) ? 'safe' : 'unknown';
              });
            };

            const inspectDocument = () => {
              inspectionScheduled = false;
              for (const [id, element] of mediaElements) {
                if (!element.isConnected) mediaElements.delete(id);
              }
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
                  type: 'pageText', documentID, revision, index, total, wasTruncated,
                  text: text.slice(index * chunkLength, (index + 1) * chunkLength)
                });
              }
            };

            window.__vigilResolvePageText = (resolvedDocumentID, revision, verdict) => {
              if (String(resolvedDocumentID) !== documentID) return;
              if (String(revision) !== String(textRevision)) return;
              if (['safe', 'sensitive', 'unknown'].includes(verdict)) {
                document.documentElement.dataset.vigilPageVerdict = verdict;
              }
            };

            const scheduleInspection = () => {
              if (inspectionScheduled) return;
              inspectionScheduled = true;
              setTimeout(inspectDocument, 120);
            };
            const markMediaPending = (node) => {
              if (!(node instanceof Element)) return;
              const media = [
                ...(node.matches('img, video') ? [node] : []),
                ...node.querySelectorAll('img, video')
              ];
              media.forEach((element) => {
                element.dataset.vigilMediaVerdict = 'unknown';
                delete element.dataset.vigilMediaFingerprint;
              });
            };
            const scheduleContentInspection = (records) => {
              records.forEach((record) => {
                if (record.type === 'attributes') markMediaPending(record.target);
                record.addedNodes?.forEach(markMediaPending);
              });
              scheduleInspection();
            };
            new MutationObserver(scheduleContentInspection).observe(document.documentElement, {
              childList: true, subtree: true, characterData: true,
              attributes: true, attributeFilter: ['src', 'srcset', 'poster']
            });
            let backgroundInspectionScheduled = false;
            const backgroundInspectionRoots = new Set();
            const markBackgroundPending = (node) => {
              if (!(node instanceof Element)) return;
              node.dataset.vigilBackgroundVerdict = 'unknown';
              node.querySelectorAll('*').forEach((descendant) => {
                descendant.dataset.vigilBackgroundVerdict = 'unknown';
              });
            };
            const queueBackgroundInspection = (node) => {
              if (!(node instanceof Element)) return;
              markBackgroundPending(node);
              for (const queued of backgroundInspectionRoots) {
                if (queued.contains(node)) return;
                if (node.contains(queued)) backgroundInspectionRoots.delete(queued);
              }
              backgroundInspectionRoots.add(node);
            };
            const requestBackgroundInspection = () => {
              if (backgroundInspectionScheduled) return;
              backgroundInspectionScheduled = true;
              setTimeout(() => {
                backgroundInspectionScheduled = false;
                const roots = [...backgroundInspectionRoots];
                backgroundInspectionRoots.clear();
                roots.forEach(inspectBackgroundMedia);
              }, 120);
            };
            const queueStylesheetImpact = (node) => {
              if (!(node instanceof Element)) return;
              const stylesheets = [
                ...(node.matches('style, link[rel~="stylesheet" i]') ? [node] : []),
                ...node.querySelectorAll('style, link[rel~="stylesheet" i]')
              ];
              if (!stylesheets.length) return;
              queueBackgroundInspection(document.body);
              stylesheets.forEach((stylesheet) => {
                if (stylesheet instanceof HTMLLinkElement) {
                  stylesheet.addEventListener('load', () => {
                    queueBackgroundInspection(document.body);
                    requestBackgroundInspection();
                  }, { once: true });
                }
              });
            };
            const scheduleBackgroundInspection = (records) => {
              records.forEach((record) => {
                if (record.type === 'attributes') queueBackgroundInspection(record.target);
                if (record.type === 'childList') {
                  queueBackgroundInspection(record.target);
                  if (record.target instanceof Element && record.target.matches('style')) {
                    queueStylesheetImpact(record.target);
                  }
                  record.addedNodes?.forEach((node) => {
                    queueBackgroundInspection(node);
                    queueStylesheetImpact(node);
                  });
                }
                if (record.type === 'characterData'
                    && record.target.parentElement?.matches('style')) {
                  queueStylesheetImpact(record.target.parentElement);
                }
              });
              requestBackgroundInspection();
            };
            new MutationObserver(scheduleBackgroundInspection).observe(document.documentElement, {
              childList: true, subtree: true,
              characterData: true,
              attributes: true, attributeFilter: ['class', 'style']
            });
            inspectBackgroundMedia(document.body);
            queueStylesheetImpact(document.head || document.documentElement);
            requestBackgroundInspection();
            const rescanAllBackgrounds = () => {
              queueBackgroundInspection(document.body);
              requestBackgroundInspection();
            };
            addEventListener('load', rescanAllBackgrounds, { once: true });
            addEventListener('pageshow', rescanAllBackgrounds);
            matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', rescanAllBackgrounds);
            addEventListener('orientationchange', rescanAllBackgrounds);
            ['animationstart', 'animationiteration', 'transitionstart'].forEach((eventName) => {
              document.addEventListener(eventName, (event) => {
                queueBackgroundInspection(event.target);
                requestBackgroundInspection();
              }, true);
            });
            ['pointerover', 'pointerdown', 'focusin'].forEach((eventName) => {
              document.addEventListener(eventName, (event) => {
                const target = event.target instanceof Element ? event.target : event.target?.parentElement;
                queueBackgroundInspection(target);
                const interactive = target?.closest(
                  'button, a, input, textarea, select, label, [role="button"], [role="tab"], [tabindex]'
                );
                if (interactive !== target) queueBackgroundInspection(interactive);
                requestBackgroundInspection();
              }, true);
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
                relayFrameCommand('audio', window.__vigilAudioPreferred);
              });
            };

            document.addEventListener('pointerup', applyAudioPreference, true);
            document.addEventListener('play', applyAudioPreference, true);
            document.addEventListener('load', (event) => {
              if (event.target instanceof HTMLIFrameElement) {
                sendFrameCommand(event.target, 'audio', window.__vigilAudioPreferred);
              }
            }, true);
            new MutationObserver(scheduleAudioRefresh).observe(document.documentElement, {
              childList: true,
              subtree: true
            });
            applyAudioPreference();
            relayFrameCommand('audio', window.__vigilAudioPreferred);
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
      if (!['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(String(location.hostname || '').toLowerCase())) return;
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
        html:is([data-vigil-feature-explore="blocked"], [data-vigil-feature-explore="pending"]) a[href*="/feed/explore"],
        html:is([data-vigil-feature-explore="blocked"], [data-vigil-feature-explore="pending"]) a[href*="/feed/trending"],
        html:is([data-vigil-feature-suggested="blocked"], [data-vigil-feature-suggested="pending"]) ytm-related-item-section-renderer,
        html:is([data-vigil-feature-suggested="blocked"], [data-vigil-feature-suggested="pending"]) ytm-watch-next-secondary-results-renderer,
        html:is([data-vigil-feature-ads="blocked"], [data-vigil-feature-ads="pending"]) ytm-promoted-sparkles-web-renderer,
        html:is([data-vigil-feature-ads="blocked"], [data-vigil-feature-ads="pending"]) ytm-companion-ad-renderer,
        html:is([data-vigil-feature-ads="blocked"], [data-vigil-feature-ads="pending"]) ytm-display-ad-renderer,
        html:is([data-vigil-feature-ads="blocked"], [data-vigil-feature-ads="pending"]) ytm-promoted-video-renderer,
        html:is([data-vigil-feature-ads="blocked"], [data-vigil-feature-ads="pending"]) [data-is-ad="true"] {
          display: none !important;
        }
        html:is([data-vigil-feature-home="blocked"], [data-vigil-feature-home="pending"])[data-vigil-youtube-home="true"] ytm-rich-grid-renderer {
          visibility: hidden !important;
        }
        [data-vigil-hidden-feature] {
          display: none !important;
        }
        a[href^="youtube:"], a[href^="vnd.youtube:"],
        ytm-open-app-button, ytm-app-upsell-dialog-renderer,
        ytm-app-promo-renderer, [data-vigil-native-app-prompt="true"] {
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
        document.querySelectorAll('[data-vigil-hidden-feature]')
          .forEach((node) => node.removeAttribute('data-vigil-hidden-feature'));
        document.querySelectorAll('a[href^="/shorts"], a[href*="youtube.com/shorts"], ytm-reel-shelf-renderer, ytd-reel-shelf-renderer, ytm-reel-item-renderer, ytd-reel-video-renderer, ytm-shorts-lockup-view-model, ytm-shorts-lockup-view-model-v2, [is-shorts]')
          .forEach((node) => {
            const container = node.closest('ytm-pivot-bar-item-renderer, ytm-pivot-bar-item, ytd-guide-entry-renderer, [role="tab"]') || node;
            container.style.setProperty('display', 'none', 'important');
          });
        document.querySelectorAll('ytm-pivot-bar-item-renderer, ytm-pivot-bar-item, [role="tab"]').forEach((node) => {
          const label = String(node.textContent || node.getAttribute('aria-label') || '').trim().toLowerCase();
          if (label === 'shorts' || label.startsWith('shorts ')) node.style.setProperty('display', 'none', 'important');
        });
        if (document.documentElement.getAttribute('data-vigil-feature-explore') !== 'available') {
          document.querySelectorAll('a[href*="/feed/explore"], a[href*="/feed/trending"]')
            .forEach((node) => {
              const container = node.closest('ytm-pivot-bar-item-renderer, ytm-pivot-bar-item, ytd-guide-entry-renderer, [role="tab"]') || node;
              container.dataset.vigilHiddenFeature = 'explore';
            });
        }
        if (document.documentElement.getAttribute('data-vigil-feature-ads') !== 'available') {
          document.querySelectorAll('ytm-promoted-sparkles-web-renderer, ytm-companion-ad-renderer, ytm-display-ad-renderer, ytm-promoted-video-renderer, [data-is-ad="true"]')
            .forEach((node) => { node.dataset.vigilHiddenFeature = 'ads'; });
        }
        document.querySelectorAll('button, [role="button"]').forEach((node) => {
          const label = String(node.textContent || node.getAttribute('aria-label') || '').trim().toLowerCase();
          if (label === 'open youtube app' || label === 'switch to the app' || label === 'get the youtube app') {
            const container = node.closest('ytm-app-upsell-dialog-renderer, ytm-app-promo-renderer, ytm-mealbar-promo-renderer') || node;
            container.dataset.vigilNativeAppPrompt = 'true';
          }
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
      document.addEventListener('__vigilPolicyFeaturesChanged', scheduleReconcile);

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
      if (!['instagram.com', 'www.instagram.com'].includes(String(location.hostname || '').toLowerCase())) return;
      window.__vigilInstagramInstalled = true;

      const style = document.createElement('style');
      style.id = 'vigil-instagram-style';
      style.textContent = `
        html:is([data-vigil-feature-reels="blocked"], [data-vigil-feature-reels="pending"]) a[href^="/reel"],
        html:is([data-vigil-feature-reels="blocked"], [data-vigil-feature-reels="pending"]) a[href^="/reels"],
        html:is([data-vigil-feature-reels="blocked"], [data-vigil-feature-reels="pending"]) [aria-label="Reels" i],
        html:is([data-vigil-feature-explore="blocked"], [data-vigil-feature-explore="pending"]) a[href^="/explore"],
        html:is([data-vigil-feature-explore="blocked"], [data-vigil-feature-explore="pending"]) [aria-label="Explore" i],
        html:is([data-vigil-feature-shopping="blocked"], [data-vigil-feature-shopping="pending"]) a[href^="/shop"],
        html:is([data-vigil-feature-shopping="blocked"], [data-vigil-feature-shopping="pending"]) a[href^="/shopping"],
        html:is([data-vigil-feature-shopping="blocked"], [data-vigil-feature-shopping="pending"]) a[href^="/live"] {
          display: none !important;
        }
        html[data-vigil-instagram-route-feature="reels"][data-vigil-feature-reels="pending"] body,
        html[data-vigil-instagram-route-feature="explore"][data-vigil-feature-explore="pending"] body,
        html[data-vigil-instagram-route-feature="suggested"]:is([data-vigil-feature-explore="pending"], [data-vigil-feature-suggested="pending"]) body,
        html[data-vigil-instagram-route-feature="shopping"][data-vigil-feature-shopping="pending"] body {
          visibility: hidden !important;
        }
        [data-vigil-hidden-feature],
        [data-vigil-native-app-prompt="true"],
        a[href^="instagram:"] {
          display: none !important;
        }
      `;
      document.documentElement.appendChild(style);

      const normalizeBottomNavigation = () => {
        const routeLinks = (prefix) => [...document.querySelectorAll('a[href]')].filter((link) => {
          try {
            const path = new URL(link.href, location.href).pathname.toLowerCase();
            return path === prefix || path.startsWith(`${prefix}/`);
          } catch (_) { return false; }
        });
        for (const reelsLink of routeLinks('/reels')) {
          for (const directLink of routeLinks('/direct')) {
            let navigation = reelsLink.parentElement;
            while (navigation && !navigation.contains(directLink)) navigation = navigation.parentElement;
            if (!navigation) continue;
            const rect = navigation.getBoundingClientRect();
            if (rect.height > 300 || rect.bottom < innerHeight - 30 || rect.top >= innerHeight) continue;
            let reelsItem = reelsLink;
            let directItem = directLink;
            while (reelsItem.parentElement && reelsItem.parentElement !== navigation) reelsItem = reelsItem.parentElement;
            while (directItem.parentElement && directItem.parentElement !== navigation) directItem = directItem.parentElement;
            if (reelsItem.parentElement === navigation && directItem.parentElement === navigation
                && [...navigation.children].indexOf(directItem) < [...navigation.children].indexOf(reelsItem)) {
              navigation.insertBefore(reelsItem, directItem);
            }
            return;
          }
        }
      };

      const hasExactLeafLabel = (container, expected) => [...container.querySelectorAll('span, div, a')].some((node) => {
        if (node.children.length > 0) return false;
        const label = String(node.textContent || node.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().toLowerCase();
        return label === expected;
      });

      const routeFeature = (value) => {
        try {
          const url = new URL(value, location.href);
          if (!['instagram.com', 'www.instagram.com'].includes(url.hostname.toLowerCase())) return '';
          const path = url.pathname.toLowerCase();
          if (path === '/reel' || path.startsWith('/reel/') || path === '/reels' || path.startsWith('/reels/')) return 'reels';
          if (path === '/explore/people/suggested' || path.startsWith('/explore/people/suggested/')) return 'suggested';
          if (path === '/explore' || path.startsWith('/explore/')) return 'explore';
          if (/^\/(shop|shopping|live)(\/|$)/.test(path)) return 'shopping';
          return '';
        } catch (_) { return ''; }
      };
      const restrictedFeature = (value) => {
        const feature = routeFeature(value);
        const isBlocked = (key) => document.documentElement.getAttribute(`data-vigil-feature-${key}`) === 'blocked';
        if (feature === 'suggested' && isBlocked('explore')) return 'explore';
        return feature && isBlocked(feature) ? feature : '';
      };
      const syncRouteFeature = () => {
        const feature = routeFeature(location.href);
        if (feature) document.documentElement.dataset.vigilInstagramRouteFeature = feature;
        else delete document.documentElement.dataset.vigilInstagramRouteFeature;
      };
      const blockRestrictedNavigation = (event) => {
        const link = event.target?.closest?.('a[href]');
        if (!link) return;
        const feature = restrictedFeature(link.href);
        if (!feature) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        window.__vigilBridge({
          type: 'health', state: 'degraded',
          detail: `That Instagram ${feature} surface is intentionally unavailable.`
        });
      };
      const enforceRestrictedLocation = () => {
        syncRouteFeature();
        const feature = restrictedFeature(location.href);
        if (!feature) return;
        window.__vigilBridge({
          type: 'health', state: 'degraded',
          detail: `That Instagram ${feature} surface is intentionally unavailable.`
        });
        location.replace('/');
      };
      document.addEventListener('click', blockRestrictedNavigation, true);
      for (const name of ['pushState', 'replaceState']) {
        const original = history[name];
        history[name] = function(...args) {
          const result = original.apply(this, args);
          queueMicrotask(enforceRestrictedLocation);
          return result;
        };
      }
      addEventListener('popstate', enforceRestrictedLocation);
      document.addEventListener('__vigilPolicyFeaturesChanged', enforceRestrictedLocation);
      enforceRestrictedLocation();

      const reconcile = () => {
        document.querySelectorAll('[data-vigil-hidden-feature]')
          .forEach((node) => node.removeAttribute('data-vigil-hidden-feature'));

        const promptControls = [...document.querySelectorAll('a, button, [role="button"]')].filter((node) => {
          const label = String(node.textContent || node.getAttribute('aria-label') || '').trim().toLowerCase();
          return label === 'open instagram' || label === 'get the instagram app' || label === 'download the app';
        });
        promptControls.forEach((node) => {
          node.dataset.vigilNativeAppPrompt = 'true';
        });

        if (document.documentElement.getAttribute('data-vigil-feature-suggested') !== 'available') {
          document.querySelectorAll('article, [data-testid*="suggested" i]').forEach((node) => {
            const container = node.closest('article') || node;
            if (hasExactLeafLabel(container, 'suggested for you') || container.querySelector?.('a[href*="/explore/people/suggested"]')
                || node.matches?.('[data-testid*="suggested" i]')) {
              container.dataset.vigilHiddenFeature = 'suggested';
            }
          });
        }
        if (document.documentElement.getAttribute('data-vigil-feature-ads') !== 'available') {
          document.querySelectorAll('article, [data-testid*="sponsored" i], [data-testid*="ad-container" i]').forEach((node) => {
            const container = node.closest('article') || node;
            if (hasExactLeafLabel(container, 'sponsored') || node.matches?.('[data-testid*="sponsored" i], [data-testid*="ad-container" i]')) {
              container.dataset.vigilHiddenFeature = 'ads';
            }
          });
        }
        normalizeBottomNavigation();
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
      document.addEventListener('__vigilPolicyFeaturesChanged', scheduleReconcile);
      window.__vigilBridge({ type: 'health', state: 'ready', detail: '' });
    })();
    """#

}
