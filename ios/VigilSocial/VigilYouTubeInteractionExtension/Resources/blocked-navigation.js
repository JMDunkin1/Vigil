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
