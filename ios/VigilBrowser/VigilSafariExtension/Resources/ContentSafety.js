(() => {
  "use strict";
  if (globalThis.__vigilContentSafetyInstalled) return;
  globalThis.__vigilContentSafetyInstalled = true;

  const nativeApplication = "tech.caseline.vigil.browser";
  const isWebKitBrowser = Boolean(globalThis.webkit?.messageHandlers?.vigilContentSafety);
  const style = document.createElement("style");
  style.id = "vigil-content-safety-style";
  style.textContent = `
    img, video, [style*="background-image"] { filter: blur(32px) !important; }
    [data-vigil-media-verdict="safe"] { filter: none !important; }
    [data-vigil-media-verdict="sensitive"] { filter: blur(48px) !important; visibility: hidden !important; }
    html[data-vigil-page-verdict="sensitive"] body,
    html[data-vigil-page-verdict="unknown"] body { visibility: hidden !important; }
  `;
  (document.head || document.documentElement).appendChild(style);
  document.documentElement.dataset.vigilPageVerdict = "unknown";

  const mediaElements = new Map();
  let nextMediaID = 1;
  let nextMediaToken = 1;
  let textRevision = 0;
  let inspectionScheduled = false;

  const sendNative = payload => {
    if (isWebKitBrowser) {
      globalThis.webkit.messageHandlers.vigilContentSafety.postMessage(payload);
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
    } catch (_) { return null; }
  };

  globalThis.__vigilResolveMedia = (id, token, verdict) => {
    const element = mediaElements.get(String(id));
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
      mediaElements.set(id, element);
    }
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
      sourceURL: element instanceof HTMLImageElement ? String(element.currentSrc || element.src || "") : "",
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

  globalThis.__vigilResolvePageText = (revision, verdict) => {
    if (String(revision) === String(textRevision) && ["safe", "sensitive", "unknown"].includes(verdict)) {
      document.documentElement.dataset.vigilPageVerdict = verdict;
    }
  };

  const inspectDocument = () => {
    inspectionScheduled = false;
    document.querySelectorAll("img, video").forEach(element => {
      if (element instanceof HTMLImageElement && !element.complete) element.addEventListener("load", () => submitMedia(element), { once: true });
      else if (element instanceof HTMLVideoElement && element.readyState < 2) element.addEventListener("loadeddata", () => submitMedia(element), { once: true });
      else submitMedia(element);
    });
    const extracted = extractText(512000);
    const revision = String(++textRevision);
    const chunkLength = 24000;
    const chunks = [];
    for (let offset = 0; offset < extracted.text.length || offset === 0; offset += chunkLength - 128) {
      chunks.push(extracted.text.slice(offset, offset + chunkLength));
      if (offset + chunkLength >= extracted.text.length) break;
    }
    if (isWebKitBrowser) {
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

  const scheduleInspection = () => {
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
