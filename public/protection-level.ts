export function normalizedProtectionLevel(requestedLevel: number): number {
  return Math.max(1, Math.min(3, Math.round(requestedLevel || 1)));
}

export function protectionLevelStatus(level: number): string {
  const normalized = normalizedProtectionLevel(level);
  if (normalized === 1) return "Filtered Social";
  if (normalized === 2) return "Full Brick";
  return "3 min lock";
}

export function applyProtectionLevelPresentation(
  requestedLevel: number,
  preview: boolean,
  elements: {
    input: { value: string };
    control: { dataset: DOMStringMap };
    label: { textContent: string | null };
    status: { textContent: string | null };
  }
): number {
  const level = normalizedProtectionLevel(requestedLevel);
  elements.input.value = String(level);
  elements.control.dataset.level = String(level);
  elements.label.textContent = level === 3 ? "Panic" : `Level ${level}`;
  elements.status.textContent = preview
    ? (level === 3 ? "3 min lock" : "Release to apply")
    : protectionLevelStatus(level);
  return level;
}
