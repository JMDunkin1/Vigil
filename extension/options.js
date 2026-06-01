const DEFAULT_LOCAL_SERVER = "http://127.0.0.1:8787";
const EXTENSION_TOKEN_HEADER = "x-sentinel-extension-token";
const STORAGE_DEFAULTS = {
  sentinelLocalServer: DEFAULT_LOCAL_SERVER,
  sentinelExtensionToken: ""
};

const form = document.querySelector("#settings");
const localServerInput = document.querySelector("#localServer");
const extensionTokenInput = document.querySelector("#extensionToken");
const extensionOriginInput = document.querySelector("#extensionOrigin");
const statusText = document.querySelector("#status");
const testButton = document.querySelector("#testConnection");

extensionOriginInput.value = `chrome-extension://${chrome.runtime.id}`;
loadOptions();

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const localServer = normalizeLocalServer(localServerInput.value);
  const extensionToken = extensionTokenInput.value.trim();
  await storageSet({
    sentinelLocalServer: localServer,
    sentinelExtensionToken: extensionToken
  });
  localServerInput.value = localServer;
  setStatus("Saved.");
});

testButton.addEventListener("click", async () => {
  const localServer = normalizeLocalServer(localServerInput.value);
  const extensionToken = extensionTokenInput.value.trim();
  const headers = { Accept: "application/json" };
  if (extensionToken) headers[EXTENSION_TOKEN_HEADER] = extensionToken;

  try {
    const response = await fetch(new URL("/api/state", `${localServer}/`).toString(), { headers });
    const signature = response.headers.get("x-sentinel-app") || "";
    if (!response.ok || !signature.startsWith("tech.caseline.sentinel;")) {
      setStatus(`No Sentinel response at ${localServer}.`);
      return;
    }
    setStatus(`Connected to ${localServer}.`);
  } catch {
    setStatus(`No Sentinel response at ${localServer}.`);
  }
});

async function loadOptions() {
  const values = await storageGet(STORAGE_DEFAULTS);
  localServerInput.value = normalizeLocalServer(values.sentinelLocalServer);
  extensionTokenInput.value = String(values.sentinelExtensionToken || "");
}

function normalizeLocalServer(value) {
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

function isLocalHost(hostname) {
  return ["127.0.0.1", "localhost", "::1"].includes(String(hostname || "").replace(/^\[|\]$/g, "").toLowerCase());
}

function setStatus(value) {
  statusText.textContent = value;
}

function storageGet(defaults) {
  return new Promise((resolve) => {
    chrome.storage.local.get(defaults, (value) => resolve(value || defaults));
  });
}

function storageSet(value) {
  return new Promise((resolve) => {
    chrome.storage.local.set(value, () => resolve(!chrome.runtime.lastError));
  });
}
