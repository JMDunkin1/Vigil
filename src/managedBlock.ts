export function removeCompleteManagedBlocks(currentText: string, begin: string, endMarker: string): string {
  let next = currentText;
  while (true) {
    const start = next.indexOf(begin);
    if (start < 0) return next;
    const end = next.indexOf(endMarker, start + begin.length);
    if (end <= start) return next;
    const before = next.slice(0, start).trimEnd();
    const after = next.slice(end + endMarker.length).trimStart();
    next = `${before}${before && after ? "\n\n" : ""}${after}`;
  }
}

export function removePartialManagedBlockFragments(currentText: string, begin: string, endMarker: string): string {
  let next = currentText;
  while (true) {
    const beginIndex = next.indexOf(begin);
    const endIndex = next.indexOf(endMarker);
    if (beginIndex < 0 && endIndex < 0) return next;
    if (beginIndex >= 0 && endIndex > beginIndex) return next;
    const range = beginIndex >= 0
      ? {
          start: beginIndex,
          end: next.indexOf("\n\n", beginIndex)
        }
      : {
          start: previousBlankLineBoundary(next, endIndex),
          end: endIndex + endMarker.length
        };
    const removeStart = Math.max(0, range.start);
    const removeEnd = range.end >= 0 ? range.end : next.length;
    const before = next.slice(0, removeStart).trimEnd();
    const after = next.slice(removeEnd).trimStart();
    const updated = `${before}${before && after ? "\n\n" : ""}${after}`;
    if (updated === next) return next;
    next = updated;
  }
}

function previousBlankLineBoundary(text: string, index: number): number {
  const boundary = text.lastIndexOf("\n\n", Math.max(0, index));
  return boundary >= 0 ? boundary : 0;
}
