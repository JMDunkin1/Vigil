import Foundation

enum DOMAdapters {
    static var contentFilterBootstrap: String {
        contentFilterBootstrap(for: .conceal)
    }

    static func documentStartScript(
        unclassifiedMediaPolicy: UnclassifiedMediaPolicy,
        audioEnabled: Bool
    ) -> String {
        documentIdentityBootstrap
            + contentFilterBootstrap(for: unclassifiedMediaPolicy)
            + earlyMediaGate(audioEnabled: audioEnabled)
    }

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

    static func earlyMediaGate(audioEnabled: Bool) -> String {
        let preference = audioEnabled ? "true" : "false"
        return #"""
    (() => {
      const configuredAudioPreference = AUDIO_PREFERENCE;
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
      const desiredRuntimeMute = (state) => (
        state.mutedExplicitlySet ? state.desiredMuted : state.desiredDefaultMuted
      );
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
          audioPreferred ? desiredRuntimeMute(state) : true
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
            audioPreferred ? desiredRuntimeMute(state) : true
          );
        } else {
          setPhysicalMute(media, state, true);
        }
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
              descriptor.set.call(this, state.allowed && audioPreferred ? Boolean(value) : true);
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
    """#.replacingOccurrences(of: "AUDIO_PREFERENCE", with: preference)
    }

    static func script(for service: SocialService, audioEnabled: Bool) -> String {
        frameSafetyScript(audioEnabled: audioEnabled)
            + frameRoutePolicyGuard(for: service)
            + controlsScript(for: service)
    }

    static func frameSafetyScript(audioEnabled: Bool) -> String {
        common(audioEnabled: audioEnabled)
    }

    static func controlsScript(for service: SocialService) -> String {
        lockdownProbe(service) + serviceScript(service)
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
            if (path === '/reel' || path.startsWith('/reel/')
                || path === '/reels' || path.startsWith('/reels/')) {
              return { feature: 'reels', mode: 'redirect', permanent: false };
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
            if (path === '/explore' || path.startsWith('/explore/')) {
              return { feature: 'explore', mode: 'redirect', permanent: false };
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
              const probes = featureKeys.map(async (key) => {
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
                  if (current === request) publish(key, !accepted);
                } catch (_) {
                  if (current === request) publish(key, true);
                }
              });
              // Publish each feature as soon as its own sentinel resolves. A slow
              // optional probe must not leave unrelated available surfaces hidden.
              await Promise.allSettled(probes);
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
              }, { rootMargin: '900px', threshold: 0.01 });
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
                if (media) applyAudioPreference(media);
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
        html:is([data-vigil-feature-ads="blocked"], [data-vigil-feature-ads="pending"]) ytm-in-feed-ad-layout-renderer,
        html:is([data-vigil-feature-ads="blocked"], [data-vigil-feature-ads="pending"]) [data-is-ad="true"] {
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
            const playerBonus = video.closest('ytm-player, #player, .html5-video-player, ytm-watch') ? 10_000_000 : 0;
            return playerBonus + Math.min(rect.width, innerWidth) * Math.min(rect.height, innerHeight);
          };
          return score(right) - score(left);
        })[0] || null;
      };
      const savePlayback = (force = false) => {
        const video = attachedVideo;
        const key = attachedVideoKey;
        if (!video || !key || !Number.isFinite(video.currentTime) || video.currentTime < 0.5) return;
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
              || !Number.isFinite(position) || position < 2) return;
          const apply = () => {
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
      const healthVisibilitySelector = `${healthContentSelector}, `
        + `${youtubeTopbarSelector}, ${youtubeNavigationSelector}, `
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
          ? mainVideo() || firstVisibleYouTubeElement('ytm-player, #player')
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
            + 'ytm-promoted-video-renderer, ytm-ad-slot-renderer, ytm-in-feed-ad-layout-renderer, [data-is-ad="true"]'
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
        return !current;
      };
      const instagramRoute = () => {
        const path = location.pathname.toLowerCase();
        if (path === '/' || path === '') return 'feed';
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
        if (path === '/direct' || path.startsWith('/direct/')) return 'direct';
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
        const modal = blockingModalVisible();
        const route = modal ? 'modal' : underlyingRoute;
        const blocksRefresh = modal || underlyingRoute === 'story' || underlyingRoute === 'direct';
        const refreshEligible = !blocksRefresh && underlyingRoute === 'feed';
        const state = JSON.stringify({ route, refreshEligible, blocksRefresh });
        if (state === lastSurfaceState) return;
        lastSurfaceState = state;
        window.__vigilBridge({
          type: 'surface',
          service: 'instagram',
          route,
          refreshEligible,
          blocksRefresh
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
        direct: [
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
        direct: 'messages',
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
          }
          record.addedNodes?.forEach((node) => {
            onlyRemoval = false;
            if (node instanceof Element) {
              scheduleReconcile(node);
              if (node.matches(instagramHealthCandidateSelector)
                  || node.querySelector(instagramHealthCandidateSelector)) healthRelevant = true;
            } else if (node.parentElement) {
              scheduleReconcile(node.parentElement);
              if (node.parentElement.closest(instagramHealthCandidateSelector)) healthRelevant = true;
            }
          });
          record.removedNodes?.forEach((node) => {
            if (node instanceof Element
                && (node.matches(instagramHealthCandidateSelector)
                  || node.querySelector(instagramHealthCandidateSelector))) healthRelevant = true;
          });
        });
        if (onlyRemoval) requestAnimationFrame(reportSurface);
        if (healthRelevant) scheduleHealth(450);
      }).observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: [
          'href', 'aria-label', 'aria-hidden', 'aria-modal',
          'open', 'hidden', 'class', 'style'
        ]
      });
      document.addEventListener('__vigilPolicyFeaturesChanged', () => {
        scheduleReconcile(null, true);
        scheduleHealth(450);
      });
      const instagramRouteChanged = () => {
        scheduleReconcile(null, true);
        scheduleHealth(250, true);
        setTimeout(() => scheduleHealth(0, true), 2600);
      };
      document.addEventListener('__vigilRouteChanged', instagramRouteChanged);
      document.addEventListener('__vigilPageVerdictChanged', () => scheduleHealth(0, true));
      addEventListener('pageshow', () => {
        reportSurface();
        scheduleHealth(100, true);
      });
      scheduleHealth(500);
      setTimeout(() => scheduleHealth(0, true), 3500);
      setTimeout(() => scheduleHealth(0, true), 7000);
    })();
    """#

}
