// This function is also embedded in classic extension scripts and block pages.
// Keep it self-contained: every destination still runs ordinary browser guards.
function blockedPageBack(destination = "", exhausted = false) {
    const state = blockedPageBack;
    const now = Date.now();
    if ((state.busyUntil || 0) > now)
        return;
    const key = "vigil-blocked-page-back";
    if (destination && destination !== "about:blank") {
        try {
            sessionStorage.removeItem(key);
        }
        catch { /* Storage can be unavailable in private tabs. */ }
        state.attempt = undefined;
        state.busyUntil = now + 1500;
        location.replace(destination);
        return;
    }
    if (!exhausted && history.length > 1) {
        let previous = state.attempt;
        const navigation = globalThis.navigation;
        const entry = navigation?.currentEntry;
        try {
            const stored = JSON.parse(sessionStorage.getItem(key) || "null");
            const earlierEntry = stored?.entryKey && entry && navigation?.entries().some(candidate => candidate.key === stored.entryKey && candidate.index > entry.index);
            // A tab-wide timestamp cannot distinguish a denied-entry bounce from a
            // successful Back followed by Forward and reload. Reuse it only when the
            // attempted blocker remains ahead of this earlier history entry.
            if (earlierEntry)
                previous = stored || previous;
        }
        catch { /* Retain the in-document fallback when provenance is unavailable. */ }
        const retry = previous && Number.isInteger(previous.steps) && previous.steps > 0
            && Number.isInteger(previous.length) && previous.length >= history.length
            && previous.at <= now && now - previous.at < 30_000;
        const steps = retry && previous ? previous.steps + 1 : 1;
        if (steps < history.length) {
            // A denied entry can redirect back here after native Back. Remember the
            // attempt in this tab and advance past it on a retry, including reloads.
            state.attempt = { steps, length: history.length, at: now, entryKey: entry?.key };
            try {
                sessionStorage.setItem(key, JSON.stringify(state.attempt));
            }
            catch { /* The same document still remembers retries. */ }
            state.busyUntil = now + 1500;
            const source = location.href;
            const fallback = setTimeout(() => {
                if (location.href !== source)
                    return;
                // history.length includes forward entries. If the larger traversal
                // overshoots the beginning, a single step can still reach a real page.
                if (steps > 1)
                    history.back();
                state.busyUntil = 0;
                blockedPageBack("", true);
            }, 1500);
            // A timer frozen in BFCache must not navigate when this page is restored.
            addEventListener("pagehide", () => { clearTimeout(fallback); state.attempt = undefined; state.busyUntil = 0; }, { once: true });
            if (steps === 1)
                history.back();
            else
                history.go(-steps);
            return;
        }
    }
    let status = document.querySelector("#vigilBackStatus");
    if (!status) {
        status = document.createElement("p");
        status.id = "vigilBackStatus";
        status.className = "message";
        status.hidden = true;
        status.setAttribute("role", "status");
        (document.querySelector("main") || document.body).append(status);
    }
    status.textContent = "There isn’t an available previous page in this tab. Close this tab or enter another address.";
    const back = document.querySelector("#leaveBlockedPage");
    back?.setAttribute("aria-describedby", status.id);
    back?.setAttribute("title", status.textContent);
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
        if (result?.handled) {
            leaving = false;
            return;
        }
        if (result?.ok && result.url && result.url !== "about:blank")
            blockedPageBack(result.url);
        else if (document.body.hasAttribute("data-vigil-quiet-return"))
            location.replace("about:blank");
        else {
            leaving = false;
            blockedPageBack("", result?.exhausted);
        }
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
addEventListener("pageshow", () => { leaving = false; });
document.querySelector("#leaveBlockedPage")?.addEventListener("click", event => {
    event.preventDefault();
    event.stopImmediatePropagation();
    leaveInThisTab();
}, true);
if (document.body.hasAttribute("data-vigil-quiet-return"))
    leaveInThisTab();
