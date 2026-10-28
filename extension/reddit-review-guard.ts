import { redditReviewHost, redditReviewPostId, redditReviewSearchPage, redditReviewTarget, redditReviewDestination, redditReviewRedirect, vigilReturnPage } from "../src/redditReview.js";
import { blockedPageBack } from "../src/blockedPageBack.js";

const reviewApi: typeof chrome = (globalThis as typeof globalThis & { browser?: typeof chrome }).browser || chrome;
function reviewBlocked(): void {
  if (window !== window.top) { location.replace("about:blank"); return; }
  if (returnPending) return;
  returnPending = true;
  let settled = false;
  const finish = (result?: { handled?: boolean; ok?: boolean; url?: string; exhausted?: boolean }) => {
    if (settled) return;
    settled = true;
    clearTimeout(fallback);
    if (result?.handled) { returnPending = false; return; }
    if (result?.ok && result.url && result.url !== "about:blank") blockedPageBack(result.url);
    else if (onReturnPage && !document.querySelector('[data-vigil-quiet-return]')) {
      returnPending = false;
      blockedPageBack("", result?.exhausted);
    }
    else location.replace("about:blank");
  };
  const fallback = setTimeout(finish, 4000);
  try {
    void reviewApi.runtime.sendMessage({ type: "VIGIL_REDDIT_REVIEW", action: "return", sourceUrl: location.href })
      .then(finish, () => finish());
  } catch { finish(); }
}
let returnPending = false;
const onReturnPage = vigilReturnPage(location.href, reviewApi.runtime.getURL("/"));
if (onReturnPage) {
  addEventListener("pageshow", () => { returnPending = false; });
  addEventListener("click", event => {
    const target = event.target instanceof Element ? event.target.closest("#leaveBlockedPage") : null;
    if (!target) return;
    event.preventDefault(); event.stopImmediatePropagation(); reviewBlocked();
  }, true);
  const quietReturn = () => {
    if (document.querySelector('[data-vigil-quiet-return]')) reviewBlocked();
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
  if (reviewAppControl(element)) return true;
  if (!element.matches("button, [role='button']")) return false;
  const label = [element.getAttribute("aria-label"), element.getAttribute("title"), element.textContent].filter(Boolean).join(" ").trim();
  return /^(?:upvote|downvote|reply|create post|join|follow|chat|share|award|log in|sign up)(?:\b|$)/iu.test(label);
}
function reviewAppControl(element: Element): boolean {
  if (!element.matches("a[href], button, [role='button']")) return false;
  const label = [element.getAttribute("aria-label"), element.getAttribute("title"), element.textContent].filter(Boolean).join(" ").trim();
  if (/^(?:open(?: in)?|use|get|download|install|try|continue (?:in|to))(?: the)? (?:reddit )?app(?:\b|$)/iu.test(label)) return true;
  if (!(element instanceof HTMLAnchorElement)) return false;
  try { const url = new URL(element.href); return ["itms-apps:", "itms:", "reddit:"].includes(url.protocol)
    || ["apps.apple.com", "itunes.apple.com", "play.google.com", "reddit.app.link"].includes(url.hostname); }
  catch { return false; }
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
  const target = anchor && redditReviewTarget(anchor.href);
  if (target && !redditReviewPostId(target)) {
    event.preventDefault(); event.stopImmediatePropagation();
  }
}, true);
addEventListener("click", reviewSearchClick, true);
addEventListener("auxclick", reviewSearchClick, true);

if (redditReviewHost(location.href)) {
  const initialPost = redditReviewPostId(location.href);
  let authorized = false;
  let pendingForm: HTMLFormElement | null = null;
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
    // Reddit's automatic document check may submit before the tab grant check
    // resolves. Replay only a GET to this exact post after authorization.
    const form = pendingForm;
    pendingForm = null;
    if (form?.isConnected && form.method.toLowerCase() === "get" && redditReviewPostId(form.action) === initialPost) form.requestSubmit();
    }, block);
  }

  const guard = (event: Event) => {
    if (event instanceof KeyboardEvent && event.key !== "Enter" && event.key !== " ") return;
    const anchor = reviewAnchor(event);
    const target = event.composedPath().find(node => node instanceof Element) as Element | undefined;
    if (event.type === "submit" && event.target instanceof HTMLFormElement && !authorized
      && initialPost && event.target.method.toLowerCase() === "get" && redditReviewPostId(event.target.action) === initialPost) pendingForm = event.target;
    const forbidden = !authorized || event.composedPath().some(node => node instanceof Element && reviewSocialControl(node))
      || target?.closest("[data-vigil-review-label], [data-vigil-review-meta]")
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
  const labels = new WeakMap<HTMLAnchorElement, HTMLSpanElement>();
  const metadata = new WeakMap<Element, HTMLDivElement>();
  const discussion = "shreddit-post, shreddit-comment, .thing.link, .thing.comment, [data-testid='post-container'], [data-testid='comment']";
  // These are text-only mirrors. Original links and headers stay hidden and
  // the capture guard also stops site handlers on their inert replacements.
  const identityLink = (anchor: HTMLAnchorElement) => {
    try {
      const url = new URL(anchor.href);
      return /^(?:www\.|old\.|new\.|np\.|m\.)?reddit\.com$/iu.test(url.hostname)
        && /^\/(?:u|user|r)\/[^/]+\/?$/iu.test(url.pathname);
    } catch { return false; }
  };
  const updateText = (element: Element, value: string) => {
    if (element.textContent !== value) element.textContent = value;
  };
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
        let label = labels.get(anchor);
        if (identityLink(anchor) && !reviewAppControl(anchor) && anchor.textContent?.trim()) {
          if (!label) {
            label = document.createElement("span");
            label.setAttribute("data-vigil-review-label", "");
            labels.set(anchor, label);
          }
          updateText(label, anchor.textContent.trim());
          const slot = anchor.getAttribute("slot");
          if (slot !== label.getAttribute("slot")) {
            if (slot === null) label.removeAttribute("slot");
            else label.setAttribute("slot", slot);
          }
          if (anchor.nextSibling !== label) anchor.after(label);
        } else label?.remove();
      }
      for (const label of root.querySelectorAll("[data-vigil-review-label]")) {
        const anchor = label.previousSibling;
        if (!(anchor instanceof HTMLAnchorElement) || labels.get(anchor) !== label) label.remove();
      }
      // Modern Reddit puts author names inside <header>, which remains
      // concealed with the navigation. Recreate only its author/time text,
      // inside the original post/comment so safety-hidden parents stay hidden.
      for (const card of root.querySelectorAll(discussion)) {
        const content = card.shadowRoot || card;
        const own = (element: Element) => element.closest(discussion) === card
          || (element.getRootNode() === card.shadowRoot && !element.closest(discussion));
        const header = Array.from(content.querySelectorAll("header")).find(own);
        const authorLink = header && Array.from(header.querySelectorAll<HTMLAnchorElement>("a[href]"))
          .find(anchor => identityLink(anchor) && /^\/(?:u|user)\//iu.test(new URL(anchor.href).pathname));
        const author = authorLink?.textContent?.trim() || card.getAttribute("author") || card.getAttribute("data-author");
        const community = header && Array.from(header.querySelectorAll<HTMLAnchorElement>("a[href]"))
          .find(anchor => identityLink(anchor) && /^\/r\//iu.test(new URL(anchor.href).pathname))?.textContent?.trim();
        const time = header?.querySelector("time");
        let row = metadata.get(card);
        const inlineAuthor = Array.from(card.querySelectorAll(".author, [slot='authorName'], [data-testid='comment_author_link']"))
          .concat(content === card ? [] : Array.from(content.querySelectorAll(".author, [slot='authorName'], [data-testid='comment_author_link']"))).some(own);
        if (author && (header || !inlineAuthor)) {
          if (!row) {
            row = document.createElement("div");
            row.setAttribute("data-vigil-review-meta", "");
            metadata.set(card, row);
          }
          updateText(row, `${community ? `${community} · ` : ""}${author}${time?.textContent?.trim() ? ` · ${time.textContent.trim()}` : ""}`);
          if (row.parentNode !== content) content.prepend(row);
        } else row?.remove();
      }
      for (const card of root.querySelectorAll("shreddit-post, shreddit-search-result, article, .thing.link, [data-testid='post-container']")) {
        const candidate = card.getAttribute("permalink") || card.getAttribute("content-href") || card.querySelector<HTMLAnchorElement>("a[href*='/comments/']")?.href;
        const id = (card.getAttribute("data-fullname") || card.getAttribute("id") || "").match(/^t3_([a-z0-9]+)$/iu)?.[1];
        if (id ? id !== post : candidate && redditReviewPostId(new URL(candidate, location.href).href) !== post) hide(card);
      }
      for (const button of root.querySelectorAll("button, [role='button']")) {
        if (reviewSocialControl(button)) hide(button);
      }
      for (const anchor of root.querySelectorAll("a[href]")) if (reviewAppControl(anchor)) hide(anchor);
    }
  };
  const schedule = () => { if (!queued) { queued = true; queueMicrotask(scan); } };
  const observe = (root: Document | ShadowRoot) => {
    if (root === document && !document.documentElement) return;
    let style = styles.get(root);
    if (!style) {
      style = document.createElement("style");
      style.textContent = `${reviewReaderAppearance}\n${hidden} { display:none !important; visibility:hidden !important; }`;
      styles.set(root, style);
    }
    if (!style.isConnected) (root === document ? document.documentElement : root).append(style);
    if (roots.has(root)) return;
    roots.add(root);
    new MutationObserver(schedule).observe(root, { childList: true, subtree: true, attributes: true,
      attributeFilter: ["href", "permalink", "content-href", "id", "data-fullname", "aria-label", "title", "author", "data-author", "slot"], characterData: true });
  };
  scan();
  setInterval(scan, 1000);
}

// Presentation never overrides display/visibility on Reddit content: the
// independent mature-content guards retain authority over every element.
const reviewReaderAppearance = `
  :root, :host {
    --vigil-reader-bg: #f6f7f8; --vigil-reader-surface: #fff;
    --vigil-reader-text: #1a282d; --vigil-reader-muted: #576f76;
    --vigil-reader-line: #dce1e3; --vigil-reader-accent: #d93900;
  }
  @media (prefers-color-scheme: dark) {
    :root, :host {
      --vigil-reader-bg: #0e1113; --vigil-reader-surface: #181c1f;
      --vigil-reader-text: #eef1f3; --vigil-reader-muted: #a8b5ba;
      --vigil-reader-line: #343e42; --vigil-reader-accent: #ff6b35;
    }
  }
  html { background: var(--vigil-reader-bg) !important; color-scheme: light dark; }
  body {
    margin: 0 !important; padding: 0 24px 48px !important;
    background: var(--vigil-reader-bg) !important; color: var(--vigil-reader-text) !important;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif !important;
    font-size: 15px; line-height: 1.55;
  }
  body::before {
    content: 'reddit'; display: block; box-sizing: border-box;
    max-width: 850px; margin: 0 auto 24px; padding: 18px 0 14px;
    border-bottom: 1px solid var(--vigil-reader-line);
    color: var(--vigil-reader-accent); font-size: 30px; font-weight: 800; letter-spacing: -1.2px;
  }
  main, body > .content, .main-container, #main-content {
    box-sizing: border-box; width: 100% !important; max-width: 850px !important;
    margin-inline: auto !important; min-width: 0 !important;
  }
  .grid-container { grid-template-columns: minmax(0, 850px) !important; justify-content: center; }
  shreddit-post, .thing.link, [data-testid='post-container'] {
    box-sizing: border-box; background: var(--vigil-reader-surface) !important;
    color: var(--vigil-reader-text) !important; border: 1px solid var(--vigil-reader-line) !important;
    border-radius: 16px !important; padding: 24px !important; margin-bottom: 24px !important;
  }
  h1, [slot='title'], .thing.link .title {
    color: var(--vigil-reader-text) !important; font-size: clamp(23px, 3vw, 30px) !important;
    font-weight: 700 !important; line-height: 1.25 !important; letter-spacing: -.5px;
  }
  [data-vigil-review-label], [data-vigil-review-meta] {
    color: var(--vigil-reader-muted); font-size: 12px; font-weight: 600; line-height: 1.5;
    cursor: text; overflow-wrap: anywhere;
  }
  [data-vigil-review-meta] { margin-bottom: 10px; }
  shreddit-comment, .thing.comment, [data-testid='comment'] {
    color: var(--vigil-reader-text); padding-block: 12px;
  }
  .thing.comment > .child, shreddit-comment > [slot='children'], [data-testid='comment'] > .replies {
    border-left: 1px solid var(--vigil-reader-line) !important;
    margin-left: 10px !important; padding-left: 20px !important;
  }
  .md, [slot='text-body'], [data-testid='comment'] p { color: var(--vigil-reader-text); line-height: 1.65; overflow-wrap: anywhere; }
  .md p, [slot='text-body'] p { margin-block: 8px 12px; }
  blockquote { border-left: 3px solid var(--vigil-reader-line); margin-inline: 0; padding-left: 16px; }
  pre { max-width: 100%; overflow-x: auto; border-radius: 8px; padding: 12px; }
  @media (max-width: 600px) {
    body { padding-inline: 14px !important; }
    body::before { margin-bottom: 16px; padding-top: 12px; font-size: 27px; }
    shreddit-post, .thing.link, [data-testid='post-container'] { padding: 18px !important; border-radius: 12px !important; }
    .thing.comment > .child, shreddit-comment > [slot='children'], [data-testid='comment'] > .replies {
      margin-left: 6px !important; padding-left: 12px !important;
    }
  }
`;
