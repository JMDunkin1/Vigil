export const ICON_THEMES = ["blue", "graphite", "mist"] as const;
export type IconTheme = typeof ICON_THEMES[number];
export const DEFAULT_ICON_THEME: IconTheme = "blue";

// Keep saved appearance choices usable when upgrading from the original artwork.
const LEGACY_ICON_THEMES: Record<string, IconTheme> = {
  "jerusalem-cross": "blue",
  "sacred-heart": "graphite",
  "saint-michael": "mist"
};

export function normalizeIconTheme(value: unknown): IconTheme | null {
  if (typeof value !== "string") return null;
  if (ICON_THEMES.includes(value as IconTheme)) return value as IconTheme;
  return Object.hasOwn(LEGACY_ICON_THEMES, value) ? LEGACY_ICON_THEMES[value] : null;
}
