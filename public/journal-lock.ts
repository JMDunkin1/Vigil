export function shouldLockJournalOnViewExit(
  previousView: string,
  nextView: string,
  autoLockMinutes: number | undefined,
  sessionActive: boolean
): boolean {
  return sessionActive
    && previousView === "journal"
    && nextView !== "journal"
    && (autoLockMinutes ?? 0) === 0;
}

export function shouldConfirmJournalDraftOnViewExit(
  lockOnExit: boolean,
  hasUnsavedDraft: boolean
): boolean {
  return lockOnExit && hasUnsavedDraft;
}
