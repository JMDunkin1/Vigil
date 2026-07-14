import { createDistanceKeyQrSvg } from "./distance-key-qr.js";
import type { ControlElement } from "./app-model.js";

interface DistanceScannerState {
  stream: MediaStream | null;
  frame: number | null;
  target: ControlElement | null;
}

interface DistanceKeyUiContext {
  $: (selector: string) => ControlElement;
  toast(message: string): void;
  errorMessage(error: unknown): string;
  scanner: DistanceScannerState;
}

interface BarcodeDetectorResult {
  rawValue?: string;
}

interface BarcodeDetectorConstructor {
  new(options?: { formats?: string[] }): { detect(source: CanvasImageSource): Promise<BarcodeDetectorResult[]> };
}

declare const BarcodeDetector: BarcodeDetectorConstructor;

export function createDistanceKeyUi({ $, toast, errorMessage, scanner }: DistanceKeyUiContext) {
  function showToken(token: string): void {
    const node = $("#distanceKeyToken");
    node.textContent = token || "";
    node.classList.toggle("hidden", !token);
    const panel = $("#distanceKeyQr");
    const qr = $("#distanceKeyQrImage");
    if (!token) {
      panel.classList.add("hidden");
      qr.replaceChildren();
      return;
    }
    qr.replaceChildren(createDistanceKeyQrSvg(token));
    panel.classList.remove("hidden");
  }

  function hideToken(): void {
    showToken("");
  }

  async function openScanner(targetSelector?: string): Promise<void> {
    if (!targetSelector) return;
    const target = $(targetSelector);
    if (!target) return;
    if (!("BarcodeDetector" in window)) {
      toast("QR scanning is not available in this browser");
      return;
    }

    closeScanner();
    scanner.target = target;
    $("#distanceScanner").classList.remove("hidden");
    $("#distanceScannerStatus").textContent = "Camera starting";

    try {
      const video = $("#distanceScannerVideo") as unknown as HTMLVideoElement;
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
        audio: false
      });
      scanner.stream = stream;
      video.srcObject = stream;
      await video.play();
      const detector = new BarcodeDetector({ formats: ["qr_code"] });
      $("#distanceScannerStatus").textContent = "Point the camera at the printed distance key";

      const tick = async () => {
        if (!scanner.stream) return;
        try {
          const codes = await detector.detect(video);
          const value = normalizeDistanceKeyScan(codes[0]?.rawValue || "");
          if (value) {
            target.value = value;
            closeScanner();
            toast("Distance key scanned");
            return;
          }
        } catch {
          $("#distanceScannerStatus").textContent = "Scanning paused; adjust camera permission or type the key";
        }
        scanner.frame = requestAnimationFrame(tick);
      };
      scanner.frame = requestAnimationFrame(tick);
    } catch (error) {
      closeScanner();
      toast(errorMessage(error) || "Camera unavailable");
    }
  }

  function closeScanner(): void {
    if (scanner.frame) cancelAnimationFrame(scanner.frame);
    if (scanner.stream) {
      for (const track of scanner.stream.getTracks()) track.stop();
    }
    scanner.stream = null;
    scanner.frame = null;
    scanner.target = null;
    const video = $("#distanceScannerVideo") as unknown as HTMLVideoElement;
    if (video) video.srcObject = null;
    const scannerNode = $("#distanceScanner");
    if (scannerNode) scannerNode.classList.add("hidden");
  }

  function print(): void {
    const token = $("#distanceKeyToken").textContent.trim();
    if (!token) {
      toast("Generate a distance key first");
      return;
    }
    const page = window.open("", "distance-key-print");
    if (!page) {
      toast("Print window was blocked");
      return;
    }
    const doc = page.document;
    doc.title = "Distance Key";
    const stylesheet = doc.createElement("link");
    stylesheet.rel = "stylesheet";
    stylesheet.href = "/styles.css";
    const main = doc.createElement("main");
    doc.body.className = "distance-key-print";
    const title = doc.createElement("h1");
    title.textContent = "Vigil Distance Key";
    const note = doc.createElement("p");
    note.textContent = "Keep this away from the desk. Scan it or type the code when a protected unlock needs the physical key.";
    const code = doc.createElement("code");
    code.textContent = token;
    main.append(title, note, createDistanceKeyQrSvg(token, 10, doc), code);
    doc.head.replaceChildren(stylesheet);
    doc.body.replaceChildren(main);
    page.focus();
    page.print();
  }

  return {
    showToken,
    hideToken,
    openScanner,
    closeScanner,
    print
  };
}

function normalizeDistanceKeyScan(value: unknown): string {
  const text = String(value || "").trim();
  const match = text.match(/[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}/i);
  return match ? match[0].toUpperCase() : "";
}
