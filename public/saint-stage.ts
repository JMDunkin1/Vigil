export interface SaintPatron {
  id: "michael" | "augustine" | "mary" | "joseph" | "thomas" | "benedict" | "pio";
  shortName: string;
  name: string;
  epithet: string;
  quote: string;
  source: string;
  fallback: string;
}

export const SAINT_PATRONS: readonly SaintPatron[] = [
  {
    id: "michael",
    shortName: "Michael",
    name: "Saint Michael the Archangel",
    epithet: "Defender in battle",
    quote: "Quis ut Deus?",
    source: "Traditional meaning of Michael: Who is like God?",
    fallback: "M"
  },
  {
    id: "augustine",
    shortName: "Augustine",
    name: "Saint Augustine of Hippo",
    epithet: "Doctor of grace",
    quote: "You have made us for yourself, O Lord, and our heart is restless until it rests in you.",
    source: "Confessions, Book I",
    fallback: "A"
  },
  {
    id: "mary",
    shortName: "Mary",
    name: "The Blessed Virgin Mary",
    epithet: "Our Lady, Star of the Sea",
    quote: "My soul magnifies the Lord.",
    source: "Luke 1:46",
    fallback: "M"
  },
  {
    id: "joseph",
    shortName: "Joseph",
    name: "Saint Joseph",
    epithet: "Guardian of the Redeemer",
    quote: "He did as the angel of the Lord commanded him.",
    source: "Matthew 1:24",
    fallback: "J"
  },
  {
    id: "thomas",
    shortName: "Thomas",
    name: "Saint Thomas Aquinas",
    epithet: "The Angelic Doctor",
    quote: "I adore you devoutly, hidden Deity.",
    source: "Adoro te devote, traditionally attributed",
    fallback: "T"
  },
  {
    id: "benedict",
    shortName: "Benedict",
    name: "Saint Benedict of Nursia",
    epithet: "Father of Western monasticism",
    quote: "Prefer nothing whatever to Christ.",
    source: "Rule of Saint Benedict, 72",
    fallback: "B"
  },
  {
    id: "pio",
    shortName: "Padre Pio",
    name: "Saint Padre Pio of Pietrelcina",
    epithet: "Capuchin priest and spiritual father",
    quote: "Pray, hope, and don't worry.",
    source: "Traditional saying attributed to Saint Padre Pio",
    fallback: "P"
  }
] as const;

const STORAGE_KEY = "vigil-patron-saint";

export function createSaintStage() {
  const stage = required<HTMLElement>("#saintStage");
  const stageButton = required<HTMLButtonElement>("#saintStageButton");
  const artwork = required<HTMLImageElement>("#saintArtwork");
  const fallback = required<HTMLElement>("#saintFallback");
  const infoPopover = required<HTMLElement>("#saintInfoPopover");
  const infoClose = required<HTMLButtonElement>("#saintInfoClose");
  const infoPrevious = required<HTMLButtonElement>("#saintInfoPrevious");
  const infoNext = required<HTMLButtonElement>("#saintInfoNext");
  const infoName = required<HTMLElement>("#saintInfoName");
  const infoEpithet = required<HTMLElement>("#saintInfoEpithet");
  const infoQuote = required<HTMLElement>("#saintInfoQuote");
  const infoSource = required<HTMLElement>("#saintInfoSource");
  let selectedId = storedSaintId();
  let pointerFrame: number | null = null;

  function bind(): void {
    select(selectedId, false);
    stageButton.addEventListener("click", () => {
      select(nextSaintId(selectedId));
    });
    stageButton.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      openInfo();
    });
    stageButton.addEventListener("keydown", (event) => {
      if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
      event.preventDefault();
      openInfo();
    });
    infoClose.addEventListener("click", () => closeInfo());
    infoPrevious.addEventListener("click", () => select(previousSaintId(selectedId), true, true));
    infoNext.addEventListener("click", () => select(nextSaintId(selectedId), true, true));
    document.addEventListener("pointerdown", (event) => {
      if (infoPopover.hidden) return;
      const target = event.target;
      if (target instanceof Node && (infoPopover.contains(target) || stageButton.contains(target))) return;
      closeInfo();
    });
    document.addEventListener("keydown", (event) => {
      if (infoPopover.hidden) return;
      if (event.key === "Escape") {
        closeInfo(true);
        return;
      }
      const target = event.target;
      if (!(target instanceof Node) || !infoPopover.contains(target)) return;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        select(previousSaintId(selectedId), true, true);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        select(nextSaintId(selectedId), true, true);
      }
    });
    artwork.addEventListener("load", () => {
      stage.dataset.artMissing = "false";
    });
    artwork.addEventListener("error", () => {
      stage.dataset.artMissing = "true";
    });

    if (!motionAllowed()) return;
    stage.addEventListener("pointerenter", (event) => {
      if (event.pointerType === "touch") return;
      stage.classList.add("is-pointer-active");
    });
    stage.addEventListener("pointermove", (event) => {
      if (event.pointerType === "touch") return;
      stage.classList.add("is-pointer-active");
      if (pointerFrame !== null) cancelAnimationFrame(pointerFrame);
      pointerFrame = requestAnimationFrame(() => {
        pointerFrame = null;
        const bounds = stage.getBoundingClientRect();
        const x = ((event.clientX - bounds.left) / Math.max(1, bounds.width) - 0.5) * 2;
        const y = ((event.clientY - bounds.top) / Math.max(1, bounds.height) - 0.5) * 2;
        stage.style.setProperty("--saint-look-x", x.toFixed(3));
        stage.style.setProperty("--saint-look-y", y.toFixed(3));
        stage.style.setProperty("--saint-pointer-x", `${((x + 1) * 50).toFixed(1)}%`);
        stage.style.setProperty("--saint-pointer-y", `${((y + 1) * 50).toFixed(1)}%`);
        stage.style.setProperty("--saint-pointer-distance", Math.min(1, Math.hypot(x, y)).toFixed(3));
      });
    });
    stage.addEventListener("pointerleave", resetPointer);
    stage.addEventListener("animationend", (event) => {
      if (event.target === stage && event.animationName === "saintSceneArrive") {
        stage.classList.remove("is-switching-saint");
      }
    });
  }

  function select(id: SaintPatron["id"], persist = true, keepInfoOpen = false): void {
    const saint = SAINT_PATRONS.find((item) => item.id === id) || SAINT_PATRONS[0];
    if (!keepInfoOpen) closeInfo();
    selectedId = saint.id;
    stage.classList.remove("is-switching-saint");
    void stage.offsetWidth;
    stage.classList.add("is-switching-saint");
    stage.dataset.saint = saint.id;
    stage.dataset.artMissing = "false";
    artwork.src = `/art/saints/${saint.id}.png`;
    artwork.alt = saint.name;
    fallback.textContent = saint.fallback;
    stageButton.setAttribute("aria-label", `${saint.name}. Show the next patron saint.`);
    if (persist) storeSaintId(saint.id);
    if (keepInfoOpen) renderInfo();
  }

  function openInfo(): void {
    renderInfo();
    infoPopover.hidden = false;
    stageButton.setAttribute("aria-expanded", "true");
    infoPopover.focus({ preventScroll: true });
  }

  function renderInfo(): void {
    const saint = SAINT_PATRONS.find((item) => item.id === selectedId) || SAINT_PATRONS[0];
    infoName.textContent = saint.name;
    infoEpithet.textContent = saint.epithet;
    infoQuote.textContent = `\u201c${saint.quote}\u201d`;
    infoSource.textContent = saint.source;
    const previous = patron(previousSaintId(selectedId));
    const next = patron(nextSaintId(selectedId));
    infoPrevious.setAttribute("aria-label", `Show ${previous.name}`);
    infoNext.setAttribute("aria-label", `Show ${next.name}`);
  }

  function closeInfo(restoreFocus = false): void {
    if (infoPopover.hidden) return;
    infoPopover.hidden = true;
    stageButton.setAttribute("aria-expanded", "false");
    if (restoreFocus) stageButton.focus({ preventScroll: true });
  }

  function resetPointer(): void {
    if (pointerFrame !== null) {
      cancelAnimationFrame(pointerFrame);
      pointerFrame = null;
    }
    stage.classList.remove("is-pointer-active");
    stage.style.setProperty("--saint-look-x", "0");
    stage.style.setProperty("--saint-look-y", "0");
    stage.style.setProperty("--saint-pointer-x", "50%");
    stage.style.setProperty("--saint-pointer-y", "50%");
    stage.style.setProperty("--saint-pointer-distance", "0");
  }

  return { bind, select };
}

function nextSaintId(id: SaintPatron["id"]): SaintPatron["id"] {
  const index = SAINT_PATRONS.findIndex((saint) => saint.id === id);
  return SAINT_PATRONS[(index + 1) % SAINT_PATRONS.length].id;
}

function previousSaintId(id: SaintPatron["id"]): SaintPatron["id"] {
  const index = SAINT_PATRONS.findIndex((saint) => saint.id === id);
  return SAINT_PATRONS[(index - 1 + SAINT_PATRONS.length) % SAINT_PATRONS.length].id;
}

function patron(id: SaintPatron["id"]): SaintPatron {
  return SAINT_PATRONS.find((saint) => saint.id === id) || SAINT_PATRONS[0];
}

function storedSaintId(): SaintPatron["id"] {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    const saint = SAINT_PATRONS.find((item) => item.id === value);
    if (saint) return saint.id;
  } catch {
  }
  return "michael";
}

function storeSaintId(id: SaintPatron["id"]): void {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
  }
}

function motionAllowed(): boolean {
  return !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    && !window.matchMedia?.("(pointer: coarse)").matches;
}

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing saint-stage element: ${selector}`);
  return element;
}
