import assert from "node:assert/strict";
import {
  fallbackSafeSearchHostMappings,
  resolveSafeSearchHostMappings,
  safeSearchHostsLines,
  safeSearchMappedHostCount
} from "../src/networkSafeSearch.js";

const mappings = await resolveSafeSearchHostMappings({
  async resolve4(hostname) {
    if (hostname === "forcesafesearch.google.com") return ["216.239.38.120"];
    if (hostname === "strict.bing.com") return ["150.171.29.16", "150.171.29.16"];
    return ["52.149.247.1"];
  },
  async resolve6(hostname) {
    if (hostname === "forcesafesearch.google.com") return ["2001:4860:4802:32::78"];
    throw new Error("No IPv6 record");
  }
});

assert.deepEqual(mappings.map((mapping) => mapping.id), ["google", "bing", "duckduckgo"]);
assert.deepEqual(mappings[0]?.addresses, ["216.239.38.120", "2001:4860:4802:32::78"]);
assert.deepEqual(mappings[1]?.addresses, [
  "204.79.197.220",
  "2620:1ec:33::16",
  "2620:1ec:33:1::16",
  "2620:1ec:33:2::16",
  "2620:1ec:33:3::16"
], "rotating DNS answers must not make the managed hosts block perpetually stale or leave an ordinary IPv6 route");
assert.equal(safeSearchMappedHostCount(mappings) > 500, true, "all published Google regional and image-search hosts must be covered");

const lines = safeSearchHostsLines(mappings);
assert.equal(lines.includes("216.239.38.120 www.google.com"), true);
assert.equal(lines.includes("2001:4860:4802:32::78 images.google.co.uk"), true);
assert.equal(lines.includes("204.79.197.220 www.bing.com"), true);
assert.equal(lines.includes("52.149.247.1 duckduckgo.com"), true);

const denyPrecedenceLines = safeSearchHostsLines(mappings, new Set(["google.com", "www.google.com"]));
assert.equal(denyPrecedenceLines.includes("216.239.38.120 google.com"), false, "an explicit deny must take precedence over SafeSearch routing");
assert.equal(denyPrecedenceLines.includes("216.239.38.120 www.google.com"), false, "a www deny must take precedence over SafeSearch routing");
assert.equal(denyPrecedenceLines.includes("216.239.38.120 images.google.com"), true, "unblocked image search must remain filtered");

await assert.rejects(
  resolveSafeSearchHostMappings({
    async resolve4() { throw new Error("offline"); },
    async resolve6() { throw new Error("offline"); }
  }),
  /Could not resolve Vigil's Google Filter endpoint/u,
  "network application must fail before replacing an existing protected block when strict endpoints cannot be resolved"
);

assert.deepEqual(
  fallbackSafeSearchHostMappings().map((mapping) => mapping.id),
  ["google", "bing", "duckduckgo"]
);
