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

export const SAINT_STAGE_PORTRAITS: readonly SaintStagePortrait[] = [
  ...SAINT_PATRONS,
  CHRIST_PANTOCRATOR
];

const STORAGE_KEY = "vigil-patron-saint";

export function coerceStagePortraitId(id: unknown): SaintStagePortraitId {
  const portrait = SAINT_STAGE_PORTRAITS.find((item) => item.id === id);
  return portrait?.id || "michael";
}

export function nextStagePortraitId(id: SaintStagePortraitId): SaintStagePortraitId {
  const selectedId = coerceStagePortraitId(id);
  const index = SAINT_STAGE_PORTRAITS.findIndex((portrait) => portrait.id === selectedId);
  return SAINT_STAGE_PORTRAITS[(index + 1) % SAINT_STAGE_PORTRAITS.length].id;
}

export function previousStagePortraitId(id: SaintStagePortraitId): SaintStagePortraitId {
  const selectedId = coerceStagePortraitId(id);
  const index = SAINT_STAGE_PORTRAITS.findIndex((portrait) => portrait.id === selectedId);
  return SAINT_STAGE_PORTRAITS[(index - 1 + SAINT_STAGE_PORTRAITS.length) % SAINT_STAGE_PORTRAITS.length].id;
}

export function saintArtworkPath(id: SaintStagePortraitId): string {
  if (!SAINT_STAGE_PORTRAITS.some((portrait) => portrait.id === id)) {
    throw new Error(`${id} artwork is unavailable`);
  }
  return `/art/saints/traditional/${id}.png`;
}

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
  let selectedId = coerceStagePortraitId(storedStagePortraitId());

  function bind(): void {
    select(selectedId, false);
    stageButton.addEventListener("click", () => {
      select(nextStagePortraitId(selectedId));
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
    infoPrevious.addEventListener("click", () => select(previousStagePortraitId(selectedId), true, true));
    infoNext.addEventListener("click", () => select(nextStagePortraitId(selectedId), true, true));
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
        select(previousStagePortraitId(selectedId), true, true);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        select(nextStagePortraitId(selectedId), true, true);
      }
    });
    artwork.addEventListener("load", () => {
      stage.dataset.artMissing = "false";
    });
    artwork.addEventListener("error", () => {
      stage.dataset.artMissing = "true";
    });
    stage.addEventListener("animationend", (event) => {
      if (event.target === stage && event.animationName === "saintSceneArrive") {
        stage.classList.remove("is-switching-saint");
      }
    });
  }

  function select(id: SaintStagePortraitId, persist = true, keepInfoOpen = false): void {
    const portrait = stagePortrait(coerceStagePortraitId(id));
    if (!keepInfoOpen) closeInfo();
    selectedId = portrait.id;
    stage.classList.remove("is-switching-saint");
    void stage.offsetWidth;
    stage.classList.add("is-switching-saint");
    stage.dataset.saint = portrait.id;
    stage.dataset.artMissing = "false";
    artwork.src = saintArtworkPath(portrait.id);
    artwork.alt = portrait.name;
    fallback.textContent = portrait.fallback;
    stageButton.setAttribute("aria-label", `${portrait.name}. Show the next sacred portrait.`);
    if (persist) storeStagePortraitId(portrait.id);
    if (keepInfoOpen) renderInfo();
  }

  function openInfo(): void {
    renderInfo();
    infoPopover.hidden = false;
    stageButton.setAttribute("aria-expanded", "true");
    infoPopover.focus({ preventScroll: true });
  }

  function renderInfo(): void {
    const portrait = stagePortrait(selectedId);
    infoName.textContent = portrait.name;
    infoEpithet.textContent = portrait.epithet;
    infoQuote.textContent = `\u201c${portrait.quote}\u201d`;
    infoSource.textContent = portrait.source;
    const previous = stagePortrait(previousStagePortraitId(selectedId));
    const next = stagePortrait(nextStagePortraitId(selectedId));
    infoPrevious.setAttribute("aria-label", `Show ${previous.name}`);
    infoNext.setAttribute("aria-label", `Show ${next.name}`);
  }

  function closeInfo(restoreFocus = false): void {
    if (infoPopover.hidden) return;
    infoPopover.hidden = true;
    stageButton.setAttribute("aria-expanded", "false");
    if (restoreFocus) stageButton.focus({ preventScroll: true });
  }

  return { bind, select };
}

function stagePortrait(id: SaintStagePortraitId): SaintStagePortrait {
  return SAINT_STAGE_PORTRAITS.find((portrait) => portrait.id === id) || SAINT_PATRONS[0];
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

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing saint-stage element: ${selector}`);
  return element;
}
