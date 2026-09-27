// Bundled extension pages do not receive website content scripts.
const returnApi = globalThis.browser || chrome;
function leaveInThisTab() {
    const fallback = setTimeout(() => location.replace("about:blank"), 4000);
    void returnApi.runtime.sendMessage({ type: "VIGIL_REDDIT_REVIEW", action: "return", sourceUrl: location.href })
        .then(result => { clearTimeout(fallback); if (!result?.handled)
        location.replace(result?.ok && result.url ? result.url : "about:blank"); }, () => { clearTimeout(fallback); location.replace("about:blank"); });
}
document.querySelector("#leaveBlockedPage")?.addEventListener("click", event => {
    event.preventDefault();
    event.stopImmediatePropagation();
    leaveInThisTab();
}, true);
if (document.body.hasAttribute("data-vigil-quiet-return"))
    leaveInThisTab();
