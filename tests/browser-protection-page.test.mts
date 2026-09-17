import assert from "node:assert/strict";
import { defaultState } from "../src/defaults.js";
import { blockedPage } from "../src/server/pages.js";

const state = defaultState();
  const connectionPage = blockedPage({
    url: new URL("http://127.0.0.1:8787/blocked?site=Browser+protection+connection+interrupted&kind=browser-protection"),
    state
  });
  assert.match(connectionPage, /<h1>Browser protection connection interrupted\.<\/h1>/);
  assert.match(connectionPage, /The extension may still be enabled/);
  assert.doesNotMatch(connectionPage, /A saved Vigil rule applies|Enable Vigil protection|is blocked\./);

