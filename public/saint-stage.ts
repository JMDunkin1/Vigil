export type SaintPatronId = "michael" | "augustine" | "mary" | "joseph" | "thomas" | "benedict" | "pio";
export type SaintStagePortraitId = SaintPatronId | "christ";

export interface SaintStagePortrait {
  id: SaintStagePortraitId;
  shortName: string;
  name: string;
  epithet: string;
  quote: string;
  source: string;
  fallback: string;
}

export interface SaintPatron extends SaintStagePortrait {
  id: SaintPatronId;
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

export const CHRIST_PANTOCRATOR: SaintStagePortrait = {
  id: "christ",
  shortName: "Christ",
  name: "Jesus Christ Pantocrator",
  epithet: "Ruler of All",
  quote: "I am the light of the world. Whoever follows me will not walk in darkness, but will have the light of life.",
  source: "John 8:12",
  fallback: "C"
};

export const SERIOUS_STAGE_PORTRAITS: readonly SaintStagePortrait[] = [
  ...SAINT_PATRONS,
  CHRIST_PANTOCRATOR
];

const STORAGE_KEY = "vigil-patron-saint";

export function normalizeSaintAesthetic(value: unknown): SaintAesthetic {
  return value === "serious" ? "serious" : "playful";
}

export function stagePortraitsForAesthetic(aesthetic: SaintAesthetic): readonly SaintStagePortrait[] {
  return aesthetic === "serious" ? SERIOUS_STAGE_PORTRAITS : SAINT_PATRONS;
}

export function coerceStagePortraitId(id: unknown, aesthetic: SaintAesthetic): SaintStagePortraitId {
  const portrait = stagePortraitsForAesthetic(aesthetic).find((item) => item.id === id);
  return portrait?.id || "michael";
}

export function nextStagePortraitId(id: SaintStagePortraitId, aesthetic: SaintAesthetic): SaintStagePortraitId {
  const portraits = stagePortraitsForAesthetic(aesthetic);
  const selectedId = coerceStagePortraitId(id, aesthetic);
  const index = portraits.findIndex((portrait) => portrait.id === selectedId);
  return portraits[(index + 1) % portraits.length].id;
}

export function previousStagePortraitId(id: SaintStagePortraitId, aesthetic: SaintAesthetic): SaintStagePortraitId {
  const portraits = stagePortraitsForAesthetic(aesthetic);
  const selectedId = coerceStagePortraitId(id, aesthetic);
  const index = portraits.findIndex((portrait) => portrait.id === selectedId);
  return portraits[(index - 1 + portraits.length) % portraits.length].id;
}

export function saintArtworkPath(id: SaintStagePortraitId, aesthetic: SaintAesthetic): string {
  if (!stagePortraitsForAesthetic(aesthetic).some((portrait) => portrait.id === id)) {
    throw new Error(`${id} artwork is unavailable in ${aesthetic} mode`);
  }
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
  let aesthetic = storedSaintAesthetic();
  let selectedId = coerceStagePortraitId(storedStagePortraitId(), aesthetic);
  let pointerFrame: number | null = null;

  function bind(): void {
    setAesthetic(aesthetic, false);
    stageButton.addEventListener("click", () => {
      select(nextStagePortraitId(selectedId, aesthetic));
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
    infoPrevious.addEventListener("click", () => select(previousStagePortraitId(selectedId, aesthetic), true, true));
    infoNext.addEventListener("click", () => select(nextStagePortraitId(selectedId, aesthetic), true, true));
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
        select(previousStagePortraitId(selectedId, aesthetic), true, true);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        select(nextStagePortraitId(selectedId, aesthetic), true, true);
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

  function select(id: SaintStagePortraitId, persist = true, keepInfoOpen = false): void {
    const portrait = stagePortrait(coerceStagePortraitId(id, aesthetic), aesthetic);
    if (!keepInfoOpen) closeInfo();
    selectedId = portrait.id;
    stage.classList.remove("is-switching-saint");
    void stage.offsetWidth;
    stage.classList.add("is-switching-saint");
    stage.dataset.saint = portrait.id;
    stage.dataset.artMissing = "false";
    artwork.src = saintArtworkPath(portrait.id, aesthetic);
    artwork.alt = portrait.name;
    fallback.textContent = portrait.fallback;
    stageButton.setAttribute("aria-label", `${portrait.name}. Show the next sacred portrait.`);
    if (persist) storeStagePortraitId(portrait.id);
    if (keepInfoOpen) renderInfo();
  }

  function setAesthetic(value: SaintAesthetic, persist = true): void {
    const keepInfoOpen = !infoPopover.hidden;
    aesthetic = normalizeSaintAesthetic(value);
    document.documentElement.dataset.saintAesthetic = aesthetic;
    for (const input of aestheticInputs) input.checked = input.value === aesthetic;
    if (aestheticStatus) aestheticStatus.textContent = `${aesthetic === "serious" ? "Traditional" : "Pixel Art"} active`;
    if (persist) storeSaintAesthetic(aesthetic);
    select(selectedId, persist, keepInfoOpen);
  }

  function openInfo(): void {
    renderInfo();
    infoPopover.hidden = false;
    stageButton.setAttribute("aria-expanded", "true");
    infoPopover.focus({ preventScroll: true });
  }

  function renderInfo(): void {
    const portrait = stagePortrait(selectedId, aesthetic);
    infoName.textContent = portrait.name;
    infoEpithet.textContent = portrait.epithet;
    infoQuote.textContent = `\u201c${portrait.quote}\u201d`;
    infoSource.textContent = portrait.source;
    const previous = stagePortrait(previousStagePortraitId(selectedId, aesthetic), aesthetic);
    const next = stagePortrait(nextStagePortraitId(selectedId, aesthetic), aesthetic);
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

function stagePortrait(id: SaintStagePortraitId, aesthetic: SaintAesthetic): SaintStagePortrait {
  return stagePortraitsForAesthetic(aesthetic).find((portrait) => portrait.id === id) || SAINT_PATRONS[0];
}

function storedStagePortraitId(): SaintStagePortraitId {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value === "christ") return value;
    const saint = SAINT_PATRONS.find((item) => item.id === value);
    if (saint) return saint.id;
  } catch {
  }
  return "michael";
}

function storeStagePortraitId(id: SaintStagePortraitId): void {
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
