// This function is also embedded in classic extension scripts and block pages.
// Keep it self-contained: ordinary history navigation still runs browser guards.
function blockedPageBack() {
    if (history.length > 1) {
        history.back();
        return;
    }
    let status = document.querySelector("#vigilBackStatus");
    if (!status) {
        status = document.createElement("p");
        status.id = "vigilBackStatus";
        status.className = "message";
        status.setAttribute("role", "status");
        (document.querySelector("main") || document.body).append(status);
    }
    status.textContent = "There isn’t a previous page in this tab. Close this tab or enter another address.";
}

const BLOCK_REFERENCE_KINDS = {
    "adult-blocklist": "ADULT", allowlist: "ALLOW", "app-lock": "APP",
    baseline: "BASE", "browser-control": "BROWSER", "browser-protection": "CONNECTION",
    "content-filter": "FILTER", "explicit-content": "CONTENT", integrity: "INTEGRITY",
    limit: "LIMIT", "url-pattern": "URL", focus: "FOCUS", lock: "LOCK",
    "search-break": "BREAK", https: "HTTPS", "filter-unavailable": "UNAVAILABLE"
};
// A readable screenshot reference, never an authorization token. Full context
// remains in the page's diagnostic metadata rather than its visible message.
function blockPageDiagnostic(input) {
    const source = input.source.toUpperCase().replace(/[^A-Z0-9]/gu, "").slice(0, 12) || "UNKNOWN";
    const kind = input.kind.toLowerCase().trim().slice(0, 80) || "rule";
    const diagnostic = {
        schema: 1,
        source,
        kind,
        target: String(input.target || "").slice(0, 2048),
        policyId: String(input.policyId || "").slice(0, 240),
        until: String(input.until || "").slice(0, 80),
        detail: String(input.detail || "").slice(0, 2048)
    };
    const identity = JSON.stringify([source, kind, diagnostic.target, diagnostic.policyId, diagnostic.until]);
    let hash = 0x811c9dc5;
    for (let index = 0; index < identity.length; index++) {
        hash = Math.imul(hash ^ identity.charCodeAt(index), 0x01000193) >>> 0;
    }
    return {
        ...diagnostic,
        reference: `V1-${source}-${BLOCK_REFERENCE_KINDS[kind] || "RULE"}-${hash.toString(16).padStart(8, "0").toUpperCase()}`
    };
}

// Static redirects share a minimal page; its corner reference identifies the
// browser surface even when the original website's referrer is unavailable.
const diagnosticNode = document.querySelector("#vigilBlockDiagnostic");
const detailsNode = document.querySelector("#vigilBlockDetails");
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
const returnApi = globalThis.browser || chrome;
function leaveInThisTab() {
    if (leaving)
        return;
    leaving = true;
    let settled = false;
    const finish = (result) => {
        if (settled)
            return;
        settled = true;
        clearTimeout(fallback);
        leaving = false;
        if (result?.handled)
            return;
        if (result?.ok && result.url && result.url !== "about:blank")
            location.replace(result.url);
        else if (document.body.hasAttribute("data-vigil-quiet-return"))
            location.replace("about:blank");
        else
            blockedPageBack();
    };
    const fallback = setTimeout(finish, 4000);
    try {
        void returnApi.runtime.sendMessage({ type: "VIGIL_REDDIT_REVIEW", action: "return", sourceUrl: location.href })
            .then(finish, () => finish());
    }
    catch {
        finish();
    }
}
let leaving = false;
document.querySelector("#leaveBlockedPage")?.addEventListener("click", event => {
    event.preventDefault();
    event.stopImmediatePropagation();
    leaveInThisTab();
}, true);
if (document.body.hasAttribute("data-vigil-quiet-return"))
    leaveInThisTab();
