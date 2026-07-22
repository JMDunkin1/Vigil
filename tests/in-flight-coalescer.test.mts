import assert from "node:assert/strict";
import { InFlightCoalescer } from "../src/inFlight.js";

{
  const coalescer = new InFlightCoalescer<string, number>();
  let calls = 0;
  let release: (value: number) => void = () => {};
  const gate = new Promise<number>((resolve) => { release = resolve; });
  const operation = async () => {
    calls += 1;
    return await gate;
  };

  const first = coalescer.run("browser", operation);
  const second = coalescer.run("browser", operation);
  assert.equal(first, second, "concurrent work for one resource must share the exact promise");
  assert.equal(calls, 0, "the operation must start asynchronously so the in-flight entry is published first");
  release(7);
  assert.deepEqual(await Promise.all([first, second]), [7, 7]);
  assert.equal(calls, 1);

  assert.equal(await coalescer.run("browser", async () => {
    calls += 1;
    return 8;
  }), 8);
  assert.equal(calls, 2, "completed work must not become a cache for later observations");
}

{
  const coalescer = new InFlightCoalescer<string, number>();
  let calls = 0;
  const [first, second] = await Promise.all([
    coalescer.run("Safari", async () => { calls += 1; return 1; }),
    coalescer.run("Chrome", async () => { calls += 1; return 2; })
  ]);
  assert.deepEqual([first, second], [1, 2]);
  assert.equal(calls, 2, "different resources must never be coalesced together");
}

{
  const coalescer = new InFlightCoalescer<string, number>();
  const failure = new Error("expected failure");
  const first = coalescer.run("browser", async () => { throw failure; });
  const second = coalescer.run("browser", async () => 2);
  assert.equal(first, second);
  await assert.rejects(first, /expected failure/u);
  assert.equal(await coalescer.run("browser", async () => 3), 3,
    "failed work must be evicted so recovery can retry");
}
