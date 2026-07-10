export interface SaintPatron {
  id: "michael" | "augustine" | "mary" | "joseph" | "thomas" | "benedict";
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
  }
] as const;

const STORAGE_KEY = "sentinel-patron-saint";

export function createSaintStage() {
  const stage = required<HTMLElement>("#saintStage");
  const stageButton = required<HTMLButtonElement>("#saintStageButton");
  const artwork = required<HTMLImageElement>("#saintArtwork");
  const fallback = required<HTMLElement>("#saintFallback");
  let selectedId = storedSaintId();
  let pointerFrame: number | null = null;

  function bind(): void {
    select(selectedId, false);
    stageButton.addEventListener("click", () => select(nextSaintId(selectedId)));
    artwork.addEventListener("load", () => {
      stage.dataset.artMissing = "false";
    });
    artwork.addEventListener("error", () => {
      stage.dataset.artMissing = "true";
    });

    if (!motionAllowed()) return;
    stage.addEventListener("pointermove", (event) => {
      if (event.pointerType === "touch") return;
      if (pointerFrame !== null) cancelAnimationFrame(pointerFrame);
      pointerFrame = requestAnimationFrame(() => {
        pointerFrame = null;
        const bounds = stage.getBoundingClientRect();
        const x = ((event.clientX - bounds.left) / Math.max(1, bounds.width) - 0.5) * 2;
        const y = ((event.clientY - bounds.top) / Math.max(1, bounds.height) - 0.5) * 2;
        stage.style.setProperty("--saint-look-x", x.toFixed(3));
        stage.style.setProperty("--saint-look-y", y.toFixed(3));
      });
    });
    stage.addEventListener("pointerleave", resetPointer);
  }

  function select(id: SaintPatron["id"], persist = true): void {
    const saint = SAINT_PATRONS.find((item) => item.id === id) || SAINT_PATRONS[0];
    selectedId = saint.id;
    stage.dataset.saint = saint.id;
    stage.dataset.artMissing = "false";
    artwork.src = `/art/saints/${saint.id}.png`;
    artwork.alt = saint.name;
    fallback.textContent = saint.fallback;
    stageButton.setAttribute("aria-label", `${saint.name}. Show the next patron saint.`);
    if (persist) storeSaintId(saint.id);
  }

  function resetPointer(): void {
    stage.style.setProperty("--saint-look-x", "0");
    stage.style.setProperty("--saint-look-y", "0");
  }

  return { bind, select };
}

function nextSaintId(id: SaintPatron["id"]): SaintPatron["id"] {
  const index = SAINT_PATRONS.findIndex((saint) => saint.id === id);
  return SAINT_PATRONS[(index + 1) % SAINT_PATRONS.length].id;
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
