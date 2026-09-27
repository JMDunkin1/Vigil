(() => {
// URL shape is eligibility only. Permission to read a post lives in the
// extension background and is issued only for a click from an external search.
function redditReviewHost(value) {
    try {
        return /(^|\.)(reddit\.com|redd\.it|redditmedia\.com)$/iu.test(new URL(value).hostname);
    }
    catch {
        return false;
    }
}
function redditReviewPostId(value) {
    try {
        const url = new URL(value);
        if (url.protocol !== "https:" || url.username || url.password || url.port
            || !/^(www\.|old\.|new\.|np\.|m\.)?reddit\.com$/iu.test(url.hostname))
            return null;
        // JSON, galleries, media viewers, feeds, short links and user posts are
        // deliberately excluded. Comment permalinks stay inside the selected post.
        const match = url.pathname.match(/^\/(?:r\/[a-z0-9_]+\/)?comments\/([a-z0-9]+)(?:\/[^/.]+(?:\/[a-z0-9]+)?)?\/?$/iu);
        return match?.[1].toLowerCase() || null;
    }
    catch {
        return null;
    }
}
function redditReviewSearchPage(value) {
    try {
        const url = new URL(value);
        if (url.protocol !== "https:" || url.username || url.password || url.port)
            return null;
        const host = url.hostname.toLowerCase();
        const google = /^(www\.)?google\.(com|co\.uk|com\.au|ca|de|fr|co\.in)$/u.test(host) && url.pathname === "/search";
        const supported = google
            || (["www.bing.com", "bing.com", "search.brave.com", "kagi.com", "search.yahoo.com"].includes(host) && url.pathname === "/search")
            || (["duckduckgo.com", "www.duckduckgo.com", "html.duckduckgo.com"].includes(host) && ["/", "/html/", "/html"].includes(url.pathname));
        if (!supported || !(url.searchParams.get(host === "search.yahoo.com" ? "p" : "q") || "").trim())
            return null;
        // Tracking, pagination and a changed hash do not constitute a new search.
        const query = (url.searchParams.get(host === "search.yahoo.com" ? "p" : "q") || "").trim().replace(/\s+/gu, " ").toLowerCase();
        const identity = new URL(url.origin + url.pathname);
        identity.searchParams.set("q", query);
        return identity.href;
    }
    catch {
        return null;
    }
}
function redditReviewDestination(value) {
    try {
        let url = new URL(value);
        if (/^(www\.)?google\.(com|co\.uk|com\.au|ca|de|fr|co\.in)$/u.test(url.hostname) && url.pathname === "/url") {
            url = new URL(url.searchParams.get("url") || url.searchParams.get("q") || "");
        }
        else if (/(^|\.)duckduckgo\.com$/u.test(url.hostname) && url.pathname === "/l/") {
            url = new URL(url.searchParams.get("uddg") || "");
        }
        else if (/^(www\.)?bing\.com$/u.test(url.hostname) && url.pathname === "/ck/a") {
            const encoded = url.searchParams.get("u") || "";
            if (!encoded.startsWith("a1"))
                return null;
            url = new URL(atob(encoded.slice(2).replace(/-/gu, "+").replace(/_/gu, "/")));
        }
        if (!redditReviewPostId(url.href))
            return null;
        return url.href;
    }
    catch {
        return null;
    }
}
// Google sometimes keeps the destination opaque until its /goto redirect.
// A short-lived navigation ticket can follow this wrapper; it is not a post
// grant until the browser actually arrives at a supported Reddit permalink.
function redditReviewRedirect(value, source) {
    try {
        const url = new URL(value);
        const page = new URL(source);
        return Boolean(redditReviewSearchPage(source) && url.protocol === "https:" && !url.username && !url.password && !url.port
            && url.hostname === page.hostname && ["/goto", "/url", "/l/", "/ck/a"].includes(url.pathname));
    }
    catch {
        return false;
    }
}
function vigilReturnPage(value, extensionRoot) {
    try {
        const url = new URL(value);
        const root = new URL(extensionRoot);
        if (url.protocol === root.protocol && url.host === root.host && ["/blocked.html", "/reddit-review-blocked.html"].includes(url.pathname))
            return true;
        return url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/blocked";
    }
    catch {
        return false;
    }
}

const reviewApi = globalThis.browser || chrome;
function reviewBlocked() {
    if (window !== window.top) {
        location.replace("about:blank");
        return;
    }
    const fallback = setTimeout(() => location.replace("about:blank"), 4000);
    void reviewApi.runtime.sendMessage({ type: "VIGIL_REDDIT_REVIEW", action: "return", sourceUrl: location.href })
        .then(result => { clearTimeout(fallback); if (!result?.handled)
        location.replace(result?.ok && result.url ? result.url : "about:blank"); }, () => { clearTimeout(fallback); location.replace("about:blank"); });
}
const onReturnPage = vigilReturnPage(location.href, reviewApi.runtime.getURL("/"));
if (onReturnPage) {
    addEventListener("click", event => {
        const target = event.target instanceof Element ? event.target.closest("#leaveBlockedPage") : null;
        if (!target)
            return;
        event.preventDefault();
        event.stopImmediatePropagation();
        reviewBlocked();
    }, true);
    const quietReturn = () => {
        if (document.querySelector('[data-vigil-quiet-return]') || location.pathname === "/reddit-review-blocked.html")
            reviewBlocked();
    };
    if (document.readyState === "loading")
        document.addEventListener("DOMContentLoaded", quietReturn, { once: true });
    else
        quietReturn();
}
function reviewAnchor(event) {
    for (const node of event.composedPath()) {
        if (node instanceof Element) {
            const anchor = node.closest("a[href]");
            if (anchor instanceof HTMLAnchorElement)
                return anchor;
        }
    }
    return null;
}
function reviewSocialControl(element) {
    if (!element.matches("button, [role='button']"))
        return false;
    const label = [element.getAttribute("aria-label"), element.getAttribute("title"), element.textContent].filter(Boolean).join(" ").trim();
    return /^(?:upvote|downvote|reply|create post|join|follow|chat|share|award|log in|sign up)(?:\b|$)/iu.test(label);
}
// Only an actual result click in an external search document can ask the
// background to open Reddit. It persists the grant before doing navigation.
function reviewSearchClick(event) {
    if (!event.isTrusted || !redditReviewSearchPage(location.href) || event.button > 1)
        return;
    const anchor = reviewAnchor(event);
    if (!anchor)
        return;
    const destination = redditReviewDestination(anchor.href) || (redditReviewRedirect(anchor.href, location.href) ? anchor.href : null);
    if (!destination && !redditReviewHost(anchor.href))
        return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!destination)
        return;
    void reviewApi.runtime.sendMessage({ type: "VIGIL_REDDIT_REVIEW", action: "open", url: destination, sourceUrl: location.href,
        newTab: event.button === 1 || event.metaKey || event.ctrlKey || event.shiftKey || anchor.target === "_blank" })
        .catch(() => { });
}
for (const eventName of ["click", "auxclick"])
    addEventListener(eventName, event => {
        if (redditReviewHost(location.href))
            return;
        const anchor = reviewAnchor(event);
        if (anchor && redditReviewHost(anchor.href) && !redditReviewPostId(anchor.href)) {
            event.preventDefault();
            event.stopImmediatePropagation();
        }
    }, true);
addEventListener("click", reviewSearchClick, true);
addEventListener("auxclick", reviewSearchClick, true);
if (redditReviewHost(location.href)) {
    const initialPost = redditReviewPostId(location.href);
    let authorized = false;
    let lastURL = location.href;
    const pendingStyle = document.createElement("style");
    pendingStyle.textContent = "html { visibility:hidden !important; }";
    const concealPending = () => {
        if (!pendingStyle.isConnected && document.documentElement)
            document.documentElement.append(pendingStyle);
    };
    concealPending();
    const rootObserver = new MutationObserver(concealPending);
    rootObserver.observe(document, { childList: true, subtree: true });
    const block = () => { authorized = false; concealPending(); reviewBlocked(); };
    const timer = setTimeout(block, 5000);
    if (window !== window.top || !initialPost)
        block();
    else
        checkPermission();
    function checkPermission() {
        void reviewApi.runtime.sendMessage({ type: "VIGIL_REDDIT_REVIEW", action: "check", sourceUrl: location.href }).then(result => {
            if (result?.retry && !result.ok) {
                setTimeout(checkPermission, 50);
                return;
            }
            clearTimeout(timer);
            if (!initialPost || !result?.ok || redditReviewPostId(location.href) !== initialPost) {
                block();
                return;
            }
            authorized = true;
            rootObserver.disconnect();
            installReviewReader(initialPost);
            pendingStyle.remove();
        }, block);
    }
    const guard = (event) => {
        if (event instanceof KeyboardEvent && event.key !== "Enter" && event.key !== " ")
            return;
        const anchor = reviewAnchor(event);
        const target = event.composedPath().find(node => node instanceof Element);
        const forbidden = !authorized || event.composedPath().some(node => node instanceof Element && reviewSocialControl(node))
            || (anchor && redditReviewHost(anchor.href) && redditReviewPostId(anchor.href) !== initialPost)
            || target?.closest("textarea, [contenteditable='true'], input[type='search'], [role='searchbox'], shreddit-composer, [data-testid='post-composer']");
        if (forbidden) {
            if (event.cancelable)
                event.preventDefault();
            event.stopImmediatePropagation();
        }
        if (event.type === "submit" && event.target instanceof HTMLFormElement) {
            const action = new URL(event.target.action || location.href, location.href);
            if (event.target.method.toLowerCase() !== "get" || redditReviewPostId(action.href) !== initialPost) {
                event.preventDefault();
                event.stopImmediatePropagation();
            }
        }
    };
    for (const name of ["click", "auxclick", "keydown", "submit", "beforeinput"])
        addEventListener(name, guard, true);
    const checkNavigation = () => {
        if (location.href === lastURL)
            return;
        lastURL = location.href;
        if (redditReviewPostId(lastURL) !== initialPost)
            block();
    };
    addEventListener("popstate", checkNavigation, true);
    addEventListener("hashchange", checkNavigation, true);
    setInterval(checkNavigation, 100);
    // BFCache must re-check permission after the background revoked the tab grant.
    addEventListener("pageshow", event => { if (event.persisted) {
        concealPending();
        location.reload();
    } });
}
function installReviewReader(post) {
    const hidden = "[data-vigil-review-hidden], header, nav, aside, footer, [role='navigation'], [role='search'], #header, #sr-header-area, .side, .footer-parent, reddit-search-large, reddit-search-small, shreddit-composer, shreddit-recommendation-feed, shreddit-related-posts, [slot='right-sidebar'], [slot='left-sidebar'], #right-sidebar-container, #left-sidebar-container, textarea, [contenteditable='true'], input[type='search'], .arrow, .reply-button, .commentarea > form";
    const roots = new Set();
    const styles = new WeakMap();
    const hide = (element) => {
        if (!element.hasAttribute("data-vigil-review-hidden"))
            element.setAttribute("data-vigil-review-hidden", "");
    };
    let queued = false;
    const scan = () => {
        queued = false;
        observe(document);
        for (const root of roots) {
            if (root instanceof ShadowRoot && !root.host.isConnected) {
                roots.delete(root);
                continue;
            }
            observe(root);
            for (const element of root.querySelectorAll("*"))
                if (element.shadowRoot)
                    observe(element.shadowRoot);
            for (const anchor of root.querySelectorAll("a[href]")) {
                if (redditReviewHost(anchor.href) && redditReviewPostId(anchor.href) !== post)
                    hide(anchor);
            }
            for (const card of root.querySelectorAll("shreddit-post, shreddit-search-result, article, .thing.link, [data-testid='post-container']")) {
                const candidate = card.getAttribute("permalink") || card.getAttribute("content-href") || card.querySelector("a[href*='/comments/']")?.href;
                const id = (card.getAttribute("data-fullname") || card.getAttribute("id") || "").match(/^t3_([a-z0-9]+)$/iu)?.[1];
                if (id ? id !== post : candidate && redditReviewPostId(new URL(candidate, location.href).href) !== post)
                    hide(card);
            }
            for (const button of root.querySelectorAll("button, [role='button']")) {
                if (reviewSocialControl(button))
                    hide(button);
            }
        }
    };
    const schedule = () => { if (!queued) {
        queued = true;
        queueMicrotask(scan);
    } };
    const observe = (root) => {
        if (root === document && !document.documentElement)
            return;
        let style = styles.get(root);
        if (!style) {
            style = document.createElement("style");
            style.textContent = `${hidden} { display:none !important; visibility:hidden !important; }`;
            styles.set(root, style);
        }
        if (!style.isConnected)
            (root === document ? document.documentElement : root).append(style);
        if (roots.has(root))
            return;
        roots.add(root);
        new MutationObserver(schedule).observe(root, { childList: true, subtree: true, attributes: true,
            attributeFilter: ["href", "permalink", "content-href", "id", "data-fullname", "aria-label", "title"] });
    };
    scan();
    setInterval(scan, 1000);
}


})();
