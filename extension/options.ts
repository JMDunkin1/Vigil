const DEFAULT_LOCAL_SERVER = "http://127.0.0.1:8787";
const EXTENSION_TOKEN_HEADER = "x-vigil-extension-token";
const STORAGE_DEFAULTS = {
  vigilLocalServer: DEFAULT_LOCAL_SERVER,
  vigilExtensionToken: ""
};

type StorageOptions = typeof STORAGE_DEFAULTS;

const form = queryElement<HTMLFormElement>("#settings");
const localServerInput = queryElement<HTMLInputElement>("#localServer");
const extensionTokenInput = queryElement<HTMLInputElement>("#extensionToken");
const extensionOriginInput = queryElement<HTMLInputElement>("#extensionOrigin");
const statusText = queryElement<HTMLElement>("#status");
const testButton = queryElement<HTMLButtonElement>("#testConnection");
const copyPairingEnvButton = queryElement<HTMLButtonElement>("#copyPairingEnv");
const serverCheck = queryElement<HTMLElement>("#serverCheck");
const pairingCheck = queryElement<HTMLElement>("#pairingCheck");
const pairingEnvHint = queryElement<HTMLElement>("#pairingEnvHint");

const manifest = chrome.runtime.getManifest();
const extensionOrigin = `chrome-extension://${chrome.runtime.id}`;

extensionOriginInput.value = extensionOrigin;
pairingEnvHint.textContent = defaultPairingEnv();
void loadOptions();

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const localServer = normalizeLocalServer(localServerInput.value);
  const extensionToken = extensionTokenInput.value.trim();
  await storageSet({
    vigilLocalServer: localServer,
    vigilExtensionToken: extensionToken
  });
  localServerInput.value = localServer;
  setStatus("Saved.");
});

testButton.addEventListener("click", async () => {
  const localServer = normalizeLocalServer(localServerInput.value);
  const extensionToken = extensionTokenInput.value.trim();
  localServerInput.value = localServer;
  setDiagnostic(serverCheck, "Checking...");
  setDiagnostic(pairingCheck, "Checking...");
  setStatus("");

  try {
    const response = await fetch(vigilUrl("/api/state", localServer), { headers: { Accept: "application/json" } });
    const signature = response.headers.get("x-vigil-app") || "";
    if (!response.ok || !signature.startsWith("tech.caseline.vigil;")) {
      setDiagnostic(serverCheck, `No Vigil response at ${localServer}.`);
      setDiagnostic(pairingCheck, "Not checked.");
      return;
    }
    setDiagnostic(serverCheck, `Connected to ${localServer}.`);
  } catch {
    setDiagnostic(serverCheck, `No Vigil response at ${localServer}.`);
    setDiagnostic(pairingCheck, "Not checked.");
    return;
  }

  const pairing = await readPairing(localServer, extensionToken);
  if (pairing?.setup?.idEnv || pairing?.setup?.originEnv) {
    pairingEnvHint.textContent = [pairing.setup.idEnv, pairing.setup.originEnv].filter(Boolean).join("\n");
  } else {
    pairingEnvHint.textContent = defaultPairingEnv();
  }

  try {
    const response = await fetch(vigilUrl("/api/extension/check", localServer), {
      method: "POST",
      headers: extensionHeaders(extensionToken, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        url: "https://example.com/",
        event: "heartbeat",
        extensionVersion: manifest.version
      })
    });
    if (response.ok) {
      const trustedBy = pairing?.trust?.trustedBy && pairing.trust.trustedBy !== "none"
        ? pairing.trust.trustedBy
        : (extensionToken ? "token" : "origin");
      setDiagnostic(pairingCheck, `Trusted by ${trustedBy}.`);
      setStatus(`Companion paired with ${localServer}.`);
      return;
    }
    const detail = await responseError(response);
    setDiagnostic(pairingCheck, pairingFailureText(pairing, detail, extensionToken));
    setStatus("Pairing needs repair.");
  } catch {
    setDiagnostic(pairingCheck, "Extension API did not answer. Check the server URL, then reload the extension.");
    setStatus("Pairing needs repair.");
  }
});

copyPairingEnvButton.addEventListener("click", async () => {
  const value = pairingEnvHint.textContent || defaultPairingEnv();
  try {
    await navigator.clipboard.writeText(value);
    setStatus("Server env copied.");
  } catch {
    setStatus(value);
  }
});

async function loadOptions() {
  const values = await storageGet(STORAGE_DEFAULTS);
  localServerInput.value = normalizeLocalServer(values.vigilLocalServer);
  extensionTokenInput.value = String(values.vigilExtensionToken || "");
}

function queryElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required options element: ${selector}`);
  return element;
}

function normalizeLocalServer(value: unknown): string {
  try {
    const raw = String(value || DEFAULT_LOCAL_SERVER).trim();
    const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
    const url = new URL(withScheme);
    if (!["http:", "https:"].includes(url.protocol)) return DEFAULT_LOCAL_SERVER;
    if (!isLocalHost(url.hostname)) return DEFAULT_LOCAL_SERVER;
    return url.origin;
  } catch {
    return DEFAULT_LOCAL_SERVER;
  }
}

function vigilUrl(path: string, localServer: string): string {
  return new URL(path, `${localServer}/`).toString();
}

async function readPairing(localServer: string, extensionToken: string): Promise<PairingResponse | null> {
  try {
    const response = await fetch(vigilUrl("/api/extension/pairing", localServer), {
      headers: extensionHeaders(extensionToken, { Accept: "application/json" })
    });
    if (!response.ok) return null;
    return await response.json() as PairingResponse;
  } catch {
    return null;
  }
}

function extensionHeaders(extensionToken: string, headers: Record<string, string> = {}): Record<string, string> {
  const next = { ...headers };
  if (extensionToken) next[EXTENSION_TOKEN_HEADER] = extensionToken;
  return next;
}

async function responseError(response: Response): Promise<string> {
  try {
    const value = await response.json() as { error?: unknown };
    return String(value.error || `HTTP ${response.status}`);
  } catch {
    return `HTTP ${response.status}`;
  }
}

function pairingFailureText(pairing: PairingResponse | null, detail: string, extensionToken: string): string {
  const trust = pairing?.trust;
  if (extensionToken && trust?.tokenConfigured && trust?.tokenSupplied) {
    return `Token not accepted. Check VIGIL_EXTENSION_TOKEN. ${detail}`;
  }
  if (!trust?.tokenConfigured && !trust?.configuredOriginCount) {
    return "Server has no companion trust configured. Add the server env below, or set a shared token on both sides.";
  }
  return `Not paired. Add this extension ID/origin to Vigil, or enter the shared token. ${detail}`;
}

function defaultPairingEnv(): string {
  return [
    `VIGIL_EXTENSION_ID=${chrome.runtime.id}`,
    `VIGIL_EXTENSION_ORIGIN=${extensionOrigin}`
  ].join("\n");
}

function isLocalHost(hostname: unknown): boolean {
  return ["127.0.0.1", "localhost", "::1"].includes(String(hostname || "").replace(/^\[|\]$/g, "").toLowerCase());
}

function setStatus(value: string): void {
  statusText.textContent = value;
}

function setDiagnostic(element: HTMLElement, value: string): void {
  element.textContent = value;
}

function storageGet(defaults: StorageOptions): Promise<StorageOptions> {
  return new Promise((resolve) => {
    chrome.storage.local.get(defaults, (value) => resolve({ ...defaults, ...(value as Partial<StorageOptions> || {}) }));
  });
}

function storageSet(value: StorageOptions): Promise<boolean> {
  return new Promise((resolve) => {
    chrome.storage.local.set(value, () => resolve(!chrome.runtime.lastError));
  });
}

interface PairingResponse {
  trust?: {
    trusted?: boolean;
    trustedBy?: "origin" | "token" | "none";
    tokenConfigured?: boolean;
    tokenSupplied?: boolean;
    configuredOriginCount?: number;
  };
  setup?: {
    originEnv?: string | null;
    idEnv?: string | null;
  };
}
