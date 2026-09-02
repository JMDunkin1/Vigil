import Foundation

enum DOMAdapters {
    static var contentFilterBootstrap: String {
        contentFilterBootstrap(for: .conceal)
    }

    static func documentStartScript(
        for service: SocialService,
        unclassifiedMediaPolicy: UnclassifiedMediaPolicy,
        audioEnabled: Bool,
        contentSafetyEnabled: Bool = true
    ) -> String {
        let safetyBootstrap = contentSafetyEnabled
            ? contentFilterBootstrap(for: unclassifiedMediaPolicy)
                + earlyMediaGate(
                    audioEnabled: audioEnabled,
                    preferAudibleVideo: service == .instagram
                )
            : service == .instagram ? instagramStableDocumentStartStyle : ""
        return authenticationDocumentGuard(for: service, body:
            (service == .snapchat ? snapchatDesktopIdentityBootstrap : "")
            + documentIdentityBootstrap
            + safetyBootstrap
        )
    }

    private static let snapchatDesktopIdentityBootstrap = #"""
    (() => {
      // Snapchat for Web currently gates the chat client on a desktop browser
      // identity. Keep the compatibility surface narrow and deterministic;
      // navigation remains confined independently by SocialService.
      const define = (target, key, value) => {
        try {
          Object.defineProperty(target, key, {
            configurable: true,
            enumerable: true,
            get: () => value
          });
        } catch (_) {}
      };
      const desktopUserAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15';
      define(Navigator.prototype, 'userAgent', desktopUserAgent);
      define(Navigator.prototype, 'appVersion', desktopUserAgent.replace(/^Mozilla\//, ''));
      define(Navigator.prototype, 'platform', 'MacIntel');
      define(Navigator.prototype, 'vendor', 'Apple Computer, Inc.');
      define(Navigator.prototype, 'maxTouchPoints', 0);
      define(Navigator.prototype, 'webdriver', false);

      const style = document.createElement('style');
      style.id = 'vigil-snapchat-start-style';
      style.textContent = `
        a[href*="/spotlight" i], a[href*="/discover" i],
        button[aria-label*="Spotlight" i], [role="button"][aria-label*="Spotlight" i],
        button[aria-label*="Discover" i], [role="button"][aria-label*="Discover" i],
        [data-testid*="spotlight" i], [data-testid*="discover" i] {
          display: none !important;
        }
        html[data-vigil-snapchat-restricted="true"] body {
          visibility: hidden !important;
        }
      `;
      document.documentElement.appendChild(style);
    })();
    """#

    private static let documentIdentityBootstrap = #"""
    (() => {
      if (typeof window.__vigilDocumentID === 'string' && window.__vigilDocumentID) return;
      const documentID = (() => {
        try { return crypto.randomUUID(); } catch (_) {}
        return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      })();
      try {
        Object.defineProperty(window, '__vigilDocumentID', {
          value: documentID,
          writable: false,
          configurable: false
        });
      } catch (_) {
        window.__vigilDocumentID = documentID;
      }
    })();
    """#

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
        [data-vigil-background-subtree-pending]:not([data-vigil-background-inspecting]),
        [data-vigil-background-subtree-pending] *:not([data-vigil-background-inspecting]),
        [data-vigil-background-subtree-pending]:not([data-vigil-background-inspecting])::before,
        [data-vigil-background-subtree-pending]:not([data-vigil-background-inspecting])::after,
        [data-vigil-background-subtree-pending] *:not([data-vigil-background-inspecting])::before,
        [data-vigil-background-subtree-pending] *:not([data-vigil-background-inspecting])::after {
          background-image: none !important;
        }
        *, *::before, *::after {
          border-image-source: none !important;
          list-style-image: none !important;
        }
        [data-vigil-content-verdict="unknown"],
        [data-vigil-content-verdict="sensitive"] {
          content: normal !important;
        }
        [data-vigil-content-before-verdict="unknown"]::before,
        [data-vigil-content-before-verdict="sensitive"]::before,
        [data-vigil-content-after-verdict="unknown"]::after,
        [data-vigil-content-after-verdict="sensitive"]::after {
          content: none !important;
        }
        html[data-vigil-content-subtree-pending] body *:not(img):not(video):not([data-vigil-content-inspecting]),
        [data-vigil-content-subtree-pending]:not(img):not(video):not([data-vigil-content-inspecting]),
        [data-vigil-content-subtree-pending] *:not(img):not(video):not([data-vigil-content-inspecting]),
        [data-vigil-visual-effect-pending],
        [data-vigil-visual-effect-pending] *:not(img):not(video) {
          content: normal !important;
        }
        html[data-vigil-content-subtree-pending] body *:not([data-vigil-content-inspecting])::before,
        html[data-vigil-content-subtree-pending] body *:not([data-vigil-content-inspecting])::after,
        [data-vigil-content-subtree-pending]:not([data-vigil-content-inspecting])::before,
        [data-vigil-content-subtree-pending]:not([data-vigil-content-inspecting])::after,
        [data-vigil-content-subtree-pending] *:not([data-vigil-content-inspecting])::before,
        [data-vigil-content-subtree-pending] *:not([data-vigil-content-inspecting])::after,
        [data-vigil-visual-effect-pending] *::before,
        [data-vigil-visual-effect-pending] *::after {
          content: none !important;
        }
        [data-vigil-visual-effect-pending],
        [data-vigil-visual-effect-pending] *,
        [data-vigil-visual-effect-pending]::before,
        [data-vigil-visual-effect-pending]::after,
        [data-vigil-visual-effect-pending] *::before,
        [data-vigil-visual-effect-pending] *::after {
          background-image: none !important;
        }
        """# : ""
        let shadowUnclassifiedMediaCSS = unclassifiedMediaPolicy.concealsUnclassifiedMedia ? #"""
        canvas, object, embed, input[type="image"],
        svg image, svg foreignObject { visibility: hidden !important; }
        *:not([data-vigil-background-verdict="safe"]):not([data-vigil-background-inspecting]),
        *:not([data-vigil-background-verdict="safe"]):not([data-vigil-background-inspecting])::before,
        *:not([data-vigil-background-verdict="safe"]):not([data-vigil-background-inspecting])::after {
          background-image: none !important;
        }
        *, *::before, *::after {
          border-image-source: none !important;
          list-style-image: none !important;
        }
        [data-vigil-content-verdict="unknown"],
        [data-vigil-content-verdict="sensitive"] {
          content: normal !important;
        }
        [data-vigil-content-before-verdict="unknown"]::before,
        [data-vigil-content-before-verdict="sensitive"]::before,
        [data-vigil-content-after-verdict="unknown"]::after,
        [data-vigil-content-after-verdict="sensitive"]::after {
          content: none !important;
        }
        :host([data-vigil-content-subtree-pending]) *:not(img):not(video):not([data-vigil-content-inspecting]),
        [data-vigil-content-subtree-pending]:not(img):not(video):not([data-vigil-content-inspecting]),
        [data-vigil-content-subtree-pending] *:not(img):not(video):not([data-vigil-content-inspecting]),
        [data-vigil-visual-effect-pending],
        [data-vigil-visual-effect-pending] *:not(img):not(video) {
          content: normal !important;
        }
        :host([data-vigil-content-subtree-pending]) *:not([data-vigil-content-inspecting])::before,
        :host([data-vigil-content-subtree-pending]) *:not([data-vigil-content-inspecting])::after,
        [data-vigil-content-subtree-pending]:not([data-vigil-content-inspecting])::before,
        [data-vigil-content-subtree-pending]:not([data-vigil-content-inspecting])::after,
        [data-vigil-content-subtree-pending] *:not([data-vigil-content-inspecting])::before,
        [data-vigil-content-subtree-pending] *:not([data-vigil-content-inspecting])::after,
        [data-vigil-visual-effect-pending] *::before,
        [data-vigil-visual-effect-pending] *::after {
          content: none !important;
        }
        [data-vigil-visual-effect-pending],
        [data-vigil-visual-effect-pending] *,
        [data-vigil-visual-effect-pending]::before,
        [data-vigil-visual-effect-pending]::after,
        [data-vigil-visual-effect-pending] *::before,
        [data-vigil-visual-effect-pending] *::after {
          background-image: none !important;
        }
        """# : ""
        let policy = unclassifiedMediaPolicy.rawValue
        return #"""
    (() => {
      if (window.__vigilContentBootstrapInstalled) return;
      window.__vigilContentBootstrapInstalled = true;
      const documentSafetyCSS = `
        img, video {
          filter: blur(32px) !important;
        }
        DOCUMENT_UNCLASSIFIED_MEDIA_CSS
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
      const shadowSafetyCSS = `
        img, video {
          filter: blur(32px) !important;
        }
        SHADOW_UNCLASSIFIED_MEDIA_CSS
        [data-vigil-media-verdict="safe"] { filter: none !important; }
        [data-vigil-media-verdict="sensitive"] {
          filter: blur(48px) !important;
          visibility: hidden !important;
        }
      `;
      const protectedRoots = new Set();
      const hostShadowRoots = new WeakMap();
      const safetyStyles = new WeakMap();
      const safetySheets = new WeakMap();
      const safetySheetRoots = new WeakMap();
      const nativeSheetReplaceSync = typeof CSSStyleSheet === 'function'
        ? CSSStyleSheet.prototype.replaceSync
        : null;
      const rootSubscribers = new Set();
      const visualMutationSubscribers = new Set();
      const isShadowRoot = (value) => (
        typeof ShadowRoot === 'function' && value instanceof ShadowRoot
      );
      const markerForRoot = (root) => root === document
        ? document.documentElement
        : isShadowRoot(root) ? root.host : null;
      const markVisualPending = (root) => {
        const marker = markerForRoot(root);
        if (!marker?.dataset) return;
        marker.dataset.vigilBackgroundSubtreePending = 'true';
        marker.dataset.vigilContentSubtreePending = 'true';
      };
      const ensureSafetyStyle = (root, forceSheetReset = false) => {
        const container = root === document
          ? (document.head || document.documentElement)
          : root;
        if (!container?.appendChild) return null;
        if (root !== document
            && typeof nativeSheetReplaceSync === 'function'
            && 'adoptedStyleSheets' in root) {
          let sheet = safetySheets.get(root);
          if (!sheet) {
            sheet = new CSSStyleSheet();
            nativeSheetReplaceSync.call(sheet, shadowSafetyCSS);
            safetySheets.set(root, sheet);
            safetySheetRoots.set(sheet, root);
          } else if (forceSheetReset) {
            nativeSheetReplaceSync.call(sheet, shadowSafetyCSS);
          }
          const currentSheets = root.adoptedStyleSheets || [];
          if (!currentSheets.includes(sheet)) {
            root.adoptedStyleSheets = [...currentSheets, sheet];
          }
          return sheet;
        }
        let style = safetyStyles.get(root);
        if (!style) {
          style = document.createElement('style');
          if (root === document) style.id = 'vigil-content-safety-style';
          else style.dataset.vigilShadowSafetyStyle = 'true';
          safetyStyles.set(root, style);
        }
        const expected = root === document ? documentSafetyCSS : shadowSafetyCSS;
        if (forceSheetReset || style.textContent !== expected) style.textContent = expected;
        if (style.disabled) style.disabled = false;
        if (style.hasAttribute('media')) style.removeAttribute('media');
        if (style.getRootNode() !== root) container.prepend(style);
        if (style.sheet) safetySheetRoots.set(style.sheet, root);
        return style;
      };
      const notifyRoot = (root) => {
        rootSubscribers.forEach((subscriber) => {
          try { subscriber(root); } catch (_) {}
        });
      };
      const discoverOpenRoots = (node) => {
        if (!(node instanceof Element || node instanceof Document || isShadowRoot(node))) return;
        const elements = node instanceof Element
          ? [node, ...node.querySelectorAll('*')]
          : [...node.querySelectorAll('*')];
        elements.forEach((element) => {
          const captured = hostShadowRoots.get(element);
          if (captured) registerShadowRoot(captured);
          else if (element.shadowRoot) registerShadowRoot(element.shadowRoot);
        });
      };
      const protectRoot = (root) => {
        if (protectedRoots.has(root)) return;
        protectedRoots.add(root);
        markVisualPending(root);
        ensureSafetyStyle(root);
        new MutationObserver((records) => {
          if (root === document || safetyStyles.has(root)) ensureSafetyStyle(root);
          records.forEach((record) => {
            record.addedNodes?.forEach(discoverOpenRoots);
          });
        }).observe(root, {
          childList: true,
          subtree: true,
          characterData: true,
          attributes: true
        });
        discoverOpenRoots(root);
      };
      function registerShadowRoot(root) {
        if (!isShadowRoot(root)) return root;
        hostShadowRoots.set(root.host, root);
        if (protectedRoots.has(root)) {
          ensureSafetyStyle(root);
          notifyRoot(root);
          return root;
        }
        protectRoot(root);
        notifyRoot(root);
        return root;
      }
      const signalVisualMutation = (root = null) => {
        const targets = isShadowRoot(root) || root === document
          ? [root]
          : [...protectedRoots];
        targets.forEach((target) => {
          markVisualPending(target);
          ensureSafetyStyle(target);
        });
        visualMutationSubscribers.forEach((subscriber) => {
          try { subscriber(isShadowRoot(root) || root === document ? root : null); } catch (_) {}
        });
      };
      const shadowDOM = Object.freeze({
        forEach(callback) {
          if (typeof callback !== 'function') return;
          protectedRoots.forEach((root) => {
            if (root !== document) callback(root);
          });
        },
        subscribe(callback) {
          if (typeof callback !== 'function') return () => {};
          rootSubscribers.add(callback);
          protectedRoots.forEach((root) => {
            if (root !== document) callback(root);
          });
          return () => rootSubscribers.delete(callback);
        },
        subscribeVisualMutations(callback) {
          if (typeof callback !== 'function') return () => {};
          visualMutationSubscribers.add(callback);
          return () => visualMutationSubscribers.delete(callback);
        },
        ensureSafetyStyle,
        signalVisualMutation
      });
      try {
        Object.defineProperty(window, '__vigilShadowDOM', {
          configurable: false,
          enumerable: false,
          writable: false,
          value: shadowDOM
        });
      } catch (_) {
        window.__vigilShadowDOM = shadowDOM;
      }

      const attachShadowDescriptor = Object.getOwnPropertyDescriptor(
        Element.prototype,
        'attachShadow'
      );
      const nativeAttachShadow = attachShadowDescriptor?.value;
      if (typeof nativeAttachShadow === 'function') {
        try {
          Object.defineProperty(Element.prototype, 'attachShadow', {
            configurable: attachShadowDescriptor.configurable,
            enumerable: attachShadowDescriptor.enumerable,
            writable: attachShadowDescriptor.writable,
            value: function vigilAttachShadow(...argumentsList) {
              return registerShadowRoot(nativeAttachShadow.apply(this, argumentsList));
            }
          });
        } catch (_) {}
      }

      const wrapMethod = (prototype, name, shouldSignal = () => true) => {
        const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
        const native = descriptor?.value;
        if (typeof native !== 'function' || descriptor.configurable === false) return;
        try {
          Object.defineProperty(prototype, name, {
            ...descriptor,
            value: function vigilVisualMutationMethod(...argumentsList) {
              const result = native.apply(this, argumentsList);
              const safetyRoot = safetySheetRoots.get(this);
              if (safetyRoot) ensureSafetyStyle(safetyRoot, true);
              if (shouldSignal(argumentsList)) {
                const root = safetyRoot
                  || (isShadowRoot(this) || this === document ? this : null);
                signalVisualMutation(root);
                result?.then?.(
                  () => signalVisualMutation(root),
                  () => signalVisualMutation(root)
                );
              }
              return result;
            }
          });
        } catch (_) {}
      };
      if (typeof CSSStyleSheet === 'function') {
        ['insertRule', 'deleteRule', 'replace', 'replaceSync'].forEach((name) => {
          wrapMethod(CSSStyleSheet.prototype, name);
        });
        const disabledDescriptor = Object.getOwnPropertyDescriptor(
          CSSStyleSheet.prototype,
          'disabled'
        );
        if (disabledDescriptor?.get && disabledDescriptor?.set && disabledDescriptor.configurable) {
          try {
            Object.defineProperty(CSSStyleSheet.prototype, 'disabled', {
              ...disabledDescriptor,
              set(value) {
                disabledDescriptor.set.call(this, value);
                signalVisualMutation();
              }
            });
          } catch (_) {}
        }
      }
      if (typeof CSSStyleDeclaration === 'function') {
        const relevantStyleProperty = (argumentsList) => {
          const property = String(argumentsList[0] || '').toLowerCase();
          return property.startsWith('--')
            || property.includes('background')
            || property.includes('content')
            || property.includes('image');
        };
        wrapMethod(CSSStyleDeclaration.prototype, 'setProperty', relevantStyleProperty);
        wrapMethod(CSSStyleDeclaration.prototype, 'removeProperty', relevantStyleProperty);
        ['background', 'backgroundImage', 'content', 'borderImageSource', 'listStyleImage']
          .forEach((name) => {
            let owner = CSSStyleDeclaration.prototype;
            let descriptor = null;
            while (owner && !descriptor) {
              descriptor = Object.getOwnPropertyDescriptor(owner, name);
              owner = Object.getPrototypeOf(owner);
            }
            if (!descriptor?.get || !descriptor?.set || descriptor.configurable === false) return;
            try {
              Object.defineProperty(CSSStyleDeclaration.prototype, name, {
                ...descriptor,
                get() {
                  return descriptor.get.call(this);
                },
                set(value) {
                  descriptor.set.call(this, value);
                  signalVisualMutation();
                }
              });
            } catch (_) {}
          });
      }
      const patchAdoptedStyleSheets = (prototype) => {
        if (!prototype) return;
        let owner = prototype;
        let descriptor = null;
        while (owner && !descriptor) {
          descriptor = Object.getOwnPropertyDescriptor(owner, 'adoptedStyleSheets');
          owner = Object.getPrototypeOf(owner);
        }
        if (!descriptor?.get || !descriptor?.set || descriptor.configurable === false) return;
        try {
          Object.defineProperty(prototype, 'adoptedStyleSheets', {
            configurable: descriptor.configurable,
            enumerable: descriptor.enumerable,
            get() {
              return descriptor.get.call(this);
            },
            set(value) {
              const required = safetySheets.get(this);
              const requested = Array.from(value || []);
              descriptor.set.call(
                this,
                required && !requested.includes(required) ? [...requested, required] : requested
              );
              if (isShadowRoot(this)) registerShadowRoot(this);
              signalVisualMutation(isShadowRoot(this) || this === document ? this : null);
            }
          });
        } catch (_) {}
      };
      patchAdoptedStyleSheets(Document.prototype);
      if (typeof ShadowRoot === 'function') patchAdoptedStyleSheets(ShadowRoot.prototype);

      protectRoot(document);
      document.documentElement.dataset.vigilUnclassifiedMediaPolicy = 'UNCLASSIFIED_MEDIA_POLICY';
      document.documentElement.dataset.vigilPageVerdict = 'unknown';
    })();
    """#
            .replacingOccurrences(of: "DOCUMENT_UNCLASSIFIED_MEDIA_CSS", with: unclassifiedMediaCSS)
            .replacingOccurrences(of: "SHADOW_UNCLASSIFIED_MEDIA_CSS", with: shadowUnclassifiedMediaCSS)
            .replacingOccurrences(of: "UNCLASSIFIED_MEDIA_POLICY", with: policy)
    }

    static func earlyMediaGate(
        audioEnabled: Bool,
        preferAudibleVideo: Bool = false
    ) -> String {
        let preference = audioEnabled ? "true" : "false"
        let audibleVideoPreference = preferAudibleVideo ? "true" : "false"
        return #"""
    (() => {
      const configuredAudioPreference = AUDIO_PREFERENCE;
      const preferAudibleVideo = PREFER_AUDIBLE_VIDEO;
      if (window.__vigilEarlyMediaGate) {
        window.__vigilEarlyMediaGate.setAudioPreference(configuredAudioPreference);
        return;
      }

      const mediaPrototype = window.HTMLMediaElement?.prototype;
      if (!mediaPrototype) return;
      const nativePlay = mediaPrototype.play;
      const nativePause = mediaPrototype.pause;
      const findProperty = (name) => {
        let owner = mediaPrototype;
        while (owner) {
          const descriptor = Object.getOwnPropertyDescriptor(owner, name);
          if (descriptor) return descriptor;
          owner = Object.getPrototypeOf(owner);
        }
        return null;
      };
      const mutedProperty = findProperty('muted');
      const defaultMutedProperty = findProperty('defaultMuted');
      const states = new WeakMap();
      const mediaRoots = new Set();
      const audioContextStates = new WeakMap();
      const audioContexts = new Set();
      const audioContextPrototypeMethods = new WeakMap();
      const audioContextWrappers = new Map();
      let audioPreferred = configuredAudioPreference;
      let audibleVideoSessionRequested = false;
      let eligibilityResolver = null;
      let audioContextEligibilityResolver = null;

      const readProperty = (media, descriptor, fallback) => {
        try {
          return descriptor?.get ? Boolean(descriptor.get.call(media)) : Boolean(fallback());
        } catch (_) {
          return Boolean(fallback());
        }
      };
      const writeProperty = (media, descriptor, value, fallback) => {
        try {
          if (descriptor?.set) descriptor.set.call(media, Boolean(value));
          else fallback(Boolean(value));
        } catch (_) {}
      };
      const stateFor = (media) => {
        let state = states.get(media);
        if (state) return state;
        state = {
          allowed: false,
          resumeWhenSafe: false,
          settingMute: false,
          mutedExplicitlySet: false,
          userMuteIntent: false,
          desiredMuted: readProperty(media, mutedProperty, () => media.hasAttribute('muted')),
          desiredDefaultMuted: readProperty(
            media,
            defaultMutedProperty,
            () => media.hasAttribute('muted')
          )
        };
        states.set(media, state);
        return state;
      };
      const desiredRuntimeMute = (media, state) => {
        if (preferAudibleVideo && media instanceof HTMLVideoElement
            && audibleVideoSessionRequested && !state.userMuteIntent) return false;
        return state.mutedExplicitlySet ? state.desiredMuted : state.desiredDefaultMuted;
      };
      const setPhysicalMute = (media, state, muted) => {
        state.settingMute = true;
        try {
          if (readProperty(media, mutedProperty, () => media.hasAttribute('muted'))
              !== Boolean(muted)) {
            writeProperty(media, mutedProperty, muted, (value) => {
              try { media.muted = value; } catch (_) {}
            });
          }
        } finally {
          state.settingMute = false;
        }
      };
      const hold = (media, rememberIntent = false, discardIntent = false) => {
        if (!(media instanceof HTMLMediaElement)) return;
        const state = stateFor(media);
        state.allowed = false;
        if (discardIntent) {
          state.resumeWhenSafe = false;
          delete media.dataset.vigilPlaybackRequested;
        } else if (rememberIntent || media.autoplay || !media.paused) {
          state.resumeWhenSafe = true;
          media.dataset.vigilPlaybackRequested = 'true';
        }
        setPhysicalMute(media, state, true);
        if (!media.paused) {
          try { nativePause.call(media); } catch (_) {}
        }
        refreshAudioContexts();
      };
      const allow = (media, resumeRememberedIntent = true) => {
        if (!(media instanceof HTMLMediaElement)) return;
        const state = stateFor(media);
        state.allowed = true;
        setPhysicalMute(
          media,
          state,
          audioPreferred ? desiredRuntimeMute(media, state) : true
        );
        const shouldResume = resumeRememberedIntent
          && state.resumeWhenSafe
          && document.visibilityState !== 'hidden';
        state.resumeWhenSafe = false;
        delete media.dataset.vigilPlaybackRequested;
        if (shouldResume) {
          try {
            const result = nativePlay.call(media);
            result?.catch?.(() => {});
          } catch (_) {}
        }
        refreshAudioContexts();
      };
      const isEligible = (media) => {
        try { return Boolean(eligibilityResolver?.(media)); } catch (_) { return false; }
      };
      const audioContextMayRun = (context, state) => {
        if (!audioPreferred || document.visibilityState === 'hidden') return false;
        try {
          if (!audioContextEligibilityResolver?.(context)) return false;
        } catch (_) {
          return false;
        }
        for (const media of state.mediaElements) {
          if (!isEligible(media)) return false;
        }
        return true;
      };
      const suspendAudioContext = (
        context,
        rememberIntent = false,
        discardIntent = false
      ) => {
        const state = audioContextStates.get(context);
        if (!state) return false;
        if (discardIntent) state.resumeWhenSafe = false;
        else if (rememberIntent) state.resumeWhenSafe = true;
        if (context.state === 'closed') {
          audioContexts.delete(context);
          return true;
        }
        if (context.state !== 'suspended' && !state.suspendRequested) {
          state.suspendRequested = true;
          try {
            const result = state.nativeSuspend.call(context);
            const finishSuspension = () => {
              state.suspendRequested = false;
              if (context.state === 'running' && !audioContextMayRun(context, state)) {
                suspendAudioContext(context);
              } else resumeAudioContextIfAllowed(context);
            };
            Promise.resolve(result).then(finishSuspension, finishSuspension);
          } catch (_) {
            state.suspendRequested = false;
          }
        }
        return true;
      };
      const resumeAudioContextIfAllowed = (context) => {
        const state = audioContextStates.get(context);
        if (!state || context.state === 'closed') {
          audioContexts.delete(context);
          return false;
        }
        if (!audioContextMayRun(context, state)) {
          suspendAudioContext(
            context,
            context.state === 'running' && !state.suspendRequested
          );
          return false;
        }
        if (!state.resumeWhenSafe || context.state === 'running') return true;
        // A prior site resume request (or a context constructed during an
        // active browser gesture) is required. This never creates a context or
        // grants WebKit a playback activation that the page did not earn.
        state.resumeWhenSafe = false;
        try {
          const result = state.nativeResume.call(context);
          result?.catch?.(() => {});
        } catch (_) {}
        return true;
      };
      const refreshAudioContexts = () => {
        audioContexts.forEach((context) => {
          resumeAudioContextIfAllowed(context);
        });
      };
      const suspendAllAudioContexts = (
        discardIntent = false,
        rememberRunning = !discardIntent
      ) => {
        audioContexts.forEach((context) => {
          suspendAudioContext(
            context,
            rememberRunning && context.state === 'running',
            discardIntent
          );
        });
      };
      const registerAudioContext = (context, methods) => {
        let state = audioContextStates.get(context);
        if (state) return state;
        state = {
          nativeResume: methods.resume,
          nativeSuspend: methods.suspend,
          nativeClose: methods.close,
          mediaElements: new Set(),
          suspendRequested: false,
          // Construction alone is not permission to replay later. Preserve an
          // initially-running context only when WebKit reports active user
          // activation at construction time.
          resumeWhenSafe: context.state === 'running'
            && Boolean(navigator.userActivation?.isActive)
        };
        audioContextStates.set(context, state);
        audioContexts.add(context);
        try {
          context.addEventListener('statechange', () => {
            if (context.state === 'closed') {
              audioContexts.delete(context);
            } else if (context.state === 'running' && !audioContextMayRun(context, state)) {
              suspendAudioContext(
                context,
                state.resumeWhenSafe && !state.suspendRequested
              );
            }
          });
        } catch (_) {}
        if (!audioContextMayRun(context, state)) suspendAudioContext(context);
        return state;
      };
      const patchAudioContextPrototype = (prototype) => {
        if (!prototype) return null;
        const existing = audioContextPrototypeMethods.get(prototype);
        if (existing) return existing;
        const resumeDescriptor = Object.getOwnPropertyDescriptor(prototype, 'resume');
        const suspendDescriptor = Object.getOwnPropertyDescriptor(prototype, 'suspend');
        const closeDescriptor = Object.getOwnPropertyDescriptor(prototype, 'close');
        const mediaSourceDescriptor = Object.getOwnPropertyDescriptor(
          prototype,
          'createMediaElementSource'
        );
        const methods = {
          resume: resumeDescriptor?.value || prototype.resume,
          suspend: suspendDescriptor?.value || prototype.suspend,
          close: closeDescriptor?.value || prototype.close,
          createMediaElementSource: mediaSourceDescriptor?.value
            || prototype.createMediaElementSource
        };
        if (typeof methods.resume !== 'function' || typeof methods.suspend !== 'function') {
          return null;
        }
        audioContextPrototypeMethods.set(prototype, methods);
        try {
          Object.defineProperty(prototype, 'resume', {
            configurable: resumeDescriptor?.configurable ?? true,
            enumerable: resumeDescriptor?.enumerable ?? false,
            writable: resumeDescriptor?.writable ?? true,
            value: function vigilGuardedAudioContextResume(...argumentsList) {
              const state = registerAudioContext(this, methods);
              state.resumeWhenSafe = true;
              if (!audioContextMayRun(this, state)) {
                suspendAudioContext(this);
                return Promise.resolve();
              }
              state.resumeWhenSafe = false;
              return methods.resume.apply(this, argumentsList);
            }
          });
        } catch (_) {}
        try {
          Object.defineProperty(prototype, 'suspend', {
            configurable: suspendDescriptor?.configurable ?? true,
            enumerable: suspendDescriptor?.enumerable ?? false,
            writable: suspendDescriptor?.writable ?? true,
            value: function vigilGuardedAudioContextSuspend(...argumentsList) {
              const state = registerAudioContext(this, methods);
              state.resumeWhenSafe = false;
              return methods.suspend.apply(this, argumentsList);
            }
          });
        } catch (_) {}
        if (typeof methods.close === 'function') {
          try {
            Object.defineProperty(prototype, 'close', {
              configurable: closeDescriptor?.configurable ?? true,
              enumerable: closeDescriptor?.enumerable ?? false,
              writable: closeDescriptor?.writable ?? true,
              value: function vigilGuardedAudioContextClose(...argumentsList) {
                const state = registerAudioContext(this, methods);
                state.resumeWhenSafe = false;
                const result = methods.close.apply(this, argumentsList);
                Promise.resolve(result).then(
                  () => audioContexts.delete(this),
                  () => {
                    if (this.state === 'closed') audioContexts.delete(this);
                  }
                );
                return result;
              }
            });
          } catch (_) {}
        }
        if (typeof methods.createMediaElementSource === 'function') {
          try {
            Object.defineProperty(prototype, 'createMediaElementSource', {
              configurable: mediaSourceDescriptor?.configurable ?? true,
              enumerable: mediaSourceDescriptor?.enumerable ?? false,
              writable: mediaSourceDescriptor?.writable ?? true,
              value: function vigilGuardedCreateMediaElementSource(
                media,
                ...argumentsList
              ) {
                const result = methods.createMediaElementSource.call(
                  this,
                  media,
                  ...argumentsList
                );
                const state = registerAudioContext(this, methods);
                if (media instanceof HTMLMediaElement) state.mediaElements.add(media);
                resumeAudioContextIfAllowed(this);
                return result;
              }
            });
          } catch (_) {}
        }
        return methods;
      };
      const installAudioContextConstructor = (name) => {
        const NativeAudioContext = window[name];
        if (typeof NativeAudioContext !== 'function') return;
        let GuardedAudioContext = audioContextWrappers.get(NativeAudioContext);
        if (!GuardedAudioContext) {
          const methods = patchAudioContextPrototype(NativeAudioContext.prototype);
          if (!methods) return;
          GuardedAudioContext = new Proxy(NativeAudioContext, {
            construct(target, argumentsList, newTarget) {
              const context = Reflect.construct(target, argumentsList, newTarget);
              registerAudioContext(context, methods);
              return context;
            }
          });
          audioContextWrappers.set(NativeAudioContext, GuardedAudioContext);
          const constructorDescriptor = Object.getOwnPropertyDescriptor(
            NativeAudioContext.prototype,
            'constructor'
          );
          if (constructorDescriptor?.configurable !== false) {
            try {
              Object.defineProperty(NativeAudioContext.prototype, 'constructor', {
                configurable: constructorDescriptor?.configurable ?? true,
                enumerable: constructorDescriptor?.enumerable ?? false,
                writable: constructorDescriptor?.writable ?? true,
                value: GuardedAudioContext
              });
            } catch (_) {}
          }
        }
        const descriptor = Object.getOwnPropertyDescriptor(window, name);
        try {
          Object.defineProperty(window, name, {
            configurable: descriptor?.configurable ?? true,
            enumerable: descriptor?.enumerable ?? false,
            writable: descriptor?.writable ?? true,
            value: GuardedAudioContext
          });
        } catch (_) {
          try { window[name] = GuardedAudioContext; } catch (_) {}
        }
      };
      const applyAudioPreference = (media, enabled) => {
        if (!(media instanceof HTMLMediaElement)) return false;
        audioPreferred = Boolean(enabled);
        const state = stateFor(media);
        if (state.allowed) {
          setPhysicalMute(
            media,
            state,
            audioPreferred ? desiredRuntimeMute(media, state) : true
          );
        } else {
          setPhysicalMute(media, state, true);
        }
        return true;
      };
      const requestAudiblePlayback = (media) => {
        if (!preferAudibleVideo || !audioPreferred
            || !(media instanceof HTMLVideoElement)) return false;
        const state = stateFor(media);
        if (state.userMuteIntent) return false;
        audibleVideoSessionRequested = true;
        state.mutedExplicitlySet = true;
        state.desiredMuted = false;
        if (state.allowed) setPhysicalMute(media, state, false);
        return true;
      };
      const setAudioPreference = (enabled) => {
        audioPreferred = Boolean(enabled);
        mediaRoots.forEach((root) => {
          root.querySelectorAll?.('video, audio').forEach((media) => {
            applyAudioPreference(media, audioPreferred);
          });
        });
        if (audioPreferred) refreshAudioContexts();
        else suspendAllAudioContexts(false, true);
      };
      const scan = (root) => {
        if (!(root instanceof Element
            || root instanceof Document
            || (typeof ShadowRoot === 'function' && root instanceof ShadowRoot))) return;
        const mediaElements = root instanceof HTMLMediaElement
          ? [root]
          : [...root.querySelectorAll('video, audio')];
        mediaElements.forEach((media) => hold(media, media.autoplay || !media.paused));
      };
      const observeMediaRoot = (root) => {
        if (!root?.addEventListener || mediaRoots.has(root)) return;
        mediaRoots.add(root);
        ['play', 'playing'].forEach((eventName) => {
          root.addEventListener(eventName, (event) => {
            if (!(event.target instanceof HTMLMediaElement)) return;
            if (!isEligible(event.target)) hold(event.target, true);
          }, true);
        });
        root.addEventListener('volumechange', (event) => {
          if (!(event.target instanceof HTMLMediaElement)) return;
          const state = stateFor(event.target);
          if (!state.allowed) setPhysicalMute(event.target, state, true);
        }, true);
        new MutationObserver((records) => {
          records.forEach((record) => {
            if (record.type === 'attributes' && record.target instanceof HTMLMediaElement) {
              const state = stateFor(record.target);
              if (record.attributeName === 'muted') {
                state.desiredDefaultMuted = record.target.hasAttribute('muted');
              }
              if (!state.allowed) hold(record.target, record.target.autoplay || !record.target.paused);
            }
            record.addedNodes?.forEach((node) => scan(node));
          });
        }).observe(root, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['autoplay', 'muted', 'src']
        });
        scan(root);
      };

      const playDescriptor = Object.getOwnPropertyDescriptor(mediaPrototype, 'play');
      try {
        Object.defineProperty(mediaPrototype, 'play', {
          configurable: playDescriptor?.configurable ?? true,
          enumerable: playDescriptor?.enumerable ?? false,
          writable: playDescriptor?.writable ?? true,
          value: function vigilGuardedPlay(...argumentsList) {
            const state = stateFor(this);
            if (navigator.userActivation?.isActive) requestAudiblePlayback(this);
            if (!state.allowed && isEligible(this)) allow(this, false);
            if (!state.allowed) {
              this.dataset.vigilPlaybackRequested = 'true';
              this.dispatchEvent(new CustomEvent('__vigilPlaybackInspectionRequested'));
              hold(this, true);
              return Promise.resolve();
            }
            applyAudioPreference(this, audioPreferred);
            return nativePlay.apply(this, argumentsList);
          }
        });
      } catch (_) {
        // Capture listeners and the document observer remain as a fail-closed
        // fallback on engines that do not permit patching this prototype.
      }

      const installMutedGuard = () => {
        const descriptor = mutedProperty;
        if (!descriptor?.get || !descriptor?.set || descriptor.configurable === false) return;
        try {
          Object.defineProperty(mediaPrototype, 'muted', {
            configurable: descriptor.configurable,
            enumerable: descriptor.enumerable,
            get: function vigilGuardedMuteGetter() {
              return descriptor.get.call(this);
            },
            set: function vigilGuardedMuteSetter(value) {
              const state = stateFor(this);
              if (state.settingMute) {
                descriptor.set.call(this, Boolean(value));
                return;
              }
              state.mutedExplicitlySet = true;
              state.desiredMuted = Boolean(value);
              if (preferAudibleVideo && this instanceof HTMLVideoElement
                  && state.allowed && navigator.userActivation?.isActive) {
                state.userMuteIntent = Boolean(value);
                audibleVideoSessionRequested = !Boolean(value);
              }
              descriptor.set.call(
                this,
                state.allowed && audioPreferred ? desiredRuntimeMute(this, state) : true
              );
            }
          });
        } catch (_) {}
      };
      const installDefaultMutedRecorder = () => {
        const descriptor = defaultMutedProperty;
        if (!descriptor?.get || !descriptor?.set || descriptor.configurable === false) return;
        try {
          Object.defineProperty(mediaPrototype, 'defaultMuted', {
            configurable: descriptor.configurable,
            enumerable: descriptor.enumerable,
            get: function vigilDefaultMutedGetter() {
              return descriptor.get.call(this);
            },
            set: function vigilDefaultMutedSetter(value) {
              const state = stateFor(this);
              state.desiredDefaultMuted = Boolean(value);
              descriptor.set.call(this, Boolean(value));
            }
          });
        } catch (_) {}
      };
      installMutedGuard();
      installDefaultMutedRecorder();
      installAudioContextConstructor('AudioContext');
      installAudioContextConstructor('webkitAudioContext');

      window.__vigilEarlyMediaGate = {
        hold,
        allow,
        applyAudioPreference,
        requestAudiblePlayback,
        setAudioPreference,
        refreshAudioContexts,
        suspendAudioContexts(discardIntent = false) {
          suspendAllAudioContexts(Boolean(discardIntent), !discardIntent);
        },
        setAudioContextEligibilityResolver(resolver) {
          audioContextEligibilityResolver = typeof resolver === 'function' ? resolver : null;
          refreshAudioContexts();
        },
        setEligibilityResolver(resolver) {
          eligibilityResolver = typeof resolver === 'function' ? resolver : null;
          refreshAudioContexts();
        },
        isHeld(media) {
          return media instanceof HTMLMediaElement && !stateFor(media).allowed;
        },
        isAudioContextHeld(context) {
          const state = audioContextStates.get(context);
          return Boolean(state)
            && context.state !== 'closed'
            && (context.state !== 'running' || !audioContextMayRun(context, state));
        },
        hasAudioContextResumeIntent(context) {
          return Boolean(audioContextStates.get(context)?.resumeWhenSafe);
        },
        get audioPreferred() {
          return audioPreferred;
        }
      };

      observeMediaRoot(document);
      window.__vigilShadowDOM?.subscribe(observeMediaRoot);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') suspendAllAudioContexts(true, false);
        else refreshAudioContexts();
      });
      addEventListener('pagehide', () => suspendAllAudioContexts(true, false));
    })();
    """#
            .replacingOccurrences(of: "AUDIO_PREFERENCE", with: preference)
            .replacingOccurrences(of: "PREFER_AUDIBLE_VIDEO", with: audibleVideoPreference)
    }

    static func script(
        for service: SocialService,
        audioEnabled: Bool,
        contentSafetyEnabled: Bool = true
    ) -> String {
        authenticationDocumentGuard(for: service, body:
            (contentSafetyEnabled
                ? frameSafetyScript(audioEnabled: audioEnabled)
                : instagramStableCompatibilityScript(audioEnabled: audioEnabled))
            + frameRoutePolicyGuard(for: service)
            + controlsScript(for: service)
        )
    }

    static func mainFrameInstallationProbe(for service: SocialService) -> String {
        switch service {
        case .instagram:
            #"Boolean(window.__vigilInstagramCompatibilityInstalled && window.__vigilPolicyProbeInstalled && window.__vigilInstagramInstalled)"#
        case .youtube:
            #"Boolean(window.__vigilCommonInstalled && window.__vigilPolicyProbeInstalled && window.__vigilYouTubeInstalled)"#
        case .snapchat:
            #"Boolean(window.__vigilCommonInstalled && window.__vigilPolicyProbeInstalled && window.__vigilSnapchatInstalled)"#
        }
    }

    private static func authenticationDocumentGuard(for service: SocialService, body: String) -> String {
        if service == .youtube {
            return #"""
            (() => {
              let url;
              try { url = new URL(location.href); } catch (_) { return; }
              const host = url.hostname.toLowerCase();
              const defaultHTTPSPort = !url.port || url.port === '443';
              const youtubeAuthenticationFrame = host === 'accounts.youtube.com'
                && [
                  '/accounts/SetSID', '/accounts/SetSID/',
                  '/accounts/CheckConnection', '/accounts/CheckConnection/',
                  '/RotateCookiesPage', '/RotateCookiesPage/'
                ].includes(url.pathname);
              // Keep Google's sign-in, YouTube consent, and the exact
              // first-party auth/session frames completely outside Vigil's
              // DOM, media, route-policy, and player gesture scripts.
              if (url.protocol === 'https:'
                  && defaultHTTPSPort
                  && (host === 'accounts.google.com'
                    || host === 'consent.youtube.com'
                    || youtubeAuthenticationFrame)) return;
              GUARDED_BODY
            })();
            """#.replacingOccurrences(of: "GUARDED_BODY", with: body)
        }
        guard service == .instagram else { return body }
        return #"""
        (() => {
          const vigilAuthenticationPath = (candidate) => {
            let url;
            try { url = new URL(candidate, location.href); } catch (_) { return false; }
            if (url.protocol !== 'https:') return false;
            const host = url.hostname.toLowerCase();
            if (host === 'facebook.com' || host.endsWith('.facebook.com')) return true;
            if (!(host === 'instagram.com' || host.endsWith('.instagram.com'))) return false;
            const path = url.pathname.toLowerCase().replace(/\/+$/, '') || '/';
            return [
              '/accounts/login', '/accounts/emailsignup', '/accounts/signup',
              '/accounts/password', '/accounts/account_recovery', '/accounts/onetap',
              '/accounts/confirm', '/accounts/challenge', '/accounts/two_factor',
              '/accounts/verification', '/challenge', '/checkpoint', '/two_factor',
              '/accounts/suspended', '/accounts/disabled'
            ].some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
          };
          if (vigilAuthenticationPath(location.href)) {
            // Keep Meta's authentication and security-check environment pristine.
            // If it completes with a same-document route change, reload once so the
            // protected document-start policy is present before feed content renders.
            if (window.__vigilAuthenticationTransitionWatchdogInstalled) return;
            window.__vigilAuthenticationTransitionWatchdogInstalled = true;
            const timer = setInterval(() => {
              if (vigilAuthenticationPath(location.href)) return;
              clearInterval(timer);
              location.reload();
            }, 250);
            addEventListener('pagehide', () => clearInterval(timer), { once: true });
            return;
          }
          GUARDED_BODY
        })();
        """#.replacingOccurrences(of: "GUARDED_BODY", with: body)
    }

    static func frameSafetyScript(audioEnabled: Bool) -> String {
        common(audioEnabled: audioEnabled)
    }

    static func installedFrameSafetyScript(
        for service: SocialService,
        audioEnabled: Bool,
        contentSafetyEnabled: Bool = true
    ) -> String {
        authenticationDocumentGuard(
            for: service,
            body: contentSafetyEnabled
                ? frameSafetyScript(audioEnabled: audioEnabled)
                : instagramStableCompatibilityScript(audioEnabled: audioEnabled)
        )
    }

    static func controlsScript(for service: SocialService) -> String {
        lockdownProbe(service) + serviceScript(service)
    }

    static func installedControlsScript(for service: SocialService) -> String {
        authenticationDocumentGuard(for: service, body: controlsScript(for: service))
    }

    static func frameRoutePolicyGuard(for service: SocialService) -> String {
        let allowedHosts: String
        let routePolicy: String
        let fallbackPath: String
        switch service {
        case .instagram:
            allowedHosts = "['instagram.com', 'www.instagram.com']"
            fallbackPath = "/"
            routePolicy = #"""
            if (path === '/reels' || path.startsWith('/reels/')) {
              return { feature: 'reels', mode: 'redirect', permanent: true };
            }
            if (path === '/explore/people/suggested'
                || path.startsWith('/explore/people/suggested/')) {
              return {
                feature: 'suggested',
                features: ['suggested', 'explore'],
                mode: 'redirect',
                permanent: false
              };
            }
            if (/^\/(shop|shopping|live)(\/|$)/.test(path)) {
              return { feature: 'shopping', mode: 'redirect', permanent: false };
            }
            """#
        case .youtube:
            allowedHosts = "['youtube.com', 'www.youtube.com', 'm.youtube.com']"
            fallbackPath = "/feed/subscriptions"
            routePolicy = #"""
            if (path === '/shorts' || path.startsWith('/shorts/')) {
              return { feature: 'shorts', mode: 'redirect', permanent: true };
            }
            if (path === '/feed/explore' || path.startsWith('/feed/explore/')
                || path === '/feed/trending' || path.startsWith('/feed/trending/')) {
              return { feature: 'explore', mode: 'redirect', permanent: false };
            }
            if (path === '/feed/recommended' || path.startsWith('/feed/recommended/')) {
              return { feature: 'home', mode: 'redirect', permanent: false };
            }
            if (path === '/results'
                && String(url.searchParams.get('search_query') || '').toLowerCase().includes('shorts')) {
              return { feature: 'suggested', mode: 'redirect', permanent: false };
            }
            if (path === '/' || path === '') {
              return { feature: 'home', mode: 'conceal', permanent: false };
            }
            """#
        case .snapchat:
            allowedHosts = "['snapchat.com', 'www.snapchat.com', 'web.snapchat.com']"
            fallbackPath = "/web/"
            routePolicy = #"""
            if (path === '/spotlight' || path.startsWith('/spotlight/')) {
              return { feature: 'spotlight', mode: 'redirect', permanent: true };
            }
            if (path === '/discover' || path.startsWith('/discover/')) {
              return { feature: 'stories', mode: 'redirect', permanent: true };
            }
            """#
        }
        return #"""
        (() => {
          if (window === window.top || window.__vigilFrameRoutePolicyInstalled) return;
          const allowedHosts = ALLOWED_HOSTS;
          if (!allowedHosts.includes(String(location.hostname || '').toLowerCase())) return;
          window.__vigilFrameRoutePolicyInstalled = true;

          const style = document.createElement('style');
          style.id = 'vigil-frame-route-policy-style';
          style.textContent = `
            html[data-vigil-frame-route-policy="pending"] body,
            html[data-vigil-frame-route-policy="blocked"] body {
              visibility: hidden !important;
            }
          `;
          document.documentElement.appendChild(style);

          const routePolicy = (value = location.href) => {
            try {
              const url = new URL(value, location.href);
              if (!allowedHosts.includes(url.hostname.toLowerCase())) return null;
              const path = url.pathname.toLowerCase();
              ROUTE_POLICY
              return null;
            } catch (_) { return null; }
          };
          const featureVerdicts = new Map();
          const inFlightProbes = new Map();
          let redirectedURL = '';
          let lastURL = location.href;
          let checkScheduled = false;

          const clearRoutePolicy = () => {
            redirectedURL = '';
            delete document.documentElement.dataset.vigilFrameRoutePolicy;
            delete document.documentElement.dataset.vigilFrameRouteFeature;
          };
          const redirectBlockedRoute = (policy) => {
            document.documentElement.dataset.vigilFrameRoutePolicy = 'blocked';
            document.documentElement.dataset.vigilFrameRouteFeature = policy.feature;
            if (policy.mode !== 'redirect' || redirectedURL === location.href) return;
            redirectedURL = location.href;
            try { location.replace('FALLBACK_PATH'); } catch (_) {}
          };
          const probeFeature = (feature) => {
            if (inFlightProbes.has(feature)) return;
            const task = (async () => {
              const controller = new AbortController();
              const timeout = setTimeout(() => controller.abort(), 6000);
              let blocked = true;
              try {
                const requestedURL = new URL('/', location.origin);
                requestedURL.searchParams.set('__vigil_feature', feature);
                const response = await fetch(requestedURL.href, {
                  method: 'HEAD',
                  cache: 'no-store',
                  credentials: 'include',
                  redirect: 'follow',
                  signal: controller.signal
                });
                let responseURL = null;
                try { responseURL = response.url ? new URL(response.url) : null; } catch (_) {}
                blocked = !(response.ok
                  && response.status >= 200 && response.status < 300
                  && responseURL !== null
                  && responseURL.protocol === 'https:'
                  && allowedHosts.includes(String(responseURL.hostname || '').toLowerCase())
                  && responseURL.searchParams.get('__vigil_feature') === feature);
              } catch (_) {
                blocked = true;
              } finally {
                clearTimeout(timeout);
              }
              featureVerdicts.set(feature, blocked);
              inFlightProbes.delete(feature);
              scheduleCheck();
            })();
            inFlightProbes.set(feature, task);
          };
          const check = () => {
            lastURL = location.href;
            const policy = routePolicy();
            if (!policy) {
              clearRoutePolicy();
              return;
            }
            document.documentElement.dataset.vigilFrameRouteFeature = policy.feature;
            if (policy.permanent) {
              redirectBlockedRoute(policy);
              return;
            }
            const requiredFeatures = policy.features || [policy.feature];
            const unresolvedFeatures = requiredFeatures.filter(
              (feature) => typeof featureVerdicts.get(feature) !== 'boolean'
            );
            if (unresolvedFeatures.length) {
              document.documentElement.dataset.vigilFrameRoutePolicy = 'pending';
              unresolvedFeatures.forEach(probeFeature);
              return;
            }
            const blockedFeature = requiredFeatures.find(
              (feature) => featureVerdicts.get(feature) === true
            );
            if (blockedFeature) {
              redirectBlockedRoute({ ...policy, feature: blockedFeature });
              return;
            }
            redirectedURL = '';
            document.documentElement.dataset.vigilFrameRoutePolicy = 'available';
          };
          const scheduleCheck = () => {
            if (checkScheduled) return;
            checkScheduled = true;
            queueMicrotask(() => {
              checkScheduled = false;
              check();
            });
          };
          for (const name of ['pushState', 'replaceState']) {
            const original = history[name];
            history[name] = function(...args) {
              const result = original.apply(this, args);
              scheduleCheck();
              return result;
            };
          }
          const routeEvent = () => {
            check();
            scheduleCheck();
          };
          for (const name of [
            'popstate', 'hashchange', 'pageshow',
            'yt-navigate-start', 'yt-navigate-finish', 'yt-navigate-cache',
            'yt-navigate-redirect', 'yt-page-data-updated',
            'state-navigatestart', 'state-navigateend', 'state-navigatecomplete'
          ]) {
            addEventListener(name, routeEvent, true);
          }
          window.navigation?.addEventListener?.('navigate', scheduleCheck);
          addEventListener('focus', () => {
            const policy = routePolicy();
            if (policy && !policy.permanent) {
              (policy.features || [policy.feature]).forEach(
                (feature) => probeFeature(feature)
              );
            }
            check();
          });
          setInterval(() => {
            if (location.href !== lastURL) {
              scheduleCheck();
              return;
            }
            const policy = routePolicy();
            if (!policy || policy.permanent) return;
            (policy.features || [policy.feature]).forEach(
              (feature) => probeFeature(feature)
            );
            check();
          }, 15000);
          check();
        })();
        """#
            .replacingOccurrences(of: "ALLOWED_HOSTS", with: allowedHosts)
            .replacingOccurrences(of: "ROUTE_POLICY", with: routePolicy)
            .replacingOccurrences(of: "FALLBACK_PATH", with: fallbackPath)
    }

    static func installedFrameRoutePolicyGuard(for service: SocialService) -> String {
        authenticationDocumentGuard(for: service, body: frameRoutePolicyGuard(for: service))
    }

    private static func lockdownProbe(_ service: SocialService) -> String {
        let featureKeys: String
        let allowedHosts: String
        let priorityFeature: String
        switch service {
        case .instagram:
            featureKeys = "['reels', 'explore', 'suggested', 'shopping', 'ads']"
            allowedHosts = "['instagram.com', 'www.instagram.com']"
            priorityFeature = "reels"
        case .youtube:
            featureKeys = "['home', 'explore', 'suggested', 'ads']"
            allowedHosts = "['youtube.com', 'www.youtube.com', 'm.youtube.com']"
            priorityFeature = "home"
        case .snapchat:
            featureKeys = "['spotlight', 'stories']"
            allowedHosts = "['snapchat.com', 'www.snapchat.com', 'web.snapchat.com']"
            priorityFeature = "spotlight"
        }
        return #"""
        (() => {
          if (window.__vigilPolicyProbeInstalled) return;
          const pageHost = String(location.hostname || '').toLowerCase();
          const allowedHosts = ALLOWED_HOSTS;
          if (!allowedHosts.includes(pageHost)) return;
          window.__vigilPolicyProbeInstalled = true;
          const featureKeys = FEATURE_KEYS;
          const priorityFeature = 'PRIORITY_FEATURE';
          const blockedFeatures = new Map(featureKeys.map((key) => [key, null]));
          const inFlightProbes = new Map();
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

          const probeFeature = (key) => {
            if (!featureKeys.includes(key)) return Promise.resolve();
            const existing = inFlightProbes.get(key);
            if (existing) return existing;
            if (!navigator.onLine) {
              publish(key, true);
              return Promise.resolve();
            }
            const task = (async () => {
              const controller = new AbortController();
              const timeout = setTimeout(() => controller.abort(), 6000);
              try {
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
                  publish(key, !accepted);
                } catch (_) {
                  publish(key, true);
                }
              } finally {
                clearTimeout(timeout);
              }
            })();
            inFlightProbes.set(key, task);
            task.finally(() => {
              if (inFlightProbes.get(key) === task) inFlightProbes.delete(key);
            });
            return task;
          };
          const probe = (requestedFeatures = featureKeys) => Promise.allSettled(
            [...new Set(requestedFeatures)].map(probeFeature)
          );
          let initialProbeStarted = false;
          let initialProbeRequest = 0;
          const runInitialProbe = () => {
            if (initialProbeStarted) return;
            initialProbeStarted = true;
            if (initialProbeRequest && typeof cancelIdleCallback === 'function') {
              cancelIdleCallback(initialProbeRequest);
            }
            probe(featureKeys.filter((key) => key !== priorityFeature));
          };
          const scheduleInitialProbe = () => {
            if (initialProbeStarted || initialProbeRequest) return;
            if (typeof requestIdleCallback === 'function') {
              initialProbeRequest = requestIdleCallback(runInitialProbe, { timeout: 1200 });
            } else {
              initialProbeRequest = setTimeout(runInitialProbe, 500);
            }
          };
          // Reels/Home is the primary navigation destination and its control is
          // fail-closed while pending. Resolve that one sentinel immediately;
          // waiting for the service's load event made the control disappear for
          // several seconds on an otherwise usable page.
          probe([priorityFeature]);
          if (document.readyState === 'complete') scheduleInitialProbe();
          else addEventListener('load', scheduleInitialProbe, { once: true });
          // A stalled third-party resource must not leave feature availability
          // unresolved forever. Pending features stay hidden fail-closed while
          // this bounded startup grace lets Instagram's own first load win.
          setTimeout(scheduleInitialProbe, 5000);
          addEventListener('online', () => {
            probe([priorityFeature]);
            if (initialProbeStarted) {
              probe(featureKeys.filter((key) => key !== priorityFeature));
            } else scheduleInitialProbe();
          });
          addEventListener('focus', () => {
            probe([priorityFeature]);
            if (!initialProbeStarted) scheduleInitialProbe();
          });
          // Revalidate one feature per tick instead of sending a burst of every
          // sentinel every 15 seconds. The OS deny rules still guard the actual
          // routes, while the companion keeps each DOM toggle fresh without
          // competing continuously with Story and Reel media requests.
          let periodicProbeIndex = featureKeys.length > 1 ? 1 : 0;
          setInterval(() => {
            probe([featureKeys[periodicProbeIndex]]);
            periodicProbeIndex = (periodicProbeIndex + 1) % featureKeys.length;
          }, 15000);
        })();
        """#
            .replacingOccurrences(of: "FEATURE_KEYS", with: featureKeys)
            .replacingOccurrences(of: "ALLOWED_HOSTS", with: allowedHosts)
            .replacingOccurrences(of: "PRIORITY_FEATURE", with: priorityFeature)
    }

    // Instagram is a fast-changing single-page app. Keep the production
    // companion deliberately small: hide restricted entry points before they
    // can paint and normalize only the comments surface requested below, while
    // leaving Instagram's remaining layout, media, and gestures under its control.
    private static let instagramStableDocumentStartStyle = #"""
    (() => {
      if (window.__vigilInstagramStableStartInstalled) return;
      window.__vigilInstagramStableStartInstalled = true;

      // The site may cache History methods while booting. Install this shim
      // before its router so autoplay and taps share the same prepaint guard.
      window.__vigilInstagramEarlyHistoryInstalled = true;
      for (const name of ['pushState', 'replaceState']) {
        const original = history[name];
        history[name] = function(...args) {
          if (typeof window.__vigilInstagramPrepareRoute === 'function') {
            window.__vigilInstagramPrepareRoute(args[2], true);
          } else {
            try {
              const url = new URL(args[2] || location.href, location.href);
              if (url.origin === location.origin && url.pathname !== location.pathname) {
                if (/^\/stories(?:\/|$)/i.test(url.pathname)) {
                  document.documentElement.dataset.vigilInstagramStoryGate = 'pending';
                } else if (url.pathname === '/') {
                  document.documentElement.dataset.vigilInstagramHomeFilter = 'true';
                }
              }
            } catch (_) {}
          }
          const result = original.apply(this, args);
          document.dispatchEvent(new Event('__vigilInstagramHistoryChanged'));
          return result;
        };
      }

      // WebKit's default document canvas is white. Hold a black canvas from
      // document-start through Instagram's first complete DOM so the native
      // launch screen hands off directly to Instagram's startup mark.
      document.documentElement.dataset.vigilInstagramStarting = 'true';
      const finishStartupCanvas = () => requestAnimationFrame(() => {
        delete document.documentElement.dataset.vigilInstagramStarting;
      });
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', finishStartupCanvas, { once: true });
      } else {
        finishStartupCanvas();
      }

      const style = document.createElement('style');
      style.id = 'vigil-instagram-stable-start-style';
      style.textContent = `
        html[data-vigil-instagram-starting="true"],
        html[data-vigil-instagram-starting="true"] body {
          background-color: #000 !important;
        }
        html :is(
          a[href="/reels/"], a[href="/reels"], [aria-label="Reels" i]
        ),
        html
          :is(nav, [role="navigation"]) :is(li, div):has(> :is(a[href="/reels/"], a[href="/reels"])),
        html
          div[data-visualcompletion="ignore-dynamic"] > div:has(> span > div > :is(a[href="/reels/"], a[href="/reels"])),
        html:not([data-vigil-feature-shopping="available"]) :is(
          a[href^="/shop"], a[href^="/shopping"], a[href^="/live"]
        ),
        html[data-vigil-instagram-account-search="true"] :is(main, [role="main"]) :is(
          a[href^="/p/"], a[href^="/reel/"],
          a[href^="/reels/"]:not([href="/reels/"]),
          a[href^="/explore/tags/"], a[href^="/explore/locations/"],
          a[href^="/audio/"], a[href^="/music/"], a[href^="/effects/"]
        ),
        [data-vigil-hidden-feature],
        [data-vigil-instagram-search-discovery="true"],
        [data-vigil-native-app-prompt="true"],
        a[href^="instagram:"] {
          display: none !important;
        }
        html[data-vigil-route-policy-blocked] body {
          visibility: hidden !important;
        }
        html[data-vigil-instagram-home-filter="true"] :is(article, [role="article"]):not(
          nav *, [role="navigation"] *, [role="dialog"] *, [aria-modal="true"] *
        ):not(
          [data-vigil-instagram-home-relationship="friend"]
        ):not([data-vigil-instagram-home-relationship="self"]),
        [data-vigil-instagram-home-relationship]:not(
          [data-vigil-instagram-home-relationship="friend"]
        ):not([data-vigil-instagram-home-relationship="self"]) {
          display: none !important;
        }
        html[data-vigil-instagram-home-filter="true"] a[href^="/stories/"]:not(
          [data-vigil-instagram-story-relationship="friend"]
        ):not(
          [data-vigil-instagram-story-relationship="self"]
        ) {
          visibility: hidden !important;
        }
        html[data-vigil-instagram-home-filter="true"] main
          :is(ul, [role="list"], [aria-label="Stories" i])
          :is(button, [role="button"]):has(img[alt*="profile picture" i]):not(
            article *, nav *, [role="navigation"] *
          ):not([aria-label="Profile" i]):not([aria-label="Your profile" i]):not(
            [data-vigil-instagram-profile-control="true"]
          ):not([aria-label="Your story" i]):not([aria-label="Add to your story" i]):not(
            [data-vigil-instagram-story-relationship="friend"]
          ):not([data-vigil-instagram-story-relationship="self"]) {
          visibility: hidden !important;
        }
        [data-vigil-instagram-story-relationship="pending"] {
          display: none !important;
        }
        [data-vigil-instagram-feed-region="closed"] {
          display: none !important;
          content-visibility: hidden !important;
        }
        [data-vigil-instagram-story-relationship="other"] {
          display: none !important;
        }
        html[data-vigil-instagram-story-gate="pending"] body {
          visibility: hidden !important;
        }
        [data-vigil-instagram-story-relationship="unavailable"] {
          display: none !important;
        }
        [data-vigil-instagram-story-rail="true"] {
          overscroll-behavior-x: none !important;
          scroll-behavior: auto !important;
          scroll-snap-type: none !important;
          overflow-x: auto !important;
          overflow-anchor: none !important;
        }
        [data-vigil-instagram-story-track="true"] {
          display: flex !important;
          flex-flow: row nowrap !important;
          justify-content: flex-start !important;
          gap: 0 !important;
          position: relative !important;
          inset: auto !important;
          transform: none !important;
          translate: none !important;
          margin: 0 !important;
          padding: 0 !important;
          transition: none !important;
        }
        [data-vigil-instagram-story-track="true"]:not([data-vigil-instagram-story-rail="true"]),
        [data-vigil-instagram-story-carrier="true"] {
          width: max-content !important;
          min-width: 0 !important;
          max-width: none !important;
          transform: none !important;
          translate: none !important;
        }
        [data-vigil-instagram-story-track="true"] > :not([data-vigil-instagram-story-slot]) {
          display: none !important;
        }
        [data-vigil-instagram-story-slot] {
          overflow: clip !important;
          position: relative !important;
          inset: auto !important;
          transform: none !important;
          translate: none !important;
          margin: 0 !important;
          flex: 0 0 auto !important;
          order: 0 !important;
          transition: none !important;
        }
        [data-vigil-instagram-story-slot]:not([data-vigil-instagram-story-slot="visible"]) {
          display: none !important;
        }
        html[data-vigil-instagram-home-filter="true"] main [role="progressbar"] {
          display: none !important;
        }
        @media (prefers-color-scheme: dark) {
          html a[href="/"] svg[aria-label="Instagram" i],
          html a[href="/"] svg[aria-label="Instagram" i] * {
            color: #f5f5f5 !important;
            fill: #f5f5f5 !important;
          }
        }
        @media (prefers-color-scheme: light) {
          html a[href="/"] svg[aria-label="Instagram" i],
          html a[href="/"] svg[aria-label="Instagram" i] * {
            color: #050505 !important;
            fill: #050505 !important;
          }
        }
        #vigil-instagram-friends-empty {
          box-sizing: border-box !important;
          position: fixed !important;
          z-index: 2 !important;
          inset: 156px 20px 84px !important;
          display: grid !important;
          place-items: center !important;
          pointer-events: none !important;
          color: inherit !important;
          font: 600 15px/1.45 -apple-system, BlinkMacSystemFont, sans-serif !important;
          text-align: center !important;
        }
        #vigil-instagram-friends-empty > span {
          display: none !important;
          box-sizing: border-box !important;
          max-width: 320px !important;
          padding: 20px 22px !important;
          border: 1px solid rgba(128, 128, 128, .3) !important;
          border-radius: 14px !important;
          background: rgba(128, 128, 128, .08) !important;
        }
        #vigil-instagram-friends-empty[data-vigil-state="empty"] > span {
          display: block !important;
        }
        #vigil-instagram-friends-empty > i {
          width: 24px !important;
          height: 24px !important;
          border: 2.5px solid rgba(128, 128, 128, .28) !important;
          border-top-color: currentColor !important;
          border-radius: 50% !important;
          animation: vigil-instagram-friends-spin .72s linear infinite !important;
        }
        #vigil-instagram-friends-empty[data-vigil-state="empty"] > i {
          display: none !important;
        }
        @keyframes vigil-instagram-friends-spin { to { transform: rotate(360deg); } }
        [data-vigil-instagram-comments-sheet="true"] {
          box-sizing: border-box !important;
          position: fixed !important;
          inset: auto 0 0 0 !important;
          z-index: 2147483644 !important;
          width: 100% !important;
          min-width: 0 !important;
          max-width: none !important;
          height: 52vh !important;
          height: 52dvh !important;
          min-height: 0 !important;
          max-height: 52vh !important;
          max-height: 52dvh !important;
          margin: 0 !important;
          transform: none !important;
          translate: none !important;
          overflow: hidden !important;
          border-radius: 18px 18px 0 0 !important;
        }
        video {
          /* Instagram's web Reel/Story surface commonly fills a taller iPhone
             box with object-fit: cover, which discards the left and right of a
             9:16 source. Preserve the source aspect ratio and trade that crop
             for centered letterboxing, matching the user's parity preference. */
          max-width: 100% !important;
          object-fit: contain !important;
          object-position: center center !important;
          background-color: #000 !important;
          /* Instagram recycles video nodes between adjacent Reels. Never set
             their width, height, opacity, or transition here: those properties
             participate in its snap-stack measurements and loading state. */
        }
      `;
      document.documentElement.appendChild(style);
      try {
        const path = new URL(location.href).pathname.toLowerCase().replace(/\/+$/, '') || '/';
        if (path === '/') {
          document.documentElement.dataset.vigilInstagramHomeFilter = 'true';
        } else if (path === '/stories' || path.startsWith('/stories/')) {
          // Story documents start concealed. The document-end verifier opens
          // only the viewer's own Story or a confirmed mutual friend's Story.
          document.documentElement.dataset.vigilInstagramStoryGate = 'pending';
        } else if (path === '/explore') {
          document.documentElement.dataset.vigilInstagramAccountSearch = 'true';
        }
      } catch (_) {}
    })();
    """#

    private static func instagramStableCompatibilityScript(audioEnabled: Bool) -> String {
        let preference = audioEnabled ? "true" : "false"
        return #"""
        (() => {
          const documentID = (() => {
            const existing = String(window.__vigilDocumentID || '');
            if (existing) return existing;
            let generated = '';
            try { generated = crypto.randomUUID(); } catch (_) {}
            if (!generated) generated = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
            try {
              Object.defineProperty(window, '__vigilDocumentID', {
                value: generated,
                writable: false,
                configurable: false
              });
            } catch (_) {
              window.__vigilDocumentID = generated;
            }
            return generated;
          })();
          const bridge = (payload) => {
            try {
              window.webkit.messageHandlers.vigil.postMessage({ ...payload, documentID });
            } catch (_) {}
          };
          window.__vigilBridge = bridge;
          bridge({ type: 'documentReady' });

          if (window.__vigilInstagramCompatibilityInstalled) return;
          window.__vigilInstagramCompatibilityInstalled = true;
          window.__vigilAudioPreferred = AUDIO_PREFERENCE;

          const allMedia = () => [...document.querySelectorAll('video, audio')];
          const suspendedMedia = new Set();
          const audioState = new WeakMap();
          const mediaSourceKey = (media) => String(
            media.currentSrc || media.getAttribute('src') || media.querySelector('source')?.src || ''
          );
          const instagramUnmuteControlFor = (media) => {
            let container = media?.parentElement || null;
            for (let depth = 0; container && depth < 10; depth += 1) {
              const mediaInContainer = container.querySelectorAll?.('video, audio') || [];
              if (mediaInContainer.length === 1 && mediaInContainer[0] === media) {
                const labelled = container.querySelector?.('[aria-label="Unmute" i]');
                if (labelled) return labelled.closest('button, [role="button"]') || labelled;
              }
              container = container.parentElement;
            }
            return null;
          };
          const applyAudioPreference = (media) => {
            if (!(media instanceof HTMLMediaElement)) return;
            const source = mediaSourceKey(media);
            let state = audioState.get(media);
            if (!state || state.source !== source) {
              state = { source, initialized: false, userChoseMute: false };
              audioState.set(media, state);
            }
            if (!window.__vigilAudioPreferred) {
              media.defaultMuted = true;
              media.muted = true;
              return;
            }
            if (state.userChoseMute) return;
            const unmuteControl = instagramUnmuteControlFor(media);
            if (unmuteControl && media.muted) {
              // Use Instagram's own control so its icon/framework state agrees
              // with the physical media element. Synthetic clicks are excluded
              // from the user-choice listener below.
              try { unmuteControl.click(); } catch (_) {}
            }
            if (!state.initialized || media.muted || media.defaultMuted) {
              state.initialized = true;
              media.defaultMuted = false;
              media.muted = false;
            }
          };
          const scanMedia = (root = document) => {
            if (root instanceof HTMLMediaElement) applyAudioPreference(root);
            root.querySelectorAll?.('video, audio').forEach(applyAudioPreference);
          };
          const isVisible = (media) => {
            if (!(media instanceof HTMLMediaElement) || !media.isConnected || media.ended) return false;
            const rect = media.getBoundingClientRect();
            const viewport = window.visualViewport;
            const width = viewport?.width || innerWidth;
            const height = viewport?.height || innerHeight;
            return rect.width > 1 && rect.height > 1
              && rect.right > 0 && rect.bottom > 0
              && rect.left < width && rect.top < height;
          };
          window.__vigilSetAudioPreference = (enabled) => {
            window.__vigilAudioPreferred = Boolean(enabled);
            scanMedia();
            bridge({ type: 'audio', enabled: window.__vigilAudioPreferred });
          };
          window.__vigilPauseAllMedia = () => {
            allMedia().forEach((media) => {
              try { media.pause(); } catch (_) {}
            });
          };
          window.__vigilSuspendAllMedia = () => {
            suspendedMedia.clear();
            allMedia().forEach((media) => {
              if (media.paused || media.ended) return;
              suspendedMedia.add(media);
              try { media.pause(); } catch (_) {}
            });
            try {
              if (navigator.mediaSession) {
                navigator.mediaSession.metadata = null;
                navigator.mediaSession.setPositionState?.();
              }
            } catch (_) {}
          };
          window.__vigilResumeSuspendedMedia = () => {
            const pending = [...suspendedMedia];
            suspendedMedia.clear();
            if (document.visibilityState === 'hidden') return;
            pending.forEach((media) => {
              if (!isVisible(media)) return;
              try { media.play()?.catch?.(() => {}); } catch (_) {}
            });
          };
          document.addEventListener('click', (event) => {
            if (!event.isTrusted || !(event.target instanceof Element)) return;
            const media = event.target.closest('video, audio')
              || event.target.closest('button, [role="button"]')
                ?.parentElement?.querySelector?.('video, audio');
            if (!(media instanceof HTMLMediaElement)) return;
            queueMicrotask(() => {
              const state = audioState.get(media) || {
                source: mediaSourceKey(media), initialized: true, userChoseMute: false
              };
              state.userChoseMute = media.muted;
              state.initialized = true;
              audioState.set(media, state);
            });
          }, true);
          document.addEventListener('play', (event) => applyAudioPreference(event.target), true);
          new MutationObserver((records) => {
            records.forEach((record) => {
              if (record.type === 'attributes') applyAudioPreference(record.target);
              record.addedNodes?.forEach((node) => {
                if (node instanceof Element) scanMedia(node);
              });
            });
          }).observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['muted', 'src']
          });
          scanMedia();
        })();
        """#.replacingOccurrences(of: "AUDIO_PREFERENCE", with: preference)
    }

    private static func instagramCompatibilityScript(audioEnabled: Bool) -> String {
        let preference = audioEnabled ? "true" : "false"
        return #"""
        (() => {
          const configuredAudioPreference = AUDIO_PREFERENCE;
          const documentID = (() => {
            const existing = String(window.__vigilDocumentID || '');
            if (existing) return existing;
            let generated = '';
            try { generated = crypto.randomUUID(); } catch (_) {}
            if (!generated) generated = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
            try {
              Object.defineProperty(window, '__vigilDocumentID', {
                value: generated,
                writable: false,
                configurable: false
              });
            } catch (_) {
              window.__vigilDocumentID = generated;
            }
            return generated;
          })();
          const bridge = (payload) => {
            try {
              window.webkit.messageHandlers.vigil.postMessage({ ...payload, documentID });
            } catch (_) {}
          };
          window.__vigilBridge = bridge;
          bridge({ type: 'documentReady' });

          if (window.__vigilInstagramCompatibilityInstalled) {
            window.__vigilSetAudioPreference?.(configuredAudioPreference);
            return;
          }
          window.__vigilInstagramCompatibilityInstalled = true;
          window.__vigilAudioPreferred = configuredAudioPreference;

          const mediaRoots = new Set();
          const mediaWithin = (root) => {
            if (!root?.querySelectorAll) return [];
            return [
              ...(root instanceof HTMLMediaElement ? [root] : []),
              ...root.querySelectorAll('video, audio')
            ];
          };
          const instagramUnmuteSelector = '[aria-label="Unmute" i]';
          const instagramUnmuteControlFor = (media) => {
            let container = media?.parentElement || null;
            for (let depth = 0; container && depth < 10; depth += 1) {
              const containedMedia = mediaWithin(container);
              if (containedMedia.length === 1 && containedMedia[0] === media) {
                const labelledControl = container.matches?.(instagramUnmuteSelector)
                  ? container
                  : container.querySelector(instagramUnmuteSelector);
                if (labelledControl) {
                  return labelledControl.closest('button, [role="button"]') || labelledControl;
                }
              }
              container = container.parentElement;
            }
            const documentMedia = mediaWithin(document);
            if (documentMedia.length !== 1 || documentMedia[0] !== media) return null;
            const labelledControl = document.querySelector(instagramUnmuteSelector);
            return labelledControl?.closest('button, [role="button"]') || labelledControl;
          };
          const synchronizeInstagramAudioIndicator = (media) => {
            if (media.dataset.vigilInstagramAudioIndicatorSynced === 'true') return false;
            const control = instagramUnmuteControlFor(media);
            if (!control) return false;
            media.dataset.vigilInstagramAudioIndicatorSynced = 'true';
            try {
              // Instagram owns the mute icon in framework state. Recreate the
              // state that icon represents, then use its own control so the UI
              // and the physical media element become audible together.
              media.muted = true;
              control.click();
            } catch (_) {
              delete media.dataset.vigilInstagramAudioIndicatorSynced;
              return false;
            }
            media.defaultMuted = false;
            media.muted = false;
            return true;
          };
          const applyAudioPreference = (media) => {
            if (!(media instanceof HTMLMediaElement)) return;
            if (!window.__vigilAudioPreferred) {
              if (media.dataset.vigilMutedByPreference !== 'true') {
                media.dataset.vigilMutedByPreference = 'true';
                media.dataset.vigilPreviousMuted = String(media.muted);
                media.dataset.vigilPreviousDefaultMuted = String(media.defaultMuted);
              }
              media.defaultMuted = true;
              media.muted = true;
              return;
            }
            if (media.dataset.vigilMutedByPreference === 'true') {
              media.muted = media.dataset.vigilPreviousMuted === 'true';
              media.defaultMuted = media.dataset.vigilPreviousDefaultMuted === 'true';
              delete media.dataset.vigilMutedByPreference;
              delete media.dataset.vigilPreviousMuted;
              delete media.dataset.vigilPreviousDefaultMuted;
            } else if (media.dataset.vigilInstagramAudioInitialized !== 'true') {
              // Match the companion's audio-on default without continuously
              // overriding Instagram's own subsequent tap-to-mute behavior.
              media.dataset.vigilInstagramAudioInitialized = 'true';
              if (!synchronizeInstagramAudioIndicator(media)) {
                media.defaultMuted = false;
                media.muted = false;
              }
            } else {
              // The video and its overlay control can mount in separate React
              // commits. Complete UI synchronization when that control arrives.
              synchronizeInstagramAudioIndicator(media);
            }
          };
          const scanMedia = (root) => mediaWithin(root).forEach(applyAudioPreference);
          const scanMediaNearControl = (control) => {
            let container = control?.parentElement || null;
            for (let depth = 0; container && depth < 10; depth += 1) {
              const containedMedia = mediaWithin(container);
              if (containedMedia.length === 1) {
                applyAudioPreference(containedMedia[0]);
                return;
              }
              container = container.parentElement;
            }
          };
          const installMediaRoot = (root) => {
            if (!root?.addEventListener || mediaRoots.has(root)) return;
            mediaRoots.add(root);
            const target = root === document ? document.documentElement : root;
            if (!target) return;
            new MutationObserver((records) => {
              records.forEach((record) => {
                if (record.type === 'attributes') {
                  if (record.target instanceof Element
                      && record.target.matches(instagramUnmuteSelector)) {
                    scanMediaNearControl(record.target);
                  }
                  return;
                }
                record.addedNodes?.forEach((node) => {
                  if (!(node instanceof Element || node instanceof DocumentFragment)) return;
                  scanMedia(node);
                  const controls = node instanceof Element
                    && node.matches(instagramUnmuteSelector)
                    ? [node, ...node.querySelectorAll(instagramUnmuteSelector)]
                    : [...node.querySelectorAll(instagramUnmuteSelector)];
                  controls.forEach(scanMediaNearControl);
                });
              });
            }).observe(target, {
              attributes: true,
              attributeFilter: ['aria-label'],
              childList: true,
              subtree: true
            });
            scanMedia(root);
          };
          installMediaRoot(document);
          window.__vigilShadowDOM?.subscribe(installMediaRoot);

          window.__vigilSetAudioPreference = (enabled) => {
            window.__vigilAudioPreferred = Boolean(enabled);
            mediaRoots.forEach(scanMedia);
            bridge({ type: 'audio', enabled: Boolean(enabled) });
          };
          window.__vigilPauseAllMedia = () => {
            mediaRoots.forEach((root) => mediaWithin(root).forEach((media) => media.pause()));
          };
          const suspendedMedia = new Set();
          const mediaIsVisible = (media) => {
            if (!(media instanceof HTMLMediaElement)
                || !media.isConnected
                || media.ended
                || document.visibilityState === 'hidden') return false;
            try {
              if (typeof media.checkVisibility === 'function'
                  && !media.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
            } catch (_) {}
            const rect = media.getBoundingClientRect();
            const viewport = window.visualViewport;
            const width = viewport?.width || document.documentElement.clientWidth || window.innerWidth;
            const height = viewport?.height || document.documentElement.clientHeight || window.innerHeight;
            if (rect.width <= 1 || rect.height <= 1
                || rect.right <= 0 || rect.bottom <= 0
                || rect.left >= width || rect.top >= height) return false;
            let element = media;
            while (element instanceof Element) {
              const style = getComputedStyle(element);
              if (style.display === 'none'
                  || style.visibility === 'hidden'
                  || style.visibility === 'collapse'
                  || Number(style.opacity) === 0) return false;
              const root = element.getRootNode?.();
              element = element.parentElement || root?.host || null;
            }
            return true;
          };
          window.__vigilSuspendAllMedia = () => {
            window.__vigilRestoreReelHold?.();
            [...suspendedMedia].forEach((media) => {
              if (!(media instanceof HTMLMediaElement) || !media.isConnected || media.ended) {
                suspendedMedia.delete(media);
              }
            });
            mediaRoots.forEach((root) => mediaWithin(root).forEach((media) => {
              if (!(media instanceof HTMLMediaElement)
                  || !media.isConnected
                  || media.paused
                  || media.ended) return;
              suspendedMedia.add(media);
              try { media.pause(); } catch (_) {}
            }));
            try {
              if (navigator.mediaSession) {
                navigator.mediaSession.metadata = null;
                navigator.mediaSession.setPositionState?.();
              }
            } catch (_) {}
          };
          window.__vigilResumeSuspendedMedia = () => {
            const pending = [...suspendedMedia];
            suspendedMedia.clear();
            pending.forEach((media) => {
              if (!mediaIsVisible(media)) return;
              try {
                const playback = media.play();
                playback?.catch?.(() => {});
              } catch (_) {}
            });
          };

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
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class', 'style', 'data-theme']
          });
          matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', scheduleAppearance);
          addEventListener('pageshow', scheduleAppearance);
          scheduleAppearance();
        })();
        """#.replacingOccurrences(of: "AUDIO_PREFERENCE", with: preference)
    }

    private static func common(audioEnabled: Bool) -> String {
        let preference = audioEnabled ? "true" : "false"
        return #"""
        (() => {
          const earlyMediaGate = window.__vigilEarlyMediaGate || null;
          const configuredAudioPreference = typeof earlyMediaGate?.audioPreferred === 'boolean'
            ? earlyMediaGate.audioPreferred
            : AUDIO_PREFERENCE;
          const documentID = (() => {
            const existing = String(window.__vigilDocumentID || '');
            if (existing) return existing;
            let generated = '';
            try { generated = crypto.randomUUID(); } catch (_) {}
            if (!generated) generated = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
            try {
              Object.defineProperty(window, '__vigilDocumentID', {
                value: generated,
                writable: false,
                configurable: false
              });
            } catch (_) {
              window.__vigilDocumentID = generated;
            }
            return generated;
          })();
          const bridge = (payload) => {
            try {
              window.webkit.messageHandlers.vigil.postMessage({ ...payload, documentID });
            } catch (_) {}
          };
          window.__vigilBridge = bridge;
          // Bind the native store before health, surface, text, or media events
          // can arrive. Fast cache-backed documents can otherwise publish their
          // one deduplicated ready event before didCommit's async identity read.
          bridge({ type: 'documentReady' });

          if (!window.__vigilCommonInstalled) {
            window.__vigilCommonInstalled = true;
            window.__vigilAudioPreferred = configuredAudioPreference;
            earlyMediaGate?.setAudioPreference(window.__vigilAudioPreferred);
            const shadowDOM = window.__vigilShadowDOM || null;
            const inspectionRoots = new Set([document]);
            shadowDOM?.forEach((root) => inspectionRoots.add(root));
            const queryAllInspectionRoots = (selector) => {
              const results = [];
              inspectionRoots.forEach((root) => {
                root.querySelectorAll?.(selector).forEach((element) => results.push(element));
              });
              return results;
            };
            const frameCommandChannel = '__vigilFrameCommandV1';
            const sendFrameCommand = (frame, command, value = null) => {
              try {
                frame.contentWindow?.postMessage({ channel: frameCommandChannel, command, value }, '*');
              } catch (_) {}
            };
            const relayFrameCommand = (command, value = null) => {
              queryAllInspectionRoots('iframe').forEach((frame) => {
                sendFrameCommand(frame, command, value);
              });
            };

            const applyAudioPreference = (root = document) => {
              const queryable = root?.querySelectorAll;
              const mediaElements = typeof queryable === 'function'
                ? [
                    ...(root instanceof Element && root.matches('video, audio') ? [root] : []),
                    ...root.querySelectorAll('video, audio')
                  ]
                : [];
              mediaElements.forEach((media) => {
                if (earlyMediaGate?.applyAudioPreference(media, window.__vigilAudioPreferred)) return;
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
              earlyMediaGate?.setAudioPreference(window.__vigilAudioPreferred);
              inspectionRoots.forEach(applyAudioPreference);
              relayFrameCommand('audio', window.__vigilAudioPreferred);
              bridge({ type: 'audio', enabled: Boolean(enabled) });
            };

            window.__vigilPauseAllMedia = () => {
              queryAllInspectionRoots('video, audio').forEach((media) => {
                earlyMediaGate?.hold(media, false, true);
                media.pause();
              });
              earlyMediaGate?.suspendAudioContexts(true);
              relayFrameCommand('pause');
            };
            addEventListener('message', (event) => {
              if (event.source !== window.parent) return;
              const payload = event.data;
              if (!payload || payload.channel !== frameCommandChannel) return;
              if (payload.command === 'audio' && typeof payload.value === 'boolean') {
                window.__vigilAudioPreferred = payload.value;
                earlyMediaGate?.setAudioPreference(window.__vigilAudioPreferred);
                inspectionRoots.forEach(applyAudioPreference);
                relayFrameCommand('audio', payload.value);
              } else if (payload.command === 'pause') {
                queryAllInspectionRoots('video, audio').forEach((media) => {
                  earlyMediaGate?.hold(media, false, true);
                  media.pause();
                });
                earlyMediaGate?.suspendAudioContexts(true);
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
            const mediaRequestFingerprints = new Map();
            const mediaRequestKinds = new Map();
            const pendingMedia = new Set();
            let nextMediaID = 1;
            let nextMediaToken = 1;
            let activeMediaRequests = 0;
            let mediaWorkScheduled = false;
            const maximumConcurrentMedia = window === window.top ? 12 : 4;
            const maximumImageBytes = 4 * 1024 * 1024;
            const videoPosterOverrides = new WeakMap();
            const renderedVideoPoster = (element) => String(
              element.poster || element.getAttribute('poster') || ''
            );
            const videoPosterFingerprint = (element) => {
              const rendered = renderedVideoPoster(element);
              const override = videoPosterOverrides.get(element);
              if (!override?.suppressed) return rendered;
              if (!rendered || rendered === override.url) return override.url;
              videoPosterOverrides.delete(element);
              delete element.dataset.vigilVideoPosterSuppressed;
              return rendered;
            };
            const suppressVideoPoster = (element) => {
              const poster = videoPosterFingerprint(element);
              if (!poster) return;
              videoPosterOverrides.set(element, { url: poster, suppressed: true });
              element.dataset.vigilVideoPosterSuppressed = 'true';
              if (element.hasAttribute('poster')) element.removeAttribute('poster');
            };
            const restoreVideoPoster = (element) => {
              const override = videoPosterOverrides.get(element);
              if (!override?.suppressed) return;
              videoPosterOverrides.delete(element);
              delete element.dataset.vigilVideoPosterSuppressed;
              if (renderedVideoPoster(element) !== override.url) element.poster = override.url;
            };
            const enforceVideoPosterSuppression = (element) => {
              const override = videoPosterOverrides.get(element);
              if (override?.suppressed && renderedVideoPoster(element) === override.url
                  && element.hasAttribute('poster')) {
                element.removeAttribute('poster');
              }
            };
            const videoSourceFingerprint = (element) => JSON.stringify({
              current: String(element.currentSrc || element.src || ''),
              declared: String(element.getAttribute('src') || ''),
              sources: [...element.querySelectorAll('source')].map((source) => [
                String(source.getAttribute('src') || ''),
                String(source.getAttribute('srcset') || ''),
                String(source.getAttribute('media') || ''),
                String(source.getAttribute('type') || '')
              ])
            });
            const mediaFingerprint = (element) => element instanceof HTMLVideoElement
              ? JSON.stringify({
                  source: videoSourceFingerprint(element),
                  poster: videoPosterFingerprint(element)
                })
              : String(element.currentSrc || element.src || '');
            const pageAllowsPlayback = () => document.documentElement.dataset.vigilPageVerdict === 'safe';
            const mediaAllowsPlayback = (media) => !(media instanceof HTMLVideoElement)
              || (
                media.dataset.vigilMediaVerdict !== 'sensitive'
                && media.dataset.vigilVideoFrameVerdict === 'safe'
                && media.dataset.vigilVideoFrameFingerprint === videoSourceFingerprint(media)
              );
            earlyMediaGate?.setEligibilityResolver((media) => (
              pageAllowsPlayback() && mediaAllowsPlayback(media)
            ));
            earlyMediaGate?.setAudioContextEligibilityResolver(() => pageAllowsPlayback());
            const gatePlayback = (media, rememberIntent = false) => {
              if (!(media instanceof HTMLMediaElement)) return true;
              const mediaSafe = mediaAllowsPlayback(media);
              if (pageAllowsPlayback() && mediaSafe) {
                earlyMediaGate?.allow(media, true);
                if (media.dataset.vigilResumeWhenSafe === 'true' && document.visibilityState !== 'hidden') {
                  delete media.dataset.vigilResumeWhenSafe;
                  media.play().catch(() => {});
                }
                return true;
              }
              const permanentlyBlocked = document.documentElement.dataset.vigilPageVerdict === 'sensitive'
                || (media instanceof HTMLVideoElement && media.dataset.vigilMediaVerdict === 'sensitive');
              if (permanentlyBlocked) delete media.dataset.vigilResumeWhenSafe;
              else if (rememberIntent && !media.paused) media.dataset.vigilResumeWhenSafe = 'true';
              earlyMediaGate?.hold(media, rememberIntent, permanentlyBlocked);
              if (!media.paused) media.pause();
              return false;
            };
            const refreshPlaybackGates = () => {
              queryAllInspectionRoots('video, audio').forEach((media) => gatePlayback(media));
              earlyMediaGate?.refreshAudioContexts();
            };
            const stopAllMediaForPage = () => {
              queryAllInspectionRoots('video, audio').forEach((media) => {
                delete media.dataset.vigilResumeWhenSafe;
                earlyMediaGate?.hold(media, false, true);
                if (!media.paused) media.pause();
              });
              earlyMediaGate?.suspendAudioContexts(true);
              relayFrameCommand('pause');
            };
            const currentVideoFrameVerdict = (element) => (
              element.dataset.vigilVideoFrameFingerprint === videoSourceFingerprint(element)
                ? element.dataset.vigilVideoFrameVerdict || 'unknown'
                : 'unknown'
            );
            const currentVideoPosterVerdict = (element) => (
              element.dataset.vigilVideoPosterFingerprint === videoPosterFingerprint(element)
                ? element.dataset.vigilVideoPosterVerdict || 'unknown'
                : 'unknown'
            );
            const applyVideoVisualVerdict = (element) => {
              const frameVerdict = currentVideoFrameVerdict(element);
              const poster = videoPosterFingerprint(element);
              const posterVerdict = poster ? currentVideoPosterVerdict(element) : 'none';
              const posterSuppressed = element.dataset.vigilVideoPosterSuppressed === 'true';
              let verdict = 'unknown';
              if (frameVerdict === 'sensitive') {
                verdict = 'sensitive';
              } else if (!posterSuppressed && poster && posterVerdict === 'sensitive') {
                verdict = 'sensitive';
              } else if (!posterSuppressed && poster && posterVerdict === 'safe') {
                verdict = 'safe';
              } else if ((!poster || posterSuppressed) && frameVerdict === 'safe') {
                verdict = 'safe';
              }
              element.dataset.vigilMediaVerdict = verdict;
              gatePlayback(element);
              return verdict;
            };

            const ensureMediaIdentity = (element) => {
              let id = element.dataset.vigilMediaId;
              if (!id || (mediaElements.has(id) && mediaElements.get(id) !== element)) {
                id = String(nextMediaID++);
                element.dataset.vigilMediaId = id;
                element.dataset.vigilMediaVerdict = 'unknown';
              }
              mediaElements.set(id, element);
              if (element instanceof HTMLVideoElement) {
                enforceVideoPosterSuppression(element);
                const sourceFingerprint = videoSourceFingerprint(element);
                if (element.dataset.vigilVideoSourceFingerprint !== sourceFingerprint) {
                  element.dataset.vigilVideoSourceFingerprint = sourceFingerprint;
                  element.dataset.vigilVideoFrameVerdict = 'unknown';
                  delete element.dataset.vigilVideoFrameFingerprint;
                }
                const posterFingerprint = videoPosterFingerprint(element);
                if (element.dataset.vigilVideoPosterFingerprint !== posterFingerprint) {
                  element.dataset.vigilVideoPosterFingerprint = posterFingerprint;
                  element.dataset.vigilVideoPosterVerdict = 'unknown';
                  element.dataset.vigilVideoPosterRetry = '0';
                  delete element.dataset.vigilVideoPosterDeferred;
                  if (posterFingerprint) element.dataset.vigilVideoPosterPending = 'true';
                  else {
                    delete element.dataset.vigilVideoPosterPending;
                    delete element.dataset.vigilVideoPosterSuppressed;
                  }
                }
              }
              const fingerprint = mediaFingerprint(element);
              if (element.dataset.vigilMediaFingerprint !== fingerprint) {
                element.dataset.vigilMediaFingerprint = fingerprint;
                element.dataset.vigilMediaRetry = '0';
                if (element.dataset.vigilMediaInFlight) element.dataset.vigilMediaSuperseded = 'true';
                if (element instanceof HTMLVideoElement) applyVideoVisualVerdict(element);
                else {
                  element.dataset.vigilMediaVerdict = 'unknown';
                  gatePlayback(element);
                }
              }
              return id;
            };
            const drawMedia = (source, sourceWidth, sourceHeight) => {
              try {
                const width = Math.max(1, Number(sourceWidth) || 1);
                const height = Math.max(1, Number(sourceHeight) || 1);
                if (width < 32 || height < 32) return null;
                const scale = Math.min(1, 640 / Math.max(width, height));
                const canvas = document.createElement('canvas');
                canvas.width = Math.max(1, Math.round(width * scale));
                canvas.height = Math.max(1, Math.round(height * scale));
                canvas.getContext('2d', { alpha: false })?.drawImage(source, 0, 0, canvas.width, canvas.height);
                const dataURL = canvas.toDataURL('image/jpeg', 0.76);
                return dataURL.length <= maximumImageBytes * 1.38 ? dataURL : null;
              } catch (_) { return null; }
            };
            const captureRenderedMedia = (element) => drawMedia(
              element,
              element.naturalWidth || element.videoWidth || element.clientWidth,
              element.naturalHeight || element.videoHeight || element.clientHeight
            );
            const captureImageBlob = async (blob) => {
              if (typeof createImageBitmap === 'function') {
                try {
                  const bitmap = await createImageBitmap(blob);
                  const dataURL = drawMedia(bitmap, bitmap.width, bitmap.height);
                  bitmap.close?.();
                  if (dataURL) return dataURL;
                } catch (_) {}
              }
              return await new Promise((resolve) => {
                const objectURL = URL.createObjectURL(blob);
                const image = new Image();
                const finish = (value) => {
                  clearTimeout(timeout);
                  image.onload = null;
                  image.onerror = null;
                  URL.revokeObjectURL(objectURL);
                  resolve(value);
                };
                const timeout = setTimeout(() => finish(null), 5000);
                image.onload = () => finish(drawMedia(image, image.naturalWidth, image.naturalHeight));
                image.onerror = () => finish(null);
                image.src = objectURL;
              });
            };
            const captureCORSResource = async (value) => {
              let resourceURL;
              try {
                resourceURL = new URL(value, location.href);
                if (!['https:', 'data:', 'blob:'].includes(resourceURL.protocol)) return null;
              } catch (_) { return null; }
              const controller = new AbortController();
              const timeout = setTimeout(() => controller.abort(), 5000);
              try {
                const response = await fetch(resourceURL.href, {
                  cache: 'force-cache',
                  credentials: 'omit',
                  mode: 'cors',
                  redirect: 'follow',
                  signal: controller.signal
                });
                if (!response.ok || !String(response.headers.get('content-type') || '').toLowerCase().startsWith('image/')) {
                  return null;
                }
                const blob = await response.blob();
                if (blob.size < 1 || blob.size > maximumImageBytes) return null;
                return await captureImageBlob(blob);
              } catch (_) {
                return null;
              } finally {
                clearTimeout(timeout);
              }
            };
            const videoFrameReady = (element) => element.readyState >= 2
              && element.videoWidth >= 32 && element.videoHeight >= 32;
            const mediaCaptureKind = (element) => {
              if (element instanceof HTMLImageElement) {
                return element.complete && element.naturalWidth >= 32 && element.naturalHeight >= 32
                  ? 'image'
                  : null;
              }
              if (!(element instanceof HTMLVideoElement)) return null;
              const poster = videoPosterFingerprint(element);
              const posterPending = poster && element.dataset.vigilVideoPosterPending === 'true';
              const posterDeferred = element.dataset.vigilVideoPosterDeferred === 'true';
              if (posterPending && !posterDeferred) return 'videoPoster';
              if (videoFrameReady(element)
                  && (
                    element.dataset.vigilForceMediaInspection === 'true'
                    || !['safe', 'sensitive'].includes(element.dataset.vigilVideoFrameVerdict)
                    || element.dataset.vigilVideoFrameFingerprint !== videoSourceFingerprint(element)
                  )) {
                return 'videoFrame';
              }
              if (posterPending && posterDeferred) return null;
              if (poster
                  && (
                    !['safe', 'sensitive'].includes(element.dataset.vigilVideoPosterVerdict)
                    || element.dataset.vigilVideoPosterFingerprint !== poster
                  )) {
                return 'videoPoster';
              }
              return null;
            };
            const captureMedia = async (element, captureKind) => {
              if (captureKind === 'videoPoster') {
                const poster = videoPosterFingerprint(element);
                return poster ? await captureCORSResource(poster) : null;
              }
              const rendered = captureRenderedMedia(element);
              if (rendered) return rendered;
              if (captureKind !== 'image') return null;
              const resource = String(element.currentSrc || element.src || '');
              return resource ? await captureCORSResource(resource) : null;
            };

            let mediaObserver = null;
            const scheduleMediaWork = () => {
              if (mediaWorkScheduled) return;
              mediaWorkScheduled = true;
              requestAnimationFrame(() => {
                mediaWorkScheduled = false;
                while (activeMediaRequests < maximumConcurrentMedia && pendingMedia.size) {
                  let element = [...pendingMedia].find((candidate) => candidate.dataset.vigilNearViewport === 'true');
                  if (!element) element = pendingMedia.values().next().value;
                  pendingMedia.delete(element);
                  if (!(element instanceof HTMLImageElement || element instanceof HTMLVideoElement)
                      || !element.isConnected || element.dataset.vigilMediaInFlight) continue;
                  const captureKind = mediaCaptureKind(element);
                  if (!captureKind) {
                    if (element.dataset.vigilLoadListener !== 'true') {
                      element.dataset.vigilLoadListener = 'true';
                      element.addEventListener(element instanceof HTMLVideoElement ? 'loadeddata' : 'load', () => {
                        delete element.dataset.vigilLoadListener;
                        queueMedia(element, true);
                      }, { once: true });
                    }
                    continue;
                  }
                  submitMedia(element, captureKind);
                }
              });
            };
            const queueMedia = (element, priority = false, force = false) => {
              if (!(element instanceof HTMLImageElement || element instanceof HTMLVideoElement) || !element.isConnected) return;
              ensureMediaIdentity(element);
              if (force) element.dataset.vigilForceMediaInspection = 'true';
              if (!priority && mediaObserver && element.dataset.vigilNearViewport !== 'true') return;
              if (element.dataset.vigilMediaInFlight) return;
              if (element instanceof HTMLImageElement
                  && element.dataset.vigilMediaVerdict === 'safe'
                  && element.dataset.vigilForceMediaInspection !== 'true') return;
              pendingMedia.add(element);
              scheduleMediaWork();
            };
            const submitMedia = async (element, captureKind) => {
              const id = ensureMediaIdentity(element);
              const fingerprint = mediaFingerprint(element);
              const token = String(nextMediaToken++);
              element.dataset.vigilMediaToken = token;
              element.dataset.vigilMediaInFlight = token;
              mediaRequestFingerprints.set(token, fingerprint);
              mediaRequestKinds.set(token, captureKind);
              element.dataset.vigilMediaCaptureKind = captureKind;
              delete element.dataset.vigilForceMediaInspection;
              activeMediaRequests += 1;
              const dataURL = await captureMedia(element, captureKind);
              if (!element.isConnected || element.dataset.vigilMediaInFlight !== token
                  || mediaFingerprint(element) !== fingerprint) {
                if (element.dataset.vigilMediaInFlight === token) delete element.dataset.vigilMediaInFlight;
                mediaRequestFingerprints.delete(token);
                mediaRequestKinds.delete(token);
                delete element.dataset.vigilMediaSuperseded;
                activeMediaRequests = Math.max(0, activeMediaRequests - 1);
                if (element.isConnected) queueMedia(element, true);
                scheduleMediaWork();
                return;
              }
              bridge({
                type: 'mediaCandidate',
                documentID,
                id,
                token,
                kind: captureKind,
                dataURL: dataURL || '',
                captureFailed: !dataURL
              });
              // A missing native response must not permanently strand the queue.
              setTimeout(() => {
                if (element.dataset.vigilMediaInFlight !== token) return;
                delete element.dataset.vigilMediaInFlight;
                mediaRequestFingerprints.delete(token);
                mediaRequestKinds.delete(token);
                delete element.dataset.vigilMediaSuperseded;
                activeMediaRequests = Math.max(0, activeMediaRequests - 1);
                queueMedia(element, true, true);
                scheduleMediaWork();
              }, 30000);
            };
            const scheduleVideoPosterRetry = (element) => {
              const poster = videoPosterFingerprint(element);
              if (!poster) return;
              const previousRetry = Number(element.dataset.vigilVideoPosterRetry || 0);
              if (previousRetry >= 6) return;
              const retry = previousRetry + 1;
              element.dataset.vigilVideoPosterRetry = String(retry);
              const attempt = () => {
                if (!element.isConnected
                    || videoPosterFingerprint(element) !== poster
                    || currentVideoPosterVerdict(element) !== 'unknown') return;
                if (element.dataset.vigilMediaInFlight) {
                  setTimeout(attempt, 500);
                  return;
                }
                delete element.dataset.vigilVideoPosterDeferred;
                queueMedia(element, true, true);
              };
              setTimeout(attempt, Math.min(30000, 1000 * (2 ** retry)));
            };

            window.__vigilResolveMedia = (resolvedDocumentID, id, token, verdict) => {
              if (String(resolvedDocumentID) !== documentID) return;
              const element = mediaElements.get(String(id));
              if (!element || element.dataset.vigilMediaToken !== String(token)
                  || element.dataset.vigilMediaInFlight !== String(token)
                  || !['safe', 'sensitive', 'unknown'].includes(verdict)) return;
              const submittedFingerprint = mediaRequestFingerprints.get(String(token));
              const submittedKind = mediaRequestKinds.get(String(token));
              const fingerprintChanged = submittedFingerprint === undefined
                || !['image', 'videoPoster', 'videoFrame'].includes(submittedKind)
                || submittedFingerprint !== mediaFingerprint(element)
                || submittedFingerprint !== element.dataset.vigilMediaFingerprint;
              delete element.dataset.vigilMediaInFlight;
              mediaRequestFingerprints.delete(String(token));
              mediaRequestKinds.delete(String(token));
              activeMediaRequests = Math.max(0, activeMediaRequests - 1);
              if (fingerprintChanged || element.dataset.vigilMediaSuperseded === 'true') {
                ensureMediaIdentity(element);
                delete element.dataset.vigilMediaSuperseded;
                queueMedia(element, true, true);
                scheduleMediaWork();
                return;
              }
              if (element instanceof HTMLVideoElement && submittedKind === 'videoPoster') {
                element.dataset.vigilVideoPosterVerdict = verdict;
                element.dataset.vigilVideoPosterFingerprint = videoPosterFingerprint(element);
                if (verdict === 'safe') {
                  element.dataset.vigilVideoPosterRetry = '0';
                  delete element.dataset.vigilVideoPosterPending;
                  delete element.dataset.vigilVideoPosterDeferred;
                  restoreVideoPoster(element);
                } else {
                  suppressVideoPoster(element);
                  if (verdict === 'unknown') {
                    element.dataset.vigilVideoPosterPending = 'true';
                    element.dataset.vigilVideoPosterDeferred = 'true';
                    scheduleVideoPosterRetry(element);
                  } else {
                    element.dataset.vigilVideoPosterRetry = '0';
                    delete element.dataset.vigilVideoPosterPending;
                    delete element.dataset.vigilVideoPosterDeferred;
                  }
                }
                applyVideoVisualVerdict(element);
                if (currentVideoFrameVerdict(element) === 'unknown'
                    && (
                      element.dataset.vigilPlaybackRequested === 'true'
                      || videoFrameReady(element)
                    )) {
                  queueMedia(element, true, true);
                }
                scheduleMediaWork();
                return;
              }
              if (element instanceof HTMLVideoElement && submittedKind === 'videoFrame') {
                if (element.dataset.vigilVideoFrameVerdict !== 'sensitive') {
                  element.dataset.vigilVideoFrameVerdict = verdict;
                }
                element.dataset.vigilVideoFrameFingerprint = videoSourceFingerprint(element);
                applyVideoVisualVerdict(element);
              } else if (element.dataset.vigilMediaVerdict !== 'sensitive') {
                element.dataset.vigilMediaVerdict = verdict;
              }
              if (verdict === 'safe') {
                element.dataset.vigilMediaRetry = '0';
                gatePlayback(element);
                if (element instanceof HTMLVideoElement && !element.paused) {
                  setTimeout(() => queueMedia(element, true, true), 6000);
                }
              } else if (verdict === 'sensitive') {
                delete element.dataset.vigilResumeWhenSafe;
                gatePlayback(element);
              } else {
                gatePlayback(element);
                const retry = Math.min(6, Number(element.dataset.vigilMediaRetry || 0) + 1);
                element.dataset.vigilMediaRetry = String(retry);
                setTimeout(() => queueMedia(element, true, true), Math.min(30000, 1000 * (2 ** retry)));
              }
              scheduleMediaWork();
            };

            const registerMediaTree = (node) => {
              if (!node?.querySelectorAll) return;
              const media = [
                ...(node instanceof Element && node.matches('img, video') ? [node] : []),
                ...node.querySelectorAll('img, video')
              ];
              media.forEach((element) => {
                const previousFingerprint = element.dataset.vigilMediaFingerprint;
                ensureMediaIdentity(element);
                mediaObserver?.observe(element);
                if (!mediaObserver) queueMedia(element, true);
                else if (previousFingerprint !== undefined
                    && previousFingerprint !== element.dataset.vigilMediaFingerprint) {
                  queueMedia(element);
                }
              });
            };
            if (typeof window.IntersectionObserver === 'function') {
              mediaObserver = new IntersectionObserver((entries) => {
                entries.forEach((entry) => {
                  entry.target.dataset.vigilNearViewport = String(entry.isIntersecting);
                  if (entry.isIntersecting) queueMedia(entry.target, true);
                });
              }, { rootMargin: '1500px 0px', threshold: 0.01 });
            }

            let responsiveMediaRefreshScheduled = false;
            let responsiveMediaRefreshDirty = false;
            let responsiveMediaIterator = null;
            const scheduleResponsiveMediaRefresh = () => {
              if (responsiveMediaRefreshScheduled) {
                responsiveMediaRefreshDirty = true;
                return;
              }
              responsiveMediaRefreshScheduled = true;
              responsiveMediaRefreshDirty = false;
              responsiveMediaIterator = mediaElements.values();
              const run = () => {
                let budget = 80;
                while (budget > 0) {
                  const item = responsiveMediaIterator.next();
                  if (item.done) {
                    responsiveMediaIterator = null;
                    responsiveMediaRefreshScheduled = false;
                    if (responsiveMediaRefreshDirty) scheduleResponsiveMediaRefresh();
                    return;
                  }
                  const element = item.value;
                  if (!element.isConnected) {
                    const id = element.dataset.vigilMediaId;
                    mediaObserver?.unobserve(element);
                    if (id && mediaElements.get(id) === element) mediaElements.delete(id);
                    pendingMedia.delete(element);
                  } else {
                    const previousFingerprint = element.dataset.vigilMediaFingerprint;
                    ensureMediaIdentity(element);
                    if (previousFingerprint !== element.dataset.vigilMediaFingerprint) {
                      queueMedia(element);
                    }
                  }
                  budget -= 1;
                }
                requestAnimationFrame(run);
              };
              requestAnimationFrame(run);
            };
            let responsiveDensityQuery = null;
            const handleResponsiveDensityChange = () => {
              armResponsiveDensityChange();
              scheduleResponsiveMediaRefresh();
              rescanAllVisuals();
            };
            const armResponsiveDensityChange = () => {
              responsiveDensityQuery?.removeEventListener?.('change', handleResponsiveDensityChange);
              responsiveDensityQuery?.removeListener?.(handleResponsiveDensityChange);
              responsiveDensityQuery = matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
              if (responsiveDensityQuery.addEventListener) {
                responsiveDensityQuery.addEventListener('change', handleResponsiveDensityChange);
              } else {
                responsiveDensityQuery.addListener?.(handleResponsiveDensityChange);
              }
            };
            const refreshSelectedMediaSource = (element) => {
              if (!(element instanceof HTMLImageElement || element instanceof HTMLVideoElement)
                  || !element.isConnected) return;
              const previousFingerprint = element.dataset.vigilMediaFingerprint;
              ensureMediaIdentity(element);
              if (previousFingerprint !== element.dataset.vigilMediaFingerprint) queueMedia(element);
            };

            let textRevision = 0;
            let textInspectionTimer = 0;
            let lastTextInspectionAt = 0;
            const extractPageText = (limit) => {
              if (!document.body) return { text: '', wasTruncated: false };
              const pieces = [];
              let length = 0;
              let wasTruncated = false;
              for (const inspectionRoot of inspectionRoots) {
                const root = inspectionRoot === document ? document.body : inspectionRoot;
                if (!root || !root.isConnected) continue;
                const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
                  acceptNode: (node) => {
                    const parent = node.parentElement;
                    if (!parent || ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(parent.tagName)) {
                      return NodeFilter.FILTER_REJECT;
                    }
                    return NodeFilter.FILTER_ACCEPT;
                  }
                });
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
                if (wasTruncated) break;
              }
              return { text: pieces.join('\n'), wasTruncated };
            };
            const inspectPageText = () => {
              textInspectionTimer = 0;
              lastTextInspectionAt = Date.now();
              const maximumTextLength = 512000;
              const chunkLength = 24000;
              const extracted = extractPageText(maximumTextLength);
              const revision = String(++textRevision);
              const total = Math.max(1, Math.ceil(extracted.text.length / chunkLength));
              for (let index = 0; index < total; index += 1) {
                bridge({
                  type: 'pageText', documentID, revision, index, total,
                  wasTruncated: extracted.wasTruncated,
                  text: extracted.text.slice(index * chunkLength, (index + 1) * chunkLength)
                });
              }
            };
            const scheduleTextInspection = (minimumDelay = 320) => {
              if (textInspectionTimer) return;
              const delay = Math.max(minimumDelay, 1500 - (Date.now() - lastTextInspectionAt));
              textInspectionTimer = setTimeout(() => {
                const run = () => inspectPageText();
                if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout: 800 });
                else run();
              }, delay);
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
            const pendingBackgrounds = new Set();
            const pendingBackgroundTrees = new Map();
            let backgroundWorkScheduled = false;
            const isShadowInspectionRoot = (value) => (
              typeof ShadowRoot === 'function' && value instanceof ShadowRoot
            );
            const isConnectedInspectionRoot = (root) => (
              root === document || Boolean(root?.isConnected)
            );
            const visualMarkerForTree = (root) => {
              if (root === document) return document.documentElement;
              if (isShadowInspectionRoot(root)) return root.host;
              return root instanceof Element ? root : null;
            };
            const clearVisualTreePending = (root) => {
              const marker = visualMarkerForTree(root);
              if (!marker?.dataset) return;
              delete marker.dataset.vigilBackgroundSubtreePending;
              delete marker.dataset.vigilContentSubtreePending;
            };
            const visualTreeContains = (ancestor, candidate) => {
              if (ancestor === candidate) return true;
              if (ancestor === document) {
                return candidate instanceof Element && candidate.getRootNode() === document;
              }
              if (isShadowInspectionRoot(ancestor)) {
                return candidate === ancestor
                  || (candidate instanceof Element && candidate.getRootNode() === ancestor);
              }
              return ancestor instanceof Element
                && candidate instanceof Element
                && ancestor.contains(candidate);
            };
            const firstVisualTreeElement = (root, walker) => (
              root instanceof Element ? root : walker.nextNode()
            );
            // Incremental successors to the former markBackgroundPending,
            // backgroundInspectionRoots, and roots.forEach(inspectBackgroundMedia)
            // whole-subtree pass. Keep work bounded while preserving fail-closed
            // marking before any newly introduced background can paint.
            const inspectBackgroundElement = (element) => {
              if (!(element instanceof Element) || !element.isConnected || !element.dataset) return;
              // Probe past our own fail-closed CSS synchronously. JavaScript runs
              // to completion before WebKit can paint the temporary probe state.
              element.dataset.vigilBackgroundVerdict = 'inspecting';
              element.dataset.vigilBackgroundInspecting = 'true';
              element.dataset.vigilContentInspecting = 'true';
              element.dataset.vigilContentVerdict = 'inspecting';
              element.dataset.vigilContentBeforeVerdict = 'inspecting';
              element.dataset.vigilContentAfterVerdict = 'inspecting';
              let backgrounds;
              let contents;
              try {
                backgrounds = [
                  getComputedStyle(element).backgroundImage,
                  getComputedStyle(element, '::before').backgroundImage,
                  getComputedStyle(element, '::after').backgroundImage
                ];
                contents = [
                  getComputedStyle(element).content,
                  getComputedStyle(element, '::before').content,
                  getComputedStyle(element, '::after').content
                ];
              } catch (_) {
                element.dataset.vigilBackgroundVerdict = 'unknown';
                element.dataset.vigilContentVerdict = 'unknown';
                element.dataset.vigilContentBeforeVerdict = 'unknown';
                element.dataset.vigilContentAfterVerdict = 'unknown';
              } finally {
                delete element.dataset.vigilBackgroundInspecting;
                delete element.dataset.vigilContentInspecting;
              }
              if (backgrounds) {
                const urls = backgrounds.flatMap(backgroundURLs);
                if (!urls.length) {
                  const generated = backgrounds.some((value) => value && value !== 'none');
                  element.dataset.vigilBackgroundVerdict = generated ? 'safe' : 'none';
                } else {
                  element.dataset.vigilBackgroundVerdict = isTrustedChromeBackground(element, urls)
                    ? 'safe'
                    : 'unknown';
                }
              }
              if (contents) {
                const verdictForContent = (value) => {
                  const urls = backgroundURLs(value);
                  if (!urls.length) return 'none';
                  return isTrustedChromeBackground(element, urls) ? 'safe' : 'unknown';
                };
                element.dataset.vigilContentVerdict = verdictForContent(contents[0]);
                element.dataset.vigilContentBeforeVerdict = verdictForContent(contents[1]);
                element.dataset.vigilContentAfterVerdict = verdictForContent(contents[2]);
              }
            };
            const requestBackgroundWork = () => {
              if (backgroundWorkScheduled) return;
              backgroundWorkScheduled = true;
              const run = () => {
                backgroundWorkScheduled = false;
                let budget = 80;
                let directBudget = Math.min(40, budget);
                for (const element of pendingBackgrounds) {
                  pendingBackgrounds.delete(element);
                  inspectBackgroundElement(element);
                  budget -= 1;
                  directBudget -= 1;
                  if (directBudget <= 0) break;
                }
                if (budget > 0) {
                  for (const [root, job] of pendingBackgroundTrees) {
                    if (!isConnectedInspectionRoot(root)) {
                      pendingBackgroundTrees.delete(root);
                      continue;
                    }
                    while (budget > 0 && job.next) {
                      const element = job.next;
                      job.next = job.walker.nextNode();
                      inspectBackgroundElement(element);
                      budget -= 1;
                    }
                    if (!job.next) {
                      if (job.dirty) {
                        job.walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
                        job.next = firstVisualTreeElement(root, job.walker);
                        job.dirty = false;
                      } else {
                        pendingBackgroundTrees.delete(root);
                        clearVisualTreePending(root);
                      }
                    }
                    if (budget <= 0) break;
                  }
                }
                if (pendingBackgrounds.size || pendingBackgroundTrees.size) requestBackgroundWork();
              };
              if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout: 500 });
              else setTimeout(run, 80);
            };
            const queueBackgroundElement = (element) => {
              if (!(element instanceof Element) || !element.isConnected) return;
              element.dataset.vigilBackgroundVerdict = 'unknown';
              element.dataset.vigilContentVerdict = 'unknown';
              element.dataset.vigilContentBeforeVerdict = 'unknown';
              element.dataset.vigilContentAfterVerdict = 'unknown';
              pendingBackgrounds.add(element);
              requestBackgroundWork();
            };
            const queueBackgroundTree = (node) => {
              if (!(node instanceof Element || node === document || isShadowInspectionRoot(node))
                  || !isConnectedInspectionRoot(node)) return;
              for (const [pendingRoot, pendingJob] of pendingBackgroundTrees) {
                if (!visualTreeContains(pendingRoot, node)) continue;
                // The pending ancestor already conceals this subtree. Mark its
                // pass dirty so a mutation behind the iterator is revisited
                // without scheduling a duplicate descendant walk.
                pendingJob.dirty = true;
                requestBackgroundWork();
                return;
              }
              for (const pendingRoot of [...pendingBackgroundTrees.keys()]) {
                if (!visualTreeContains(node, pendingRoot)) continue;
                pendingBackgroundTrees.delete(pendingRoot);
                clearVisualTreePending(pendingRoot);
              }
              // One ancestor marker fail-closes the complete subtree immediately.
              // A TreeWalker then inspects a bounded number of descendants per
              // idle slice instead of allocating and mutating a full query result.
              const marker = visualMarkerForTree(node);
              if (marker?.dataset) {
                marker.dataset.vigilBackgroundSubtreePending = 'true';
                marker.dataset.vigilContentSubtreePending = 'true';
              }
              const existing = pendingBackgroundTrees.get(node);
              if (existing) {
                existing.dirty = true;
                requestBackgroundWork();
                return;
              }
              const walker = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT);
              pendingBackgroundTrees.set(node, {
                walker,
                next: firstVisualTreeElement(node, walker),
                dirty: false
              });
              requestBackgroundWork();
            };

            window.__vigilResolvePageText = (resolvedDocumentID, revision, verdict) => {
              if (String(resolvedDocumentID) !== documentID) return;
              if (String(revision) !== String(textRevision)) return;
              if (['safe', 'sensitive', 'unknown'].includes(verdict)) {
                document.documentElement.dataset.vigilPageVerdict = verdict;
                if (verdict === 'sensitive') stopAllMediaForPage();
                else refreshPlaybackGates();
                document.dispatchEvent(new CustomEvent('__vigilPageVerdictChanged', {
                  detail: { verdict }
                }));
              }
            };

            const scheduleContentInspection = (records) => {
              let textChanged = false;
              records.forEach((record) => {
                if (record.type === 'attributes') {
                  registerMediaTree(record.target);
                  if (record.target instanceof HTMLSourceElement) {
                    registerMediaTree(record.target.closest('video, picture') || record.target.parentElement);
                  }
                } else if (record.type === 'childList') {
                  const noisyContainer = record.target instanceof Element
                    && record.target.closest('video, ytm-player, .html5-video-player, [role="slider"], [aria-valuenow]');
                  record.addedNodes?.forEach((node) => {
                    registerMediaTree(node);
                    if (!noisyContainer && node instanceof Element) textChanged = true;
                    else if (!noisyContainer && node.nodeType === Node.TEXT_NODE && String(node.nodeValue || '').trim()) {
                      textChanged = true;
                    }
                  });
                  if (!noisyContainer && record.removedNodes?.length) textChanged = true;
                } else if (record.type === 'characterData') {
                  const container = record.target.parentElement;
                  if (!container?.closest('video, ytm-player, .html5-video-player, [role="slider"], [aria-valuenow]')) {
                    textChanged = true;
                  }
                }
              });
              if (textChanged) scheduleTextInspection();
            };
            const contentMutationObserver = new MutationObserver(scheduleContentInspection);
            const contentObserverOptions = {
              childList: true, subtree: true, characterData: true,
              attributes: true, attributeFilter: ['src', 'srcset', 'sizes', 'media', 'type', 'poster']
            };
            const visualTreeForNode = (node) => {
              const root = node?.getRootNode?.();
              return isShadowInspectionRoot(root) ? root : document;
            };
            const queueStylesheetImpact = (node) => {
              if (!node?.querySelectorAll) return;
              const stylesheets = [
                ...(node instanceof Element && node.matches('style, link[rel~="stylesheet" i]')
                  ? [node]
                  : []),
                ...node.querySelectorAll('style, link[rel~="stylesheet" i]')
              ];
              if (!stylesheets.length) return;
              const affectedTree = visualTreeForNode(node);
              queueBackgroundTree(affectedTree);
              stylesheets.forEach((stylesheet) => {
                if (stylesheet instanceof HTMLLinkElement) {
                  stylesheet.addEventListener('load', () => {
                    queueBackgroundTree(affectedTree);
                  }, { once: true });
                }
              });
            };
            const scheduleBackgroundInspection = (records) => {
              records.forEach((record) => {
                if (record.type === 'attributes') {
                  queueBackgroundElement(record.target);
                  // Inline declarations normally affect only their element.
                  // Revisit descendants only when inherited custom properties
                  // could have changed; class selectors can affect descendants.
                  const customPropertyChanged = record.attributeName === 'style'
                    && /--[\w-]+\s*:/.test(`${record.oldValue || ''};${record.target.getAttribute('style') || ''}`);
                  if (record.attributeName === 'class' || customPropertyChanged) {
                    queueBackgroundTree(record.target);
                  }
                }
                if (record.type === 'childList') {
                  queueBackgroundElement(record.target);
                  if (record.target instanceof Element && record.target.matches('style')) {
                    queueStylesheetImpact(record.target);
                  }
                  record.addedNodes?.forEach((node) => {
                    queueBackgroundTree(node);
                    queueStylesheetImpact(node);
                  });
                }
                if (record.type === 'characterData'
                    && record.target.parentElement?.matches('style')) {
                  queueStylesheetImpact(record.target.parentElement);
                }
              });
            };
            const backgroundMutationObserver = new MutationObserver(scheduleBackgroundInspection);
            const backgroundObserverOptions = {
              childList: true, subtree: true,
              characterData: true,
              attributes: true, attributeOldValue: true, attributeFilter: ['class', 'style']
            };
            const rescanAllVisuals = () => {
              inspectionRoots.forEach((root) => {
                queueBackgroundTree(root);
              });
            };
            const activeVisualEffects = new WeakMap();
            const visualEffectKey = (event) => event.type.startsWith('animation')
              ? `animation:${event.animationName || ''}`
              : `transition:${event.propertyName || ''}`;
            const beginVisualEffect = (event) => {
              const target = event.target;
              if (!(target instanceof Element)) return;
              let active = activeVisualEffects.get(target);
              if (!active) {
                active = new Map();
                activeVisualEffects.set(target, active);
              }
              const key = visualEffectKey(event);
              active.set(key, Number(active.get(key) || 0) + 1);
              target.dataset.vigilVisualEffectPending = 'true';
              queueBackgroundTree(target);
            };
            const continueVisualEffect = (event) => {
              if (event.target instanceof Element) queueBackgroundTree(event.target);
            };
            const finishVisualEffect = (event) => {
              const target = event.target;
              if (!(target instanceof Element)) return;
              // Mark the final computed value unknown before releasing the
              // duration-long animation/transition hold.
              queueBackgroundTree(target);
              const active = activeVisualEffects.get(target);
              const key = visualEffectKey(event);
              const remaining = Number(active?.get(key) || 0) - 1;
              if (remaining > 0) active?.set(key, remaining);
              else active?.delete(key);
              if (!active?.size) {
                activeVisualEffects.delete(target);
                delete target.dataset.vigilVisualEffectPending;
              }
            };
            const installVisualEventListeners = (root) => {
              root.addEventListener('load', (event) => {
                if (event.target instanceof HTMLImageElement) {
                  refreshSelectedMediaSource(event.target);
                }
              }, true);
              root.addEventListener('loadeddata', (event) => {
                if (event.target instanceof HTMLVideoElement) {
                  refreshSelectedMediaSource(event.target);
                  queueMedia(event.target, true);
                }
              }, true);
              root.addEventListener('__vigilPlaybackInspectionRequested', (event) => {
                const video = event.target;
                if (!(video instanceof HTMLVideoElement)) return;
                video.dataset.vigilPlaybackRequested = 'true';
                queueMedia(video, true, true);
              }, true);
              ['animationstart', 'transitionrun'].forEach((eventName) => {
                root.addEventListener(eventName, beginVisualEffect, true);
              });
              root.addEventListener('animationiteration', continueVisualEffect, true);
              ['animationend', 'animationcancel', 'transitionend', 'transitioncancel']
                .forEach((eventName) => {
                  root.addEventListener(eventName, finishVisualEffect, true);
                });
              ['pointerover', 'pointerdown', 'focusin'].forEach((eventName) => {
                root.addEventListener(eventName, (event) => {
                  const target = event.target instanceof Element
                    ? event.target
                    : event.target?.parentElement;
                  queueBackgroundElement(target);
                  const interactive = target?.closest(
                    'button, a, input, textarea, select, label, [role="button"], [role="tab"], [tabindex]'
                  );
                  if (interactive !== target) queueBackgroundElement(interactive);
                }, true);
              });
            };
            const observedVisualRoots = new WeakSet();
            const installVisualRoot = (root) => {
              if (!root?.addEventListener || observedVisualRoots.has(root)) return;
              observedVisualRoots.add(root);
              inspectionRoots.add(root);
              const observationTarget = root === document ? document.documentElement : root;
              if (!observationTarget) return;
              contentMutationObserver.observe(observationTarget, contentObserverOptions);
              backgroundMutationObserver.observe(observationTarget, backgroundObserverOptions);
              installVisualEventListeners(root);
              registerMediaTree(observationTarget);
              queueBackgroundTree(root);
              queueStylesheetImpact(
                root === document ? (document.head || document.documentElement) : root
              );
              scheduleTextInspection();
            };
            inspectionRoots.forEach(installVisualRoot);
            shadowDOM?.subscribe(installVisualRoot);
            shadowDOM?.subscribeVisualMutations((root) => {
              if (root) {
                installVisualRoot(root);
                queueBackgroundTree(root);
              } else {
                rescanAllVisuals();
              }
            });
            const rescanResponsiveVisuals = () => {
              rescanAllVisuals();
              scheduleResponsiveMediaRefresh();
            };
            addEventListener('load', rescanAllVisuals, { once: true });
            addEventListener('pageshow', rescanResponsiveVisuals);
            matchMedia('(prefers-color-scheme: dark)').addEventListener?.(
              'change',
              rescanAllVisuals
            );
            addEventListener('orientationchange', rescanResponsiveVisuals, { passive: true });
            addEventListener('resize', rescanResponsiveVisuals, { passive: true });
            window.visualViewport?.addEventListener(
              'resize',
              rescanResponsiveVisuals,
              { passive: true }
            );
            armResponsiveDensityChange();

            // A bounded visible-area audit is a backstop for CSSOM properties
            // whose engine-native setters cannot be wrapped. Intercepted
            // mutations still fail close synchronously through the bootstrap.
            const auditVisibleVisuals = () => {
              const width = Math.max(1, window.innerWidth || 1);
              const height = Math.max(1, window.innerHeight || 1);
              inspectionRoots.forEach((root) => {
                const elementsFromPoint = root.elementsFromPoint?.bind(root);
                if (!elementsFromPoint || (root !== document && !root.isConnected)) return;
                for (let row = 0; row < 6; row += 1) {
                  for (let column = 0; column < 4; column += 1) {
                    const x = width * (column + 0.5) / 4;
                    const y = height * (row + 0.5) / 6;
                    elementsFromPoint(x, y).slice(0, 4).forEach(queueBackgroundElement);
                  }
                }
              });
            };
            setInterval(auditVisibleVisuals, 5000);
            scheduleTextInspection(0);

            // Re-check only registered near-viewport moving media. A new video
            // sample is never submitted while its prior native verdict is pending.
            setInterval(() => {
              for (const [id, media] of mediaElements) {
                if (!media.isConnected) {
                  mediaObserver?.unobserve(media);
                  mediaElements.delete(id);
                  pendingMedia.delete(media);
                  continue;
                }
                if (media.dataset.vigilNearViewport !== 'true') continue;
                if (media instanceof HTMLVideoElement && !media.paused && media.readyState >= 2) {
                  queueMedia(media, true, true);
                } else if (media instanceof HTMLImageElement && media.complete
                    && /\.(gif|webp)(?:$|[?#])/i.test(media.currentSrc || media.src || '')) {
                  queueMedia(media, true, true);
                }
              }
            }, 6000);

            let audioRefreshScheduled = false;
            const audioRefreshRoots = new Set();
            const scheduleAudioRefresh = (records) => {
              records.forEach((record) => {
                record.addedNodes?.forEach((node) => {
                  if (node instanceof Element) audioRefreshRoots.add(node);
                });
              });
              if (audioRefreshScheduled) return;
              audioRefreshScheduled = true;
              requestAnimationFrame(() => {
                audioRefreshScheduled = false;
                [...audioRefreshRoots].forEach((root) => {
                  applyAudioPreference(root);
                  const mediaElements = root.matches('video, audio')
                    ? [root, ...root.querySelectorAll('video, audio')]
                    : [...root.querySelectorAll('video, audio')];
                  mediaElements.forEach((media) => gatePlayback(media));
                });
                audioRefreshRoots.clear();
              });
            };
            const audioMutationObserver = new MutationObserver(scheduleAudioRefresh);
            const audioObserverOptions = {
              childList: true,
              subtree: true
            };
            const observedAudioRoots = new WeakSet();
            const installAudioRoot = (root) => {
              if (!root?.addEventListener || observedAudioRoots.has(root)) return;
              observedAudioRoots.add(root);
              inspectionRoots.add(root);
              const observationTarget = root === document ? document.documentElement : root;
              if (!observationTarget) return;
              audioMutationObserver.observe(observationTarget, audioObserverOptions);
              root.addEventListener('pointerup', (event) => {
                const media = event.target instanceof Element
                  ? event.target.closest('video, audio')
                  : null;
                if (media) {
                  if (event.isTrusted) {
                    // Let Instagram's own tap-to-mute handler record an explicit
                    // choice before supplying the audible-session fallback.
                    queueMicrotask(() => {
                      earlyMediaGate?.requestAudiblePlayback(media);
                      applyAudioPreference(media);
                    });
                  } else {
                    applyAudioPreference(media);
                  }
                }
              }, true);
              root.addEventListener('play', (event) => {
                const media = event.target;
                applyAudioPreference(media);
                if (media instanceof HTMLVideoElement) queueMedia(media, true);
                gatePlayback(media, true);
              }, true);
              root.addEventListener('load', (event) => {
                if (event.target instanceof HTMLIFrameElement) {
                  sendFrameCommand(event.target, 'audio', window.__vigilAudioPreferred);
                }
              }, true);
              applyAudioPreference(root);
              root.querySelectorAll?.('video, audio').forEach((media) => gatePlayback(media));
            };
            inspectionRoots.forEach(installAudioRoot);
            shadowDOM?.subscribe(installAudioRoot);
            refreshPlaybackGates();
            relayFrameCommand('audio', window.__vigilAudioPreferred);
          } else {
            window.__vigilSetAudioPreference(AUDIO_PREFERENCE);
          }
        })();
        """#.replacingOccurrences(of: "AUDIO_PREFERENCE", with: preference)
    }

    private static func serviceScript(_ service: SocialService) -> String {
        switch service {
        case .instagram: instagramStable
        case .youtube: youtube
        case .snapchat: snapchat
        }
    }

    private static let snapchat = #"""
    (() => {
      if (window.__vigilSnapchatInstalled) return;
      const allowedHosts = ['snapchat.com', 'www.snapchat.com', 'web.snapchat.com'];
      if (!allowedHosts.includes(String(location.hostname || '').toLowerCase())) return;
      window.__vigilSnapchatInstalled = true;

      const style = document.createElement('style');
      style.id = 'vigil-snapchat-style';
      style.textContent = `
        a[href*="/spotlight" i], a[href*="/discover" i],
        button[aria-label*="Spotlight" i], [role="button"][aria-label*="Spotlight" i],
        button[aria-label*="Discover" i], [role="button"][aria-label*="Discover" i],
        [data-testid*="spotlight" i], [data-testid*="discover" i],
        [data-page-type*="spotlight" i], [data-page-type*="discover" i] {
          display: none !important;
        }
        [data-vigil-hidden-feature] { display: none !important; }
        html[data-vigil-snapchat-restricted="true"] body {
          visibility: hidden !important;
        }
      `;
      document.documentElement.appendChild(style);

      const restrictedFeature = (value = location.href) => {
        try {
          const url = new URL(value, location.href);
          if (!allowedHosts.includes(url.hostname.toLowerCase())) return '';
          const path = url.pathname.toLowerCase();
          if (path === '/spotlight' || path.startsWith('/spotlight/')) return 'Spotlight';
          if (path === '/discover' || path.startsWith('/discover/')) return 'Discover';
        } catch (_) {}
        return '';
      };
      const labelledRestrictedControl = (element) => {
        const control = element?.closest?.('a[href], button, [role="button"], [role="tab"]');
        if (!control) return null;
        if (control instanceof HTMLAnchorElement && restrictedFeature(control.href)) return control;
        const label = String(
          control.getAttribute('aria-label')
          || control.getAttribute('data-testid')
          || control.textContent
          || ''
        ).trim().toLowerCase();
        return /^(spotlight|discover)(\s|$)/.test(label) ? control : null;
      };
      const hideRestrictedControls = (root = document) => {
        root.querySelectorAll?.(
          'a[href], button[aria-label], [role="button"][aria-label], '
          + '[role="tab"], [data-testid]'
        ).forEach((element) => {
          const control = labelledRestrictedControl(element);
          if (control) control.setAttribute('data-vigil-hidden-feature', 'true');
        });
      };
      const publishUnavailable = (feature) => {
        if (window !== window.top) return;
        window.__vigilBridge?.({
          type: 'health',
          state: 'degraded',
          detail: `Snapchat ${feature} is intentionally unavailable.`
        });
      };
      const loginAttemptKey = 'vigil-snapchat-web-login-attempted';
      const webLoginURL = 'https://accounts.snapchat.com/v2/login?continue=https%3A%2F%2Fwww.snapchat.com%2Fweb%2F';
      const isMarketingShell = () => {
        const text = String(document.body?.innerText || '').toLowerCase();
        return text.includes('download snapchat') && text.includes('open snapchat');
      };
      const beginWebLoginIfNeeded = () => {
        if (!isMarketingShell()) return false;
        try {
          if (sessionStorage.getItem(loginAttemptKey) === 'true') return false;
          sessionStorage.setItem(loginAttemptKey, 'true');
        } catch (_) {}
        try { location.replace(webLoginURL); } catch (_) {}
        return true;
      };
      const enforceRoute = (notify = false) => {
        const feature = restrictedFeature();
        if (!feature) {
          delete document.documentElement.dataset.vigilSnapchatRestricted;
          return false;
        }
        document.documentElement.dataset.vigilSnapchatRestricted = 'true';
        if (notify) publishUnavailable(feature);
        try { location.replace('/web/'); } catch (_) {}
        return true;
      };

      document.addEventListener('click', (event) => {
        const control = labelledRestrictedControl(event.target);
        if (!control) return;
        const feature = restrictedFeature(control.href || '')
          || (/spotlight/i.test(control.textContent || control.getAttribute('aria-label') || '')
            ? 'Spotlight' : 'Discover');
        event.preventDefault();
        event.stopImmediatePropagation();
        publishUnavailable(feature);
      }, true);

      let reconciliationScheduled = false;
      const reconcile = () => {
        reconciliationScheduled = false;
        if (beginWebLoginIfNeeded()) return;
        if (enforceRoute(true)) return;
        hideRestrictedControls();
      };
      const scheduleReconcile = () => {
        if (reconciliationScheduled) return;
        reconciliationScheduled = true;
        requestAnimationFrame(reconcile);
      };
      for (const name of ['pushState', 'replaceState']) {
        const original = history[name];
        history[name] = function(...args) {
          const result = original.apply(this, args);
          scheduleReconcile();
          return result;
        };
      }
      addEventListener('popstate', scheduleReconcile, true);
      addEventListener('hashchange', scheduleReconcile, true);
      new MutationObserver(scheduleReconcile).observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['href', 'aria-label', 'data-testid']
      });

      const reportHealth = () => {
        const text = String(document.body?.innerText || '').toLowerCase();
        const marketingShell = isMarketingShell();
        const unsupported = marketingShell
          || /browser (isn't|is not) supported|unsupported browser|try another browser|only available on desktop/.test(text);
        window.__vigilBridge?.({
          type: 'health',
          state: unsupported ? 'unsupported' : 'ready',
          detail: unsupported
            ? (marketingShell
              ? 'Snapchat returned its app-download page instead of friend chat after web sign-in.'
              : 'Snapchat rejected its web client in this version of WebKit.')
            : ''
        });
      };
      reconcile();
      reportHealth();
      setTimeout(reportHealth, 1500);
      setTimeout(reportHealth, 8000);
    })();
    """#

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
        html:is([data-vigil-feature-home="blocked"], [data-vigil-feature-home="pending"]) a[href*="/feed/recommended"],
        html:is([data-vigil-feature-suggested="blocked"], [data-vigil-feature-suggested="pending"]) a[href*="/results?search_query=shorts"],
        html:is([data-vigil-feature-suggested="blocked"], [data-vigil-feature-suggested="pending"]) ytm-related-item-section-renderer,
        html:is([data-vigil-feature-suggested="blocked"], [data-vigil-feature-suggested="pending"]) ytm-watch-next-secondary-results-renderer,
        html[data-vigil-youtube-watch="true"]:is([data-vigil-feature-suggested="blocked"], [data-vigil-feature-suggested="pending"]) ytm-single-column-watch-next-results-renderer,
        html[data-vigil-youtube-watch="true"]:is([data-vigil-feature-suggested="blocked"], [data-vigil-feature-suggested="pending"]) ytm-item-section-renderer:has(ytm-video-with-context-renderer),
        html[data-vigil-youtube-watch="true"]:is([data-vigil-feature-suggested="blocked"], [data-vigil-feature-suggested="pending"]) ytm-video-with-context-renderer,
        html:is([data-vigil-feature-ads="blocked"], [data-vigil-feature-ads="pending"]) ytm-promoted-sparkles-web-renderer,
        html:is([data-vigil-feature-ads="blocked"], [data-vigil-feature-ads="pending"]) ytm-companion-ad-renderer,
        html:is([data-vigil-feature-ads="blocked"], [data-vigil-feature-ads="pending"]) ytm-display-ad-renderer,
        html:is([data-vigil-feature-ads="blocked"], [data-vigil-feature-ads="pending"]) ytm-promoted-video-renderer,
        html:is([data-vigil-feature-ads="blocked"], [data-vigil-feature-ads="pending"]) ytm-ad-slot-renderer,
        html:is([data-vigil-feature-ads="blocked"], [data-vigil-feature-ads="pending"]) ytm-in-feed-ad-layout-renderer {
          display: none !important;
        }
        html:is([data-vigil-feature-home="blocked"], [data-vigil-feature-home="pending"])[data-vigil-youtube-home="true"] ytm-rich-grid-renderer,
        html:is([data-vigil-feature-home="blocked"], [data-vigil-feature-home="pending"])[data-vigil-youtube-home="true"] ytm-item-section-renderer,
        html:is([data-vigil-feature-home="blocked"], [data-vigil-feature-home="pending"])[data-vigil-youtube-home="true"] ytm-two-column-browse-results-renderer,
        html[data-vigil-youtube-route-feature="home"]:is([data-vigil-feature-home="blocked"], [data-vigil-feature-home="pending"]) ytm-browse,
        html[data-vigil-youtube-route-feature="home"]:is([data-vigil-feature-home="blocked"], [data-vigil-feature-home="pending"]) main,
        html[data-vigil-youtube-route-feature="home"]:is([data-vigil-feature-home="blocked"], [data-vigil-feature-home="pending"]) [role="main"],
        html[data-vigil-youtube-route-feature="explore"][data-vigil-feature-explore="pending"] body,
        html[data-vigil-youtube-route-feature="suggested"][data-vigil-feature-suggested="pending"] body {
          visibility: hidden !important;
        }
        html[data-vigil-route-policy-blocked] body {
          visibility: hidden !important;
        }
        [data-vigil-hidden-feature], [data-vigil-shorts-hidden] {
          display: none !important;
        }
        a[href^="youtube:"], a[href^="vnd.youtube:"],
        ytm-open-app-button, ytm-app-upsell-dialog-renderer,
        ytm-app-promo-renderer, [data-vigil-native-app-prompt="true"] {
          display: none !important;
        }
      `;
      document.documentElement.appendChild(style);

      const routeFeature = (value) => {
        try {
          const url = new URL(value, location.href);
          if (!['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.hostname.toLowerCase())) return '';
          const path = url.pathname.toLowerCase();
          if (path === '/shorts' || path.startsWith('/shorts/')) return 'shorts';
          if (path === '/feed/explore' || path.startsWith('/feed/explore/')
              || path === '/feed/trending' || path.startsWith('/feed/trending/')) return 'explore';
          if (path === '/feed/recommended' || path.startsWith('/feed/recommended/')) return 'home';
          if (path === '/results'
              && String(url.searchParams.get('search_query') || '').toLowerCase().includes('shorts')) return 'suggested';
          if (path === '/' || path === '') return 'home';
          return '';
        } catch (_) { return ''; }
      };
      const restrictedFeature = (value) => {
        const feature = routeFeature(value);
        if (feature === 'shorts') return feature;
        return feature
          && document.documentElement.getAttribute(`data-vigil-feature-${feature}`) === 'blocked'
          ? feature
          : '';
      };
      const syncRouteFeature = () => {
        const feature = routeFeature(location.href);
        if (feature) document.documentElement.dataset.vigilYoutubeRouteFeature = feature;
        else if (location.pathname === '/' || location.pathname === '') {
          document.documentElement.dataset.vigilYoutubeRouteFeature = 'home';
        }
        else delete document.documentElement.dataset.vigilYoutubeRouteFeature;
      };
      const blockRestrictedNavigation = (event) => {
        const link = event.target?.closest?.('a[href]');
        if (!link) return;
        const feature = restrictedFeature(link.href);
        if (!feature) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (window === window.top) {
          const label = feature === 'shorts' ? 'Shorts' : feature;
          window.__vigilBridge({
            type: 'health',
            state: 'degraded',
            detail: `YouTube ${label} is intentionally unavailable.`
          });
        }
      };
      document.addEventListener('click', blockRestrictedNavigation, true);

      let redirectedPolicyURL = '';
      let lastPolicyRouteURL = location.href;
      let routePolicyCheckScheduled = false;
      let routePolicyNotificationPending = false;
      const enforceRestrictedLocation = () => {
        syncRouteFeature();
        const feature = restrictedFeature(location.href);
        if (!feature) {
          redirectedPolicyURL = '';
          delete document.documentElement.dataset.vigilRoutePolicyBlocked;
          return false;
        }
        document.documentElement.dataset.vigilRoutePolicyBlocked = feature;
        const blockedURL = location.href;
        if (redirectedPolicyURL !== blockedURL) {
          redirectedPolicyURL = blockedURL;
          if (window === window.top) {
            const label = feature === 'shorts' ? 'Shorts' : feature;
            window.__vigilBridge({
              type: 'health',
              state: 'degraded',
              detail: `YouTube ${label} is intentionally unavailable.`
            });
          }
          try { location.replace('/feed/subscriptions'); } catch (_) {}
        }
        return true;
      };
      const processRoutePolicy = (notify = false) => {
        const currentURL = location.href;
        const changed = currentURL !== lastPolicyRouteURL;
        lastPolicyRouteURL = currentURL;
        if (enforceRestrictedLocation()) return;
        if (notify || changed) document.dispatchEvent(new Event('__vigilRouteChanged'));
      };
      const scheduleRoutePolicyCheck = (notify = false) => {
        routePolicyNotificationPending = routePolicyNotificationPending || notify;
        if (routePolicyCheckScheduled) return;
        routePolicyCheckScheduled = true;
        queueMicrotask(() => {
          routePolicyCheckScheduled = false;
          const shouldNotify = routePolicyNotificationPending;
          routePolicyNotificationPending = false;
          processRoutePolicy(shouldNotify);
        });
      };
      const serviceRouteEvent = () => {
        // Navigation-start events may fire before the router updates history,
        // while finish events normally fire afterward. Check both now and once
        // the current event turn settles.
        processRoutePolicy();
        scheduleRoutePolicyCheck();
      };
      for (const name of ['pushState', 'replaceState']) {
        const original = history[name];
        history[name] = function(...args) {
          const result = original.apply(this, args);
          scheduleRoutePolicyCheck(true);
          return result;
        };
      }
      for (const name of [
        'yt-navigate-start', 'yt-navigate-finish', 'yt-navigate-cache',
        'yt-navigate-redirect', 'yt-page-data-updated',
        'state-navigatestart', 'state-navigateend', 'state-navigatecomplete'
      ]) {
        // Window capture sees events targeted at either window or document.
        addEventListener(name, serviceRouteEvent, true);
      }
      addEventListener('popstate', serviceRouteEvent, true);
      addEventListener('hashchange', serviceRouteEvent, true);
      addEventListener('pageshow', serviceRouteEvent, true);
      window.navigation?.addEventListener?.('navigate', () => scheduleRoutePolicyCheck());
      const routePolicyWatchdog = setInterval(() => {
        if (location.href !== lastPolicyRouteURL) scheduleRoutePolicyCheck(true);
      }, 500);
      document.addEventListener('__vigilPolicyFeaturesChanged', () => processRoutePolicy());
      processRoutePolicy();

      // Subframes need the same cached-History/deep-route enforcement, but they
      // must not report page health or install main-document player controls.
      if (window !== window.top) return;

      let attachedVideo = null;
      let attachedVideoKey = '';
      let attachedVideoCleanup = null;
      let lastSavedAt = 0;
      let nextPlaybackVideoID = 1;
      const playbackVideoIDs = new WeakMap();
      const videoKey = (value = location.href) => {
        try {
          const url = new URL(value, location.href);
          const queryKey = String(url.searchParams.get('v') || '').trim();
          if (/^[A-Za-z0-9_-]{1,128}$/.test(queryKey)) return queryKey;
          const routeMatch = url.pathname.match(/^\/(?:live|embed)\/([^/?#]+)/i);
          const routeKey = routeMatch ? decodeURIComponent(routeMatch[1]) : '';
          return /^[A-Za-z0-9_-]{1,128}$/.test(routeKey) ? routeKey : '';
        } catch (_) { return ''; }
      };
      const explicitStartOffset = () => {
        try {
          const url = new URL(location.href);
          const key = ['t', 'start', 'time_continue'].find((name) => url.searchParams.has(name));
          if (!key) return null;
          const value = String(url.searchParams.get(key) || '').trim().toLowerCase();
          if (/^\d+(?:\.\d+)?$/.test(value)) return Number(value);
          const match = value.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
          if (!match) return 0;
          return Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0);
        } catch (_) { return null; }
      };
      const visibleElement = (element) => {
        if (!(element instanceof Element) || !element.isConnected) return false;
        const rect = element.getBoundingClientRect();
        if (rect.width <= 1 || rect.height <= 1) return false;
        let current = element;
        let depth = 0;
        let cumulativeOpacity = 1;
        while (current && depth < 32) {
          if (current.hidden || current.getAttribute('aria-hidden') === 'true') return false;
          const style = getComputedStyle(current);
          if (style.display === 'none' || style.visibility === 'hidden'
              || style.visibility === 'collapse' || style.contentVisibility === 'hidden') return false;
          const opacity = Number.parseFloat(style.opacity || '1');
          cumulativeOpacity *= Number.isFinite(opacity) ? opacity : 1;
          if (cumulativeOpacity <= 0.01) return false;
          const root = current.getRootNode?.();
          current = current.parentElement
            || (root instanceof ShadowRoot && root.host instanceof Element ? root.host : null);
          depth += 1;
        }
        // Extremely deep or cyclic component trees are not credible health
        // evidence; keep the recovery overlay available instead of guessing.
        return !current;
      };
      const mainVideo = () => {
        const candidates = [...document.querySelectorAll('video')].filter((video) => {
          const rect = video.getBoundingClientRect();
          return visibleElement(video) && rect.width >= 120 && rect.height >= 68
            && rect.bottom > 0 && rect.top < innerHeight;
        });
        return candidates.sort((left, right) => {
          const score = (video) => {
            const rect = video.getBoundingClientRect();
            const playerBonus = video.closest(
              'ytm-player, ytd-player, #player-container-id, #player, '
              + '.html5-video-player, ytm-watch, ytd-watch-flexy, [page-subtype="watch"]'
            ) ? 10_000_000 : 0;
            return playerBonus + Math.min(rect.width, innerWidth) * Math.min(rect.height, innerHeight);
          };
          return score(right) - score(left);
        })[0] || null;
      };
      const videoHasActiveAd = (video) => Boolean(
        video?.closest('.ad-showing, .ad-interrupting')
      );
      const savePlayback = (force = false) => {
        const video = attachedVideo;
        const key = attachedVideoKey;
        if (!video || !key || !Number.isFinite(video.currentTime) || video.currentTime < 0.5) return;
        if (videoHasActiveAd(video)) return;
        if (video.dataset.vigilMediaVerdict !== 'safe'
            || document.documentElement.dataset.vigilPageVerdict !== 'safe') return;
        const now = Date.now();
        if (!force && now - lastSavedAt < 4000) return;
        lastSavedAt = now;
        window.__vigilBridge({
          type: 'playback',
          service: 'youtube',
          key,
          position: video.currentTime
        });
      };

      const attachPlayback = () => {
        const video = mainVideo();
        const key = videoKey();
        if (!video || !key) {
          savePlayback(true);
          attachedVideoCleanup?.();
          attachedVideoCleanup = null;
          attachedVideo = null;
          attachedVideoKey = '';
          return;
        }
        if (attachedVideo === video && attachedVideoKey === key) return;
        savePlayback(true);
        attachedVideoCleanup?.();
        attachedVideo = video;
        attachedVideoKey = key;
        lastSavedAt = 0;
        if (!playbackVideoIDs.has(video)) playbackVideoIDs.set(video, nextPlaybackVideoID++);
        const timeupdate = () => savePlayback(false);
        const pause = () => savePlayback(true);
        const ended = () => savePlayback(true);
        video.addEventListener('timeupdate', timeupdate);
        video.addEventListener('pause', pause);
        video.addEventListener('ended', ended);
        attachedVideoCleanup = () => {
          video.removeEventListener('timeupdate', timeupdate);
          video.removeEventListener('pause', pause);
          video.removeEventListener('ended', ended);
        };
        if (explicitStartOffset() === null) {
          window.__vigilBridge({
            type: 'playbackRequest',
            service: 'youtube',
            key,
            binding: `${key}:${playbackVideoIDs.get(video)}`
          });
        }
      };

      window.__vigilRestorePlayback = (key, position) => {
        const restore = () => {
          const video = mainVideo();
          if (!video || videoKey() !== key || explicitStartOffset() !== null
              || !Number.isFinite(position) || position < 2 || videoHasActiveAd(video)) return;
          const apply = () => {
            if (videoHasActiveAd(video)) return;
            // Preserve a position already selected by YouTube's signed-in
            // session rather than racing it with the local fallback.
            if (video.currentTime > 3) return;
            if (!Number.isFinite(video.duration) || position < video.duration - 2) video.currentTime = position;
          };
          if (video.readyState >= 1) apply();
          else video.addEventListener('loadedmetadata', apply, { once: true });
        };
        restore();
        setTimeout(restore, 500);
        setTimeout(restore, 1500);
      };
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') savePlayback(true);
      });
      addEventListener('pagehide', () => savePlayback(true));

      const healthContentSelector = [
        'video', 'ytm-player', 'ytm-rich-item-renderer', 'ytm-video-with-context-renderer',
        'ytm-compact-video-renderer', 'ytm-playlist-video-renderer', 'ytm-channel-renderer',
        'ytm-item-section-renderer', 'ytm-single-column-watch-next-results-renderer'
      ].join(', ');
      const youtubeTopbarSelector = 'ytm-header, ytm-mobile-topbar-renderer, ytm-masthead';
      const youtubeNavigationSelector =
        'ytm-pivot-bar-renderer, ytm-pivot-bar-item-renderer';
      const youtubeWatchSelector =
        'ytm-watch, ytd-watch-flexy, [page-subtype="watch"]';
      const youtubePlayerSelector =
        'ytm-player, ytd-player, #player-container-id, #player';
      const healthVisibilitySelector = `${healthContentSelector}, `
        + `${youtubeTopbarSelector}, ${youtubeNavigationSelector}, `
        + `${youtubeWatchSelector}, ${youtubePlayerSelector}, `
        + 'a[href*="accounts.google.com"], a[href*="ServiceLogin"], a[href*="/signin"]';
      const firstVisibleYouTubeElement = (selector, maximum = 96) => {
        let inspected = 0;
        for (const element of document.querySelectorAll(selector)) {
          inspected += 1;
          if (visibleElement(element)) return element;
          if (inspected >= maximum) break;
        }
        return null;
      };
      const blockingModalVisible = () => [...document.querySelectorAll(
        'ytm-dialog[open], ytm-dialog[opened], tp-yt-paper-dialog[open], tp-yt-paper-dialog[opened], '
        + 'ytm-bottom-sheet-renderer, [role="dialog"]:not([aria-hidden="true"])'
      )].some(visibleElement);
      const youtubeRoute = () => {
        const path = location.pathname.toLowerCase();
        if (path === '/' || path === '') return 'home';
        if (path === '/feed/subscriptions' || path.startsWith('/feed/subscriptions/')) return 'subscriptions';
        if (path === '/results' || path.startsWith('/results/')) return 'search';
        if (path === '/watch' || path.startsWith('/watch/')
            || path.startsWith('/live/') || path.startsWith('/embed/')) return 'watch';
        if (path.startsWith('/feed/you') || path.startsWith('/feed/library')
            || path.startsWith('/feed/history') || path.startsWith('/playlist')) return 'library';
        return 'other';
      };
      let lastSurfaceState = '';
      const reportSurface = () => {
        const route = youtubeRoute();
        const blocksRefresh = route === 'watch' || Boolean(document.fullscreenElement) || blockingModalVisible();
        const refreshEligible = !blocksRefresh && (route === 'home' || route === 'subscriptions');
        document.documentElement.dataset.vigilYoutubeHome = String(route === 'home');
        document.documentElement.dataset.vigilYoutubeWatch = String(route === 'watch');
        const state = JSON.stringify({ route, refreshEligible, blocksRefresh });
        if (state === lastSurfaceState) return;
        lastSurfaceState = state;
        window.__vigilBridge({
          type: 'surface',
          service: 'youtube',
          route,
          refreshEligible,
          blocksRefresh
        });
      };

      let lastHealthState = '';
      let healthTimer = 0;
      let healthRouteKey = '';
      let blankStartedAt = 0;
      const healthTextSignalPattern =
        /disallowed_useragent|this browser or app may not be secure|couldn.t sign you in/;
      const publishHealth = (state, detail = '') => {
        const next = `${state}:${detail}`;
        if (next === lastHealthState) return;
        lastHealthState = next;
        window.__vigilBridge({ type: 'health', state, detail });
      };
      const reportHealth = () => {
        healthTimer = 0;
        const route = youtubeRoute();
        const routeKey = `${route}:${location.pathname}:${location.search}`;
        const now = Date.now();
        if (routeKey !== healthRouteKey) {
          healthRouteKey = routeKey;
          blankStartedAt = now;
        }
        const text = String(document.body?.innerText || '').toLowerCase();
        if (healthTextSignalPattern.test(text)) {
          blankStartedAt = 0;
          publishHealth(
            'unsupported',
            'Google rejected embedded WebKit sign-in. This authentication path is unavailable in the YouTube companion.'
          );
          return;
        }
        const content = route === 'watch'
          ? mainVideo()
            || firstVisibleYouTubeElement(youtubePlayerSelector)
            || firstVisibleYouTubeElement(youtubeWatchSelector)
          : firstVisibleYouTubeElement(healthContentSelector);
        const usableEmptyBrowseShell = (
          route === 'subscriptions'
            || (route === 'home'
              && document.documentElement.getAttribute('data-vigil-feature-home') === 'available')
        )
          && firstVisibleYouTubeElement(youtubeTopbarSelector, 32)
          && firstVisibleYouTubeElement(youtubeNavigationSelector, 48);
        const signIn = firstVisibleYouTubeElement(
          'a[href*="accounts.google.com"], a[href*="ServiceLogin"], a[href*="/signin"]',
          24
        );
        if (content) {
          blankStartedAt = 0;
          publishHealth('ready', '');
          return;
        }
        if (signIn) {
          blankStartedAt = 0;
          publishHealth(
            'degraded',
            'YouTube is signed out. Google may reject embedded WebKit sign-in for this companion.'
          );
          return;
        }
        if (usableEmptyBrowseShell) {
          blankStartedAt = 0;
          publishHealth('ready', '');
          return;
        }
        if (!blankStartedAt) blankStartedAt = now;
        const graceMilliseconds = route === 'watch' ? 6000 : 4500;
        const remaining = graceMilliseconds - (now - blankStartedAt);
        if (remaining > 0) {
          scheduleHealth(Math.min(remaining + 20, 1200));
          return;
        }
        publishHealth(
          'degraded',
          `YouTube has not loaded a usable ${route} surface yet.`
        );
      };
      const scheduleHealth = (delay = 350, restart = false) => {
        if (healthTimer && !restart) return;
        if (healthTimer) clearTimeout(healthTimer);
        healthTimer = setTimeout(reportHealth, delay);
      };

      const elementsWithin = (root, selector) => {
        if (root === document) return [...document.querySelectorAll(selector)];
        if (!(root instanceof Element)) return [];
        return [...(root.matches(selector) ? [root] : []), ...root.querySelectorAll(selector)];
      };
      const reconcile = (requestedRoot = document) => {
        const root = requestedRoot instanceof Element
          ? requestedRoot.closest(
            '[data-vigil-hidden-feature], [data-vigil-shorts-hidden], [data-vigil-native-app-prompt]'
          ) || requestedRoot
          : requestedRoot;
        elementsWithin(
          root,
          '[data-vigil-hidden-feature], [data-vigil-shorts-hidden], [data-vigil-native-app-prompt]'
        )
          .forEach((node) => {
            node.removeAttribute('data-vigil-hidden-feature');
            node.removeAttribute('data-vigil-shorts-hidden');
            node.removeAttribute('data-vigil-native-app-prompt');
          });
        elementsWithin(
          root,
          'a[href^="/shorts"], a[href*="youtube.com/shorts"], ytm-reel-shelf-renderer, '
          + 'ytd-reel-shelf-renderer, ytm-reel-item-renderer, ytd-reel-video-renderer, '
          + 'ytm-shorts-lockup-view-model, ytm-shorts-lockup-view-model-v2, [is-shorts]'
        ).forEach((node) => {
          const container = node.closest(
            'ytm-pivot-bar-item-renderer, ytm-pivot-bar-item, ytd-guide-entry-renderer, [role="tab"]'
          ) || node;
          container.dataset.vigilShortsHidden = 'true';
        });
        elementsWithin(root, 'ytm-pivot-bar-item-renderer, ytm-pivot-bar-item, [role="tab"]').forEach((node) => {
          const label = String(node.textContent || node.getAttribute('aria-label') || '').trim().toLowerCase();
          if (label === 'shorts' || label.startsWith('shorts ')) node.dataset.vigilShortsHidden = 'true';
        });
        if (document.documentElement.getAttribute('data-vigil-feature-explore') !== 'available') {
          elementsWithin(root, 'a[href*="/feed/explore"], a[href*="/feed/trending"]').forEach((node) => {
            const container = node.closest(
              'ytm-pivot-bar-item-renderer, ytm-pivot-bar-item, ytd-guide-entry-renderer, [role="tab"]'
            ) || node;
            container.dataset.vigilHiddenFeature = 'explore';
          });
        }
        if (document.documentElement.getAttribute('data-vigil-feature-ads') !== 'available') {
          elementsWithin(
            root,
            'ytm-promoted-sparkles-web-renderer, ytm-companion-ad-renderer, ytm-display-ad-renderer, '
            + 'ytm-promoted-video-renderer, ytm-ad-slot-renderer, ytm-in-feed-ad-layout-renderer'
          ).forEach((node) => { node.dataset.vigilHiddenFeature = 'ads'; });
        }
        elementsWithin(root, 'button, [role="button"]').forEach((node) => {
          const label = String(node.textContent || node.getAttribute('aria-label') || '').trim().toLowerCase();
          if (label === 'open youtube app' || label === 'switch to the app' || label === 'get the youtube app') {
            const container = node.closest(
              'ytm-app-upsell-dialog-renderer, ytm-app-promo-renderer, ytm-mealbar-promo-renderer'
            ) || node;
            container.dataset.vigilNativeAppPrompt = 'true';
          }
        });
      };
      let reconcileScheduled = false;
      let fullReconcileRequested = false;
      const reconcileRoots = new Set();
      const scheduleReconcile = (root = null, full = false) => {
        if (full) fullReconcileRequested = true;
        if (root instanceof Element) reconcileRoots.add(root);
        if (reconcileScheduled) return;
        reconcileScheduled = true;
        requestAnimationFrame(() => {
          reconcileScheduled = false;
          if (fullReconcileRequested || !reconcileRoots.size) {
            reconcile(document);
          } else {
            [...reconcileRoots].forEach((candidate) => reconcile(candidate));
          }
          fullReconcileRequested = false;
          reconcileRoots.clear();
          attachPlayback();
          reportSurface();
        });
      };
      const observeYouTube = (records) => {
        // A service router can retain the native History method before this
        // adapter installs. URL comparison in the existing bounded observer is
        // the prompt fallback when that cached method bypasses our wrapper.
        if (location.href !== lastPolicyRouteURL) scheduleRoutePolicyCheck();
        let healthRelevant = false;
        let removalObserved = false;
        records.forEach((record) => {
          if (record.type === 'characterData'
              && record.target.parentElement?.closest?.('[data-vigil-instagram-reels-card="true"]')) {
            scheduleReelSurfaceNormalization();
          }
          if (record.type === 'attributes') {
            scheduleReconcile(record.target);
            if (record.target.matches?.(healthVisibilitySelector)
                || record.target.closest?.(healthVisibilitySelector)
                || record.target.querySelector?.(healthVisibilitySelector)) healthRelevant = true;
          }
          record.addedNodes?.forEach((node) => {
            if (node instanceof Element) {
              scheduleReconcile(node);
              if (node.matches(healthVisibilitySelector)
                  || node.querySelector(healthVisibilitySelector)
                  || healthTextSignalPattern.test(
                    String(node.textContent || '').slice(0, 1024).toLowerCase()
                  )) healthRelevant = true;
            } else if (node.parentElement) {
              scheduleReconcile(node.parentElement);
              if (node.parentElement.closest(healthVisibilitySelector)
                  || healthTextSignalPattern.test(
                    String(node.nodeValue || '').slice(0, 1024).toLowerCase()
                  )) healthRelevant = true;
            }
          });
          if (record.removedNodes?.length) {
            healthRelevant = true;
            removalObserved = true;
          }
        });
        if (removalObserved) requestAnimationFrame(() => {
          attachPlayback();
          reportSurface();
        });
        if (healthRelevant) scheduleHealth(450);
      };
      reconcile(document);
      attachPlayback();
      reportSurface();
      new MutationObserver(observeYouTube).observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['href', 'aria-label', 'aria-hidden', 'open', 'hidden', 'class', 'style']
      });
      document.addEventListener('__vigilPolicyFeaturesChanged', () => {
        scheduleReconcile(null, true);
        scheduleHealth(0, true);
      });
      const routeChanged = () => {
        scheduleReconcile(null, true);
        scheduleHealth(300, true);
        setTimeout(() => scheduleHealth(0, true), 2500);
      };
      document.addEventListener('__vigilRouteChanged', routeChanged);
      document.addEventListener('__vigilPageVerdictChanged', (event) => {
        if (event.detail?.verdict !== 'safe') return;
        requestAnimationFrame(() => {
          attachPlayback();
          scheduleHealth(0, true);
        });
      });
      document.addEventListener('fullscreenchange', reportSurface);
      scheduleHealth(750);
      setTimeout(() => scheduleHealth(0, true), 7000);
    })();
    """#

    private static let instagramStable = #"""
    (() => {
      if (window.__vigilInstagramInstalled) return;
      if (!['instagram.com', 'www.instagram.com'].includes(
        String(location.hostname || '').toLowerCase()
      )) return;
      window.__vigilInstagramInstalled = true;

      if (!document.getElementById('vigil-instagram-stable-start-style')) {
        const style = document.createElement('style');
        style.id = 'vigil-instagram-stable-start-style';
        style.textContent = `
          html :is(
            a[href="/reels/"], a[href="/reels"], [aria-label="Reels" i]
          ),
          html
            :is(nav, [role="navigation"]) :is(li, div):has(> :is(a[href="/reels/"], a[href="/reels"])),
          html
            div[data-visualcompletion="ignore-dynamic"] > div:has(> span > div > :is(a[href="/reels/"], a[href="/reels"])),
          html:not([data-vigil-feature-shopping="available"]) :is(
            a[href^="/shop"], a[href^="/shopping"], a[href^="/live"]
          ),
          html[data-vigil-instagram-account-search="true"] :is(main, [role="main"]) :is(
            a[href^="/p/"], a[href^="/reel/"],
            a[href^="/reels/"]:not([href="/reels/"]),
            a[href^="/explore/tags/"], a[href^="/explore/locations/"],
            a[href^="/audio/"], a[href^="/music/"], a[href^="/effects/"]
          ),
          [data-vigil-hidden-feature],
          [data-vigil-instagram-search-discovery="true"],
          [data-vigil-native-app-prompt="true"],
          a[href^="instagram:"] {
            display: none !important;
          }
          html[data-vigil-route-policy-blocked] body {
            visibility: hidden !important;
          }
          html[data-vigil-instagram-home-filter="true"] :is(article, [role="article"]):not(
            nav *, [role="navigation"] *, [role="dialog"] *, [aria-modal="true"] *
          ):not(
            [data-vigil-instagram-home-relationship="friend"]
          ):not([data-vigil-instagram-home-relationship="self"]),
          [data-vigil-instagram-home-relationship]:not(
            [data-vigil-instagram-home-relationship="friend"]
          ):not([data-vigil-instagram-home-relationship="self"]) {
            display: none !important;
          }
          html[data-vigil-instagram-home-filter="true"] a[href^="/stories/"]:not(
            [data-vigil-instagram-story-relationship="friend"]
          ):not(
            [data-vigil-instagram-story-relationship="self"]
          ) {
            visibility: hidden !important;
          }
          html[data-vigil-instagram-home-filter="true"] main
            :is(ul, [role="list"], [aria-label="Stories" i])
            :is(button, [role="button"]):has(img[alt*="profile picture" i]):not(
              article *, nav *, [role="navigation"] *
            ):not([aria-label="Profile" i]):not([aria-label="Your profile" i]):not(
              [data-vigil-instagram-profile-control="true"]
            ):not([aria-label="Your story" i]):not([aria-label="Add to your story" i]):not(
              [data-vigil-instagram-story-relationship="friend"]
            ):not([data-vigil-instagram-story-relationship="self"]) {
            visibility: hidden !important;
          }
          [data-vigil-instagram-story-relationship="pending"] {
            display: none !important;
          }
          [data-vigil-instagram-feed-region="closed"] {
            display: none !important;
            content-visibility: hidden !important;
          }
          [data-vigil-instagram-story-relationship="other"] {
            display: none !important;
          }
          html[data-vigil-instagram-story-gate="pending"] body {
            visibility: hidden !important;
          }
          [data-vigil-instagram-story-relationship="unavailable"] {
            display: none !important;
          }
          [data-vigil-instagram-story-rail="true"] {
            overscroll-behavior-x: none !important;
            scroll-behavior: auto !important;
            scroll-snap-type: none !important;
            overflow-x: auto !important;
            overflow-anchor: none !important;
          }
          [data-vigil-instagram-story-track="true"] {
            display: flex !important;
            flex-flow: row nowrap !important;
            justify-content: flex-start !important;
            gap: 0 !important;
            position: relative !important;
            inset: auto !important;
            transform: none !important;
            translate: none !important;
            margin: 0 !important;
            padding: 0 !important;
            transition: none !important;
          }
          [data-vigil-instagram-story-track="true"]:not([data-vigil-instagram-story-rail="true"]),
          [data-vigil-instagram-story-carrier="true"] {
            width: max-content !important;
            min-width: 0 !important;
            max-width: none !important;
            transform: none !important;
            translate: none !important;
          }
          [data-vigil-instagram-story-track="true"] > :not([data-vigil-instagram-story-slot]) {
            display: none !important;
          }
          [data-vigil-instagram-story-slot] {
            overflow: clip !important;
            position: relative !important;
            inset: auto !important;
            transform: none !important;
            translate: none !important;
            margin: 0 !important;
            flex: 0 0 auto !important;
            order: 0 !important;
            transition: none !important;
          }
          [data-vigil-instagram-story-slot]:not([data-vigil-instagram-story-slot="visible"]) {
            display: none !important;
          }
          html[data-vigil-instagram-home-filter="true"] main [role="progressbar"] {
            display: none !important;
          }
          @media (prefers-color-scheme: dark) {
            html a[href="/"] svg[aria-label="Instagram" i],
            html a[href="/"] svg[aria-label="Instagram" i] * {
              color: #f5f5f5 !important;
              fill: #f5f5f5 !important;
            }
          }
          @media (prefers-color-scheme: light) {
            html a[href="/"] svg[aria-label="Instagram" i],
            html a[href="/"] svg[aria-label="Instagram" i] * {
              color: #050505 !important;
              fill: #050505 !important;
            }
          }
          #vigil-instagram-friends-empty {
            box-sizing: border-box !important;
            position: fixed !important;
            z-index: 2 !important;
            inset: 156px 20px 84px !important;
            display: grid !important;
            place-items: center !important;
            pointer-events: none !important;
            color: inherit !important;
            font: 600 15px/1.45 -apple-system, BlinkMacSystemFont, sans-serif !important;
            text-align: center !important;
          }
          #vigil-instagram-friends-empty > span {
            display: none !important;
            box-sizing: border-box !important;
            max-width: 320px !important;
            padding: 20px 22px !important;
            border: 1px solid rgba(128, 128, 128, .3) !important;
            border-radius: 14px !important;
            background: rgba(128, 128, 128, .08) !important;
          }
          #vigil-instagram-friends-empty[data-vigil-state="empty"] > span {
            display: block !important;
          }
          #vigil-instagram-friends-empty > i {
            width: 24px !important;
            height: 24px !important;
            border: 2.5px solid rgba(128, 128, 128, .28) !important;
            border-top-color: currentColor !important;
            border-radius: 50% !important;
            animation: vigil-instagram-friends-spin .72s linear infinite !important;
          }
          #vigil-instagram-friends-empty[data-vigil-state="empty"] > i {
            display: none !important;
          }
          @keyframes vigil-instagram-friends-spin { to { transform: rotate(360deg); } }
          [data-vigil-instagram-comments-sheet="true"] {
            box-sizing: border-box !important;
            position: fixed !important;
            inset: auto 0 0 0 !important;
            z-index: 2147483644 !important;
            width: 100% !important;
            min-width: 0 !important;
            max-width: none !important;
            height: 52vh !important;
            height: 52dvh !important;
            min-height: 0 !important;
            max-height: 52vh !important;
            max-height: 52dvh !important;
            margin: 0 !important;
            transform: none !important;
            translate: none !important;
            overflow: hidden !important;
            border-radius: 18px 18px 0 0 !important;
          }
          video {
            max-width: 100% !important;
            object-fit: contain !important;
            object-position: center center !important;
            background-color: #000 !important;
          }
        `;
        document.documentElement.appendChild(style);
      }

      const featureForURL = (value = location.href) => {
        try {
          const url = new URL(value, location.href);
          if (!['instagram.com', 'www.instagram.com'].includes(url.hostname.toLowerCase())) return '';
          const path = url.pathname.toLowerCase();
          if (path === '/reels' || path.startsWith('/reels/')) return 'reels';
          if (path === '/explore/people/suggested'
              || path.startsWith('/explore/people/suggested/')) return 'suggested';
          if (/^\/(shop|shopping|live)(\/|$)/.test(path)) return 'shopping';
          return '';
        } catch (_) { return ''; }
      };
      const isAccountSearchRoute = (value = location.href) => {
        try {
          const url = new URL(value, location.href);
          if (!['instagram.com', 'www.instagram.com'].includes(url.hostname.toLowerCase())) return false;
          const path = url.pathname.toLowerCase().replace(/\/+$/, '') || '/';
          return path === '/explore';
        } catch (_) { return false; }
      };
      const isSingularReelRoute = (value = location.href) => {
        try {
          const url = new URL(value, location.href);
          if (!['instagram.com', 'www.instagram.com'].includes(url.hostname.toLowerCase())) return false;
          const path = url.pathname.toLowerCase();
          return path === '/reel' || path.startsWith('/reel/');
        } catch (_) { return false; }
      };
      const isReelsDestinationRoute = (value = location.href) => {
        try {
          const url = new URL(value, location.href);
          if (!['instagram.com', 'www.instagram.com'].includes(url.hostname.toLowerCase())) return false;
          const path = url.pathname.toLowerCase();
          return path === '/reels' || path.startsWith('/reels/');
        } catch (_) { return false; }
      };
      const isDiscoverySearchRoute = (value = location.href) => {
        try {
          const url = new URL(value, location.href);
          if (!['instagram.com', 'www.instagram.com'].includes(url.hostname.toLowerCase())) return false;
          const path = url.pathname.toLowerCase();
          return path.startsWith('/explore/tags/')
            || path.startsWith('/explore/locations/')
            || path.startsWith('/audio/')
            || path.startsWith('/music/')
            || path.startsWith('/effects/');
        } catch (_) { return false; }
      };
      const featureState = (feature) => feature
        ? document.documentElement.getAttribute(`data-vigil-feature-${feature}`) || 'pending'
        : 'available';
      const restrictedFeature = (value) => {
        const feature = featureForURL(value);
        if (feature === 'suggested'
            && featureState('explore') !== 'available') return 'explore';
        return feature && featureState(feature) !== 'available' ? feature : '';
      };
      const publishUnavailable = (feature) => {
        if (!feature || window !== window.top) return;
        window.__vigilBridge?.({
          type: 'health',
          state: 'degraded',
          detail: `That Instagram ${feature} surface is intentionally unavailable.`
        });
      };

      const instagramRoute = () => {
        const path = location.pathname.toLowerCase();
        if (path === '/' || path === '') return 'feed';
        if (path === '/stories' || path.startsWith('/stories/')) return 'story';
        if (path === '/reel' || path.startsWith('/reel/')
            || path === '/reels' || path.startsWith('/reels/')) return 'reels';
        if (path === '/direct/inbox' || path === '/direct/inbox/') return 'directInbox';
        if (path.startsWith('/direct/t/')) return 'directThread';
        if (path === '/accounts/login' || path.startsWith('/accounts/login/')) return 'login';
        if (path === '/challenge' || path.startsWith('/challenge/')
            || path.includes('/challenge/')) return 'challenge';
        if (path === '/p' || path.startsWith('/p/')) return 'post';
        if (path === '/explore' || path.startsWith('/explore/')) return 'search';
        const pieces = path.split('/').filter(Boolean);
        return pieces.length === 1 ? 'profile' : 'other';
      };
      let lastSurface = '';
      const reportSurface = () => {
        if (window !== window.top) return;
        const route = instagramRoute();
        const payload = `${route}:${location.pathname}:${location.search}`;
        if (payload === lastSurface) return;
        lastSurface = payload;
        window.__vigilBridge?.({
          type: 'surface',
          service: 'instagram',
          route,
          refreshEligible: route === 'feed',
          blocksRefresh: route !== 'feed',
          fullBleedTop: false
        });
      };

      const visibleInstagramElement = (element) => {
        if (!(element instanceof Element) || !element.isConnected) return false;
        const style = getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden'
          && element.getClientRects().length > 0;
      };
      const normalizedInstagramLabel = (element) => String(
        element?.getAttribute?.('aria-label') || element?.textContent || ''
      ).replace(/\s+/g, ' ').trim().toLowerCase();
      const commentComposerSelector = [
        'textarea[placeholder*="comment" i]',
        'input[placeholder*="comment" i]',
        '[aria-label*="add a comment" i]'
      ].join(', ');
      const commentDetailSelector = [
        '[data-testid*="comment" i]',
        '[aria-label="Comments" i]',
        '[aria-label^="Comment by" i]',
        '[aria-label^="Reply to" i]'
      ].join(', ');
      const largeVisibleMediaIn = (root) => {
        const viewportWidth = Math.max(1, window.visualViewport?.width || innerWidth || 1);
        const viewportHeight = Math.max(1, window.visualViewport?.height || innerHeight || 1);
        let inspected = 0;
        for (const media of root.querySelectorAll('video, img')) {
          inspected += 1;
          if (visibleInstagramElement(media)) {
            const rect = media.getBoundingClientRect();
            if (rect.width >= Math.min(220, viewportWidth * 0.55)
                && rect.height >= Math.min(280, viewportHeight * 0.34)) return media;
          }
          if (inspected >= 24) break;
        }
        return null;
      };
      const commentHeadingIn = (root) => {
        let inspected = 0;
        for (const heading of root.querySelectorAll('h1, h2, h3, [role="heading"]')) {
          inspected += 1;
          if (normalizedInstagramLabel(heading) === 'comments') return heading;
          if (inspected >= 12) break;
        }
        return null;
      };
      const nestedCommentPanel = (dialog, heading, composer, largeMedia) => {
        if (!heading || !composer || !largeMedia) return null;
        let candidate = heading.parentElement;
        let depth = 0;
        while (candidate && candidate !== dialog && depth < 12) {
          if (candidate.contains(composer) && !candidate.contains(largeMedia)) return candidate;
          candidate = candidate.parentElement;
          depth += 1;
        }
        return null;
      };
      const instagramCommentSheetFor = (dialog) => {
        if (!(dialog instanceof Element) || !visibleInstagramElement(dialog)) return null;
        const ownLabel = normalizedInstagramLabel(dialog);
        const heading = commentHeadingIn(dialog);
        const composer = dialog.querySelector(commentComposerSelector);
        const explicitComments = ownLabel === 'comments' || ownLabel.startsWith('comments ');
        const hasCommentDetails = Boolean(dialog.querySelector(commentDetailSelector));
        if (!explicitComments && !heading && !(composer && hasCommentDetails)) return null;

        // Some post variants put the media and comments inside one full-screen
        // dialog. Pin only the nested comments panel in that case; shrinking the
        // outer dialog would crop the Reel that should continue behind the sheet.
        const largeMedia = largeVisibleMediaIn(dialog);
        if (largeMedia) return nestedCommentPanel(dialog, heading, composer, largeMedia);
        return dialog;
      };
      const isInstagramCommentsDialog = (dialog) => Boolean(instagramCommentSheetFor(dialog));
      let commentPlaybackSnapshot = [];
      let commentPlaybackSnapshotAt = 0;
      let commentPlaybackRestoreFor = 0;
      const commentTrigger = (target) => {
        const control = target?.closest?.('button, a, [role="button"]');
        if (!control) return null;
        const labels = [
          normalizedInstagramLabel(control),
          ...[...control.querySelectorAll('[aria-label]')].slice(0, 8)
            .map(normalizedInstagramLabel)
        ];
        return labels.some((label) => label === 'comment' || label === 'comments'
          || /^view(?: all)?(?: \d+)? comments?$/.test(label)
          || label === 'add a comment') ? control : null;
      };
      const rememberCommentPlayback = (event) => {
        if (!commentTrigger(event.target)) return;
        const now = performance.now();
        const playingMedia = [...document.querySelectorAll('video')].filter((media) => (
          visibleInstagramElement(media) && !media.paused && !media.ended
        ));
        // A physical tap commonly emits touchstart, pointerdown, and click. If
        // Instagram pauses between those events, keep the first event's valid
        // snapshot instead of replacing it with the later paused state.
        if (!playingMedia.length && now - commentPlaybackSnapshotAt < 1200) return;
        commentPlaybackSnapshot = playingMedia;
        commentPlaybackSnapshotAt = now;
      };
      const restoreCommentPlayback = () => {
        if (!document.querySelector('[data-vigil-instagram-comments-sheet="true"]')
            || performance.now() - commentPlaybackSnapshotAt > 1800) return;
        commentPlaybackSnapshot.forEach((media) => {
          if (!media.isConnected || !media.paused || media.ended
              || window.__vigilEarlyMediaGate?.isHeld?.(media)) return;
          try {
            const replay = media.play();
            replay?.catch?.(() => {});
          } catch (_) {}
        });
      };
      const scheduleCommentPlaybackRestore = () => {
        if (!commentPlaybackSnapshotAt
            || commentPlaybackRestoreFor === commentPlaybackSnapshotAt) return;
        commentPlaybackRestoreFor = commentPlaybackSnapshotAt;
        // Instagram variants pause either during dialog insertion or in a
        // shortly delayed React effect. Cover both without owning playback
        // beyond the opening transition.
        [0, 80, 240, 600].forEach((delay) => setTimeout(restoreCommentPlayback, delay));
      };
      const normalizeCommentSheets = () => {
        const activeSheets = new Set();
        let inspected = 0;
        for (const dialog of document.querySelectorAll(
          '[role="dialog"]:not([aria-hidden="true"]), [aria-modal="true"]:not([aria-hidden="true"])'
        )) {
          inspected += 1;
          const sheet = instagramCommentSheetFor(dialog);
          if (sheet) activeSheets.add(sheet);
          if (inspected >= 16) break;
        }
        document.querySelectorAll('[data-vigil-instagram-comments-sheet]').forEach((sheet) => {
          if (!activeSheets.has(sheet)) sheet.removeAttribute('data-vigil-instagram-comments-sheet');
        });
        activeSheets.forEach((sheet) => {
          sheet.dataset.vigilInstagramCommentsSheet = 'true';
        });
        if (activeSheets.size) scheduleCommentPlaybackRestore();
      };
      document.addEventListener('pointerdown', rememberCommentPlayback, true);
      document.addEventListener('touchstart', rememberCommentPlayback, { capture: true, passive: true });
      document.addEventListener('click', rememberCommentPlayback, true);

      let redirectedURL = '';
      let lastURL = location.href;
      let sharedReelPath = '';
      const enforceRoute = () => {
        lastURL = location.href;
        if (isReelsDestinationRoute()) {
          document.documentElement.dataset.vigilRoutePolicyBlocked = 'reels';
          if (redirectedURL !== location.href) {
            redirectedURL = location.href;
            publishUnavailable('reels');
            try { location.replace('/direct/inbox/'); } catch (_) {}
          }
          return;
        }
        if (isSingularReelRoute()) {
          const path = location.pathname.toLowerCase();
          if (!sharedReelPath) sharedReelPath = path;
          document.documentElement.dataset.vigilInstagramSharedReel = 'true';
          if (path !== sharedReelPath) {
            document.documentElement.dataset.vigilRoutePolicyBlocked = 'reels-containment';
            if (redirectedURL !== location.href) {
              redirectedURL = location.href;
              try { location.replace(sharedReelPath); } catch (_) {}
            }
            return;
          }
        } else {
          sharedReelPath = '';
          delete document.documentElement.dataset.vigilInstagramSharedReel;
        }
        if (isDiscoverySearchRoute()) {
          document.documentElement.dataset.vigilRoutePolicyBlocked = 'account-search';
          if (redirectedURL !== location.href) {
            redirectedURL = location.href;
            try { location.replace('/explore/'); } catch (_) {}
          }
          return;
        }
        if (isAccountSearchRoute()) {
          document.documentElement.dataset.vigilInstagramAccountSearch = 'true';
        } else {
          delete document.documentElement.dataset.vigilInstagramAccountSearch;
        }
        const feature = featureForURL();
        if (!feature) {
          redirectedURL = '';
          delete document.documentElement.dataset.vigilRoutePolicyBlocked;
          reportSurface();
          return;
        }
        const state = featureState(feature === 'suggested'
          && featureState('explore') !== 'available' ? 'explore' : feature);
        if (state === 'available') {
          redirectedURL = '';
          delete document.documentElement.dataset.vigilRoutePolicyBlocked;
          reportSurface();
          return;
        }
        document.documentElement.dataset.vigilRoutePolicyBlocked = feature;
        if (state !== 'blocked' || redirectedURL === location.href) return;
        redirectedURL = location.href;
        publishUnavailable(feature);
        try { location.replace('/'); } catch (_) {}
      };
      let routeTransitionGeneration = 0;
      const prepareRouteTransition = (value = location.href, committing = false) => {
        try {
          const url = value === undefined || value === null || value === ''
            ? new URL(location.href)
            : new URL(value, location.href);
          if (!['instagram.com', 'www.instagram.com'].includes(url.hostname.toLowerCase())) return;
          const source = new URL(lastURL || location.href, location.href);
          const routeKey = (candidate) => `${candidate.pathname}${candidate.search}`;
          // Instagram frequently calls replaceState without a URL and emits
          // Navigation API events for touches that never leave the current
          // surface. Treating those as route transitions made the entire body
          // disappear for one or two frames after ordinary taps and swipes.
          if (routeKey(url) === routeKey(source)) return;
          document.documentElement.dataset.vigilInstagramRouteTransition = 'true';
          const path = url.pathname.toLowerCase().replace(/\/+$/, '') || '/';
          const sourcePath = source.pathname.toLowerCase().replace(/\/+$/, '') || '/';
          const sourceIsStory = sourcePath === '/stories' || sourcePath.startsWith('/stories/');
          if (path === '/' && committing) {
            // Set the fail-closed Home marker before Instagram synchronously
            // swaps its SPA tree, not one mutation callback afterward.
            document.documentElement.dataset.vigilInstagramHomeFilter = 'true';
            if (!sourceIsStory) delete document.documentElement.dataset.vigilInstagramStoryGate;
          } else if (path === '/stories' || path.startsWith('/stories/')) {
            // Conceal the Story viewer before Instagram can synchronously swap
            // in the next account during its click or History handler.
            if (!hasKnownStoryAccess(url)) {
              document.documentElement.dataset.vigilInstagramStoryGate = 'pending';
            }
          } else if (!sourceIsStory) {
            delete document.documentElement.dataset.vigilInstagramStoryGate;
          }
          const sourceURL = location.href;
          setTimeout(() => {
            // Instagram sometimes consumes an already-selected navigation link
            // without changing history. Do not strand the current safe surface
            // behind the transition gate when no route swap actually happened.
            if (location.href !== sourceURL) return;
            delete document.documentElement.dataset.vigilInstagramRouteTransition;
            reconcileFriendsFeed();
            void reconcileStoryRoute();
          }, 400);
        } catch (_) {}
      };
      const scheduleRouteCheck = () => {
        const generation = ++routeTransitionGeneration;
        prepareRouteTransition(location.href, true);
        queueMicrotask(() => {
          enforceRoute();
          reconcileFriendsFeed();
          void reconcileStoryRoute();
          requestAnimationFrame(() => requestAnimationFrame(() => {
            if (generation !== routeTransitionGeneration) return;
            delete document.documentElement.dataset.vigilInstagramRouteTransition;
            reconcileFriendsFeed();
          }));
        });
      };
      window.__vigilInstagramPrepareRoute = prepareRouteTransition;
      document.addEventListener('__vigilInstagramHistoryChanged', scheduleRouteCheck);
      // Mobile WebKit preserves CSS hover after a touch. In Direct, Instagram
      // uses that hover to reveal reactions and More, so its first tap can stop
      // at the hover state and require a second tap to activate the underlying
      // conversation or shared item. Activate a short, stationary touch on
      // release; leave a held touch entirely to Instagram's native menu.
      const directActivationSelector = [
        'a[href]',
        'button',
        '[role="button"]',
        '[role="link"]',
        '[tabindex]:not([tabindex="-1"])'
      ].join(', ');
      const directActivationTarget = (target) => {
        const route = instagramRoute();
        if (route !== 'directInbox' && route !== 'directThread') return null;
        if (!(target instanceof Element)
            || target.closest('input, textarea, select, option, [contenteditable="true"]')) return null;
        const activation = target.closest(directActivationSelector);
        if (!(activation instanceof HTMLElement)
            || activation.matches(':disabled, [aria-disabled="true"]')) return null;
        return activation;
      };
      let directTouch = null;
      let directProgrammaticActivation = false;
      let suppressedDirectClick = null;
      const clearDirectTouch = (pointerId = null) => {
        if (directTouch && (pointerId === null || directTouch.pointerId === pointerId)) {
          directTouch = null;
        }
      };
      document.addEventListener('pointerdown', (event) => {
        if (!event.isPrimary || event.pointerType !== 'touch') return;
        const activation = directActivationTarget(event.target);
        directTouch = activation ? {
          activation,
          pointerId: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          startedAt: performance.now()
        } : null;
      }, { capture: true, passive: true });
      document.addEventListener('pointermove', (event) => {
        if (!directTouch || directTouch.pointerId !== event.pointerId) return;
        if (Math.hypot(event.clientX - directTouch.x, event.clientY - directTouch.y) > 14) {
          directTouch = null;
        }
      }, { capture: true, passive: true });
      document.addEventListener('pointercancel', (event) => {
        clearDirectTouch(event.pointerId);
      }, true);
      document.addEventListener('pointerup', (event) => {
        const touch = directTouch;
        clearDirectTouch(event.pointerId);
        if (!touch || touch.pointerId !== event.pointerId
            || Math.hypot(event.clientX - touch.x, event.clientY - touch.y) > 14
            || !touch.activation.isConnected
            || !directActivationTarget(touch.activation)) return;
        suppressedDirectClick = {
          activation: touch.activation,
          x: event.clientX,
          y: event.clientY,
          until: performance.now() + 700
        };
        // A held release may still be followed by WebKit's compatibility
        // click. Consume that click, but do not cancel or stop pointerup: the
        // latter belongs to Instagram's long-press menu lifecycle.
        if (performance.now() - touch.startedAt > 420) return;
        if (event.cancelable) event.preventDefault();
        // Run after Instagram receives pointerup so any pressed/hold state it
        // owns is cleared before the ordinary activation is delivered.
        queueMicrotask(() => {
          if (!touch.activation.isConnected || !directActivationTarget(touch.activation)) return;
          directProgrammaticActivation = true;
          try { touch.activation.click(); } catch (_) {}
          finally { directProgrammaticActivation = false; }
        });
      }, { capture: true, passive: false });
      let storyForwardTouch = null;
      let suppressedStoryForwardClick = null;
      let deliveringStoryForwardClick = false;
      const storyForwardControl = (target, x, y) => {
        if (instagramRoute() !== 'story' || !(target instanceof Element) || !target.isConnected
            || document.documentElement.dataset.vigilInstagramStoryGate === 'pending'
            || !hasKnownStoryAccess(new URL(location.href))) return null;
        const interactive = target.closest('a[href], button, [role="button"], input, textarea, select, [contenteditable="true"]');
        const nextLabel = '[aria-label="Next" i], [aria-label="Next story" i], [aria-label="Next photo" i]';
        if (interactive && !interactive.matches(nextLabel) && !interactive.querySelector(nextLabel)) return null;
        const excluded = '[aria-hidden="true"], [data-vigil-instagram-feed-region], nav';
        const dialog = target.closest('[role="dialog"], [aria-modal="true"]');
        const viewportWidth = Math.max(1, window.visualViewport?.width || innerWidth || 1);
        const viewportHeight = Math.max(1, window.visualViewport?.height || innerHeight || 1);
        let media = null;
        // Start at the actual hit target. A Home post or adjacent preloaded
        // Story can remain in the document behind the foreground viewer.
        for (let root = target, depth = 0; root && depth < 12; root = root.parentElement, depth += 1) {
          if (!media) {
            const candidates = root.matches('video, img') ? [root] : root.querySelectorAll('video, img');
            media = [...candidates].slice(0, 24).find((candidate) => {
              if (!visibleInstagramElement(candidate) || candidate.closest(excluded)) return false;
              const rect = candidate.getBoundingClientRect();
              return rect.width >= Math.min(220, viewportWidth * 0.55)
                && rect.height >= Math.min(280, viewportHeight * 0.34)
                && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
            });
          }
          if (media) {
            const bounds = media.getBoundingClientRect();
            if (x < bounds.left + bounds.width * 0.55 || x > bounds.right
                || y < bounds.top + Math.min(90, bounds.height * 0.18)
                || y > bounds.bottom - Math.min(110, bounds.height * 0.22)) return null;
            for (const labelled of root.querySelectorAll(nextLabel)) {
              const control = labelled.closest('button, [role="button"]') || labelled;
              if (!(control instanceof HTMLElement) || !visibleInstagramElement(control)
                  || control.matches(':disabled, [aria-disabled="true"]') || control.closest(excluded)) continue;
              const rect = control.getBoundingClientRect();
              if (rect.left + rect.width / 2 < bounds.left + bounds.width / 2
                  || rect.left > bounds.right + 60 || rect.bottom < bounds.top || rect.top > bounds.bottom) continue;
              return { control, media };
            }
          }
          if (root === dialog || root === document.body) break;
        }
        return null;
      };
      const storyFrameKey = (media) => [location.href, media?.currentSrc || '',
        media?.getAttribute('src') || '', media?.querySelector('source')?.getAttribute('src') || ''].join('|');
      document.addEventListener('pointerdown', (event) => {
        if (!event.isPrimary || event.pointerType !== 'touch') return;
        const forward = storyForwardControl(event.target, event.clientX, event.clientY);
        storyForwardTouch = forward ? {
          ...forward, pointerId: event.pointerId, target: event.target,
          x: event.clientX, y: event.clientY, startedAt: performance.now(),
          frameKey: storyFrameKey(forward.media)
        } : null;
      }, { capture: true, passive: true });
      document.addEventListener('pointermove', (event) => {
        if (storyForwardTouch?.pointerId === event.pointerId
            && Math.hypot(event.clientX - storyForwardTouch.x, event.clientY - storyForwardTouch.y) > 12) {
          storyForwardTouch = null;
        }
      }, { capture: true, passive: true });
      document.addEventListener('pointercancel', () => { storyForwardTouch = null; }, true);
      document.addEventListener('pointerup', (event) => {
        const touch = storyForwardTouch;
        storyForwardTouch = null;
        if (!touch || touch.pointerId !== event.pointerId || performance.now() - touch.startedAt > 350
            || Math.hypot(event.clientX - touch.x, event.clientY - touch.y) > 12) return;
        suppressedStoryForwardClick = { x: touch.x, y: touch.y, until: performance.now() + 700 };
        if (event.cancelable) event.preventDefault();
        // Let Instagram clear its press-to-pause state first. If pointerup
        // already advanced the viewer, never issue a second advance.
        setTimeout(() => {
          if (!touch.control.isConnected || !touch.media.isConnected
              || storyFrameKey(touch.media) !== touch.frameKey
              || storyForwardControl(touch.target, touch.x, touch.y)?.control !== touch.control) return;
          const rect = touch.control.getBoundingClientRect();
          deliveringStoryForwardClick = true;
          try {
            touch.control.dispatchEvent(new MouseEvent('click', {
              bubbles: true, cancelable: true, view: window,
              clientX: rect.left + rect.width * 0.75, clientY: rect.top + rect.height / 2
            }));
          } finally { deliveringStoryForwardClick = false; }
        }, 40);
      }, { capture: true, passive: false });
      document.addEventListener('click', (event) => {
        const suppressed = suppressedStoryForwardClick;
        if (!deliveringStoryForwardClick && suppressed && performance.now() < suppressed.until
            && Math.hypot(event.clientX - suppressed.x, event.clientY - suppressed.y) <= 24) {
          if (event.cancelable) event.preventDefault();
          event.stopImmediatePropagation();
        }
      }, true);
      document.addEventListener('click', (event) => {
        if (suppressedDirectClick && performance.now() > suppressedDirectClick.until) {
          suppressedDirectClick = null;
        }
        if (suppressedDirectClick && !directProgrammaticActivation) {
          const target = event.target instanceof Element ? event.target : null;
          const activation = suppressedDirectClick.activation;
          const atReleasedPoint = event instanceof MouseEvent
            && Math.hypot(
              event.clientX - suppressedDirectClick.x,
              event.clientY - suppressedDirectClick.y
            ) <= 24;
          if (target && (target === activation
              || activation.contains(target)
              || target.contains(activation)
              || atReleasedPoint)) {
            suppressedDirectClick = null;
            if (event.cancelable) event.preventDefault();
            event.stopImmediatePropagation();
            return;
          }
        }
        const link = event.target?.closest?.('a[href]');
        if (!link) return;
        if (isReelsDestinationRoute(link.href)
            || (sharedReelPath && isSingularReelRoute(link.href)
              && new URL(link.href, location.href).pathname.toLowerCase() !== sharedReelPath)) {
          event.preventDefault();
          event.stopImmediatePropagation();
          publishUnavailable('reels');
          return;
        }
        const feature = restrictedFeature(link.href);
        if (feature) {
          event.preventDefault();
          event.stopImmediatePropagation();
          publishUnavailable(feature);
          return;
        }
        prepareRouteTransition(link.href);
      }, true);
      if (!window.__vigilInstagramEarlyHistoryInstalled) for (const name of ['pushState', 'replaceState']) {
        const original = history[name];
        history[name] = function(...args) {
          prepareRouteTransition(args[2], true);
          const result = original.apply(this, args);
          scheduleRouteCheck();
          return result;
        };
      }
      const historyRouteEvent = () => {
        prepareRouteTransition();
        scheduleRouteCheck();
      };
      addEventListener('popstate', historyRouteEvent, true);
      addEventListener('hashchange', historyRouteEvent, true);
      addEventListener('pageshow', scheduleRouteCheck, true);
      window.navigation?.addEventListener?.('navigate', (event) => {
        prepareRouteTransition(event.destination?.url);
        scheduleRouteCheck();
      });

      const exactLeafLabel = (root, expected) => {
        const expectedLabels = new Set(
          (Array.isArray(expected) ? expected : [expected]).map((value) => String(value).toLowerCase())
        );
        let inspected = 0;
        for (const node of root.querySelectorAll('span, div, a')) {
          inspected += 1;
          if (node.children.length === 0) {
            const label = String(node.textContent || node.getAttribute('aria-label') || '')
              .replace(/\s+/g, ' ').trim().toLowerCase();
            if (expectedLabels.has(label)) return true;
          }
          if (inspected >= 120) break;
        }
        return false;
      };
      const markFilteredCards = (root) => {
        const scope = root instanceof Element ? root : document;
        const candidates = [
          ...(scope.matches?.('article, [data-testid*="suggested" i], [data-testid*="sponsored" i], [data-testid*="ad-container" i]') ? [scope] : []),
          ...scope.querySelectorAll?.('article, [data-testid*="suggested" i], [data-testid*="sponsored" i], [data-testid*="ad-container" i]') || []
        ];
        let inspected = 0;
        for (const candidate of candidates) {
          inspected += 1;
          const card = candidate.closest('article') || candidate;
          if (featureState('suggested') !== 'available'
              && (candidate.matches('[data-testid*="suggested" i]')
                || card.querySelector('a[href*="/explore/people/suggested"]')
                || exactLeafLabel(card, [
                  'suggested for you',
                  'suggested posts',
                  'suggested reels',
                  'because you watched',
                  'because you follow'
                ]))) {
            card.dataset.vigilHiddenFeature = 'suggested';
          } else if (featureState('ads') !== 'available'
              && (candidate.matches('[data-testid*="sponsored" i], [data-testid*="ad-container" i]')
                || exactLeafLabel(card, 'sponsored'))) {
            card.dataset.vigilHiddenFeature = 'ads';
          }
          if (inspected >= 80) break;
        }
      };
      // A normal follow is not proof of a social relationship. Home cards stay
      // fail-closed until Instagram's same-origin relationship data confirms
      // both directions: the viewer follows the author and the author follows
      // the viewer. This is identity-based and deliberately has no item limit.
      const homeCards = () => [...document.querySelectorAll('article, [role="article"]')]
        .filter((card) => !card.closest('nav, [role="navigation"], [role="dialog"], [aria-modal="true"]'));
      const homeCardIdentities = new WeakMap();
      const friendshipCache = new Map();
      const friendshipChecks = new Map();
      const normalizedUsername = (value) => String(value || '').trim().replace(/^@/, '').toLowerCase();
      const viewerID = (() => {
        try {
          return decodeURIComponent(
            document.cookie.match(/(?:^|;\s*)ds_user_id=([^;]+)/)?.[1] || ''
          );
        } catch (_) { return ''; }
      })();
      // A viewer-scoped local cache survives relaunches. If Instagram hides the
      // viewer identity cookie, fall back to this WKWebView session so cached
      // relationships can never cross accounts.
      const friendshipStorage = viewerID ? localStorage : sessionStorage;
      const friendshipCacheKey = `vigil.instagram.mutual-friendships.v1:${viewerID || 'session'}`;
      const friendshipCacheTTL = 6 * 60 * 60 * 1000;
      let friendshipLookupFailed = false;
      let viewerUsername = '';
      const csrfToken = (() => {
        try {
          return decodeURIComponent(
            document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/)?.[1] || ''
          );
        } catch (_) { return ''; }
      })();
      try {
        const saved = JSON.parse(friendshipStorage.getItem(friendshipCacheKey) || '{}');
        const now = Date.now();
        Object.entries(saved).forEach(([username, record]) => {
          if (typeof record?.mutual === 'boolean'
              && Number.isFinite(record?.checkedAt)
              && now - record.checkedAt < friendshipCacheTTL) {
            friendshipCache.set(username, record.mutual);
          }
        });
      } catch (_) {}
      const persistFriendship = (username, mutual) => {
        try {
          const now = Date.now();
          const saved = JSON.parse(friendshipStorage.getItem(friendshipCacheKey) || '{}');
          const fresh = Object.fromEntries(Object.entries(saved).filter(([, record]) => (
            typeof record?.mutual === 'boolean'
            && Number.isFinite(record?.checkedAt)
            && now - record.checkedAt < friendshipCacheTTL
          )));
          fresh[username] = { mutual, checkedAt: now };
          friendshipStorage.setItem(friendshipCacheKey, JSON.stringify(fresh));
        } catch (_) {}
      };
      const homeCardAuthor = (article) => {
        const links = article.querySelectorAll?.('a[href]') || [];
        for (const link of links) {
          let path = '';
          try { path = new URL(link.href, location.href).pathname; } catch (_) { continue; }
          const pieces = path.split('/').filter(Boolean);
          if (pieces.length !== 1) continue;
          const username = normalizedUsername(pieces[0]);
          if (!username || [
            'accounts', 'direct', 'explore', 'reel', 'reels', 'stories'
          ].includes(username)) continue;
          return username;
        }
        return '';
      };
      const relationshipBoolean = (...values) => {
        for (const value of values) {
          if (typeof value === 'boolean') return value;
        }
        return null;
      };
      const relationshipFromUser = (user) => {
        if (!user || typeof user !== 'object') return null;
        const status = user.friendship_status || user.friendship || user;
        const viewerFollows = relationshipBoolean(
          status.following,
          status.is_following,
          user.followed_by_viewer
        );
        const followsViewer = relationshipBoolean(
          status.followed_by,
          status.is_followed_by,
          user.follows_viewer
        );
        if (typeof viewerFollows !== 'boolean' || typeof followsViewer !== 'boolean') return null;
        return viewerFollows && followsViewer;
      };
      const instagramRequestHeaders = () => ({
        Accept: '*/*',
        'X-IG-App-ID': '936619743392459',
        ...(csrfToken ? { 'X-CSRFToken': csrfToken } : {})
      });
      const fetchInstagramJSON = async (path) => {
        const response = await fetch(path, {
          credentials: 'same-origin',
          headers: instagramRequestHeaders()
        });
        if (!response.ok) throw new Error(`Instagram lookup returned ${response.status}`);
        return response.json();
      };
      const fetchMutualFriendship = async (username) => {
        const cached = friendshipCache.get(username);
        if (typeof cached === 'boolean') return cached;
        if (friendshipChecks.has(username)) return friendshipChecks.get(username);
        const check = (async () => {
          for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
              const payload = await fetchInstagramJSON(
                `/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`
              );
              const user = payload?.data?.user || payload?.user;
              if (!user) throw new Error('relationship lookup omitted the user');
              let mutual = relationshipFromUser(user);
              if (mutual === null && user.id) {
                const friendship = await fetchInstagramJSON(
                  `/api/v1/friendships/show/${encodeURIComponent(user.id)}/`
                );
                mutual = relationshipFromUser(friendship);
              }
              if (typeof mutual !== 'boolean') {
                throw new Error('relationship lookup omitted mutual-follow fields');
              }
              friendshipCache.set(username, mutual);
              persistFriendship(username, mutual);
              return mutual;
            } catch (_) {
              if (attempt === 0) {
                await new Promise((resolve) => setTimeout(resolve, 250));
                continue;
              }
            }
          }
          // A transport or schema failure is not evidence that two people are
          // not friends. Keep the surface concealed without poisoning the
          // viewer-scoped cache with a false negative.
          friendshipLookupFailed = true;
          return null;
        })();
        friendshipChecks.set(username, check);
        try { return await check; }
        finally { friendshipChecks.delete(username); }
      };
      let emptyStateTimer = 0;
      let emptyStateSignature = '';
      const removeFriendsState = () => {
        clearTimeout(emptyStateTimer);
        emptyStateTimer = 0;
        emptyStateSignature = '';
        document.getElementById('vigil-instagram-friends-empty')?.remove();
      };
      const renderFriendsState = (mode, force = false) => {
        const stateID = 'vigil-instagram-friends-empty';
        let state = document.getElementById(stateID);
        if (!state) {
          state = document.createElement('div');
          state.id = stateID;
          state.setAttribute('role', 'status');
          state.setAttribute('aria-live', 'polite');
          const spinner = document.createElement('i');
          spinner.setAttribute('aria-hidden', 'true');
          const message = document.createElement('span');
          state.append(spinner, message);
          document.body?.append(state);
        }
        if (!state) return;
        // Once the settled empty result is visible, background pagination may
        // continue checking newly inserted cards without flashing back to a
        // loader. Only removeFriendsState(), called for a verified friend or a
        // route change, may replace that settled result.
        if (!force && state.dataset.vigilState === 'empty' && mode === 'loading') return;
        state.dataset.vigilState = mode;
        state.querySelector('span').textContent = friendshipLookupFailed
          ? 'We could not find anything from friends right now.'
          : 'Nothing from your friends yet.';
      };
      window.__vigilResetFriendsFeedForRefresh = () => {
        if (instagramRoute() !== 'feed') return;
        clearTimeout(emptyStateTimer);
        emptyStateTimer = 0;
        emptyStateSignature = '';
        friendshipLookupFailed = false;
        renderFriendsState('loading', true);
      };
      const scheduleFriendsEmpty = (signature, delay) => {
        if (emptyStateTimer && emptyStateSignature === signature) return;
        clearTimeout(emptyStateTimer);
        emptyStateSignature = signature;
        emptyStateTimer = setTimeout(() => {
          emptyStateTimer = 0;
          if (instagramRoute() !== 'feed') return;
          const articles = homeCards().filter((card) => !card.hasAttribute('data-vigil-hidden-feature'));
          if (articles.some((article) => (
            ['friend', 'self'].includes(article.dataset.vigilInstagramHomeRelationship)
          ))) return;
          if (articles.some((article) => (
            !article.dataset.vigilInstagramHomeRelationship
            || article.dataset.vigilInstagramHomeRelationship === 'pending'
          ))) return;
          renderFriendsState('empty');
        }, delay);
      };
      const reconcileFriendsEmptyState = () => {
        reconcileHomeFeedRegions();
        if (instagramRoute() !== 'feed') {
          removeFriendsState();
          return;
        }
        const articles = homeCards().filter((card) => !card.hasAttribute('data-vigil-hidden-feature'));
        const hasFriend = articles.some((article) => (
          ['friend', 'self'].includes(article.dataset.vigilInstagramHomeRelationship)
        ));
        if (hasFriend) {
          removeFriendsState();
          return;
        }
        const checking = articles.length === 0 || articles.some((article) => (
          !article.dataset.vigilInstagramHomeRelationship
          || article.dataset.vigilInstagramHomeRelationship === 'pending'
        ));
        renderFriendsState('loading');
        if (checking) {
          if (articles.length === 0) scheduleFriendsEmpty('no-articles', 4000);
          else {
            clearTimeout(emptyStateTimer);
            emptyStateTimer = 0;
            emptyStateSignature = '';
          }
          return;
        }
        scheduleFriendsEmpty('checked-articles', 350);
      };
      const classifyHomeCard = (article) => {
        if (!(article instanceof Element) || article.hasAttribute('data-vigil-hidden-feature')) return;
        const username = homeCardAuthor(article);
        if (username && username === discoverViewerUsername()) {
          homeCardIdentities.set(article, username);
          article.dataset.vigilInstagramHomeAuthor = username;
          article.dataset.vigilInstagramHomeRelationship = 'self';
          return;
        }
        if (!username) {
          homeCardIdentities.delete(article);
          delete article.dataset.vigilInstagramHomeAuthor;
          article.dataset.vigilInstagramHomeRelationship = 'other';
          return;
        }
        if (homeCardIdentities.get(article) === username
            && article.dataset.vigilInstagramHomeAuthor === username
            && ['friend', 'other', 'pending', 'unavailable'].includes(
              article.dataset.vigilInstagramHomeRelationship || ''
            )) return;
        article.dataset.vigilInstagramHomeAuthor = username;
        homeCardIdentities.set(article, username);
        article.dataset.vigilInstagramHomeRelationship = 'pending';
        void fetchMutualFriendship(username).then((mutual) => {
          if (!article.isConnected || homeCardAuthor(article) !== username
              || article.dataset.vigilInstagramHomeAuthor !== username) return;
          article.dataset.vigilInstagramHomeRelationship = username === discoverViewerUsername()
            ? 'self'
            : mutual === true ? 'friend' : mutual === false ? 'other' : 'unavailable';
          reconcileFriendsEmptyState();
        });
      };
      const validInstagramUsername = (value) => {
        const username = normalizedUsername(value);
        return /^[a-z0-9._]{1,30}$/.test(username) ? username : '';
      };
      const discoverViewerUsername = () => {
        if (viewerUsername) return viewerUsername;
        const controls = document.querySelectorAll([
          'nav a[href][aria-label*="profile" i]',
          '[role="navigation"] a[href][aria-label*="profile" i]',
          'a[href] svg[aria-label="Profile" i]'
        ].join(', '));
        for (const candidate of controls) {
          const link = candidate instanceof HTMLAnchorElement ? candidate : candidate.closest('a[href]');
          if (!link) continue;
          try {
            const pieces = new URL(link.href, location.href).pathname.split('/').filter(Boolean);
            if (pieces.length !== 1) continue;
            const username = validInstagramUsername(pieces[0]);
            if (username) {
              viewerUsername = username;
              return viewerUsername;
            }
          } catch (_) {}
        }
        return '';
      };
      let viewerUsernameCheck = null;
      const hydrateViewerUsername = () => {
        if (discoverViewerUsername()) return Promise.resolve(viewerUsername);
        if (viewerUsernameCheck) return viewerUsernameCheck;
        viewerUsernameCheck = fetchInstagramJSON('/api/v1/accounts/current_user/?edit=true')
          .then((payload) => {
            const username = validInstagramUsername(
              payload?.user?.username || payload?.username || payload?.data?.user?.username
            );
            if (username) viewerUsername = username;
            return viewerUsername;
          })
          .catch(() => '')
          .finally(() => { viewerUsernameCheck = null; });
        return viewerUsernameCheck;
      };
      const storyAuthor = (control) => {
        if (control instanceof HTMLAnchorElement) {
          try {
            const url = new URL(control.href, location.href);
            const pieces = url.pathname.split('/').filter(Boolean);
            if (pieces[0]?.toLowerCase() === 'stories') {
              const fromPath = validInstagramUsername(pieces[1]);
              if (fromPath) return fromPath;
            }
          } catch (_) {}
        }
        for (const image of control.querySelectorAll('img[alt]')) {
          const alt = String(image.getAttribute('alt') || '').replace(/\s+/g, ' ').trim();
          const possessive = alt.match(/^(.+?)(?:'s|’s) profile picture(?:\b|$)/i);
          if (possessive) {
            const fromPossessive = validInstagramUsername(possessive[1]);
            if (fromPossessive) return fromPossessive;
          }
          const described = alt.match(/^profile picture of ([a-z0-9._]{1,30})(?:\b|$)/i);
          if (described) return validInstagramUsername(described[1]);
        }
        const labels = [
          control.getAttribute('aria-label'),
          ...[...control.querySelectorAll('[aria-label]')].slice(0, 12)
            .map((node) => node.getAttribute('aria-label'))
        ];
        for (const value of labels) {
          const label = String(value || '').replace(/\s+/g, ' ').trim();
          const possessive = label.match(/(?:^|\s)([a-z0-9._]{1,30})(?:'s|’s) story(?:\b|$)/i);
          if (possessive) return validInstagramUsername(possessive[1]);
          const status = label.match(/^([a-z0-9._]{1,30}),? (?:unseen|seen) story(?:\b|$)/i);
          if (status) return validInstagramUsername(status[1]);
        }
        const textCandidates = [control, ...control.querySelectorAll('span, [dir="auto"]')];
        for (const node of textCandidates.slice(0, 24)) {
          const username = validInstagramUsername(
            String(node.textContent || '').replace(/\s+/g, ' ').trim()
          );
          if (username) return username;
        }
        return '';
      };
      const homeStoryItems = new WeakMap();
      const storyItemFor = (control) => {
        const semanticItem = control.closest('li, [role="listitem"]');
        const ownsOnlyThisControl = (candidate) => candidate
          && !candidate.matches('main, nav, header, [role="main"], [role="navigation"], [role="list"]')
          && [...candidate.querySelectorAll('a[href], button, [role="button"]')]
            .every((other) => other === control || control.contains(other));
        if (ownsOnlyThisControl(semanticItem)) return semanticItem;
        // Anonymous trays sometimes put every button directly in one div.
        // Hiding that parent hides the viewer's avatar and all its siblings.
        return ownsOnlyThisControl(control.parentElement) ? control.parentElement : control;
      };
      const clearStoryClassification = (control) => {
        const item = homeStoryItems.get(control);
        if (item) delete item.dataset.vigilInstagramStoryRelationship;
        homeStoryItems.delete(control);
        delete control.dataset.vigilInstagramStoryRelationship;
        delete control.dataset.vigilInstagramStoryAuthor;
        stagedHomeStoryRelationships.delete(control);
      };
      const isOwnStoryControl = (control) => {
        const labels = [
          control.getAttribute('aria-label'),
          control.textContent,
          ...[...control.querySelectorAll('[aria-label]')].slice(0, 12)
            .map((node) => node.getAttribute('aria-label'))
        ].map((value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase());
        const author = storyAuthor(control);
        return Boolean(author && author === discoverViewerUsername())
          || labels.some((label) => label === 'your story'
          || label.startsWith('your story, ')
          || label === 'add to your story'
          || label === 'create story');
      };
      const isProfileControl = (control) => {
        if (control.matches('[aria-label="Profile" i], [aria-label="Your profile" i]')
            || control.querySelector('svg[aria-label="Profile" i]')) return true;
        const link = control.closest('a[href]') || control.querySelector('a[href]');
        if (!link) return false;
        try {
          const path = new URL(link.href, location.href).pathname.split('/').filter(Boolean);
          return path.length === 1 && Boolean(validInstagramUsername(path[0]))
            && !['stories', 'reels', 'reel', 'explore', 'accounts', 'direct'].includes(path[0]);
        } catch (_) { return false; }
      };
      const isStoryControl = (control) => {
        if (control.querySelectorAll('img[alt*="profile picture" i]').length > 1) return false;
        if (isProfileControl(control)) {
          clearStoryClassification(control);
          control.dataset.vigilInstagramProfileControl = 'true';
          return false;
        }
        if (control.matches('a[href^="/stories/"]')) return true;
        const label = [control.getAttribute('aria-label'), control.textContent]
          .map((value) => String(value || '')).join(' ');
        if (/\bstor(?:y|ies)\b/i.test(label)) return true;
        if (control.closest('ul, [role="list"], [aria-label="Stories" i]')) return true;
        let ancestor = control.parentElement;
        for (let depth = 0; ancestor && ancestor !== document.body && depth < 6; depth += 1) {
          if (/auto|scroll/.test(getComputedStyle(ancestor).overflowX)
              && ancestor.querySelectorAll('img[alt*="profile picture" i]').length > 1) return true;
          ancestor = ancestor.parentElement;
        }
        return false;
      };
      const homeStoryControls = () => {
        if (instagramRoute() !== 'feed') return [];
        const controls = [...document.querySelectorAll([
          'a[href^="/stories/"]',
          ':is(main, [role="main"]) button:has(img[alt*="profile picture" i])',
          ':is(main, [role="main"]) [role="button"]:has(img[alt*="profile picture" i])'
        ].join(', '))];
        const stories = controls.filter((control) => !control.closest('article, [role="article"], nav, [role="navigation"]')
          && isStoryControl(control));
        return stories.filter((control) => !stories.some((parent) => (
          parent !== control && parent.contains(control)
        )));
      };
      const stagedHomeStoryRelationships = new WeakMap();
      const storyRailClampFrames = new WeakMap();
      const boundStoryRails = new WeakSet();
      const storyRailResizeObserver = new ResizeObserver((entries) => {
        entries.forEach(({ target }) => {
          const rail = target.closest('[data-vigil-instagram-story-rail="true"]');
          if (rail) scheduleStoryRailClamp(rail);
        });
      });
      const storyRailFor = (controls) => {
        if (controls.length === 0) {
          return document.querySelector('[data-vigil-instagram-story-rail="true"]');
        }
        const firstItem = controls[0] ? storyItemFor(controls[0]) : null;
        let candidate = firstItem?.parentElement || null;
        let measuredFallback = null;
        for (let depth = 0; candidate && candidate !== document.body && depth < 8; depth += 1) {
          if (!controls.every((control) => candidate.contains(control))) {
            candidate = candidate.parentElement;
            continue;
          }
          const style = getComputedStyle(candidate);
          if (/^(auto|scroll)$/.test(style.overflowX)) return candidate;
          if (!measuredFallback && candidate.clientWidth > 0
              && candidate.scrollWidth > candidate.clientWidth + 1) measuredFallback = candidate;
          candidate = candidate.parentElement;
        }
        return measuredFallback;
      };
      const clampStoryRail = (rail) => {
        if (!(rail instanceof HTMLElement) || !rail.isConnected
            || rail.dataset.vigilInstagramStoryRail !== 'true') return;
        const distance = Math.max(0, rail.scrollWidth - rail.clientWidth);
        const rightToLeft = getComputedStyle(rail).direction === 'rtl';
        const minimum = rightToLeft ? -distance : 0;
        const maximum = rightToLeft ? 0 : distance;
        const clamped = Math.min(maximum, Math.max(minimum, rail.scrollLeft));
        if (Math.abs(clamped - rail.scrollLeft) > 0.5) rail.scrollLeft = clamped;
      };
      const scheduleStoryRailClamp = (rail) => {
        if (!(rail instanceof HTMLElement) || storyRailClampFrames.has(rail)) return;
        const frame = requestAnimationFrame(() => {
          storyRailClampFrames.delete(rail);
          clampStoryRail(rail);
        });
        storyRailClampFrames.set(rail, frame);
      };
      const normalizeHomeStoryRail = (controls = homeStoryControls()) => {
        const rail = instagramRoute() === 'feed' ? storyRailFor(controls) : null;
        // Instagram's virtual row retains the width, absolute offsets and
        // spacers of accounts we have hidden. Clamp to a compact layout of
        // real visible slots, not that original (mostly empty) scrollWidth.
        let track = controls[0] ? storyItemFor(controls[0]).parentElement
          : rail?.matches('[data-vigil-instagram-story-track="true"]') ? rail
          : rail?.querySelector('[data-vigil-instagram-story-track="true"]');
        while (track && track !== rail && !controls.every((control) => track.contains(control))) {
          track = track.parentElement;
        }
        if (!(rail instanceof HTMLElement) || !track || !rail.contains(track)
            || track.matches('main, [role="main"], nav, [role="navigation"]')
            || track.querySelector('article, [role="article"]')) track = null;
        const slots = new Map();
        if (track) {
          for (const control of controls) {
            let slot = control;
            while (slot.parentElement && slot.parentElement !== track) slot = slot.parentElement;
            if (slot.parentElement !== track) continue;
            const visible = ['self', 'friend'].includes(control.dataset.vigilInstagramStoryRelationship);
            slots.set(slot, slots.get(slot) === 'visible' || visible ? 'visible' : 'hidden');
          }
          // A profile shortcut inside a tray is always kept. Never compact a
          // shared container that also owns unrelated navigation/actions.
          for (const control of track.querySelectorAll('a[href], button, [role="button"]')) {
            if (controls.some((story) => story === control || story.contains(control) || control.contains(story))) continue;
            if (!isProfileControl(control)) { track = null; break; }
            let slot = control;
            while (slot.parentElement && slot.parentElement !== track) slot = slot.parentElement;
            slots.set(slot, 'visible');
          }
        }
        document.querySelectorAll('[data-vigil-instagram-story-track="true"]').forEach((candidate) => {
          if (candidate !== track) {
            candidate.removeAttribute('data-vigil-instagram-story-track');
            storyRailResizeObserver.unobserve(candidate);
          }
        });
        document.querySelectorAll('[data-vigil-instagram-story-slot]').forEach((candidate) => {
          if (!track || !slots.has(candidate)) candidate.removeAttribute('data-vigil-instagram-story-slot');
        });
        const carriers = new Set();
        for (let carrier = track?.parentElement; carrier && carrier !== rail && rail?.contains(carrier);
            carrier = carrier.parentElement) carriers.add(carrier);
        document.querySelectorAll('[data-vigil-instagram-story-carrier="true"]').forEach((candidate) => {
          if (!carriers.has(candidate)) candidate.removeAttribute('data-vigil-instagram-story-carrier');
        });
        carriers.forEach((carrier) => { carrier.dataset.vigilInstagramStoryCarrier = 'true'; });
        if (track) {
          slots.forEach((state, slot) => { slot.dataset.vigilInstagramStorySlot = state; });
          if (track.dataset.vigilInstagramStoryTrack !== 'true') {
            track.dataset.vigilInstagramStoryTrack = 'true';
            storyRailResizeObserver.observe(track);
          }
        }
        document.querySelectorAll('[data-vigil-instagram-story-rail="true"]')
          .forEach((candidate) => {
            if (candidate !== rail) {
              candidate.removeAttribute('data-vigil-instagram-story-rail');
              storyRailResizeObserver.unobserve(candidate);
            }
          });
        if (!(rail instanceof HTMLElement)) return;
        rail.dataset.vigilInstagramStoryRail = 'true';
        if (!boundStoryRails.has(rail)) {
          boundStoryRails.add(rail);
          rail.addEventListener('scroll', () => scheduleStoryRailClamp(rail), { passive: true });
        }
        storyRailResizeObserver.observe(rail);
        // Reset an old offset in the same task as slot removal, before paint.
        clampStoryRail(rail);
      };
      const flushHomeStoryRelationships = () => {
        if (instagramRoute() !== 'feed') return false;
        const controls = homeStoryControls();
        rememberHomeStoryOrder(controls);
        const unresolved = controls.some((control) => {
          const relationship = control.dataset.vigilInstagramStoryRelationship || '';
          if (['self', 'friend', 'other', 'unavailable'].includes(relationship)) return false;
          return !stagedHomeStoryRelationships.has(control);
        });
        if (unresolved) {
          normalizeHomeStoryRail(controls);
          return false;
        }
        controls.forEach((control) => {
          const staged = stagedHomeStoryRelationships.get(control);
          if (!staged || storyAuthor(control) !== staged.username) return;
          const item = storyItemFor(control);
          control.dataset.vigilInstagramStoryRelationship = staged.relationship;
          item.dataset.vigilInstagramStoryRelationship = staged.relationship;
          stagedHomeStoryRelationships.delete(control);
        });
        // Commit a tray's relationship results in one task. Incrementally
        // collapsing cards as network requests returned made the remaining
        // Stories jump and cut in and out underneath an active swipe.
        normalizeHomeStoryRail(controls);
        removeStoryPlaceholders();
        return true;
      };
      const classifyHomeStory = (control) => {
        if (!(control instanceof Element) || instagramRoute() !== 'feed') return;
        const item = storyItemFor(control);
        const previousItem = homeStoryItems.get(control);
        if (previousItem && previousItem !== item) delete previousItem.dataset.vigilInstagramStoryRelationship;
        homeStoryItems.set(control, item);
        if (isOwnStoryControl(control)) {
          stagedHomeStoryRelationships.delete(control);
          control.dataset.vigilInstagramStoryAuthor = storyAuthor(control);
          control.dataset.vigilInstagramStoryRelationship = 'self';
          item.dataset.vigilInstagramStoryRelationship = 'self';
          return;
        }
        const username = storyAuthor(control);
        if (control.dataset.vigilInstagramStoryAuthor === username
            && ['friend', 'other', 'pending', 'unavailable'].includes(
              control.dataset.vigilInstagramStoryRelationship || ''
            )) return;
        control.dataset.vigilInstagramStoryAuthor = username;
        stagedHomeStoryRelationships.delete(control);
        if (!username) {
          control.dataset.vigilInstagramStoryRelationship = 'pending';
          item.dataset.vigilInstagramStoryRelationship = 'pending';
          stagedHomeStoryRelationships.set(control, { username: '', relationship: 'other' });
          queueMicrotask(flushHomeStoryRelationships);
          return;
        }
        control.dataset.vigilInstagramStoryRelationship = 'pending';
        item.dataset.vigilInstagramStoryRelationship = 'pending';
        void fetchMutualFriendship(username).then((mutual) => {
          if (!control.isConnected || storyAuthor(control) !== username
              || control.dataset.vigilInstagramStoryAuthor !== username) return;
          const relationship = isOwnStoryControl(control)
            ? 'self'
            : mutual === true ? 'friend' : mutual === false ? 'other' : 'unavailable';
          stagedHomeStoryRelationships.set(control, { username, relationship });
          flushHomeStoryRelationships();
        });
      };
      const removeStoryPlaceholders = () => {
        document.querySelectorAll('[data-vigil-instagram-story-placeholders="true"]')
          .forEach((element) => element.remove());
      };
      const hasKnownStoryAccess = (url) => {
        const parts = url.pathname.toLowerCase().split('/').filter(Boolean);
        if (parts[0] !== 'stories') return false;
        const username = validInstagramUsername(parts[1]);
        return Boolean(username) && (username === discoverViewerUsername()
          || friendshipCache.get(username) === true);
      };
      const storyOrderKey = `${friendshipCacheKey}:story-order`;
      const readStoryOrder = () => {
        try {
          const saved = JSON.parse(sessionStorage.getItem(storyOrderKey) || 'null');
          if (!saved || !discoverViewerUsername() || saved.viewer !== discoverViewerUsername()
              || !Number.isFinite(saved.savedAt) || Date.now() - saved.savedAt > 30 * 60 * 1000
              || !Array.isArray(saved.order)
              || !saved.order.every((username) => username && validInstagramUsername(username) === username)) return null;
          return saved;
        } catch (_) { return null; }
      };
      const saveStoryOrder = (saved) => {
        try { sessionStorage.setItem(storyOrderKey, JSON.stringify(saved)); } catch (_) {}
      };
      const rememberHomeStoryOrder = (controls) => {
        const viewer = discoverViewerUsername();
        if (!viewer || !controls.length) return;
        const saved = readStoryOrder();
        const order = [...new Set([...(saved?.order || []), ...controls.map(storyAuthor).filter(Boolean)])];
        if (!order.length) return;
        if (saved && !saved.active && JSON.stringify(saved.order) === JSON.stringify(order)) return;
        // Keep the original account order, including filtered slots, separately
        // from its compact visual layout. A native Next tap still visits those
        // accounts; it must skip them rather than close the entire viewer.
        saveStoryOrder({ viewer, order, active: '', savedAt: Date.now() });
      };
      const rememberVerifiedStory = (path) => {
        if (!discoverViewerUsername()) {
          // A full-document Story link has no Home profile navigation from
          // which to recover the viewer. Resolve it without reblanking an
          // already-verified Story, then retain this traversal position.
          void hydrateViewerUsername().then((viewer) => {
            if (viewer && verifiedStoryPath === path && instagramRoute() === 'story') {
              rememberVerifiedStory(path);
            }
          });
          return;
        }
        const saved = readStoryOrder();
        const username = validInstagramUsername(path.split('/').filter(Boolean)[1]);
        if (!saved || !saved.order.includes(username) || saved.active === username) return;
        saved.active = username;
        saveStoryOrder(saved);
      };
      const nextVerifiedStoryPath = (username) => {
        const saved = readStoryOrder();
        if (!saved) return '';
        const current = saved.order.indexOf(username);
        const previous = saved.order.indexOf(saved.active);
        if (current < 0 || previous < 0 || current === previous) return '';
        const direction = current < previous ? -1 : 1;
        for (let index = current + direction; index >= 0 && index < saved.order.length; index += direction) {
          const path = `/stories/${saved.order[index]}/`;
          // Sequence membership is never permission. Only the existing
          // viewer-scoped mutual-friend verifier can authorize a destination.
          if (hasKnownStoryAccess(new URL(path, location.href))) return path;
        }
        return '';
      };
      const reconcileHomeFeedRegions = () => {
        const previous = [...document.querySelectorAll('[data-vigil-instagram-feed-region]')];
        if (instagramRoute() !== 'feed') {
          previous.forEach((region) => region.removeAttribute('data-vigil-instagram-feed-region'));
          return;
        }
        const cards = homeCards();
        const protectedControls = [...homeStoryControls(), ...document.querySelectorAll([
          'nav', '[role="navigation"]', 'header', 'footer', '[role="dialog"]', '[aria-modal="true"]',
          '[aria-label="Profile" i]', '[aria-label="Your profile" i]',
          '#vigil-instagram-friends-empty'
        ].join(', '))].filter((control) => !control.closest('article, [role="article"]'));
        const safeRegion = (region) => region instanceof HTMLElement
          && !region.matches('html, body, main, [role="main"], article, [role="article"]')
          && !protectedControls.some((control) => region === control || region.contains(control));
        // Keep the enclosing stream closed even when Instagram temporarily
        // replaces articles with divs/spacers during virtualized scrolling.
        // Hiding only the articles left a tall, composited empty scroll area.
        const regions = new Set(previous.filter(safeRegion));
        cards.forEach((card) => {
          let candidate = card.parentElement;
          let region = null;
          for (let depth = 0; candidate && depth < 8 && safeRegion(candidate); depth += 1) {
            region = candidate;
            candidate = candidate.parentElement;
          }
          if (region) regions.add(region);
        });
        previous.forEach((region) => {
          if (!regions.has(region)) region.removeAttribute('data-vigil-instagram-feed-region');
        });
        regions.forEach((region) => {
          const hasVerifiedPost = cards.some((card) => region.contains(card)
            && !card.hasAttribute('data-vigil-hidden-feature')
            && ['friend', 'self'].includes(card.dataset.vigilInstagramHomeRelationship)
            && homeCardIdentities.get(card) === homeCardAuthor(card));
          region.dataset.vigilInstagramFeedRegion = hasVerifiedPost ? 'open' : 'closed';
        });
      };
      let verifiedStoryPath = '';
      let redirectedStoryPath = '';
      let storyAccessGeneration = 0;
      const reconcileStoryRoute = async () => {
        let path = '';
        try { path = new URL(location.href).pathname.toLowerCase(); } catch (_) {}
        if (!(path === '/stories' || path.startsWith('/stories/'))) {
          storyAccessGeneration += 1;
          verifiedStoryPath = '';
          redirectedStoryPath = '';
          delete document.documentElement.dataset.vigilInstagramStoryGate;
          return;
        }
        if (verifiedStoryPath === path
            && document.documentElement.dataset.vigilInstagramStoryGate !== 'pending') return;
        if (hasKnownStoryAccess(new URL(location.href))) {
          storyAccessGeneration += 1;
          redirectedStoryPath = '';
          verifiedStoryPath = path;
          rememberVerifiedStory(path);
          delete document.documentElement.dataset.vigilInstagramStoryGate;
          return;
        }
        if (redirectedStoryPath === path) return;
        const username = validInstagramUsername(path.split('/').filter(Boolean)[1]);
        document.documentElement.dataset.vigilInstagramStoryGate = 'pending';
        const generation = ++storyAccessGeneration;
        const ownUsername = discoverViewerUsername() || await hydrateViewerUsername();
        const mutual = username && username !== ownUsername
          ? await fetchMutualFriendship(username)
          : Boolean(username && username === ownUsername);
        let currentPath = '';
        try { currentPath = new URL(location.href).pathname.toLowerCase(); } catch (_) {}
        if (generation !== storyAccessGeneration || currentPath !== path) return;
        if (mutual === true) {
          redirectedStoryPath = '';
          verifiedStoryPath = path;
          rememberVerifiedStory(path);
          delete document.documentElement.dataset.vigilInstagramStoryGate;
          return;
        }
        const nextPath = nextVerifiedStoryPath(username);
        redirectedStoryPath = path;
        try { location.replace(nextPath || '/'); } catch (_) {}
      };
      const reconcileFriendsFeed = () => {
        const isFeed = instagramRoute() === 'feed';
        if (!isFeed) {
          // Classified Home cards remain fail-closed on the nodes themselves
          // until Instagram replaces them. Removing only the route flag used
          // to reveal the old feed during every delayed destination render.
          delete document.documentElement.dataset.vigilInstagramHomeFilter;
          if (instagramRoute() === 'profile') {
            document.querySelectorAll('[data-vigil-instagram-story-relationship]')
              .forEach((control) => {
                if (isProfileControl(control)) clearStoryClassification(control);
              });
            const username = validInstagramUsername(location.pathname.split('/').filter(Boolean)[0]);
            homeCards().filter((card) => card.hasAttribute('data-vigil-instagram-home-relationship'))
              .forEach((article) => {
                if (username && homeCardAuthor(article) === username) {
                  delete article.dataset.vigilInstagramHomeRelationship;
                  delete article.dataset.vigilInstagramHomeAuthor;
                }
              });
          }
          removeFriendsState();
          removeStoryPlaceholders();
          normalizeHomeStoryRail([]);
          reconcileHomeFeedRegions();
          return;
        }
        document.documentElement.dataset.vigilInstagramHomeFilter = 'true';
        void hydrateViewerUsername().then(() => {
          // A slow identity request may finish after the user opens Profile.
          // Never run Home's avatar classifier against that destination tree.
          if (instagramRoute() !== 'feed') return;
          const controls = homeStoryControls();
          controls.forEach(classifyHomeStory);
          flushHomeStoryRelationships();
          homeCards().forEach(classifyHomeCard);
          reconcileFriendsEmptyState();
          removeStoryPlaceholders();
        });
        const controls = homeStoryControls();
        controls.forEach(classifyHomeStory);
        flushHomeStoryRelationships();
        homeCards().forEach(classifyHomeCard);
        removeStoryPlaceholders();
        normalizeHomeStoryRail(controls);
        reconcileFriendsEmptyState();
      };
      const markNativeAppPrompts = (root) => {
        const scope = root instanceof Element ? root : document;
        const controls = [
          ...(scope.matches?.('a, button, [role="button"]') ? [scope] : []),
          ...scope.querySelectorAll?.('a, button, [role="button"]') || []
        ];
        for (const control of controls.slice(0, 120)) {
          const label = String(control.textContent || control.getAttribute('aria-label') || '')
            .replace(/\s+/g, ' ').trim().toLowerCase();
          if (label === 'open instagram' || label === 'get the instagram app'
              || label === 'download the app') {
            control.dataset.vigilNativeAppPrompt = 'true';
          }
        }
      };
      const searchDiscoveryPath = (value) => {
        try {
          const url = new URL(value, location.href);
          if (!['instagram.com', 'www.instagram.com'].includes(url.hostname.toLowerCase())) return false;
          const path = url.pathname.toLowerCase();
          return path === '/p' || path.startsWith('/p/')
            || path === '/reel' || path.startsWith('/reel/')
            || (path.startsWith('/reels/') && path !== '/reels/')
            || path.startsWith('/explore/tags/')
            || path.startsWith('/explore/locations/')
            || path === '/audio' || path.startsWith('/audio/')
            || path === '/music' || path.startsWith('/music/')
            || path === '/effects' || path.startsWith('/effects/');
        } catch (_) { return false; }
      };
      const markAccountOnlySearch = (root) => {
        if (!isAccountSearchRoute()) return;
        const scope = root instanceof Element ? root : document;
        const links = [
          ...(scope.matches?.('a[href]') ? [scope] : []),
          ...scope.querySelectorAll?.('a[href]') || []
        ];
        for (const link of links.slice(0, 240)) {
          if (link.closest('nav, [role="navigation"]')) continue;
          if (searchDiscoveryPath(link.href)) {
            link.dataset.vigilInstagramSearchDiscovery = 'true';
          }
        }
        const categoryLabels = new Set([
          'for you', 'top', 'posts', 'photos', 'videos', 'reels',
          'tags', 'hashtags', 'audio', 'music', 'sounds', 'places'
        ]);
        const controls = [
          ...(scope.matches?.('button, [role="tab"]') ? [scope] : []),
          ...scope.querySelectorAll?.('button, [role="tab"]') || []
        ];
        for (const control of controls.slice(0, 120)) {
          if (control.closest('nav, [role="navigation"]')) continue;
          const label = String(control.textContent || control.getAttribute('aria-label') || '')
            .replace(/\s+/g, ' ').trim().toLowerCase();
          if (categoryLabels.has(label)) {
            control.dataset.vigilInstagramSearchDiscovery = 'true';
          }
        }
      };
      let scanScheduled = false;
      const pendingRoots = new Set();
      const scheduleScan = (root = document) => {
        if (root instanceof Element) pendingRoots.add(root);
        if (scanScheduled) return;
        scanScheduled = true;
        queueMicrotask(() => {
          scanScheduled = false;
          const roots = pendingRoots.size ? [...pendingRoots] : [document];
          pendingRoots.clear();
          roots.slice(0, 24).forEach((candidate) => {
            markFilteredCards(candidate);
            markNativeAppPrompts(candidate);
            markAccountOnlySearch(candidate);
          });
          normalizeCommentSheets();
          reconcileFriendsFeed();
        });
      };
      new MutationObserver((records) => {
        records.forEach((record) => {
          if (record.type === 'attributes') scheduleScan(record.target);
          if (record.type === 'characterData') scheduleScan(record.target.parentElement);
          if ([...record.removedNodes].some((node) => node instanceof Element)) scheduleScan(record.target);
          record.addedNodes.forEach((node) => {
            if (node instanceof Element) scheduleScan(node);
          });
        });
        if (location.href !== lastURL) scheduleRouteCheck();
      }).observe(document.documentElement, {
        childList: true, subtree: true, attributes: true, characterData: true,
        attributeFilter: ['href', 'aria-label', 'alt', 'role']
      });
      document.addEventListener('__vigilPolicyFeaturesChanged', () => {
        document.querySelectorAll('[data-vigil-hidden-feature]').forEach((card) => {
          const feature = card.getAttribute('data-vigil-hidden-feature');
          if (feature && featureState(feature) === 'available') {
            card.removeAttribute('data-vigil-hidden-feature');
          }
        });
        scheduleScan();
        enforceRoute();
      });
      setInterval(() => {
        if (location.href !== lastURL) {
          enforceRoute();
          reconcileFriendsFeed();
        }
      }, 1000);

      markFilteredCards(document);
      markNativeAppPrompts(document);
      markAccountOnlySearch(document);
      normalizeCommentSheets();
      reconcileFriendsFeed();
      void reconcileStoryRoute();
      enforceRoute();
      // Reel media embedded in followed posts, profiles, and Direct threads is
      // left alone. A singular /reel/{id} shared item can open, but navigation
      // from it into another Reel is contained and the /reels destination is
      // permanently unavailable.
      if (window === window.top) {
        window.__vigilBridge?.({ type: 'health', state: 'ready', detail: '' });
      }
    })();
    """#

    // Retained temporarily as a non-production reference while the stable
    // adapter proves out on the physical phone. Production routes through
    // `instagramStable` above.
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
        html[data-vigil-route-policy-blocked] body {
          visibility: hidden !important;
        }
        [data-vigil-hidden-feature],
        [data-vigil-native-app-prompt="true"],
        a[href^="instagram:"] {
          display: none !important;
        }
        [data-vigil-instagram-comments-sheet="true"] {
          position: fixed !important;
          inset: auto 0 0 0 !important;
          width: 100% !important;
          min-width: 0 !important;
          max-width: none !important;
          height: 52vh !important;
          height: 52dvh !important;
          min-height: 0 !important;
          max-height: 52vh !important;
          max-height: 52dvh !important;
          margin: 0 !important;
          transform: none !important;
          overflow: hidden !important;
          border-radius: 18px 18px 0 0 !important;
        }
        html[data-vigil-instagram-route-feature="reels"] [data-vigil-instagram-reels-metadata="true"] {
          pointer-events: auto !important;
        }
        html[data-vigil-instagram-route-feature="reels"] [data-vigil-instagram-reels-scroll="true"] {
          /* Let WebKit keep native touch momentum, but give it one unambiguous
             vertical paging contract. No JavaScript scroll correction runs
             during a gesture. */
          scroll-behavior: auto !important;
          scroll-snap-type: y mandatory !important;
          overscroll-behavior-y: contain !important;
          overflow-anchor: none !important;
          -webkit-overflow-scrolling: touch !important;
        }
        html[data-vigil-instagram-route-feature="reels"] [data-vigil-instagram-reels-card="true"] {
          scroll-snap-align: start !important;
          scroll-snap-stop: always !important;
          overflow-anchor: none !important;
        }
        html[data-vigil-instagram-route-feature="reels"] :is(
          [aria-label="Mute" i], [aria-label="Unmute" i]
        ) {
          pointer-events: auto !important;
        }
        html[data-vigil-instagram-route-feature="reels"] [data-vigil-instagram-reels-metadata-clearance="true"] {
          translate:
            var(--vigil-instagram-reels-authored-translate-x, 0px)
            calc(
              var(--vigil-instagram-reels-authored-translate-y, 0px)
              + var(--vigil-instagram-reels-metadata-offset, 0px)
            ) !important;
        }
        [data-vigil-instagram-repost-proxy="true"] {
          display: flex !important;
          flex: 0 0 auto !important;
          width: 52px !important;
          min-width: 52px !important;
          height: 62px !important;
          min-height: 62px !important;
          margin: 0 !important;
          padding: 0 !important;
          align-items: center !important;
          justify-content: center !important;
          overflow: visible !important;
          pointer-events: auto !important;
        }
        [data-vigil-instagram-repost-proxy="true"] > button {
          appearance: none !important;
          -webkit-appearance: none !important;
          display: grid !important;
          place-items: center !important;
          box-sizing: border-box !important;
          width: 48px !important;
          height: 48px !important;
          margin: 0 !important;
          padding: 10px !important;
          border: 0 !important;
          border-radius: 999px !important;
          background: transparent !important;
          color: white !important;
          filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.52)) !important;
          pointer-events: auto !important;
        }
        [data-vigil-instagram-repost-proxy="true"] svg {
          display: block !important;
          width: 28px !important;
          height: 28px !important;
          overflow: visible !important;
          fill: none !important;
          stroke: currentColor !important;
          stroke-width: 2.15 !important;
          stroke-linecap: round !important;
          stroke-linejoin: round !important;
          pointer-events: none !important;
        }
        [data-vigil-instagram-repost-proxy="true"][data-vigil-reposted="true"] > button {
          color: rgb(0, 200, 83) !important;
        }
        [data-vigil-instagram-action-feedback="true"] {
          position: fixed !important;
          z-index: 2147483646 !important;
          left: 50% !important;
          bottom: max(calc(env(safe-area-inset-bottom) + 96px), 104px) !important;
          translate: -50% 0 !important;
          max-width: min(82vw, 340px) !important;
          padding: 9px 14px !important;
          border-radius: 999px !important;
          background: rgba(0, 0, 0, 0.72) !important;
          color: white !important;
          font: 600 14px/1.25 -apple-system, BlinkMacSystemFont, sans-serif !important;
          text-align: center !important;
          pointer-events: none !important;
        }
        [data-vigil-instagram-reels-speed-feedback="true"] {
          position: fixed !important;
          z-index: 2147483646 !important;
          bottom: var(
            --vigil-instagram-reels-speed-feedback-bottom,
            max(calc(env(safe-area-inset-bottom) + 96px), 104px)
          ) !important;
          left: 50% !important;
          translate: -50% 0 !important;
          min-width: 66px !important;
          padding: 8px 14px !important;
          border-radius: 999px !important;
          background: rgba(0, 0, 0, 0.62) !important;
          color: white !important;
          font: 700 17px/1 -apple-system, BlinkMacSystemFont, sans-serif !important;
          letter-spacing: 0.01em !important;
          text-align: center !important;
          text-shadow: 0 1px 3px rgba(0, 0, 0, 0.38) !important;
          pointer-events: none !important;
          user-select: none !important;
          -webkit-user-select: none !important;
        }
        [data-vigil-instagram-like-heart="true"] {
          position: fixed !important;
          z-index: 2147483646 !important;
          width: 112px !important;
          height: 112px !important;
          margin: -56px 0 0 -56px !important;
          display: grid !important;
          place-items: center !important;
          pointer-events: none !important;
          user-select: none !important;
          -webkit-user-select: none !important;
          filter: drop-shadow(0 2px 10px rgba(0, 0, 0, 0.38)) !important;
          animation: vigil-instagram-like-heart 780ms cubic-bezier(.2,.8,.2,1) both !important;
        }
        [data-vigil-instagram-like-heart="true"] svg {
          display: block !important;
          width: 100% !important;
          height: 100% !important;
          overflow: visible !important;
          color: #ff3040 !important;
        }
        [data-vigil-instagram-like-heart="true"] svg :is(path, circle, ellipse, polygon, polyline) {
          fill: #ff3040 !important;
          stroke: #ff3040 !important;
        }
        [data-vigil-instagram-playback-feedback="true"] {
          position: fixed !important;
          z-index: 2147483645 !important;
          width: 72px !important;
          height: 72px !important;
          margin: -36px 0 0 -36px !important;
          display: grid !important;
          place-items: center !important;
          border-radius: 50% !important;
          background: rgba(0, 0, 0, 0.5) !important;
          -webkit-backdrop-filter: blur(5px) !important;
          backdrop-filter: blur(5px) !important;
          color: white !important;
          pointer-events: none !important;
          user-select: none !important;
          -webkit-user-select: none !important;
          animation: vigil-instagram-playback-feedback-in 160ms ease-out both !important;
        }
        [data-vigil-instagram-playback-feedback="true"] svg {
          display: block !important;
          width: 34px !important;
          height: 34px !important;
          fill: currentColor !important;
        }
        [data-vigil-instagram-playback-feedback="true"][data-state="playing"] {
          animation: vigil-instagram-playback-feedback-out 480ms ease-out both !important;
        }
        @keyframes vigil-instagram-like-heart {
          0% { opacity: 0; transform: scale(.2); }
          18% { opacity: 1; transform: scale(1.16); }
          32% { opacity: 1; transform: scale(.94); }
          48% { opacity: 1; transform: scale(1); }
          78% { opacity: 1; transform: scale(1); }
          100% { opacity: 0; transform: scale(.92); }
        }
        @keyframes vigil-instagram-playback-feedback-in {
          from { opacity: 0; transform: scale(.72); }
          to { opacity: 1; transform: scale(1); }
        }
        @keyframes vigil-instagram-playback-feedback-out {
          0% { opacity: 1; transform: scale(1); }
          42% { opacity: 1; transform: scale(1); }
          100% { opacity: 0; transform: scale(.88); }
        }
        @media (prefers-reduced-motion: reduce) {
          [data-vigil-instagram-like-heart="true"] {
            animation-duration: 220ms !important;
          }
          [data-vigil-instagram-playback-feedback="true"] {
            animation-duration: 120ms !important;
          }
        }
      `;
      document.documentElement.appendChild(style);

      const normalizeBottomNavigation = () => {
        document.querySelectorAll('[data-vigil-instagram-bottom-navigation]').forEach((node) => {
          node.removeAttribute('data-vigil-instagram-bottom-navigation');
        });
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
            navigation.dataset.vigilInstagramBottomNavigation = 'true';
            return navigation;
          }
        }
        return null;
      };

      const hasExactLeafLabel = (container, expected) => [...container.querySelectorAll('span, div, a')].some((node) => {
        if (node.children.length > 0) return false;
        const label = String(node.textContent || node.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().toLowerCase();
        return label === expected;
      });

      const isInstagramCommentsDialog = (dialog) => {
        if (!(dialog instanceof Element) || !visibleElement(dialog)) return false;
        const ownLabel = String(dialog.getAttribute('aria-label') || '')
          .replace(/\s+/g, ' ').trim().toLowerCase();
        if (ownLabel === 'comments' || ownLabel.startsWith('comments ')) return true;

        // A full-screen Reel is itself commonly exposed as a dialog and contains
        // an Add-comment composer. Treating that one weak signal as the comments
        // dialog collapses the entire Reel to the 52dvh sheet below, cropping the
        // caption and moving the media toward the bottom of the screen.
        const viewportWidth = Math.max(1, window.visualViewport?.width || innerWidth || 1);
        const viewportHeight = Math.max(1, window.visualViewport?.height || innerHeight || 1);
        let inspectedMedia = 0;
        for (const media of dialog.querySelectorAll('video, img')) {
          inspectedMedia += 1;
          if (visibleElement(media)) {
            const rect = media.getBoundingClientRect();
            if (rect.width >= Math.min(220, viewportWidth * 0.55)
                && rect.height >= Math.min(280, viewportHeight * 0.34)) return false;
          }
          if (inspectedMedia >= 24) break;
        }

        let inspected = 0;
        for (const heading of dialog.querySelectorAll('h1, h2, h3, [role="heading"]')) {
          inspected += 1;
          const label = String(heading.textContent || heading.getAttribute('aria-label') || '')
            .replace(/\s+/g, ' ').trim().toLowerCase();
          if (label === 'comments') return true;
          if (inspected >= 12) break;
        }
        const composer = dialog.querySelector(
          'textarea[placeholder*="comment" i], input[placeholder*="comment" i], '
          + '[aria-label*="add a comment" i]'
        );
        if (!composer) return false;
        // Keep a fallback for compact site variants that omit a visible heading,
        // but require an additional comment-specific semantic instead of allowing
        // the composer alone to classify its enclosing post/Reel dialog.
        return Boolean(dialog.querySelector(
          '[data-testid*="comment" i], [aria-label="Comments" i], '
          + '[aria-label^="Comment by" i], [aria-label^="Reply to" i]'
        ));
      };
      const normalizeCommentSheets = () => {
        document.querySelectorAll('[data-vigil-instagram-comments-sheet]').forEach((dialog) => {
          if (!isInstagramCommentsDialog(dialog)) {
            dialog.removeAttribute('data-vigil-instagram-comments-sheet');
          }
        });
        let inspected = 0;
        for (const dialog of document.querySelectorAll(
          '[role="dialog"]:not([aria-hidden="true"]), [aria-modal="true"]:not([aria-hidden="true"])'
        )) {
          inspected += 1;
          if (isInstagramCommentsDialog(dialog)) {
            dialog.dataset.vigilInstagramCommentsSheet = 'true';
          }
          if (inspected >= 12) break;
        }
      };

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
        if (window === window.top) {
          window.__vigilBridge({
            type: 'health', state: 'degraded',
            detail: `That Instagram ${feature} surface is intentionally unavailable.`
          });
        }
      };
      let redirectedPolicyURL = '';
      let lastPolicyRouteURL = location.href;
      let routePolicyCheckScheduled = false;
      let routePolicyNotificationPending = false;
      const enforceRestrictedLocation = () => {
        syncRouteFeature();
        const feature = restrictedFeature(location.href);
        if (!feature) {
          redirectedPolicyURL = '';
          delete document.documentElement.dataset.vigilRoutePolicyBlocked;
          return false;
        }
        document.documentElement.dataset.vigilRoutePolicyBlocked = feature;
        const blockedURL = location.href;
        if (redirectedPolicyURL !== blockedURL) {
          redirectedPolicyURL = blockedURL;
          if (window === window.top) {
            window.__vigilBridge({
              type: 'health', state: 'degraded',
              detail: `That Instagram ${feature} surface is intentionally unavailable.`
            });
          }
          try { location.replace('/'); } catch (_) {}
        }
        return true;
      };
      const processRoutePolicy = (notify = false) => {
        const currentURL = location.href;
        const changed = currentURL !== lastPolicyRouteURL;
        lastPolicyRouteURL = currentURL;
        if (enforceRestrictedLocation()) return;
        if (notify || changed) document.dispatchEvent(new Event('__vigilRouteChanged'));
      };
      const scheduleRoutePolicyCheck = (notify = false) => {
        routePolicyNotificationPending = routePolicyNotificationPending || notify;
        if (routePolicyCheckScheduled) return;
        routePolicyCheckScheduled = true;
        queueMicrotask(() => {
          routePolicyCheckScheduled = false;
          const shouldNotify = routePolicyNotificationPending;
          routePolicyNotificationPending = false;
          processRoutePolicy(shouldNotify);
        });
      };
      const serviceRouteEvent = () => {
        processRoutePolicy();
        scheduleRoutePolicyCheck();
      };
      document.addEventListener('click', blockRestrictedNavigation, true);
      for (const name of ['pushState', 'replaceState']) {
        const original = history[name];
        history[name] = function(...args) {
          const result = original.apply(this, args);
          scheduleRoutePolicyCheck(true);
          return result;
        };
      }
      addEventListener('popstate', serviceRouteEvent, true);
      addEventListener('hashchange', serviceRouteEvent, true);
      addEventListener('pageshow', serviceRouteEvent, true);
      window.navigation?.addEventListener?.('navigate', () => scheduleRoutePolicyCheck());
      document.addEventListener('__vigilPolicyFeaturesChanged', () => processRoutePolicy());
      const routePolicyWatchdog = setInterval(() => {
        if (location.href !== lastPolicyRouteURL) scheduleRoutePolicyCheck(true);
      }, 500);
      processRoutePolicy();

      // Subframes need the same cached-History/deep-route enforcement, but they
      // must not report main-document health or mutate its navigation layout.
      if (window !== window.top) return;

      const elementsWithin = (root, selector) => {
        if (root === document) return [...document.querySelectorAll(selector)];
        if (!(root instanceof Element)) return [];
        return [...(root.matches(selector) ? [root] : []), ...root.querySelectorAll(selector)];
      };
      const visibleElement = (element) => {
        if (!(element instanceof Element) || !element.isConnected) return false;
        const rect = element.getBoundingClientRect();
        if (rect.width <= 1 || rect.height <= 1) return false;
        let current = element;
        let depth = 0;
        let cumulativeOpacity = 1;
        while (current && depth < 32) {
          if (current.hidden || current.getAttribute('aria-hidden') === 'true') return false;
          const style = getComputedStyle(current);
          if (style.display === 'none' || style.visibility === 'hidden'
              || style.visibility === 'collapse' || style.contentVisibility === 'hidden') return false;
          const opacity = Number.parseFloat(style.opacity || '1');
          cumulativeOpacity *= Number.isFinite(opacity) ? opacity : 1;
          if (cumulativeOpacity <= 0.01) return false;
          const root = current.getRootNode?.();
          current = current.parentElement
            || (root instanceof ShadowRoot && root.host instanceof Element ? root.host : null);
          depth += 1;
        }
        // The live Instagram Reel tree is routinely deeper than 32 elements.
        // The cap is a performance guard, not evidence that a connected,
        // non-zero element is invisible; treating it as such discarded every
        // account/caption/audio row on the real phone.
        return true;
      };

      const instagramViewport = () => {
        const viewport = window.visualViewport;
        const top = Math.max(0, Number(viewport?.offsetTop) || 0);
        const left = Math.max(0, Number(viewport?.offsetLeft) || 0);
        const width = Math.max(1, Number(viewport?.width) || innerWidth || 1);
        const height = Math.max(1, Number(viewport?.height) || innerHeight || 1);
        return { top, left, width, height, right: left + width, bottom: top + height };
      };
      const pointInsideRect = (x, y, rect, allowance = 0) => (
        x >= rect.left - allowance && x <= rect.right + allowance
          && y >= rect.top - allowance && y <= rect.bottom + allowance
      );
      const primaryInstagramMedia = (media) => {
        if (!(media instanceof HTMLImageElement || media instanceof HTMLVideoElement)
            || !visibleElement(media)) return false;
        const viewport = instagramViewport();
        const rect = media.getBoundingClientRect();
        return rect.width >= Math.min(160, viewport.width * 0.42)
          && rect.height >= Math.min(180, viewport.height * 0.24)
          && rect.width * rect.height >= 34_000;
      };
      const primaryMediaAtPoint = (target, x, y) => {
        if (!(target instanceof Element)) return null;
        if (target.closest('[data-vigil-instagram-reels-metadata="true"]')) return null;
        const interactive = target.closest(
          'button, input, textarea, select, [role="button"], [role="link"]'
        );
        if (interactive && !interactive.querySelector('video, img')) {
          const rect = interactive.getBoundingClientRect();
          if (rect.width < 120 || rect.height < 120) return null;
        }
        const candidates = [];
        const add = (candidate) => {
          if (candidate instanceof HTMLPictureElement) candidate = candidate.querySelector('img');
          if (!(candidate instanceof HTMLImageElement || candidate instanceof HTMLVideoElement)
              || candidates.includes(candidate) || !primaryInstagramMedia(candidate)) return;
          const rect = candidate.getBoundingClientRect();
          if (pointInsideRect(x, y, rect, 1)) candidates.push(candidate);
        };
        add(target.closest('video, img, picture'));
        const layers = document.elementsFromPoint?.(x, y) || [];
        for (const layer of layers.slice(0, 24)) {
          add(layer);
          add(layer.closest?.('video, img, picture'));
        }
        candidates.sort((left, right) => {
          const videoBonus = (candidate) => candidate instanceof HTMLVideoElement ? 10_000_000 : 0;
          const leftRect = left.getBoundingClientRect();
          const rightRect = right.getBoundingClientRect();
          return (videoBonus(right) + rightRect.width * rightRect.height)
            - (videoBonus(left) + leftRect.width * leftRect.height);
        });
        return candidates[0] || null;
      };

      const instagramNativeAppURL = (value) => {
        const candidate = String(value || '').trim();
        if (!candidate) return false;
        if (/^(?:instagram(?:-stories)?|x-ig|intent|itms-apps):/i.test(candidate)) return true;
        try {
          const protocol = new URL(candidate, location.href).protocol.toLowerCase();
          return ['instagram:', 'instagram-stories:', 'x-ig:', 'intent:', 'itms-apps:']
            .includes(protocol);
        } catch (_) { return false; }
      };
      const nativeWindowOpen = window.open;
      try {
        window.open = function vigilInstagramWindowOpen(value, ...argumentsList) {
          if (instagramNativeAppURL(value)) return null;
          return nativeWindowOpen.call(this, value, ...argumentsList);
        };
      } catch (_) {}
      for (const name of ['assign', 'replace']) {
        try {
          const descriptor = Object.getOwnPropertyDescriptor(Location.prototype, name);
          const nativeMethod = descriptor?.value;
          if (typeof nativeMethod !== 'function' || descriptor.configurable === false) continue;
          Object.defineProperty(Location.prototype, name, {
            ...descriptor,
            value: function vigilInstagramLocationMethod(value, ...argumentsList) {
              if (instagramNativeAppURL(value)) return;
              return nativeMethod.call(this, value, ...argumentsList);
            }
          });
        } catch (_) {}
      }
      const blockInstagramNativeAppNavigation = (event) => {
        const link = event.target?.closest?.('a[href]');
        if (!link || !instagramNativeAppURL(link.getAttribute('href') || link.href)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
      };
      document.addEventListener('click', blockInstagramNativeAppNavigation, true);
      document.addEventListener('auxclick', blockInstagramNativeAppNavigation, true);

      const reelPreconnectedOrigins = new Set();
      const reelsScrollContainers = new Set();
      const reelsCards = new Set();
      const reelsMetadata = new Set();
      const reelsMetadataByCard = new WeakMap();
      const reelsRepostProxies = new Set();
      const reelsMetadataListeners = new WeakSet();
      const reelsLayoutListeners = new WeakSet();
      let reelsNormalizationScheduled = false;
      let reelsNormalizationTimer = 0;
      let lastReelsNormalizationAt = -Infinity;
      const minimumReelsNormalizationInterval = 320;

      let reelsWarmLink = null;
      const warmReelsRoute = () => {
        if (reelsWarmLink?.isConnected
            || routeFeature(location.href) === 'reels'
            || document.documentElement.getAttribute('data-vigil-feature-reels') !== 'available') return;
        const link = document.createElement('link');
        link.rel = 'prefetch';
        link.as = 'document';
        link.href = '/reels/';
        link.setAttribute('fetchpriority', 'low');
        link.dataset.vigilInstagramReelsWarmup = 'true';
        (document.head || document.documentElement).appendChild(link);
        reelsWarmLink = link;
      };
      const scheduleReelsWarmup = () => {
        if (typeof requestIdleCallback === 'function') {
          requestIdleCallback(warmReelsRoute, { timeout: 2200 });
        } else {
          setTimeout(warmReelsRoute, 1200);
        }
      };
      document.addEventListener('pointerdown', (event) => {
        const link = event.target?.closest?.('a[href]');
        if (link && routeFeature(link.href) === 'reels') warmReelsRoute();
      }, { capture: true, passive: true });

      const markReelResourceOrigin = (value) => {
        const raw = String(value || '');
        const candidates = raw.match(/https:\/\/[^\s,]+/gi) || (raw ? [raw] : []);
        for (const candidate of candidates.slice(0, 8)) {
          let url;
          try { url = new URL(candidate, location.href); } catch (_) { continue; }
          if (url.protocol !== 'https:') continue;
          const host = url.hostname.toLowerCase();
          if (!(host === 'cdninstagram.com' || host.endsWith('.cdninstagram.com')
              || host === 'fbcdn.net' || host.endsWith('.fbcdn.net'))) continue;
          if (reelPreconnectedOrigins.has(url.origin)) continue;
          reelPreconnectedOrigins.add(url.origin);
          const hint = document.createElement('link');
          hint.rel = 'preconnect';
          hint.href = url.origin;
          hint.crossOrigin = 'anonymous';
          (document.head || document.documentElement).appendChild(hint);
        }
      };
      const primeReelMedia = (media) => {
        if (!primaryInstagramMedia(media)) return;
        const viewport = instagramViewport();
        const rect = media.getBoundingClientRect();
        const visible = rect.bottom > viewport.top && rect.top < viewport.bottom;
        const near = rect.bottom > viewport.top - viewport.height * 0.35
          && rect.top < viewport.bottom + viewport.height * 1.25;
        if (!near) return;
        if (media instanceof HTMLImageElement) {
          const desiredWidth = Math.max(rect.width, viewport.width);
          const desiredSizes = `${Math.ceil(desiredWidth)}px`;
          const picture = media.closest('picture');
          const responsiveSources = picture ? [...picture.querySelectorAll('source[srcset]')] : [];
          if ((media.srcset || responsiveSources.length) && media.getAttribute('sizes') !== desiredSizes) {
            media.setAttribute('sizes', desiredSizes);
          }
          responsiveSources.forEach((source) => {
            if (source.getAttribute('sizes') !== desiredSizes) source.setAttribute('sizes', desiredSizes);
            markReelResourceOrigin(source.getAttribute('srcset'));
          });
          if (media.loading !== 'eager') media.loading = 'eager';
          if (media.decoding !== 'async') media.decoding = 'async';
          if (visible && media.getAttribute('fetchpriority') !== 'high') {
            media.setAttribute('fetchpriority', 'high');
          }
          markReelResourceOrigin(media.currentSrc || media.src);
          markReelResourceOrigin(media.srcset);
          return;
        }
        const desiredPreload = visible || rect.top < viewport.bottom + viewport.height * 0.72
          ? 'auto'
          : 'metadata';
        if (media.preload !== desiredPreload) media.preload = desiredPreload;
        markReelResourceOrigin(media.currentSrc || media.src);
        markReelResourceOrigin(media.poster);
        media.querySelectorAll('source').forEach((source) => {
          markReelResourceOrigin(source.getAttribute('src'));
          markReelResourceOrigin(source.getAttribute('srcset'));
        });
        // Deliberately do not call load() or play(): Vigil's media gate remains
        // the sole authority over playback when content classification is active.
      };
      const reelScrollContainerFor = (media) => {
        let current = media.parentElement;
        let depth = 0;
        while (current && current !== document.body && depth < 18) {
          const style = getComputedStyle(current);
          const verticallyScrollable = /(auto|scroll)/.test(style.overflowY)
            && current.clientHeight >= 240
            && (current.scrollHeight > current.clientHeight + 4
              || style.scrollSnapType?.startsWith('y'));
          if (verticallyScrollable) return current;
          current = current.parentElement;
          depth += 1;
        }
        const scrolling = document.scrollingElement;
        return scrolling && scrolling.scrollHeight > scrolling.clientHeight + 4 ? scrolling : null;
      };
      const reelCardFor = (media, container) => {
        if (!(container instanceof Element)) return null;
        if (container === document.scrollingElement
            || container === document.documentElement || container === document.body) {
          const article = media.closest('article');
          if (article) return article;
          const viewport = instagramViewport();
          let candidate = media.parentElement;
          let best = null;
          let depth = 0;
          while (candidate && candidate !== document.body
              && candidate !== document.documentElement && depth < 14) {
            const rect = candidate.getBoundingClientRect();
            if (rect.width >= viewport.width * 0.72
                && rect.height >= viewport.height * 0.58
                && rect.height <= viewport.height * 1.35) best = candidate;
            candidate = candidate.parentElement;
            depth += 1;
          }
          return best;
        }
        let card = media;
        while (card.parentElement && card.parentElement !== container) card = card.parentElement;
        return card.parentElement === container ? card : media.closest('article');
      };
      const reelMetadataTextGeometry = (root, cardRect) => {
        const rows = [];
        let inspected = 0;
        for (const element of root.querySelectorAll(
          'a[href], [role="link"], span, [dir="auto"], [data-testid*="caption" i]'
        )) {
          inspected += 1;
          if (!visibleElement(element)) {
            if (inspected >= 180) break;
            continue;
          }
          const rect = element.getBoundingClientRect();
          const text = String(element.innerText || element.textContent || '')
            .replace(/\s+/g, ' ').trim();
          const inLeftStack = rect.width > 1 && rect.height > 1
            && rect.left < cardRect.left + cardRect.width * 0.76
            && rect.right > cardRect.left
            && rect.top >= cardRect.top + cardRect.height * 0.44
            // Instagram's live 402x874 layout lets an 874-point overlay
            // overflow its 795-point Reel card. Keep those caption/audio rows
            // eligible even though their boxes extend beneath the card.
            && rect.top < cardRect.bottom + cardRect.height * 0.2;
          if (inLeftStack && text) rows.push({ element, rect, text });
          if (inspected >= 180) break;
        }
        if (!rows.length) return null;
        return {
          rows,
          top: Math.min(...rows.map((row) => row.rect.top)),
          right: Math.max(...rows.map((row) => row.rect.right)),
          bottom: Math.max(...rows.map((row) => row.rect.bottom)),
          left: Math.min(...rows.map((row) => row.rect.left)),
          characters: Math.min(640, rows.reduce((total, row) => total + row.text.length, 0))
        };
      };
      const reelMetadataMovesRightActions = (candidate, cardRect) => {
        let inspected = 0;
        const rightActionRows = [];
        for (const control of candidate.querySelectorAll(
          'button, [role="button"], a[href], [role="link"]'
        )) {
          inspected += 1;
          const rect = control.getBoundingClientRect();
          if (visibleElement(control)
              && rect.left >= cardRect.left + cardRect.width * 0.72) {
            const centerY = rect.top + rect.height / 2;
            const duplicatesWrapper = rightActionRows.some(
              (existingY) => Math.abs(existingY - centerY) <= 16
            );
            if (!duplicatesWrapper) rightActionRows.push(centerY);
            // The live metadata overlay owns one far-right overflow/More
            // control whose nested wrappers may each be interactive. A real
            // action rail contributes several spatially distinct controls, so
            // reject the latter without discarding the complete metadata stack.
            if (rightActionRows.length >= 2) return true;
          }
          if (inspected >= 80) break;
        }
        return false;
      };
      const reelMetadataFor = (card) => {
        const cardRect = card.getBoundingClientRect();
        let best = null;
        let bestScore = -1;
        let inspected = 0;
        const metadataSignals = new Set([...card.querySelectorAll('a[href]')].filter((link) => {
          let path = '';
          try { path = new URL(link.href, location.href).pathname; } catch (_) {}
          return /^\/[^/]+\/?$/.test(path)
            && !/^\/(?:reel|reels|explore|direct|accounts)\/?$/i.test(path);
        }));
        // The current mobile rollout exposes the username as an ordinary span,
        // while unrelated profile-shaped anchors elsewhere in the card prevent
        // an anchor-only fallback from running. Seed the search from every
        // visible lower-left text row, then use row bands and right-rail
        // rejection to select the complete account/caption/audio stack.
        const cardTextGeometry = reelMetadataTextGeometry(card, cardRect);
        for (const row of cardTextGeometry?.rows || []) {
          // Instagram wraps the username and caption rows in large tap targets
          // in its current mobile markup. Excluding every descendant of a
          // role-button removes every useful seed on the live Reel. The
          // lower-left geometry filter above and candidate-level right-rail
          // rejection below already exclude the compact action controls.
          if (row.element.matches(
            'input, textarea, select, [contenteditable="true"]'
          )) continue;
          metadataSignals.add(row.element);
        }
        const verticalBands = (rows) => {
          const bands = [];
          for (const row of [...rows].sort((left, right) => left.rect.top - right.rect.top)) {
            let band = bands.find((value) => (
              row.rect.top <= value.bottom + 3 && row.rect.bottom >= value.top - 3
            ));
            if (!band) {
              band = { top: row.rect.top, bottom: row.rect.bottom };
              bands.push(band);
            } else {
              band.top = Math.min(band.top, row.rect.top);
              band.bottom = Math.max(band.bottom, row.rect.bottom);
            }
          }
          return bands;
        };
        for (const signal of metadataSignals) {
          inspected += 1;
          const signalRect = signal.getBoundingClientRect();
          let candidate = signal;
          let depth = 0;
          while (candidate && candidate !== card && depth < 12) {
            const rect = candidate.getBoundingClientRect();
            const geometry = reelMetadataTextGeometry(candidate, cardRect);
            const bands = verticalBands(geometry?.rows || []);
            const hasFollowingBand = bands.some((band) => band.top > signalRect.bottom + 3);
            const hasProfileLink = Boolean(candidate.querySelector('a[href]'))
              && [...candidate.querySelectorAll('a[href]')].some((link) => {
                let path = '';
                try { path = new URL(link.href, location.href).pathname; } catch (_) {}
                return /^\/[^/]+\/?$/.test(path)
                  && !/^\/(?:reel|reels|explore|direct|accounts)\/?$/i.test(path);
              });
            // Compact mobile layouts can put username, caption, and its More
            // button in a single wrapped band. A lower-left profile link plus
            // meaningful text is still a strong metadata signal; requiring a
            // second band made that whole caption stack disappear as soon as a
            // complete right-side action rail mounted beside it.
            const compactMetadata = hasProfileLink
              && geometry?.characters >= 12
              && rect.height >= 32
              && rect.width <= cardRect.width * 0.86;
            const movesRightActions = geometry
              ? reelMetadataMovesRightActions(candidate, cardRect)
              : false;
            const plausible = geometry
              && ((bands.length >= 2 && hasFollowingBand) || compactMetadata)
              && rect.width >= Math.min(96, cardRect.width * 0.24)
              && rect.right <= cardRect.left + cardRect.width * 0.96
              && rect.left < cardRect.left + cardRect.width * 0.72
              && geometry.bottom >= cardRect.top + cardRect.height * 0.5
              && !movesRightActions;
            const score = plausible
              ? bands.length * 120
                + (geometry.bottom - geometry.top) * 1.4
                + (geometry.bottom - cardRect.top) * 0.35
                + geometry.characters * 0.15
                - rect.width * 0.02
                - depth * 0.25
              : -1;
            if (score > bestScore) {
              best = candidate;
              bestScore = score;
            }
            candidate = candidate.parentElement;
            depth += 1;
          }
          if (inspected >= 180) break;
        }
        return best;
      };
      const initializeReelMetadataTranslate = (metadata) => {
        if (metadata.dataset.vigilInstagramReelsTranslateCaptured === 'true') return true;
        const authored = String(getComputedStyle(metadata).translate || 'none').trim();
        let authoredX = '0px';
        let authoredY = '0px';
        if (authored !== 'none') {
          const match = authored.match(
            /^(-?(?:\d+(?:\.\d+)?|\.\d+)px)(?:\s+(-?(?:\d+(?:\.\d+)?|\.\d+)px))?(?:\s+[-\d.]+px)?$/
          );
          // Do not overwrite an authored percentage/calc translation that
          // cannot be composed losslessly.
          if (!match) return false;
          authoredX = match[1];
          authoredY = match[2] || '0px';
        }
        metadata.style.setProperty('--vigil-instagram-reels-authored-translate-x', authoredX);
        metadata.style.setProperty('--vigil-instagram-reels-authored-translate-y', authoredY);
        metadata.dataset.vigilInstagramReelsTranslateCaptured = 'true';
        return true;
      };
      const setReelMetadataClearance = (metadata, lift) => {
        const normalizedLift = Math.max(0, Math.ceil(Number(lift) || 0));
        if (!normalizedLift) {
          metadata.removeAttribute('data-vigil-instagram-reels-metadata-clearance');
          metadata.style.removeProperty('--vigil-instagram-reels-metadata-offset');
          return;
        }
        if (!initializeReelMetadataTranslate(metadata)) return;
        metadata.style.setProperty('--vigil-instagram-reels-metadata-offset', `${-normalizedLift}px`);
        metadata.dataset.vigilInstagramReelsMetadataClearance = 'true';
      };
      const reconcileReelMetadataClearance = (
        metadata, card, container, viewport, navigationRect, explicitlyExpanded
      ) => {
        if (explicitlyExpanded) {
          setReelMetadataClearance(metadata, 0);
          return;
        }
        const containerRect = container.getBoundingClientRect();
        const cardRect = card.getBoundingClientRect();
        const inferredNavigationTop = viewport.bottom - containerRect.bottom >= 36
            && containerRect.bottom > viewport.top + 240
          ? containerRect.bottom
          : null;
        // The current Instagram rollout renders a reliable 0...795 Reel
        // scroller above its 79-point nav, but the nav has no stable common
        // ancestor for our semantic marker. Prefer a detected nav; otherwise
        // the scroller's measured bottom is the usable boundary.
        const usableBottom = navigationRect?.top || inferredNavigationTop;
        if (!usableBottom) {
          setReelMetadataClearance(metadata, 0);
          return;
        }
        const visibleTop = Math.max(viewport.top, containerRect.top);
        const visibleBottom = Math.min(viewport.bottom, containerRect.bottom);
        const visibleHeight = visibleBottom - visibleTop;
        if (visibleHeight < 240) return;
        // Only alter the card crossing the native snap origin. Other cards are
        // remeasured after Instagram settles them; no scroll position changes.
        const probeY = visibleTop + Math.min(56, Math.max(12, visibleHeight * 0.08));
        if (cardRect.top > probeY || cardRect.bottom <= probeY) return;
        const geometry = reelMetadataTextGeometry(metadata, cardRect);
        if (!geometry) return;
        const currentOffset = Number.parseFloat(
          metadata.style.getPropertyValue('--vigil-instagram-reels-metadata-offset')
        );
        const currentLift = Number.isFinite(currentOffset) ? Math.max(0, -currentOffset) : 0;
        const unshiftedTop = geometry.top + currentLift;
        const unshiftedBottom = geometry.bottom + currentLift;
        const safeBottom = usableBottom - 8;
        const overlap = Math.max(0, unshiftedBottom - safeBottom);
        const maximumLift = Math.max(0, unshiftedTop - (viewport.top + 8));
        setReelMetadataClearance(metadata, Math.min(overlap, maximumLift));
      };
      const installReelMetadataListeners = (metadata) => {
        if (reelsMetadataListeners.has(metadata)) return;
        reelsMetadataListeners.add(metadata);
        let mediaState = null;
        const rememberMediaState = () => {
          const card = metadata.closest('[data-vigil-instagram-reels-card="true"]');
          const media = card?.querySelector('video');
          mediaState = media instanceof HTMLVideoElement
            ? { media, muted: media.muted, paused: media.paused }
            : null;
        };
        const restoreAfterCaptionAction = () => {
          if (!mediaState) return;
          restoreMediaTapState(mediaState.media, mediaState);
        };
        metadata.addEventListener('pointerdown', rememberMediaState, { passive: true });
        metadata.addEventListener('touchstart', rememberMediaState, { passive: true });
        metadata.addEventListener('pointerup', restoreAfterCaptionAction, { passive: true });
        metadata.addEventListener('touchend', restoreAfterCaptionAction, { passive: true });
        metadata.addEventListener('click', restoreAfterCaptionAction);
      };
      const reelControlLabel = (element) => String(
        element?.getAttribute?.('aria-label') || element?.textContent || ''
      ).replace(/\s+/g, ' ').trim().toLowerCase();
      const reelSemanticControl = (root, labels, visibleOnly = true) => {
        if (!(root instanceof Element || root instanceof Document)) return null;
        const expected = new Set(labels);
        let inspected = 0;
        for (const labeled of root.querySelectorAll('[aria-label]')) {
          inspected += 1;
          if (labeled.closest('[data-vigil-instagram-repost-proxy="true"]')
              || !expected.has(reelControlLabel(labeled))) {
            if (inspected >= 200) break;
            continue;
          }
          const control = labeled.matches('button, [role="button"]')
            ? labeled
            : labeled.closest('button, [role="button"]');
          if (control && root.contains(control) && (!visibleOnly || visibleElement(control))) {
            return control;
          }
          if (inspected >= 200) break;
        }
        return null;
      };
      const reelActionRailFor = (card) => {
        const cardRect = card.getBoundingClientRect();
        const share = reelSemanticControl(card, ['share', 'share post', 'send', 'send post']);
        const controls = [
          reelSemanticControl(card, ['like', 'unlike']),
          reelSemanticControl(card, ['comment', 'comments']),
          share
        ].filter(Boolean);
        if (!share || controls.length < 2) return null;
        let candidate = share;
        let best = null;
        let depth = 0;
        while (candidate?.parentElement && candidate !== card && depth < 12) {
          candidate = candidate.parentElement;
          if (!card.contains(candidate)) break;
          const rect = candidate.getBoundingClientRect();
          const ownedControls = controls.filter((control) => candidate.contains(control));
          if (ownedControls.length >= 2
              && rect.left >= cardRect.left + cardRect.width * 0.64
              && rect.width <= Math.max(120, cardRect.width * 0.34)
              && rect.height <= cardRect.height * 0.9) best = candidate;
          depth += 1;
        }
        return best ? { rail: best, share } : null;
      };
      const showInstagramActionFeedback = (message) => {
        document.querySelectorAll('[data-vigil-instagram-action-feedback]').forEach(
          (element) => element.remove()
        );
        const feedback = document.createElement('div');
        feedback.dataset.vigilInstagramActionFeedback = 'true';
        feedback.setAttribute('role', 'status');
        feedback.textContent = message;
        document.documentElement.appendChild(feedback);
        setTimeout(() => feedback.remove(), 1800);
      };
      const setRepostProxyState = (proxy, reposted) => {
        if (!proxy?.isConnected) return;
        if (reposted) proxy.dataset.vigilReposted = 'true';
        else delete proxy.dataset.vigilReposted;
        const button = proxy.querySelector('button');
        if (button) button.setAttribute('aria-label', reposted ? 'Remove repost' : 'Repost');
      };
      const instagramRepostState = (card) => {
        if (reelSemanticControl(card, ['remove repost', 'undo repost'], false)) return true;
        if (reelSemanticControl(card, ['repost', 'repost post'], false)) return false;
        return null;
      };
      const waitForInstagramRepostConfirmation = (card, proxy, expectedState) => {
        const startedAt = performance.now();
        const confirm = () => {
          const state = instagramRepostState(card);
          if (state === expectedState) {
            setRepostProxyState(proxy, state);
            showInstagramActionFeedback(state ? 'Reposted' : 'Repost removed');
            return;
          }
          if (performance.now() - startedAt >= 1400) {
            showInstagramActionFeedback('Instagram did not confirm the repost');
            return;
          }
          setTimeout(confirm, 80);
        };
        setTimeout(confirm, 40);
      };
      const activateInstagramRepost = (card, proxy, share) => {
        const direct = reelSemanticControl(
          card,
          ['repost', 'repost post', 'remove repost', 'undo repost'],
          false
        );
        if (direct) {
          const removing = /^(?:remove|undo) repost/.test(reelControlLabel(direct));
          direct.click();
          waitForInstagramRepostConfirmation(card, proxy, !removing);
          return;
        }
        if (!share?.isConnected) {
          showInstagramActionFeedback('Repost is not available for this item');
          return;
        }
        share.click();
        const startedAt = performance.now();
        const findShareSheetRepost = () => {
          const action = reelSemanticControl(
            document,
            ['repost', 'repost post', 'remove repost', 'undo repost']
          );
          if (action) {
            const removing = /^(?:remove|undo) repost/.test(reelControlLabel(action));
            action.click();
            waitForInstagramRepostConfirmation(card, proxy, !removing);
            return;
          }
          if (performance.now() - startedAt >= 1400) {
            showInstagramActionFeedback('Repost is not available for this item');
            return;
          }
          setTimeout(findShareSheetRepost, 80);
        };
        setTimeout(findShareSheetRepost, 40);
      };
      const reconcileRepostControl = (card) => {
        const existing = reelSemanticControl(
          card,
          ['repost', 'repost post', 'remove repost', 'undo repost']
        );
        const currentProxy = card.querySelector('[data-vigil-instagram-repost-proxy="true"]');
        if (existing) {
          currentProxy?.remove();
          if (currentProxy) reelsRepostProxies.delete(currentProxy);
          return null;
        }
        const actionRail = reelActionRailFor(card);
        if (!actionRail) return currentProxy;
        if (currentProxy?.isConnected) return currentProxy;

        const proxy = document.createElement('div');
        proxy.dataset.vigilInstagramRepostProxy = 'true';
        const button = document.createElement('button');
        button.type = 'button';
        button.setAttribute('aria-label', 'Repost');
        button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">'
          + '<path d="M7 7h9.5a3.5 3.5 0 0 1 3.5 3.5V12"/>'
          + '<path d="m17 4 3 3-3 3"/>'
          + '<path d="M17 17H7.5A3.5 3.5 0 0 1 4 13.5V12"/>'
          + '<path d="m7 20-3-3 3-3"/>'
          + '</svg>';
        button.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopImmediatePropagation();
          activateInstagramRepost(card, proxy, actionRail.share);
        });
        proxy.appendChild(button);
        let shareItem = actionRail.share;
        while (shareItem.parentElement && shareItem.parentElement !== actionRail.rail) {
          shareItem = shareItem.parentElement;
        }
        if (shareItem.parentElement === actionRail.rail) {
          actionRail.rail.insertBefore(proxy, shareItem);
        } else {
          actionRail.rail.appendChild(proxy);
        }
        reelsRepostProxies.add(proxy);
        return proxy;
      };
      const clearReelSurfaceMarkers = () => {
        reelsScrollContainers.forEach((container) => {
          container.removeAttribute('data-vigil-instagram-reels-scroll');
          container.style.removeProperty('--vigil-instagram-reels-card-height');
        });
        reelsCards.forEach((card) => {
          card.removeAttribute('data-vigil-instagram-reels-card');
          card.style.removeProperty('--vigil-instagram-reels-card-height');
          card.style.removeProperty('--vigil-instagram-reels-bottom-clearance');
        });
        reelsMetadata.forEach((metadata) => {
          metadata.removeAttribute('data-vigil-instagram-reels-metadata');
          metadata.removeAttribute('data-vigil-instagram-reels-metadata-positioned');
          metadata.removeAttribute('data-vigil-instagram-reels-metadata-expanded');
          metadata.removeAttribute('data-vigil-instagram-reels-metadata-clearance');
          metadata.removeAttribute('data-vigil-instagram-reels-translate-captured');
          metadata.style.removeProperty('--vigil-instagram-authored-metadata-bottom');
          metadata.style.removeProperty('--vigil-instagram-reels-authored-translate-x');
          metadata.style.removeProperty('--vigil-instagram-reels-authored-translate-y');
          metadata.style.removeProperty('--vigil-instagram-reels-metadata-offset');
        });
        reelsRepostProxies.forEach((proxy) => proxy.remove());
        reelsScrollContainers.clear();
        reelsCards.clear();
        reelsMetadata.clear();
        reelsRepostProxies.clear();
      };
      const normalizeReelSurface = () => {
        reelsNormalizationScheduled = false;
        reelsNormalizationTimer = 0;
        lastReelsNormalizationAt = performance.now();
        if (routeFeature(location.href) !== 'reels') {
          clearReelSurfaceMarkers();
          return;
        }
        const nextContainers = new Set();
        const nextCards = new Set();
        const nextMetadata = new Set();
        const viewport = instagramViewport();
        const navigation = document.querySelector('[data-vigil-instagram-bottom-navigation="true"]');
        const measuredNavigationRect = navigation?.getBoundingClientRect();
        const navigationRect = measuredNavigationRect
            && measuredNavigationRect.height >= 36
            && measuredNavigationRect.top > viewport.top + viewport.height * 0.55
            && measuredNavigationRect.top < viewport.bottom
          ? measuredNavigationRect
          : null;
        let inspected = 0;
        let processedCards = 0;
        for (const media of document.querySelectorAll('video, img')) {
          inspected += 1;
          if (!primaryInstagramMedia(media)) {
            if (inspected >= 160) break;
            continue;
          }
          const mediaRect = media.getBoundingClientRect();
          const nearViewport = mediaRect.bottom > viewport.top - viewport.height * 0.4
            && mediaRect.top < viewport.bottom + viewport.height * 1.4;
          if (!nearViewport) {
            if (inspected >= 160) break;
            continue;
          }
          primeReelMedia(media);
          const container = reelScrollContainerFor(media);
          const card = container && reelCardFor(media, container);
          if (!(container instanceof Element) || !(card instanceof Element)) {
            if (inspected >= 160) break;
            continue;
          }
          if (nextCards.has(card)) continue;
          processedCards += 1;
          nextContainers.add(container);
          nextCards.add(card);
          container.dataset.vigilInstagramReelsScroll = 'true';
          // Preserve Instagram's authored card size. CSS supplies only the
          // standard paging contract; it never changes scrollTop or card height.
          container.style.removeProperty('--vigil-instagram-reels-card-height');
          card.dataset.vigilInstagramReelsCard = 'true';
          card.style.removeProperty('--vigil-instagram-reels-card-height');
          card.style.removeProperty('--vigil-instagram-reels-bottom-clearance');
          let metadata = reelsMetadataByCard.get(card);
          if (!(metadata instanceof Element)
              || !metadata.isConnected || !card.contains(metadata)) {
            metadata = reelMetadataFor(card);
            if (metadata) reelsMetadataByCard.set(card, metadata);
          }
          if (metadata) {
            nextMetadata.add(metadata);
            metadata.dataset.vigilInstagramReelsMetadata = 'true';
            metadata.removeAttribute('data-vigil-instagram-reels-metadata-positioned');
            metadata.style.removeProperty('--vigil-instagram-authored-metadata-bottom');
            const explicitlyExpanded = metadata.getAttribute('aria-expanded') === 'true'
              || Boolean(metadata.querySelector('[aria-expanded="true"]'));
            if (explicitlyExpanded) metadata.dataset.vigilInstagramReelsMetadataExpanded = 'true';
            else metadata.removeAttribute('data-vigil-instagram-reels-metadata-expanded');
            reconcileReelMetadataClearance(
              metadata, card, container, viewport, navigationRect, explicitlyExpanded
            );
            installReelMetadataListeners(metadata);
          }
          reconcileRepostControl(card);
          installReelLayoutListener(container);
          if (processedCards >= 3 || inspected >= 160) break;
        }
        reelsScrollContainers.forEach((container) => {
          if (nextContainers.has(container)) return;
          container.removeAttribute('data-vigil-instagram-reels-scroll');
          container.style.removeProperty('--vigil-instagram-reels-card-height');
        });
        reelsCards.forEach((card) => {
          if (nextCards.has(card)) return;
          card.removeAttribute('data-vigil-instagram-reels-card');
          card.style.removeProperty('--vigil-instagram-reels-card-height');
          card.style.removeProperty('--vigil-instagram-reels-bottom-clearance');
        });
        reelsMetadata.forEach((metadata) => {
          if (nextMetadata.has(metadata)) return;
          metadata.removeAttribute('data-vigil-instagram-reels-metadata');
          metadata.removeAttribute('data-vigil-instagram-reels-metadata-positioned');
          metadata.removeAttribute('data-vigil-instagram-reels-metadata-expanded');
          metadata.removeAttribute('data-vigil-instagram-reels-metadata-clearance');
          metadata.removeAttribute('data-vigil-instagram-reels-translate-captured');
          metadata.style.removeProperty('--vigil-instagram-authored-metadata-bottom');
          metadata.style.removeProperty('--vigil-instagram-reels-authored-translate-x');
          metadata.style.removeProperty('--vigil-instagram-reels-authored-translate-y');
          metadata.style.removeProperty('--vigil-instagram-reels-metadata-offset');
        });
        reelsRepostProxies.forEach((proxy) => {
          const card = proxy.closest('[data-vigil-instagram-reels-card="true"]');
          if (proxy.isConnected && card && nextCards.has(card)) return;
          proxy.remove();
          reelsRepostProxies.delete(proxy);
        });
        reelsScrollContainers.clear();
        reelsCards.clear();
        reelsMetadata.clear();
        nextContainers.forEach((value) => reelsScrollContainers.add(value));
        nextCards.forEach((value) => reelsCards.add(value));
        nextMetadata.forEach((value) => reelsMetadata.add(value));
      };
      const scheduleReelSurfaceNormalization = (immediate = false) => {
        if (routeFeature(location.href) !== 'reels') {
          if (reelsScrollContainers.size || reelsCards.size || reelsMetadata.size) {
            clearTimeout(reelsNormalizationTimer);
            reelsNormalizationTimer = 0;
            reelsNormalizationScheduled = true;
            requestAnimationFrame(normalizeReelSurface);
          }
          return;
        }
        if (reelsNormalizationScheduled) return;
        const elapsed = performance.now() - lastReelsNormalizationAt;
        const delay = immediate ? 0 : Math.max(0, minimumReelsNormalizationInterval - elapsed);
        reelsNormalizationScheduled = true;
        if (!delay) {
          requestAnimationFrame(normalizeReelSurface);
          return;
        }
        reelsNormalizationTimer = setTimeout(() => {
          reelsNormalizationTimer = 0;
          requestAnimationFrame(normalizeReelSurface);
        }, delay);
      };
      const installReelLayoutListener = (container) => {
        if (reelsLayoutListeners.has(container)) return;
        reelsLayoutListeners.add(container);
        let settleTimer = 0;
        const remeasureAfterNativeSettle = () => {
          clearTimeout(settleTimer);
          settleTimer = setTimeout(scheduleReelSurfaceNormalization, 140);
        };
        container.addEventListener('scroll', remeasureAfterNativeSettle, { passive: true });
        container.addEventListener('scrollend', () => scheduleReelSurfaceNormalization(true), {
          passive: true
        });
      };

      const normalizedAccessibilityLabel = (element) => String(
        element?.getAttribute?.('aria-label') || ''
      ).replace(/\s+/g, ' ').trim().toLowerCase();
      const semanticLikeControl = (root, expectedLabel) => {
        let inspected = 0;
        for (const labeled of root.querySelectorAll('[aria-label]')) {
          inspected += 1;
          if (normalizedAccessibilityLabel(labeled) !== expectedLabel) {
            if (inspected >= 160) break;
            continue;
          }
          const control = labeled.matches('button, [role="button"]')
            ? labeled
            : labeled.closest('button, [role="button"]');
          if (control && root.contains(control) && visibleElement(control)) return control;
          if (inspected >= 160) break;
        }
        return null;
      };
      const directSemanticLikeControl = (root) => (
        semanticLikeControl(root, 'unlike') || semanticLikeControl(root, 'like')
      );
      const semanticLikeScope = (media) => {
        if (!(media instanceof HTMLImageElement || media instanceof HTMLVideoElement)) return null;
        const authoredScope = media.closest(
          '[data-vigil-instagram-reels-card="true"], article'
        );
        // Instagram's article/Reel card is itself the stable ownership
        // boundary. Its action rail can be visually clipped or finish mounting
        // after pointer-down, so visibility of that rail must not decide
        // whether the media gesture recognizer arms.
        if (authoredScope) return authoredScope;
        // Post-detail and profile-overlay rollouts do not always retain an
        // article element. Find the smallest ancestor that contains this one
        // primary media item and its exact Like/Unlike control. Keeping the
        // search bounded and semantic avoids treating Story/DM reaction hearts
        // or profile-grid thumbnails as post likes.
        let candidate = media.parentElement;
        for (let depth = 0; candidate && depth < 14; depth += 1) {
          const primaryMedia = [...candidate.querySelectorAll('video, img')]
            .filter(primaryInstagramMedia);
          if (primaryMedia.length === 1 && primaryMedia[0] === media
              && directSemanticLikeControl(candidate)) return candidate;
          if (candidate === document.body) break;
          candidate = candidate.parentElement;
        }
        return null;
      };
      const semanticLikeState = (media) => {
        const scope = semanticLikeScope(media);
        if (!scope) return { state: 'unknown', control: null, scope: null };
        const unlike = semanticLikeControl(scope, 'unlike');
        const like = semanticLikeControl(scope, 'like');
        if (unlike) return { state: 'liked', control: unlike, scope };
        if (like) {
          const pressed = like.getAttribute('aria-pressed') === 'true'
            || like.getAttribute('aria-checked') === 'true';
          return { state: pressed ? 'liked' : 'unliked', control: like, scope };
        }
        return { state: 'unknown', control: null, scope: null };
      };
      const reelMediaIdentity = (media) => String(
        media.currentSrc || media.src || media.getAttribute('poster')
          || media.closest('a[href^="/reel"], a[href^="/reels"]')?.href
          || `${media.tagName}:${media.id || ''}`
      );
      const requestedLikeFingerprints = new WeakMap();
      const fallbackInstagramHeart = () => {
        const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        icon.setAttribute('viewBox', '0 0 48 48');
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute(
          'd',
          'M34.6 3.1c-4.5 0-7.9 2.2-10.6 5.3-2.7-3.1-6.1-5.3-10.6-5.3C5.7 3.1 0 9.2 0 16.9c0 10.5 9.4 18.4 23.1 27.7.5.3 1.3.3 1.8 0C38.6 35.3 48 27.4 48 16.9 48 9.2 42.3 3.1 34.6 3.1Z'
        );
        icon.appendChild(path);
        return icon;
      };
      const instagramHeartFor = (media) => {
        const source = semanticLikeState(media).control?.querySelector('svg');
        if (!(source instanceof SVGElement)) return fallbackInstagramHeart();
        const icon = source.cloneNode(true);
        icon.removeAttribute('aria-label');
        icon.setAttribute('aria-hidden', 'true');
        icon.querySelectorAll('[id]').forEach((node) => node.removeAttribute('id'));
        return icon;
      };
      const showInstagramLikeHeart = (media) => {
        const restorePausedFeedback = Boolean(document.querySelector(
          '[data-vigil-instagram-playback-feedback][data-state="paused"]'
        ));
        document.querySelectorAll('[data-vigil-instagram-playback-feedback]').forEach(
          (element) => element.remove()
        );
        const rect = media.getBoundingClientRect();
        const heart = document.createElement('div');
        heart.dataset.vigilInstagramLikeHeart = 'true';
        heart.setAttribute('aria-hidden', 'true');
        heart.appendChild(instagramHeartFor(media));
        heart.style.left = `${Math.max(rect.left, Math.min(rect.right, rect.left + rect.width / 2))}px`;
        heart.style.top = `${Math.max(rect.top, Math.min(rect.bottom, rect.top + rect.height / 2))}px`;
        document.documentElement.appendChild(heart);
        let removed = false;
        const remove = () => {
          if (removed) return;
          removed = true;
          heart.remove();
          if (restorePausedFeedback && media instanceof HTMLVideoElement
              && media.isConnected && media.paused) {
            showInstagramPlaybackFeedback(media, 'paused');
          }
        };
        heart.addEventListener('animationend', remove, { once: true });
        setTimeout(remove, 900);
      };
      const requestSemanticLike = (media, expectedIdentity, expectedScope) => {
        if (!media?.isConnected) return false;
        if (reelMediaIdentity(media) !== expectedIdentity
            || semanticLikeScope(media) !== expectedScope) return false;
        const result = semanticLikeState(media);
        if (result.scope !== expectedScope) return false;
        if (result.state === 'liked') return true;
        if (result.state !== 'unliked' || !result.control
            || result.control.matches(':disabled, [aria-disabled="true"]')) return false;
        const fingerprint = reelMediaIdentity(media);
        const previousRequest = requestedLikeFingerprints.get(result.control);
        const now = performance.now();
        if (previousRequest?.fingerprint === fingerprint && now - previousRequest.time < 650) return true;
        requestedLikeFingerprints.set(result.control, { fingerprint, time: now });
        result.control.click();
        return true;
      };
      let lastHandledLikeGesture = { media: null, time: 0 };
      const restoreMediaTapState = (media, state) => {
        if (!state || !media?.isConnected) return;
        if (media.muted !== state.muted) media.muted = state.muted;
        if (typeof state.defaultMuted === 'boolean'
            && media.defaultMuted !== state.defaultMuted) media.defaultMuted = state.defaultMuted;
        if (state.paused && !media.paused) media.pause();
        if (!state.paused && media.paused
            && !window.__vigilEarlyMediaGate?.isHeld?.(media)) {
          try { media.play()?.catch?.(() => {}); } catch (_) {}
        }
      };
      const preserveMediaMuteState = (media, state) => {
        if (!state || !media?.isConnected) return;
        if (media.muted !== state.muted) media.muted = state.muted;
        if (typeof state.defaultMuted === 'boolean'
            && media.defaultMuted !== state.defaultMuted) media.defaultMuted = state.defaultMuted;
      };
      const showInstagramPlaybackFeedback = (media, state) => {
        document.querySelectorAll('[data-vigil-instagram-playback-feedback]').forEach(
          (element) => element.remove()
        );
        if (!(media instanceof HTMLVideoElement) || !media.isConnected) return;
        const rect = media.getBoundingClientRect();
        const feedback = document.createElement('div');
        feedback.dataset.vigilInstagramPlaybackFeedback = 'true';
        feedback.dataset.state = state;
        feedback.setAttribute('aria-hidden', 'true');
        const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        icon.setAttribute('viewBox', '0 0 48 48');
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', state === 'paused'
          ? 'M16 10.8v26.4c0 1.5 1.7 2.4 3 1.5l20-13.2c1.3-.8 1.3-2.7 0-3.5L19 9.3c-1.3-.9-3 .1-3 1.5Z'
          : 'M13 10h8v28h-8zm14 0h8v28h-8z');
        icon.appendChild(path);
        feedback.appendChild(icon);
        feedback.style.left = `${rect.left + rect.width / 2}px`;
        feedback.style.top = `${rect.top + rect.height / 2}px`;
        document.documentElement.appendChild(feedback);
        const remove = () => feedback.remove();
        if (state === 'playing') {
          feedback.addEventListener('animationend', remove, { once: true });
          setTimeout(remove, 650);
        } else {
          media.addEventListener('play', remove, { once: true });
        }
      };
      const performInstagramSingleTap = (event, media, originalMediaState) => {
        if (!(media instanceof HTMLVideoElement) || !originalMediaState) return;
        preserveMediaMuteState(media, originalMediaState);
        if (originalMediaState.paused) {
          if (!window.__vigilEarlyMediaGate?.isHeld?.(media)) {
            try { media.play()?.catch?.(() => {}); } catch (_) {}
            showInstagramPlaybackFeedback(media, 'playing');
          }
        } else {
          try { media.pause(); } catch (_) {}
          showInstagramPlaybackFeedback(media, 'paused');
        }
      };
      const recognizeInstagramDoubleTap = (event, media, originalMediaState = null) => {
        const now = performance.now();
        // A synthesized click/dblclick often follows the pointer pair. Consume
        // every duplicate before consulting the dedupe window so the site's own
        // handler cannot toggle mute/play or follow an app-scheme link afterward.
        if (event.cancelable) event.preventDefault();
        event.stopImmediatePropagation();
        if (lastHandledLikeGesture.media === media && now - lastHandledLikeGesture.time < 650) return;
        lastHandledLikeGesture = { media, time: now };
        // The mobile site inconsistently treats a double tap as two mute/play
        // taps and, in some builds, also follows an app-scheme link. Consume the
        // recognized second tap, restore the first tap's media state, then use
        // the existing unliked Like control rather than fabricating liked state.
        restoreMediaTapState(media, originalMediaState);
        const expectedIdentity = reelMediaIdentity(media);
        const expectedScope = semanticLikeScope(media);
        if (!expectedScope) return;
        const initialState = semanticLikeState(media).state;
        if (initialState === 'liked' || initialState === 'unliked') {
          showInstagramLikeHeart(media);
        }
        if (requestSemanticLike(media, expectedIdentity, expectedScope)) return;
        // React can mount a post's action row a frame after its media. Retry a
        // few times without ever manufacturing liked state or crossing scopes.
        let feedbackShown = initialState === 'liked' || initialState === 'unliked';
        [40, 100, 180].forEach((delay) => setTimeout(() => {
          if (!requestSemanticLike(media, expectedIdentity, expectedScope) || feedbackShown) return;
          feedbackShown = true;
          showInstagramLikeHeart(media);
        }, delay));
      };

      const reelSpeedConsumedPointers = new Set();
      const consumeReelSpeedPointer = (pointerId) => {
        if (pointerId === null || pointerId === undefined) return;
        reelSpeedConsumedPointers.add(pointerId);
        setTimeout(() => reelSpeedConsumedPointers.delete(pointerId), 900);
      };
      let reelSpeedHold = null;
      const showReelSpeedFeedback = (video) => {
        document.querySelectorAll('[data-vigil-instagram-reels-speed-feedback]').forEach(
          (element) => element.remove()
        );
        const feedback = document.createElement('div');
        feedback.dataset.vigilInstagramReelsSpeedFeedback = 'true';
        feedback.setAttribute('role', 'status');
        feedback.setAttribute('aria-label', '2 times playback speed');
        feedback.textContent = '››  2× speed  ‹‹';
        const viewport = instagramViewport();
        const container = video.closest('[data-vigil-instagram-reels-scroll="true"]');
        const card = video.closest('[data-vigil-instagram-reels-card="true"]');
        const containerRect = container?.getBoundingClientRect();
        let feedbackBottomY = containerRect?.bottom || viewport.bottom;
        const metadata = card?.querySelector('[data-vigil-instagram-reels-metadata="true"]');
        const metadataGeometry = metadata && card
          ? reelMetadataTextGeometry(metadata, card.getBoundingClientRect())
          : null;
        if (metadataGeometry) feedbackBottomY = Math.min(feedbackBottomY, metadataGeometry.top - 12);
        feedback.style.setProperty(
          '--vigil-instagram-reels-speed-feedback-bottom',
          `${Math.max(16, viewport.bottom - feedbackBottomY + 12)}px`
        );
        document.documentElement.appendChild(feedback);
        return feedback;
      };
      const restoreReelSpeedHold = (consumePointer = false) => {
        const state = reelSpeedHold;
        reelSpeedHold = null;
        if (!state) return false;
        clearTimeout(state.timer);
        if (consumePointer && state.pointerId !== null && state.pointerId !== undefined) {
          consumeReelSpeedPointer(state.pointerId);
          suppressMediaClickUntil = performance.now() + 520;
        }
        state.feedback?.remove();
        if (state.active && state.video instanceof HTMLVideoElement) {
          try { state.video.playbackRate = state.originalPlaybackRate; } catch (_) {}
        }
        return state.active;
      };
      window.__vigilRestoreReelHold = () => restoreReelSpeedHold(true);
      const instagramMediaGestureExcluded = (target, media) => {
        if (!(target instanceof Element)
            || !(media instanceof HTMLImageElement || media instanceof HTMLVideoElement)) return true;
        if (target.closest(
          '[data-vigil-instagram-reels-metadata="true"], input, textarea, select, [contenteditable="true"]'
        )) return true;
        const interactive = target.closest('button, a, [role="button"], [role="link"]');
        if (!interactive) return false;
        if (!interactive.contains(media)) return true;
        const interactiveRect = interactive.getBoundingClientRect();
        const mediaRect = media.getBoundingClientRect();
        const overlapWidth = Math.max(0,
          Math.min(interactiveRect.right, mediaRect.right) - Math.max(interactiveRect.left, mediaRect.left));
        const overlapHeight = Math.max(0,
          Math.min(interactiveRect.bottom, mediaRect.bottom) - Math.max(interactiveRect.top, mediaRect.top));
        return interactiveRect.width < 120 || interactiveRect.height < 120
          || overlapWidth * overlapHeight < mediaRect.width * mediaRect.height * 0.45;
      };
      const supportsStandardInstagramMediaGestures = (media) => {
        const path = location.pathname.toLowerCase();
        if (/^\/(?:stories|direct|accounts|challenge|checkpoint)(?:\/|$)/.test(path)) {
          return false;
        }
        if (path === '/' || path === ''
            || /^\/(?:reel|reels|p|explore)(?:\/|$)/.test(path)) return true;
        // Instagram can keep the profile URL while presenting a post in a
        // modal. Support that post surface without claiming profile-grid media.
        return Boolean(media?.closest?.(
          '[role="dialog"]:not([aria-hidden="true"]), [aria-modal="true"]:not([aria-hidden="true"])'
        ));
      };
      const armReelSpeedHold = (event, pointer) => {
        if (routeFeature(location.href) !== 'reels' || reelSpeedHold) return;
        const target = event.target;
        if (!(target instanceof Element)) return;
        const video = primaryMediaAtPoint(target, pointer.clientX, pointer.clientY);
        if (!(video instanceof HTMLVideoElement)
            || instagramMediaGestureExcluded(target, video)) return;
        const rect = video.getBoundingClientRect();
        const edgeWidth = Math.min(96, Math.max(52, rect.width * 0.2));
        const atSideEdge = pointer.clientX <= rect.left + edgeWidth
          || pointer.clientX >= rect.right - edgeWidth;
        if (!atSideEdge) return;
        const state = {
          video,
          pointerId: pointer.pointerId,
          pointerType: pointer.pointerType,
          x: pointer.clientX,
          y: pointer.clientY,
          timer: 0,
          active: false,
          originalPlaybackRate: video.playbackRate,
          feedback: null
        };
        state.timer = setTimeout(() => {
          if (reelSpeedHold !== state || !video.isConnected
              || routeFeature(location.href) !== 'reels'
              || video.paused || video.ended
              || window.__vigilEarlyMediaGate?.isHeld?.(video)) {
            restoreReelSpeedHold(true);
            return;
          }
          state.originalPlaybackRate = video.playbackRate;
          try { video.playbackRate = 2; } catch (_) {
            restoreReelSpeedHold(false);
            return;
          }
          state.active = true;
          state.feedback = showReelSpeedFeedback(video);
        }, 320);
        reelSpeedHold = state;
      };
      const moveReelSpeedHold = (pointer) => {
        const state = reelSpeedHold;
        if (!state || state.pointerId !== pointer.pointerId) return;
        const distance = Math.hypot(pointer.clientX - state.x, pointer.clientY - state.y);
        if (distance > (state.active ? 18 : 12)) restoreReelSpeedHold(true);
      };
      document.addEventListener('pointerdown', (event) => {
        if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return;
        // A route/background cancellation may never receive its matching up.
        // Clear any stale numeric ID before iOS reuses it for a new gesture.
        reelSpeedConsumedPointers.delete(event.pointerId);
        armReelSpeedHold(event, event);
      }, { capture: true, passive: true });
      document.addEventListener('pointermove', (event) => {
        moveReelSpeedHold(event);
      }, { capture: true, passive: true });
      document.addEventListener('pointerup', (event) => {
        if (reelSpeedHold?.pointerId === event.pointerId) {
          const active = reelSpeedHold.active;
          restoreReelSpeedHold(active);
          if (active) {
            reelSpeedConsumedPointers.delete(event.pointerId);
            activeMediaPointers.delete(event.pointerId);
            lastMediaTap = null;
            if (event.cancelable) event.preventDefault();
            event.stopImmediatePropagation();
          }
        }
      }, { capture: true, passive: false });
      document.addEventListener('pointercancel', (event) => {
        if (reelSpeedHold?.pointerId === event.pointerId) restoreReelSpeedHold(false);
        reelSpeedConsumedPointers.delete(event.pointerId);
      }, true);
      document.addEventListener('touchend', () => {
        if (reelSpeedHold?.pointerType === 'touch') {
          restoreReelSpeedHold(reelSpeedHold.active);
        }
      }, { capture: true, passive: true });
      document.addEventListener('touchcancel', () => {
        if (reelSpeedHold?.pointerType === 'touch') restoreReelSpeedHold(false);
      }, { capture: true, passive: true });
      document.addEventListener('contextmenu', (event) => {
        if (!reelSpeedHold?.active) return;
        if (event.cancelable) event.preventDefault();
        event.stopImmediatePropagation();
      }, true);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') restoreReelSpeedHold(true);
      });
      addEventListener('pagehide', () => restoreReelSpeedHold(true));

      const activeMediaPointers = new Map();
      const pendingMediaTaps = new Set();
      let lastMediaTap = null;
      let suppressMediaClickUntil = 0;
      const instagramDoubleTapMilliseconds = 380;
      const instagramDoubleTapDistance = 56;
      const cancelPendingMediaTap = (tap) => {
        if (!tap) return;
        tap.canceled = true;
        clearTimeout(tap.timer);
        pendingMediaTaps.delete(tap);
        if (lastMediaTap === tap) lastMediaTap = null;
      };
      const cancelAllPendingMediaTaps = () => {
        [...pendingMediaTaps].forEach(cancelPendingMediaTap);
        activeMediaPointers.clear();
        lastMediaTap = null;
        document.querySelectorAll(
          '[data-vigil-instagram-like-heart], [data-vigil-instagram-playback-feedback]'
        ).forEach((element) => element.remove());
      };
      const scheduleInstagramSingleTap = (media, mediaState, point) => {
        const tap = {
          media,
          mediaState,
          x: point.clientX,
          y: point.clientY,
          time: performance.now(),
          identity: reelMediaIdentity(media),
          canceled: false,
          timer: 0
        };
        tap.timer = setTimeout(() => {
          pendingMediaTaps.delete(tap);
          if (lastMediaTap === tap) lastMediaTap = null;
          if (tap.canceled || !media.isConnected
              || reelMediaIdentity(media) !== tap.identity) return;
          performInstagramSingleTap(null, media, mediaState);
        }, instagramDoubleTapMilliseconds);
        pendingMediaTaps.add(tap);
        lastMediaTap = tap;
        return tap;
      };
      document.addEventListener('pointerdown', (event) => {
        if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return;
        const media = primaryMediaAtPoint(event.target, event.clientX, event.clientY);
        if (!media || instagramMediaGestureExcluded(event.target, media)
            || !supportsStandardInstagramMediaGestures(media)
            || !semanticLikeScope(media)) return;
        activeMediaPointers.set(event.pointerId, {
          media, x: event.clientX, y: event.clientY, time: performance.now(),
          mediaState: media instanceof HTMLVideoElement
            ? { muted: media.muted, defaultMuted: media.defaultMuted, paused: media.paused }
            : null
        });
      }, { capture: true, passive: true });
      document.addEventListener('pointercancel', (event) => {
        activeMediaPointers.delete(event.pointerId);
        reelSpeedConsumedPointers.delete(event.pointerId);
      }, true);
      document.addEventListener('pointerup', (event) => {
        const start = activeMediaPointers.get(event.pointerId);
        activeMediaPointers.delete(event.pointerId);
        if (reelSpeedConsumedPointers.delete(event.pointerId)) {
          lastMediaTap = null;
          if (event.cancelable) event.preventDefault();
          event.stopImmediatePropagation();
          return;
        }
        if (!start) return;
        const elapsed = performance.now() - start.time;
        const deltaX = event.clientX - start.x;
        const deltaY = event.clientY - start.y;
        const distance = Math.hypot(deltaX, deltaY);
        if (elapsed > 420 || distance > 18) {
          cancelPendingMediaTap(lastMediaTap);
          return;
        }
        const media = primaryMediaAtPoint(event.target, event.clientX, event.clientY) || start.media;
        const now = performance.now();
        if (lastMediaTap && lastMediaTap.media === media
            && now - lastMediaTap.time >= 20
            && now - lastMediaTap.time <= instagramDoubleTapMilliseconds
            && Math.hypot(event.clientX - lastMediaTap.x, event.clientY - lastMediaTap.y)
              <= instagramDoubleTapDistance) {
          suppressMediaClickUntil = now + 520;
          const firstTapState = lastMediaTap.mediaState;
          cancelPendingMediaTap(lastMediaTap);
          recognizeInstagramDoubleTap(event, media, firstTapState);
          return;
        }
        suppressMediaClickUntil = now + 560;
        if (event.cancelable) event.preventDefault();
        event.stopImmediatePropagation();
        cancelPendingMediaTap(lastMediaTap);
        scheduleInstagramSingleTap(media, start.mediaState, event);
      }, { capture: true, passive: false });
      document.addEventListener('click', (event) => {
        const media = primaryMediaAtPoint(event.target, event.clientX, event.clientY);
        if (!media || instagramMediaGestureExcluded(event.target, media)
            || !supportsStandardInstagramMediaGestures(media)
            || !semanticLikeScope(media)) return;
        if (event.detail >= 2 || performance.now() <= suppressMediaClickUntil) {
          if (event.cancelable) event.preventDefault();
          event.stopImmediatePropagation();
          if (event.detail >= 2) recognizeInstagramDoubleTap(event, media);
        }
      }, true);
      document.addEventListener('dblclick', (event) => {
        const media = primaryMediaAtPoint(event.target, event.clientX, event.clientY);
        if (!media || instagramMediaGestureExcluded(event.target, media)
            || !supportsStandardInstagramMediaGestures(media)
            || !semanticLikeScope(media)) return;
        recognizeInstagramDoubleTap(event, media);
      }, true);
      document.addEventListener('__vigilRouteChanged', cancelAllPendingMediaTaps);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') cancelAllPendingMediaTaps();
      });
      addEventListener('pagehide', cancelAllPendingMediaTaps);

      const instagramRoute = () => {
        const path = location.pathname.toLowerCase();
        if (path === '/' || path === '') return 'feed';
        if (path === '/reel' || path.startsWith('/reel/')
            || path === '/reels' || path.startsWith('/reels/')) return 'reels';
        if ([
          '/accounts/login', '/accounts/emailsignup', '/accounts/signup',
          '/accounts/password', '/accounts/onetap'
        ].some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) return 'login';
        if ([
          '/challenge', '/checkpoint', '/accounts/challenge', '/accounts/confirm',
          '/accounts/two_factor', '/accounts/verification', '/accounts/suspended',
          '/accounts/disabled'
        ].some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) return 'challenge';
        if (path === '/stories' || path.startsWith('/stories/')) return 'story';
        if (path === '/direct/t' || path.startsWith('/direct/t/')) return 'directThread';
        if (path === '/direct' || path.startsWith('/direct/')) return 'directInbox';
        if (path === '/p' || path.startsWith('/p/')) return 'post';
        if (path === '/explore' || path.startsWith('/explore/')) return 'search';
        if (/^\/[^/]+\/?$/.test(path) && !path.startsWith('/accounts')) return 'profile';
        return 'other';
      };
      const blockingModalVisible = () => [...document.querySelectorAll(
        '[role="dialog"]:not([aria-hidden="true"]), [aria-modal="true"]:not([aria-hidden="true"])'
      )].some(visibleElement);
      let lastSurfaceState = '';
      const reportSurface = () => {
        const underlyingRoute = instagramRoute();
        const modal = underlyingRoute === 'reels'
          ? [...document.querySelectorAll(
              '[role="dialog"]:not([aria-hidden="true"]), [aria-modal="true"]:not([aria-hidden="true"])'
            )].some((dialog) => isInstagramCommentsDialog(dialog))
          : blockingModalVisible();
        const route = modal ? 'modal' : underlyingRoute;
        const blocksRefresh = modal || underlyingRoute === 'story'
          || underlyingRoute === 'directInbox' || underlyingRoute === 'directThread'
          || underlyingRoute === 'reels';
        const refreshEligible = !blocksRefresh && underlyingRoute === 'feed';
        const fullBleedTop = underlyingRoute === 'reels' || underlyingRoute === 'story';
        const state = JSON.stringify({ route, refreshEligible, blocksRefresh, fullBleedTop });
        if (state === lastSurfaceState) return;
        lastSurfaceState = state;
        window.__vigilBridge({
          type: 'surface',
          service: 'instagram',
          route,
          refreshEligible,
          blocksRefresh,
          fullBleedTop
        });
      };

      const instagramHealthSelectors = Object.freeze({
        feed: [
          'main article', 'article', 'main a[href^="/stories/"]',
          'main a[href^="/p/"]'
        ],
        login: [
          'form[action*="/accounts/login"]', 'input[name="username"]',
          'input[name="password"]', 'button[type="submit"]',
          'a[href*="/accounts/password"]'
        ],
        challenge: [
          'form', 'input[autocomplete="one-time-code"]', 'input[name*="code" i]',
          'button[type="submit"]'
        ],
        story: [
          'video', 'img', 'main video', 'main img', 'section video', 'section img',
          '[role="dialog"] video', '[role="dialog"] img',
          'button[aria-label*="next" i]', 'button[aria-label*="previous" i]'
        ],
        reels: [
          'main video', 'article video', '[role="dialog"] video',
          'main img', 'article img', '[role="dialog"] img',
          'a[href^="/reel/"]'
        ],
        directInbox: [
          'main textarea', 'main input', 'main a[href^="/direct/t/"]',
          '[role="main"] textarea', '[role="main"] input'
        ],
        directThread: [
          'main textarea', 'main input', 'main a[href^="/direct/t/"]',
          '[role="main"] textarea', '[role="main"] input'
        ],
        post: [
          'main article', 'article', 'main video', 'main img'
        ],
        search: [
          'input[placeholder*="search" i]', 'main a[href^="/p/"]',
          'main article'
        ],
        profile: [
          'main header', 'main a[href^="/p/"]', 'main article'
        ],
        other: ['form', 'article', 'video', 'img']
      });
      const instagramHealthCandidateSelector = [
        'main', '[role="main"]', 'form', 'article', 'section', 'img', 'video',
        'input', 'textarea', 'button', '[role="button"]',
        '[role="dialog"]', '[aria-modal="true"]',
        'a[href^="/stories/"]', 'a[href^="/p/"]', 'a[href^="/direct/"]'
      ].join(', ');
      const elementHasBoundedText = (element, maximumNodes = 32, maximumCharacters = 512) => {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        let inspected = 0;
        let characters = 0;
        const pieces = [];
        while (inspected < maximumNodes && characters < maximumCharacters) {
          const node = walker.nextNode();
          if (!node) break;
          inspected += 1;
          const parent = node.parentElement;
          if (!parent
              || parent.closest('script, style, noscript, template, [hidden], [aria-hidden="true"]')
              || !visibleElement(parent)) continue;
          const value = String(node.nodeValue || '').replace(/\s+/g, ' ').trim();
          if (!value) continue;
          const remaining = maximumCharacters - characters;
          pieces.push(value.slice(0, remaining));
          characters += Math.min(value.length, remaining);
        }
        const text = pieces.join(' ').replace(/\s+/g, ' ').trim().toLowerCase();
        if (text.length < 2) return false;
        return !/^(?:loading|please wait|just a moment|fetching|retrying)(?:[\s.…!-].*)?$/i.test(text);
      };
      const healthElementLooksUsable = (element) => {
        if (!visibleElement(element)) return false;
        if (element.matches(
          'img, video, canvas, iframe, input, textarea, select, button, [role="button"]'
        )) return true;
        if (elementHasBoundedText(element)) return true;
        const control = element.querySelector(
          'img, video, input, textarea, select, button, a[href], [role="button"]'
        );
        return Boolean(control && visibleElement(control));
      };
      const healthElementIsActionableOrMedia = (element) => {
        if (!visibleElement(element)) return false;
        const actionableSelector = [
          'img', 'video', 'canvas', 'iframe', 'input', 'textarea', 'select',
          'button', 'a[href]', '[role="button"]'
        ].join(', ');
        if (element.matches(actionableSelector)) return true;
        let inspected = 0;
        for (const control of element.querySelectorAll(actionableSelector)) {
          inspected += 1;
          if (visibleElement(control)) return true;
          if (inspected >= 32) break;
        }
        return false;
      };
      const firstUsableHealthElement = (selectors, root = document, maximum = 64) => {
        let inspected = 0;
        for (const selector of selectors) {
          for (const element of root.querySelectorAll(selector)) {
            inspected += 1;
            if (healthElementLooksUsable(element)) return element;
            if (inspected >= maximum) return null;
          }
        }
        return null;
      };
      const firstActionableHealthElement = (selectors, root = document, maximum = 64) => {
        let inspected = 0;
        for (const selector of selectors) {
          for (const element of root.querySelectorAll(selector)) {
            inspected += 1;
            if (healthElementIsActionableOrMedia(element)) return element;
            if (inspected >= maximum) return null;
          }
        }
        return null;
      };
      const boundedPageText = (maximumNodes = 160, maximumCharacters = 16_000) => {
        if (!document.body) return '';
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        const pieces = [];
        let nodeCount = 0;
        let characterCount = 0;
        while (nodeCount < maximumNodes && characterCount < maximumCharacters) {
          const node = walker.nextNode();
          if (!node) break;
          nodeCount += 1;
          const parent = node.parentElement;
          if (!parent
              || parent.closest('script, style, noscript, template, [hidden], [aria-hidden="true"]')
              || !visibleElement(parent)) continue;
          const value = String(node.nodeValue || '').replace(/\s+/g, ' ').trim();
          if (!value) continue;
          const remaining = maximumCharacters - characterCount;
          pieces.push(value.slice(0, remaining));
          characterCount += Math.min(value.length, remaining);
        }
        return pieces.join(' ').toLowerCase();
      };
      const visibleBlockingModal = () => {
        let inspected = 0;
        for (const modal of document.querySelectorAll(
          '[role="dialog"]:not([aria-hidden="true"]), [aria-modal="true"]:not([aria-hidden="true"])'
        )) {
          inspected += 1;
          if (visibleElement(modal)) return modal;
          if (inspected >= 12) break;
        }
        return null;
      };
      const authenticationSelectors = [
        'form[action*="/accounts/login"]', 'input[name="username"]',
        'input[name="password"]', 'a[href*="/accounts/login"]'
      ];
      const challengeSignalPattern = /challenge_required|checkpoint_required|security code|confirmation code|confirm (?:it.s|it's) you|suspicious login|help us confirm/;
      const failureSignalPattern = /sorry,? something went wrong|there was a problem loading|page isn.t available|please wait a few minutes before you try again|unable to load/;
      const hasUsableChallengeControls = () => {
        const containerSelector = [
          'form', '[role="dialog"]', '[aria-modal="true"]',
          '[data-testid*="challenge" i]', '[id*="challenge" i]', '[class*="challenge" i]'
        ].join(', ');
        const codeInputSelector = [
          'input[autocomplete="one-time-code"]', 'input[name*="code" i]',
          'input[inputmode="numeric"]', 'input[type="tel"]'
        ].join(', ');
        let inspectedContainers = 0;
        for (const container of document.querySelectorAll(containerSelector)) {
          inspectedContainers += 1;
          if (!visibleElement(container)) {
            if (inspectedContainers >= 32) break;
            continue;
          }
          let inspectedInputs = 0;
          for (const input of container.querySelectorAll(codeInputSelector)) {
            inspectedInputs += 1;
            if (visibleElement(input)) return true;
            if (inspectedInputs >= 16) break;
          }
          const text = String(container.innerText || container.textContent || '')
            .replace(/\s+/g, ' ').trim().toLowerCase();
          if (!challengeSignalPattern.test(text)) {
            if (inspectedContainers >= 32) break;
            continue;
          }
          let inspectedControls = 0;
          for (const control of container.querySelectorAll(
            'button, button[type="submit"], input[type="submit"], [role="button"]'
          )) {
            inspectedControls += 1;
            const label = String(
              control.innerText || control.value || control.getAttribute('aria-label') || ''
            ).replace(/\s+/g, ' ').trim().toLowerCase();
            if (visibleElement(control)
                && /^(continue|confirm|verify|next|submit|send(?: security)? code)$/.test(label)) return true;
            if (inspectedControls >= 24) break;
          }
          if (inspectedContainers >= 32) break;
        }
        return false;
      };
      const hasStrongInstagramContent = (route, pageText) => {
        if (route === 'challenge' || challengeSignalPattern.test(pageText)) {
          return hasUsableChallengeControls();
        }
        const modal = visibleBlockingModal();
        if (modal && firstActionableHealthElement(
          ['form', 'input', 'textarea', 'select', 'button', 'a[href]', '[role="button"]'],
          modal,
          32
        )) return true;
        const routeSelectors = instagramHealthSelectors[route] || instagramHealthSelectors.other;
        if (firstActionableHealthElement(routeSelectors)) return true;
        if ((route === 'feed' || route === 'login' || route === 'other')
            && firstActionableHealthElement(authenticationSelectors)) return true;
        return false;
      };
      const hasSemanticInstagramContent = (route) => {
        const selectors = instagramHealthSelectors[route] || instagramHealthSelectors.other;
        if (route === 'feed' || route === 'post') {
          return Boolean(firstActionableHealthElement(selectors));
        }
        return Boolean(firstUsableHealthElement(selectors));
      };
      const healthRouteLabel = (route) => ({
        feed: 'feed',
        login: 'login',
        challenge: 'security-check',
        story: 'story',
        reels: 'Reels',
        directInbox: 'messages',
        directThread: 'conversation',
        post: 'post',
        search: 'search',
        profile: 'profile',
        other: 'page'
      })[route] || 'page';
      let lastHealthState = '';
      let healthTimer = 0;
      let healthRouteKey = '';
      let blankStartedAt = 0;
      const publishHealth = (state, detail = '') => {
        const next = `${state}:${detail}`;
        if (next === lastHealthState) return;
        lastHealthState = next;
        window.__vigilBridge({ type: 'health', state, detail });
      };
      const scheduleHealth = (delay = 400, restart = false) => {
        if (healthTimer && !restart) return;
        if (healthTimer) clearTimeout(healthTimer);
        healthTimer = setTimeout(reportHealth, delay);
      };
      const reportHealth = () => {
        healthTimer = 0;
        const route = instagramRoute();
        const routeKey = `${route}:${location.pathname}:${location.search}`;
        const now = Date.now();
        if (routeKey !== healthRouteKey) {
          healthRouteKey = routeKey;
          blankStartedAt = now;
        }
        const pageText = boundedPageText();
        const challengeSignaled = challengeSignalPattern.test(pageText);
        const failureSignaled = failureSignalPattern.test(pageText);
        if (hasStrongInstagramContent(route, pageText)
            || (route !== 'challenge' && !challengeSignaled && !failureSignaled
              && hasSemanticInstagramContent(route))) {
          blankStartedAt = 0;
          publishHealth('ready', '');
          return;
        }
        if (!blankStartedAt) blankStartedAt = now;
        const graceMilliseconds = route === 'login' || route === 'challenge'
          ? 6000
          : route === 'story'
            ? 5000
            : 4500;
        const remaining = graceMilliseconds - (now - blankStartedAt);
        if (remaining > 0) {
          scheduleHealth(Math.min(remaining + 20, 1200));
          return;
        }
        if (route === 'challenge' || challengeSignaled) {
          publishHealth(
            'unsupported',
            'Instagram requested a security check but did not provide usable verification controls.'
          );
          return;
        }
        if (failureSignaled) {
          publishHealth(
            'degraded',
            `Instagram reported an error instead of a usable ${healthRouteLabel(route)} surface.`
          );
          return;
        }
        publishHealth(
          'degraded',
          `Instagram has not loaded a usable ${healthRouteLabel(route)} surface yet.`
        );
      };

      const reconcile = (requestedRoot = document, normalizeNavigation = false) => {
        const root = requestedRoot instanceof Element
          ? requestedRoot.closest('[data-vigil-hidden-feature], [data-vigil-native-app-prompt]') || requestedRoot
          : requestedRoot;
        elementsWithin(root, '[data-vigil-hidden-feature], [data-vigil-native-app-prompt]')
          .forEach((node) => {
            node.removeAttribute('data-vigil-hidden-feature');
            node.removeAttribute('data-vigil-native-app-prompt');
          });

        const promptControls = elementsWithin(root, 'a, button, [role="button"]').filter((node) => {
          const label = String(node.textContent || node.getAttribute('aria-label') || '').trim().toLowerCase();
          return label === 'open instagram' || label === 'get the instagram app' || label === 'download the app';
        });
        promptControls.forEach((node) => {
          node.dataset.vigilNativeAppPrompt = 'true';
        });

        if (document.documentElement.getAttribute('data-vigil-feature-suggested') !== 'available') {
          elementsWithin(root, 'article, [data-testid*="suggested" i]').forEach((node) => {
            const container = node.closest('article') || node;
            if (hasExactLeafLabel(container, 'suggested for you') || container.querySelector?.('a[href*="/explore/people/suggested"]')
                || node.matches?.('[data-testid*="suggested" i]')) {
              container.dataset.vigilHiddenFeature = 'suggested';
            }
          });
        }
        if (document.documentElement.getAttribute('data-vigil-feature-ads') !== 'available') {
          elementsWithin(root, 'article, [data-testid*="sponsored" i], [data-testid*="ad-container" i]').forEach((node) => {
            const container = node.closest('article') || node;
            if (hasExactLeafLabel(container, 'sponsored') || node.matches?.('[data-testid*="sponsored" i], [data-testid*="ad-container" i]')) {
              container.dataset.vigilHiddenFeature = 'ads';
            }
          });
        }
        if (normalizeNavigation || elementsWithin(root, 'a[href^="/reels"], a[href^="/direct"]').length) {
          normalizeBottomNavigation();
        }
        normalizeCommentSheets();
        if (normalizeNavigation) scheduleReelSurfaceNormalization();
      };
      let reconcileScheduled = false;
      let fullReconcileRequested = false;
      const reconcileRoots = new Set();
      const scheduleReconcile = (root = null, full = false) => {
        if (full) {
          fullReconcileRequested = true;
          reconcileRoots.clear();
        }
        if (root instanceof Element && !fullReconcileRequested) {
          let covered = false;
          for (const existing of reconcileRoots) {
            if (existing.contains(root)) {
              covered = true;
              break;
            }
            if (root.contains(existing)) reconcileRoots.delete(existing);
          }
          if (!covered) reconcileRoots.add(root);
          if (reconcileRoots.size >= 24) {
            fullReconcileRequested = true;
            reconcileRoots.clear();
          }
        }
        if (reconcileScheduled) return;
        reconcileScheduled = true;
        requestAnimationFrame(() => {
          reconcileScheduled = false;
          if (fullReconcileRequested || !reconcileRoots.size) {
            reconcile(document, true);
          } else {
            [...reconcileRoots].forEach((candidate) => reconcile(candidate));
          }
          fullReconcileRequested = false;
          reconcileRoots.clear();
          reportSurface();
        });
      };
      reconcile(document, true);
      reportSurface();
      new MutationObserver((records) => {
        // React routers can call a History function captured before this
        // adapter installed. Coalesce URL enforcement into this already-bounded
        // observer rather than scanning the document for route state.
        if (location.href !== lastPolicyRouteURL) scheduleRoutePolicyCheck();
        let onlyRemoval = true;
        let healthRelevant = false;
        records.forEach((record) => {
          if (record.type === 'attributes') {
            onlyRemoval = false;
            scheduleReconcile(record.target);
            if (record.target.matches?.(instagramHealthCandidateSelector)
                || record.target.closest?.(instagramHealthCandidateSelector)) healthRelevant = true;
            if (record.target.matches?.('video, img, source, picture')
                || record.attributeName === 'aria-expanded') {
              scheduleReelSurfaceNormalization();
            }
          }
          record.addedNodes?.forEach((node) => {
            onlyRemoval = false;
            if (node instanceof Element) {
              scheduleReconcile(node);
              if (node.matches(instagramHealthCandidateSelector)
                  || node.querySelector(instagramHealthCandidateSelector)) healthRelevant = true;
              if (node.matches('video, img, source, picture')
                  || node.querySelector('video, img, source, picture')) {
                scheduleReelSurfaceNormalization();
              }
              if (routeFeature(location.href) === 'reels'
                  && node.closest?.('[data-vigil-instagram-reels-card="true"]')) {
                scheduleReelSurfaceNormalization();
              }
            } else if (node.parentElement) {
              scheduleReconcile(node.parentElement);
              if (node.parentElement.closest(instagramHealthCandidateSelector)) healthRelevant = true;
            }
          });
          record.removedNodes?.forEach((node) => {
            if (node instanceof Element
                && (node.matches(instagramHealthCandidateSelector)
                  || node.querySelector(instagramHealthCandidateSelector))) healthRelevant = true;
            if (node instanceof Element
                && (node.matches('video, img, source, picture')
                  || node.querySelector('video, img, source, picture'))) {
              scheduleReelSurfaceNormalization();
            }
          });
        });
        if (reelSpeedHold?.video && !reelSpeedHold.video.isConnected) {
          restoreReelSpeedHold(true);
        }
        if (onlyRemoval) requestAnimationFrame(reportSurface);
        if (healthRelevant) scheduleHealth(450);
      }).observe(document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: [
          'href', 'aria-label', 'aria-hidden', 'aria-modal', 'aria-expanded',
          'open', 'hidden', 'class', 'style',
          'src', 'srcset', 'sizes', 'poster'
        ]
      });
      document.addEventListener('__vigilPolicyFeaturesChanged', () => {
        scheduleReconcile(null, true);
        scheduleHealth(450);
      });
      const instagramRouteChanged = () => {
        restoreReelSpeedHold(true);
        reportSurface();
        scheduleReconcile(null, true);
        scheduleReelSurfaceNormalization(true);
        scheduleHealth(250, true);
        setTimeout(() => scheduleHealth(0, true), 2600);
      };
      document.addEventListener('__vigilRouteChanged', instagramRouteChanged);
      document.addEventListener('__vigilPageVerdictChanged', () => scheduleHealth(0, true));
      addEventListener('pageshow', () => {
        reportSurface();
        scheduleReelSurfaceNormalization();
        scheduleHealth(100, true);
      });
      window.visualViewport?.addEventListener('resize', scheduleReelSurfaceNormalization, {
        passive: true
      });
      // A speculative Reels document competes with Instagram's initial feed
      // resources on a cold connection. Keep pointer-down warming immediate,
      // but do background warming only after the first page has fully loaded
      // and enjoyed an additional quiet window.
      const scheduleBackgroundReelsWarmup = () => {
        setTimeout(scheduleReelsWarmup, 4000);
      };
      if (document.readyState === 'complete') scheduleBackgroundReelsWarmup();
      else addEventListener('load', scheduleBackgroundReelsWarmup, { once: true });
      // The adapter and its fail-closed feature CSS are installed by this point.
      // Inspect the already-present shell immediately instead of adding a fixed
      // half-second to every cold launch.
      scheduleHealth(0);
      setTimeout(() => scheduleHealth(0, true), 3500);
      setTimeout(() => scheduleHealth(0, true), 7000);
    })();
    """#

}
