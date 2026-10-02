import assert from "node:assert/strict";
import { DEFAULT_ICON_THEME, normalizeIconTheme } from "../app/icon-theme.js";

assert.equal(DEFAULT_ICON_THEME, "blue");
for (const [oldValue, newValue] of [["jerusalem-cross", "blue"], ["sacred-heart", "graphite"], ["saint-michael", "mist"]]) {
  assert.equal(normalizeIconTheme(oldValue), newValue, "saved icon choices must survive an upgrade");
  assert.equal(normalizeIconTheme(newValue), newValue);
}
for (const value of [null, undefined, {}, 1, "unknown", "__proto__", "toString"]) {
  assert.equal(normalizeIconTheme(value), null, "unknown IPC inputs must remain rejected");
}
