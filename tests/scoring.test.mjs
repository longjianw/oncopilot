import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { evaluateCandidate } from "../evaluation/a01/scoring.mjs";

const loadJson = async (name) => JSON.parse(await readFile(new URL(`../evaluation/a01/${name}`, import.meta.url), "utf8"));

test("scores equivalent missing-information labels by stable ID", async () => {
  const gold = await loadJson("gold_standard.json");
  const candidate = await loadJson("candidate_fixed_rule.json");
  candidate.missing_information = candidate.missing_information.map((item) => ({ ...item, label: `${item.label}（同义说明）` }));

  const result = evaluateCandidate(gold, candidate);
  assert.equal(result.metrics.missing_information_f1_percent, 100);
  assert.equal(result.score_percent, 100);
  assert.deepEqual(result.critical_errors, []);
});
