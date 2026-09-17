(() => {
  "use strict";
  if (globalThis.__vigilContentSafetyInstalled) return;
  globalThis.__vigilContentSafetyInstalled = true;

  const nativeApplication = "tech.caseline.vigil.browser";
  const isWebKitBrowser = Boolean(globalThis.webkit?.messageHandlers?.vigilContentSafety);
  const frameID = globalThis.crypto.randomUUID();
  const style = document.createElement("style");
  style.id = "vigil-content-safety-style";
  style.textContent = `
    img, video { filter: blur(32px) !important; }
    canvas, svg, object, embed, input[type="image"] { visibility: hidden !important; }
    *, *::before, *::after {
      background-image: none !important;
      border-image-source: none !important;
      list-style-image: none !important;
      -webkit-mask-image: none !important;
      mask-image: none !important;
      content: normal !important;
    }
    [data-vigil-media-verdict="safe"] { filter: none !important; }
    [data-vigil-media-verdict="sensitive"] { filter: blur(48px) !important; visibility: hidden !important; }
    html[data-vigil-page-verdict="sensitive"] body,
    html[data-vigil-page-verdict="unknown"] body { visibility: hidden !important; }
  `;
  (document.head || document.documentElement).appendChild(style);
  document.documentElement.dataset.vigilPageVerdict = "unknown";

  // ID lookup must not keep detached feed items and their DOM subtrees alive.
  const mediaElements = new Map();
  const waitingForMedia = new WeakSet();
  let nextMediaID = 1;
  let nextMediaToken = 1;
  let textRevision = 0;
  let inspectionScheduled = false;
  let textRetryTimer = null;
  let textRetryAttempts = 0;

  const sendNative = payload => {
    if (isWebKitBrowser) {
      globalThis.webkit.messageHandlers.vigilContentSafety.postMessage({ ...payload, frameID });
      return Promise.resolve(null);
    }
    return browser.runtime.sendNativeMessage(nativeApplication, payload);
  };

  const capture = element => {
    try {
      const width = Math.max(1, Math.min(1024, element.naturalWidth || element.videoWidth || element.clientWidth || 1));
      const height = Math.max(1, Math.min(1024, element.naturalHeight || element.videoHeight || element.clientHeight || 1));
      if (width < 32 || height < 32) return null;
      const scale = Math.min(1, 1024 / Math.max(width, height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      canvas.getContext("2d", { alpha: false })?.drawImage(element, 0, 0, canvas.width, canvas.height);
      const dataURL = canvas.toDataURL("image/jpeg", 0.82);
      return dataURL.length <= 4 * 1024 * 1024 * 1.38 ? dataURL : null;
    } catch { return null; }
  };

  globalThis.__vigilResolveMedia = (id, token, verdict) => {
    const element = mediaElements.get(String(id))?.deref();
    if (!element || element.dataset.vigilMediaToken !== String(token)
        || !["safe", "sensitive", "unknown"].includes(verdict)) return;
    if (element.dataset.vigilMediaVerdict === "sensitive") return;
    element.dataset.vigilMediaVerdict = verdict;
  };

  const submitMedia = element => {
    if (!(element instanceof HTMLImageElement || element instanceof HTMLVideoElement)) return;
    const fingerprint = element instanceof HTMLVideoElement
      ? String(element.currentSrc || element.poster || "")
      : String(element.currentSrc || element.src || "");
    let id = element.dataset.vigilMediaId;
    if (!id) {
      id = String(nextMediaID++);
      element.dataset.vigilMediaId = id;
    }
    if (mediaElements.get(id)?.deref() !== element) mediaElements.set(id, new WeakRef(element));
    if (element instanceof HTMLImageElement && element.dataset.vigilMediaFingerprint === fingerprint) return;
    if (element.dataset.vigilMediaFingerprint !== fingerprint) {
      element.dataset.vigilMediaFingerprint = fingerprint;
      element.dataset.vigilMediaVerdict = "unknown";
    }
    const token = String(nextMediaToken++);
    element.dataset.vigilMediaToken = token;
    const dataURL = capture(element);
    const payload = {
      type: "classifyMedia", id, token,
      kind: element instanceof HTMLVideoElement ? "videoFrame" : "image",
      // Never reveal a moving video based only on its poster.
      dataURL: dataURL || ""
    };
    sendNative(payload).then(response => {
      if (!isWebKitBrowser) globalThis.__vigilResolveMedia(id, token, response?.verdict || "unknown");
    }).catch(() => globalThis.__vigilResolveMedia(id, token, "unknown"));
  };

  const extractText = limit => {
    if (!document.body) return { text: "", wasTruncated: false };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: node => {
        const parent = node.parentElement;
        return !parent || ["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"].includes(parent.tagName)
          ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      }
    });
    const pieces = [];
    let length = 0;
    let wasTruncated = false;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const value = String(node.nodeValue || "").replace(/\s+/g, " ").trim();
      if (!value) continue;
      if (length + value.length + 1 > limit) {
        pieces.push(value.slice(0, Math.max(0, limit - length)));
        wasTruncated = true;
        break;
      }
      pieces.push(value);
      length += value.length + 1;
    }
    return { text: pieces.join("\n"), wasTruncated };
  };

  const scheduleTextRetry = revision => {
    if (textRetryTimer !== null || textRetryAttempts >= 3) return;
    textRetryTimer = setTimeout(() => {
      textRetryTimer = null;
      if (String(revision) === String(textRevision)) {
        textRetryAttempts += 1;
        scheduleInspection(true);
      }
    }, 2000);
  };

  globalThis.__vigilResolvePageText = (revision, verdict, retry = false) => {
    if (!inspectionScheduled && String(revision) === String(textRevision) && ["safe", "sensitive", "unknown"].includes(verdict)) {
      document.documentElement.dataset.vigilPageVerdict = verdict;
      if (verdict !== "unknown" || retry !== true) {
        if (textRetryTimer !== null) clearTimeout(textRetryTimer);
        textRetryTimer = null;
      }
      // Rejected chunks remain concealed while a bounded retry recovers native
      // capacity pressure. Permanent malformed-payload errors do not retry.
      if (verdict === "unknown" && retry === true) scheduleTextRetry(revision);
    }
  };

  const beginTextRevision = () => {
    // A prior revision may report pressure during the mutation debounce. Its
    // timer must not prevent the new batch from installing its own watchdog.
    if (textRetryTimer !== null) clearTimeout(textRetryTimer);
    textRetryTimer = null;
    return String(++textRevision);
  };

  const inspectDocument = () => {
    inspectionScheduled = false;
    for (const [id, reference] of mediaElements) {
      if (!reference.deref()) mediaElements.delete(id);
    }
    document.querySelectorAll("img, video").forEach(element => {
      const readyEvent = element instanceof HTMLImageElement && !element.complete ? "load"
        : element instanceof HTMLVideoElement && element.readyState < 2 ? "loadeddata" : null;
      if (!readyEvent) { submitMedia(element); return; }
      if (waitingForMedia.has(element)) return;
      waitingForMedia.add(element);
      const onReady = () => {
        element.removeEventListener(readyEvent, onReady);
        element.removeEventListener("error", onError);
        waitingForMedia.delete(element);
        submitMedia(element);
      };
      const onError = () => {
        element.removeEventListener(readyEvent, onReady);
        element.removeEventListener("error", onError);
        waitingForMedia.delete(element);
      };
      element.addEventListener(readyEvent, onReady, { once: true });
      element.addEventListener("error", onError, { once: true });
    });
    const extracted = extractText(512000);
    const revision = beginTextRevision();
    const chunkLength = 24000;
    const chunks = [];
    for (let offset = 0; offset < extracted.text.length || offset === 0; offset += chunkLength - 128) {
      chunks.push(extracted.text.slice(offset, offset + chunkLength));
      if (offset + chunkLength >= extracted.text.length) break;
    }
    if (isWebKitBrowser) {
      // Also recover an incomplete batch discarded at provisional navigation
      // start when that navigation fails and the existing document survives.
      // Successful native verdicts cancel this missing-response timer.
      scheduleTextRetry(revision);
      chunks.forEach((text, index) => sendNative({
        type: "classifyText", revision, index, total: chunks.length,
        wasTruncated: extracted.wasTruncated, text
      }));
    } else {
      Promise.all(chunks.map(text => sendNative({ type: "classifyText", wasTruncated: extracted.wasTruncated, text })
        .then(response => response?.verdict || "unknown").catch(() => "unknown")))
        .then(verdicts => {
          const verdict = verdicts.includes("sensitive") ? "sensitive"
            : verdicts.includes("unknown") ? "unknown" : "safe";
          globalThis.__vigilResolvePageText(revision, verdict);
        });
    }
  };

  const scheduleInspection = (isRetry = false) => {
    if (isRetry !== true) {
      textRetryAttempts = 0;
      if (textRetryTimer !== null) clearTimeout(textRetryTimer);
      textRetryTimer = null;
    }
    // MutationObserver callbacks run before the next paint, so newly inserted
    // text is concealed while the replacement revision is classified.
    document.documentElement.dataset.vigilPageVerdict = "unknown";
    if (inspectionScheduled) return;
    inspectionScheduled = true;
    setTimeout(inspectDocument, 120);
  };
  new MutationObserver(scheduleInspection).observe(document.documentElement, {
    childList: true, subtree: true, characterData: true,
    attributes: true, attributeFilter: ["src", "srcset", "poster"]
  });
  addEventListener("loadeddata", scheduleInspection, true);
  scheduleInspection();
  setInterval(() => {
    document.querySelectorAll("video, img").forEach(media => {
      if (media instanceof HTMLVideoElement && !media.paused && media.readyState >= 2) submitMedia(media);
      else if (media instanceof HTMLImageElement && media.complete && /\.(gif|webp)(?:$|[?#])/i.test(media.currentSrc || media.src || "")) {
        delete media.dataset.vigilMediaFingerprint;
        submitMedia(media);
      }
    });
  }, 2000);
})();
