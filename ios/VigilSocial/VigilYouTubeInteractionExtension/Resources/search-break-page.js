(() => {
(() => {
    const api = globalThis.browser || chrome;
    const countdown = document.getElementById("searchBreakCountdown");
    let busy = false;
    async function check() {
        if (busy)
            return;
        busy = true;
        try {
            const result = await api.runtime.sendMessage({ type: "VIGIL_SEARCH_BREAK", action: "search-break-status" });
            if (!result?.ok) {
                countdown.textContent = "Vigil could not verify the remaining time. Retrying…";
                return;
            }
            const seconds = Math.ceil(Number(result.remainingMs || 0) / 1000);
            countdown.textContent = result.blocked ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")} remaining` : "Your break is complete.";
            if (!result.blocked)
                clearInterval(timer);
        }
        catch {
            countdown.textContent = "Vigil could not verify the remaining time. Retrying…";
        }
        finally {
            busy = false;
        }
    }
    const timer = setInterval(() => { void check(); }, 1000);
    void check();
})();

})();
