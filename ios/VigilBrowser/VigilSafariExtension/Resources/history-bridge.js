(() => {
  "use strict";

  const bridgeVersion = "main-v1";
  const navigationEvent = "vigil-history-navigation";
  const readyEvent = "vigil-history-bridge-ready";

  try {
    const root = document.documentElement;
    if (!root) return;

    const URLConstructor = URL;
    const CustomEventConstructor = CustomEvent;
    const EventConstructor = Event;
    const apply = Reflect.apply;
    const defineProperty = Object.defineProperty;
    const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
    const pageLocation = location;
    const pageDocument = document;
    const baseURIGetter = getOwnPropertyDescriptor(Node.prototype, "baseURI")?.get;
    const urlHrefGetter = getOwnPropertyDescriptor(URLConstructor.prototype, "href")?.get;
    if (typeof baseURIGetter !== "function" || typeof urlHrefGetter !== "function") return;
    const originalPushState = History.prototype.pushState;
    const originalReplaceState = History.prototype.replaceState;
    const dispatch = document.dispatchEvent.bind(document);
    const guarded = original => function vigilGuardedHistoryState(...args) {
      let destination = pageLocation.href;
      if (args.length >= 3 && args[2] != null) {
        const serialized = `${args[2]}`;
        if (serialized) {
          const baseURL = apply(baseURIGetter, pageDocument, []);
          destination = apply(urlHrefGetter, new URLConstructor(serialized, baseURL), []);
          if (typeof destination !== "string") return undefined;
          args[2] = destination;
        } else {
          args[2] = serialized;
        }
      }
      const event = new CustomEventConstructor(navigationEvent, {
        bubbles: true,
        cancelable: true,
        detail: destination
      });
      if (!dispatch(event)) return undefined;
      return apply(original, this, args);
    };

    defineProperty(History.prototype, "pushState", {
      configurable: false,
      enumerable: false,
      value: guarded(originalPushState),
      writable: false
    });
    defineProperty(History.prototype, "replaceState", {
      configurable: false,
      enumerable: false,
      value: guarded(originalReplaceState),
      writable: false
    });
    root.dataset.vigilHistoryBridge = bridgeVersion;
    dispatch(new EventConstructor(readyEvent, { bubbles: true }));
  } catch {
    // The isolated content script keeps the document concealed and renders a
    // fail-closed Vigil surface if this page-world bridge cannot be installed.
  }
})();
