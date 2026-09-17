import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";

const source = await readFile(new URL("../extension/content.js", import.meta.url), "utf8");
const start = source.indexOf("function runFocusedSocialCleanupSoon(");
const end = source.indexOf("\nfunction applyFocusedSocialDomCleanup(", start);
assert.ok(start >= 0 && end > start);
let nextId = 0;
let scans = 0;
const timers = new Map<number, { run: () => void; delay: number }>();
const context = createContext({
  focusedSocialCleanupTimer: null,
  applyFocusedSocialDomCleanup() { scans += 1; },
  window: {
    setTimeout(run: () => void, delay: number) {
      const id = nextId++;
      timers.set(id, { run, delay });
      return id;
    },
    clearTimeout(id: number) { timers.delete(id); }
  }
});
runInContext(source.slice(start, end), context);
const schedule = (delay: number) => runInContext(`runFocusedSocialCleanupSoon(${delay})`, context);
const fire = () => {
  const timer = [...timers.entries()][0];
  assert.ok(timer);
  timers.delete(timer[0]);
  timer[1].run();
};
schedule(80);
for (let mutation = 0; mutation < 1_000; mutation += 1) schedule(80);
assert.equal(timers.size, 1);
assert.equal(nextId, 1, "continuous mutations must reuse the first timer, without starving the enforcement deadline");
assert.equal(timers.get(0)?.delay, 80, "zero is a valid timer ID");
fire();
assert.equal(scans, 1);
schedule(80);
assert.equal(timers.size, 1, "mutations after cleanup must schedule the next scan");
schedule(0);
assert.equal(timers.size, 1);
assert.equal([...timers.values()][0]?.delay, 0, "navigation and blocked clicks must expedite a pending scan");
schedule(80);
assert.equal([...timers.values()][0]?.delay, 0, "a mutation must not delay urgent enforcement");
fire();
assert.equal(scans, 2);
console.log("Extension cleanup scheduling tests passed");
