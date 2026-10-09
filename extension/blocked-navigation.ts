import { blockedPageBack } from "../src/blockedPageBack.js";
import { blockPageDiagnostic } from "../src/blockPageDiagnostics.js";

// Static redirects share a minimal page; its corner reference identifies the
// browser surface even when the original website's referrer is unavailable.
const diagnosticNode = document.querySelector<HTMLElement>("#vigilBlockDiagnostic");
const detailsNode = document.querySelector<HTMLScriptElement>("#vigilBlockDetails");
const blockKind = document.body?.dataset?.vigilBlockKind;
if (blockKind && diagnosticNode && detailsNode) {
  const source = location.protocol === "chrome-extension:" ? "CHR"
    : location.protocol === "safari-web-extension:" ? "SAF" : "EXT";
  const diagnostic = blockPageDiagnostic({
    source, kind: blockKind, target: document.referrer || "",
    detail: blockKind === "search-break" ? "Search-warning browser break" : "Vigil explicit-content browser guard"
  });
  diagnosticNode.textContent = diagnostic.reference;
  detailsNode.textContent = JSON.stringify(diagnostic);
}

// Bundled extension pages do not receive website content scripts.
const returnApi: typeof chrome = (globalThis as typeof globalThis & { browser?: typeof chrome }).browser || chrome;
function leaveInThisTab(): void {
  if (leaving) return;
  leaving = true;
  let settled = false;
  const finish = (result?: { handled?: boolean; ok?: boolean; url?: string }) => {
    if (settled) return;
    settled = true;
    clearTimeout(fallback);
    leaving = false;
    if (result?.handled) return;
    if (result?.ok && result.url && result.url !== "about:blank") location.replace(result.url);
    else if (document.body.hasAttribute("data-vigil-quiet-return")) location.replace("about:blank");
    else blockedPageBack();
  };
  const fallback = setTimeout(finish, 4000);
  try {
    void returnApi.runtime.sendMessage({ type: "VIGIL_REDDIT_REVIEW", action: "return", sourceUrl: location.href })
      .then(finish, () => finish());
  } catch { finish(); }
}
let leaving = false;
document.querySelector("#leaveBlockedPage")?.addEventListener("click", event => {
  event.preventDefault(); event.stopImmediatePropagation(); leaveInThisTab();
}, true);
if (document.body.hasAttribute("data-vigil-quiet-return")) leaveInThisTab();
export {};
