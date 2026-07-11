const trackedForms = new WeakSet<HTMLFormElement>();
const dirtyControls = new WeakMap<HTMLFormElement, Set<EventTarget | symbol>>();
const formRevisions = new WeakMap<HTMLFormElement, number>();
const PROGRAMMATIC_CHANGE = Symbol("programmatic-change");

export function trackFormChanges(form: HTMLFormElement): void {
  if (trackedForms.has(form)) return;
  trackedForms.add(form);
  const markDirty = (event: Event) => {
    dirtySet(form).add(event.target || PROGRAMMATIC_CHANGE);
    bumpRevision(form);
  };
  form.addEventListener("input", markDirty);
  form.addEventListener("change", markDirty);
  form.addEventListener("reset", () => {
    dirtyControls.delete(form);
    bumpRevision(form);
  });
}

export function formHasUnsavedChanges(form: HTMLFormElement): boolean {
  return Boolean(dirtyControls.get(form)?.size);
}

export function markFormSaved(form: HTMLFormElement): void {
  dirtyControls.delete(form);
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
  dirtySet(form).add(PROGRAMMATIC_CHANGE);
  bumpRevision(form);
}

function bumpRevision(form: HTMLFormElement): void {
  formRevisions.set(form, formRevision(form) + 1);
}

export function markControlSaved(form: HTMLFormElement, control: EventTarget): void {
  const dirty = dirtyControls.get(form);
  if (!dirty) return;
  dirty.delete(control);
  if (!dirty.size) dirtyControls.delete(form);
}

function dirtySet(form: HTMLFormElement): Set<EventTarget | symbol> {
  let dirty = dirtyControls.get(form);
  if (!dirty) {
    dirty = new Set();
    dirtyControls.set(form, dirty);
  }
  return dirty;
}
