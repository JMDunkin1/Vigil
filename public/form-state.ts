const trackedForms = new WeakSet<HTMLFormElement>();
const dirtyForms = new WeakSet<HTMLFormElement>();
const formRevisions = new WeakMap<HTMLFormElement, number>();

export function trackFormChanges(form: HTMLFormElement): void {
  if (trackedForms.has(form)) return;
  trackedForms.add(form);
  const markDirty = () => markFormDirty(form);
  form.addEventListener("input", markDirty);
  form.addEventListener("change", markDirty);
  form.addEventListener("reset", () => {
    dirtyForms.delete(form);
    bumpRevision(form);
  });
}

export function formHasUnsavedChanges(form: HTMLFormElement): boolean {
  return dirtyForms.has(form);
}

export function markFormSaved(form: HTMLFormElement): void {
  dirtyForms.delete(form);
}

export function formRevision(form: HTMLFormElement): number {
  return formRevisions.get(form) || 0;
}

export function markFormSavedAtRevision(form: HTMLFormElement, revision: number): boolean {
  if (formRevision(form) !== revision) return false;
  markFormSaved(form);
  return true;
}

export function markFormDirty(form: HTMLFormElement): void {
  dirtyForms.add(form);
  bumpRevision(form);
}

function bumpRevision(form: HTMLFormElement): void {
  formRevisions.set(form, formRevision(form) + 1);
}
