export interface SaintPatron {
  id: "michael" | "augustine" | "mary" | "joseph" | "thomas" | "benedict" | "pio";
  shortName: string;
  name: string;
  epithet: string;
  quote: string;
  source: string;
  fallback: string;
}

export type SaintAesthetic = "playful" | "serious";

export const SAINT_AESTHETICS: readonly SaintAesthetic[] = ["playful", "serious"] as const;
export const SAINT_AESTHETIC_STORAGE_KEY = "vigil-saint-aesthetic";

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

export function normalizeSaintAesthetic(value: unknown): SaintAesthetic {
  return value === "serious" ? "serious" : "playful";
}

export function saintArtworkPath(id: SaintPatron["id"], aesthetic: SaintAesthetic): string {
  const directory = aesthetic === "serious" ? "serious/" : "";
  return `/art/saints/${directory}${id}.png`;
}

export function readSaintAesthetic(storage: Pick<Storage, "getItem">): SaintAesthetic {
  return normalizeSaintAesthetic(storage.getItem(SAINT_AESTHETIC_STORAGE_KEY));
}

export function writeSaintAesthetic(storage: Pick<Storage, "setItem">, aesthetic: SaintAesthetic): void {
  storage.setItem(SAINT_AESTHETIC_STORAGE_KEY, aesthetic);
}

export function createSaintStage() {
  const homeStage = required<HTMLElement>("#view-home .home-stage");
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
  const aestheticStatus = document.querySelector<HTMLElement>("#saintAestheticStatus");
  const aestheticInputs = [...document.querySelectorAll<HTMLInputElement>('input[name="saintAesthetic"]')];
  let selectedId = storedSaintId();
  let aesthetic = storedSaintAesthetic();
  let pointerFrame: number | null = null;

  function bind(): void {
    setAesthetic(aesthetic, false);
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
    for (const input of aestheticInputs) {
      input.addEventListener("change", () => {
        if (input.checked) setAesthetic(normalizeSaintAesthetic(input.value));
      });
    }

    if (!motionAllowed()) return;
    homeStage.addEventListener("pointerenter", (event) => {
      if (event.pointerType === "touch") return;
      homeStage.classList.add("is-pointer-active");
    });
    homeStage.addEventListener("pointermove", (event) => {
      if (event.pointerType === "touch") return;
      homeStage.classList.add("is-pointer-active");
      if (pointerFrame !== null) cancelAnimationFrame(pointerFrame);
      pointerFrame = requestAnimationFrame(() => {
        pointerFrame = null;
        const bounds = homeStage.getBoundingClientRect();
        const x = ((event.clientX - bounds.left) / Math.max(1, bounds.width) - 0.5) * 2;
        const y = ((event.clientY - bounds.top) / Math.max(1, bounds.height) - 0.5) * 2;
        const horizontal = x < -0.25 ? "left" : x > 0.25 ? "right" : "center";
        const vertical = y < -0.25 ? "up" : y > 0.25 ? "down" : "center";
        stage.dataset.look = `${horizontal}-${vertical}`;
      });
    });
    homeStage.addEventListener("pointerleave", resetPointer);
    window.addEventListener("pagehide", resetPointer);
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
    artwork.src = saintArtworkPath(saint.id, aesthetic);
    artwork.alt = saint.name;
    fallback.textContent = saint.fallback;
    stageButton.setAttribute("aria-label", `${saint.name}. Show the next patron saint.`);
    if (persist) storeSaintId(saint.id);
    if (keepInfoOpen) renderInfo();
  }

  function setAesthetic(value: SaintAesthetic, persist = true): void {
    aesthetic = normalizeSaintAesthetic(value);
    document.documentElement.dataset.saintAesthetic = aesthetic;
    for (const input of aestheticInputs) input.checked = input.value === aesthetic;
    if (aestheticStatus) aestheticStatus.textContent = `${aesthetic === "serious" ? "Serious" : "Playful"} style active`;
    stage.dataset.artMissing = "false";
    artwork.src = saintArtworkPath(selectedId, aesthetic);
    if (persist) storeSaintAesthetic(aesthetic);
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
    homeStage.classList.remove("is-pointer-active");
    stage.dataset.look = "center-center";
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

function storedSaintAesthetic(): SaintAesthetic {
  try {
    return readSaintAesthetic(localStorage);
  } catch {
    return "playful";
  }
}

function storeSaintAesthetic(aesthetic: SaintAesthetic): void {
  try {
    writeSaintAesthetic(localStorage, aesthetic);
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
