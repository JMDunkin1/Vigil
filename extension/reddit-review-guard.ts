import { redditReviewHost, redditReviewPostId, redditReviewSearchPage, redditReviewDestination, redditReviewRedirect, vigilReturnPage } from "../src/redditReview.js";

const reviewApi: typeof chrome = (globalThis as typeof globalThis & { browser?: typeof chrome }).browser || chrome;
function reviewBlocked(): void {
  if (window !== window.top) { location.replace("about:blank"); return; }
  const fallback = setTimeout(() => location.replace("about:blank"), 4000);
  void reviewApi.runtime.sendMessage({ type: "VIGIL_REDDIT_REVIEW", action: "return", sourceUrl: location.href })
    .then(result => { clearTimeout(fallback); if (!result?.handled) location.replace(result?.ok && result.url ? result.url : "about:blank"); }, () => { clearTimeout(fallback); location.replace("about:blank"); });
}
const onReturnPage = vigilReturnPage(location.href, reviewApi.runtime.getURL("/"));
if (onReturnPage) {
  addEventListener("click", event => {
    const target = event.target instanceof Element ? event.target.closest("#leaveBlockedPage") : null;
    if (!target) return;
    event.preventDefault(); event.stopImmediatePropagation(); reviewBlocked();
  }, true);
  const quietReturn = () => {
    if (document.querySelector('[data-vigil-quiet-return]') || location.pathname === "/reddit-review-blocked.html") reviewBlocked();
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", quietReturn, { once: true });
  else quietReturn();
}
function reviewAnchor(event: Event): HTMLAnchorElement | null {
  for (const node of event.composedPath()) {
    if (node instanceof Element) {
      const anchor = node.closest("a[href]");
      if (anchor instanceof HTMLAnchorElement) return anchor;
    }
  }
  return null;
}
function reviewSocialControl(element: Element): boolean {
  if (!element.matches("button, [role='button']")) return false;
  const label = [element.getAttribute("aria-label"), element.getAttribute("title"), element.textContent].filter(Boolean).join(" ").trim();
  return /^(?:upvote|downvote|reply|create post|join|follow|chat|share|award|log in|sign up)(?:\b|$)/iu.test(label);
}

// Only an actual result click in an external search document can ask the
// background to open Reddit. It persists the grant before doing navigation.
function reviewSearchClick(event: MouseEvent): void {
  if (!event.isTrusted || !redditReviewSearchPage(location.href) || event.button > 1) return;
  const anchor = reviewAnchor(event);
  if (!anchor) return;
  const destination = redditReviewDestination(anchor.href) || (redditReviewRedirect(anchor.href, location.href) ? anchor.href : null);
  if (!destination && !redditReviewHost(anchor.href)) return;
  event.preventDefault(); event.stopImmediatePropagation();
  if (!destination) return;
  void reviewApi.runtime.sendMessage({ type: "VIGIL_REDDIT_REVIEW", action: "open", url: destination, sourceUrl: location.href,
    newTab: event.button === 1 || event.metaKey || event.ctrlKey || event.shiftKey || anchor.target === "_blank" })
    .catch(() => {});
}
for (const eventName of ["click", "auxclick"]) addEventListener(eventName, event => {
  if (redditReviewHost(location.href)) return;
  const anchor = reviewAnchor(event);
  if (anchor && redditReviewHost(anchor.href) && !redditReviewPostId(anchor.href)) {
    event.preventDefault(); event.stopImmediatePropagation();
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
    if (!pendingStyle.isConnected && document.documentElement) document.documentElement.append(pendingStyle);
  };
  concealPending();
  const rootObserver = new MutationObserver(concealPending);
  rootObserver.observe(document, { childList: true, subtree: true });
  const block = () => { authorized = false; concealPending(); reviewBlocked(); };
  const timer = setTimeout(block, 5000);
  if (window !== window.top || !initialPost) block();
  else checkPermission();
  function checkPermission(): void {
    void reviewApi.runtime.sendMessage({ type: "VIGIL_REDDIT_REVIEW", action: "check", sourceUrl: location.href }).then(result => {
    if (result?.retry && !result.ok) { setTimeout(checkPermission, 50); return; }
    clearTimeout(timer);
    if (!initialPost || !result?.ok || redditReviewPostId(location.href) !== initialPost) { block(); return; }
    authorized = true;
    rootObserver.disconnect();
    installReviewReader(initialPost);
    pendingStyle.remove();
    }, block);
  }

  const guard = (event: Event) => {
    if (event instanceof KeyboardEvent && event.key !== "Enter" && event.key !== " ") return;
    const anchor = reviewAnchor(event);
    const target = event.composedPath().find(node => node instanceof Element) as Element | undefined;
    const forbidden = !authorized || event.composedPath().some(node => node instanceof Element && reviewSocialControl(node))
      || (anchor && redditReviewHost(anchor.href) && redditReviewPostId(anchor.href) !== initialPost)
      || target?.closest("textarea, [contenteditable='true'], input[type='search'], [role='searchbox'], shreddit-composer, [data-testid='post-composer']");
    if (forbidden) { if (event.cancelable) event.preventDefault(); event.stopImmediatePropagation(); }
    if (event.type === "submit" && event.target instanceof HTMLFormElement) {
      const action = new URL(event.target.action || location.href, location.href);
      if (event.target.method.toLowerCase() !== "get" || redditReviewPostId(action.href) !== initialPost) {
        event.preventDefault(); event.stopImmediatePropagation();
      }
    }
  };
  for (const name of ["click", "auxclick", "keydown", "submit", "beforeinput"]) addEventListener(name, guard, true);
  const checkNavigation = () => {
    if (location.href === lastURL) return;
    lastURL = location.href;
    if (redditReviewPostId(lastURL) !== initialPost) block();
  };
  addEventListener("popstate", checkNavigation, true);
  addEventListener("hashchange", checkNavigation, true);
  setInterval(checkNavigation, 100);
  // BFCache must re-check permission after the background revoked the tab grant.
  addEventListener("pageshow", event => { if (event.persisted) { concealPending(); location.reload(); } });
}

function installReviewReader(post: string): void {
  const hidden = "[data-vigil-review-hidden], header, nav, aside, footer, [role='navigation'], [role='search'], #header, #sr-header-area, .side, .footer-parent, reddit-search-large, reddit-search-small, shreddit-composer, shreddit-recommendation-feed, shreddit-related-posts, [slot='right-sidebar'], [slot='left-sidebar'], #right-sidebar-container, #left-sidebar-container, textarea, [contenteditable='true'], input[type='search'], .arrow, .reply-button, .commentarea > form";
  const roots = new Set<Document | ShadowRoot>();
  const styles = new WeakMap<Document | ShadowRoot, HTMLStyleElement>();
  const hide = (element: Element) => {
    if (!element.hasAttribute("data-vigil-review-hidden")) element.setAttribute("data-vigil-review-hidden", "");
  };
  let queued = false;
  const scan = () => {
    queued = false;
    observe(document);
    for (const root of roots) {
      if (root instanceof ShadowRoot && !root.host.isConnected) { roots.delete(root); continue; }
      observe(root);
      for (const element of root.querySelectorAll("*")) if (element.shadowRoot) observe(element.shadowRoot);
      for (const anchor of root.querySelectorAll<HTMLAnchorElement>("a[href]")) {
        if (redditReviewHost(anchor.href) && redditReviewPostId(anchor.href) !== post) hide(anchor);
      }
      for (const card of root.querySelectorAll("shreddit-post, shreddit-search-result, article, .thing.link, [data-testid='post-container']")) {
        const candidate = card.getAttribute("permalink") || card.getAttribute("content-href") || card.querySelector<HTMLAnchorElement>("a[href*='/comments/']")?.href;
        const id = (card.getAttribute("data-fullname") || card.getAttribute("id") || "").match(/^t3_([a-z0-9]+)$/iu)?.[1];
        if (id ? id !== post : candidate && redditReviewPostId(new URL(candidate, location.href).href) !== post) hide(card);
      }
      for (const button of root.querySelectorAll("button, [role='button']")) {
        if (reviewSocialControl(button)) hide(button);
      }
    }
  };
  const schedule = () => { if (!queued) { queued = true; queueMicrotask(scan); } };
  const observe = (root: Document | ShadowRoot) => {
    if (root === document && !document.documentElement) return;
    let style = styles.get(root);
    if (!style) {
      style = document.createElement("style");
      style.textContent = `${hidden} { display:none !important; visibility:hidden !important; }`;
      styles.set(root, style);
    }
    if (!style.isConnected) (root === document ? document.documentElement : root).append(style);
    if (roots.has(root)) return;
    roots.add(root);
    new MutationObserver(schedule).observe(root, { childList: true, subtree: true, attributes: true,
      attributeFilter: ["href", "permalink", "content-href", "id", "data-fullname", "aria-label", "title"] });
  };
  scan();
  setInterval(scan, 1000);
}
