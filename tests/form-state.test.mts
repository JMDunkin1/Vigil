import assert from "node:assert/strict";
import {
  formHasUnsavedChanges,
  formRevision,
  markFormDirty,
  markFormSavedAtRevision,
  trackFormChanges
} from "../public/form-state.js";

const form = new EventTarget() as HTMLFormElement;
trackFormChanges(form);
assert.equal(formRevision(form), 0);
assert.equal(formHasUnsavedChanges(form), false);

form.dispatchEvent(new Event("input"));
const submittedRevision = formRevision(form);
assert.equal(submittedRevision, 1);
assert.equal(formHasUnsavedChanges(form), true);

form.dispatchEvent(new Event("change"));
assert.equal(markFormSavedAtRevision(form, submittedRevision), false);
assert.equal(formHasUnsavedChanges(form), true, "an edit made during a save must remain dirty");

const latestRevision = formRevision(form);
assert.equal(markFormSavedAtRevision(form, latestRevision), true);
assert.equal(formHasUnsavedChanges(form), false);

markFormDirty(form);
assert.equal(formRevision(form), latestRevision + 1);
assert.equal(formHasUnsavedChanges(form), true);
