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
  hasUnsavedDraft: boolean,
  isBlankNewDraft: boolean
): boolean {
  return lockOnExit && hasUnsavedDraft && !isBlankNewDraft;
}

export function isBlankNewJournalDraft(
  entryId: string,
  title: string,
  body: string
): boolean {
  return !entryId.trim() && !title.trim() && !body.trim();
}
