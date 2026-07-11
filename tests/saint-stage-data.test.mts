import assert from "node:assert/strict";
import { SAINT_PATRONS } from "../public/saint-stage.js";

assert.equal(new Set(SAINT_PATRONS.map((saint) => saint.id)).size, SAINT_PATRONS.length, "saint scene IDs must be unique");
for (const saint of SAINT_PATRONS) {
  assert.ok(saint.name.trim(), `${saint.id} must have a display name`);
  assert.ok(saint.epithet.trim(), `${saint.id} must have an epithet or detail`);
  assert.ok(saint.quote.trim(), `${saint.id} must have a quote`);
  assert.ok(saint.source.trim(), `${saint.id} must identify the quote or tradition`);
}
