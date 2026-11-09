// Build first, then run the compiled file. An optional first argument points to
// a standalone baseline explicitMediaContext.mjs saved before a change.
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as current from "../src/explicitMediaContext.js";
import { broadenedAllowedSearches, broadenedBlockedSearches } from "./fixtures/broadened-explicit-search.mjs";
import { adversarialQueryCorpus } from "./fixtures/policy-adversarial-corpus.mjs";

const baseline = process.argv[2]
  ? await import(pathToFileURL(resolve(process.argv[2])).href) as typeof current
  : null;
const labels = [
  ...broadenedAllowedSearches, ...broadenedBlockedSearches,
  ...adversarialQueryCorpus.map(item => item.query), ...current.MULTILINGUAL_EXPLICIT_TERMS,
  "Astronomy tutorial Channel 1 episode 2", "ordinary text ".repeat(250)
];
if (baseline) {
  const variants = labels.flatMap(text => [
    text, text.toUpperCase(), text.normalize("NFD"), text.replaceAll("o", "ó"),
    text.replaceAll("a", "а"), text.replaceAll("e", "e\u0301"), text.split("").join("\u200b")
  ]);
  const functions = [
    "normalizeExplicitVocabulary", "normalizeAutomaticExplicitText", "containsAdditionalExplicitSearchTerm",
    "containsMultilingualExplicitText", "containsContextualExplicitMedia", "containsExplicitPrintMedia",
    "containsExplicitSearchKeyword", "containsExplicitSearchAliases"
  ] as const;
  for (const name of functions) for (const text of variants) {
    assert.deepEqual(current[name](text), baseline[name](text), `${name}: ${text}`);
  }
  console.log(JSON.stringify({ differentialChecks: variants.length * functions.length }));
}

const groups = {
  shortOrdinary: ["Astronomy tutorial 12", "The science of stars", "Channel 2 episode 21", "Captions", "Search astronomy"],
  mixed: labels.slice(0, 320),
  longOrdinary: [Array.from({ length: 30 }, (_, index) => `Channel 11 episode ${index}`).join(" ")]
};
for (const [name, inputs] of Object.entries(groups)) {
  const modules = baseline ? { before: baseline, after: current } : { after: current };
  const samples: Record<string, number[]> = {};
  // Warm both variants, then alternate their order to reduce order bias.
  for (let batch = -2; batch < 11; batch += 1) {
    const entries = Object.entries(modules);
    if (batch % 2) entries.reverse();
    for (const [label, module] of entries) {
      const rounds = Math.ceil(300 / inputs.length);
      const startedAt = performance.now();
      for (let round = 0; round < rounds; round += 1) {
        for (const text of inputs) module.containsContextualExplicitMedia(text);
      }
      const elapsedMs = (performance.now() - startedAt) / (rounds * inputs.length);
      if (batch >= 0) (samples[label] ||= []).push(elapsedMs);
    }
  }
  const measurements = Object.fromEntries(Object.entries(samples).map(([label, values]) => {
    values.sort((left, right) => left - right);
    return [label, { medianMs: values[5], maxBatchMeanMs: values[10] }];
  }));
  console.log(JSON.stringify({ name, ...measurements }));
}
