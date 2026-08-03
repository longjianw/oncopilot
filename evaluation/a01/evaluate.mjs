import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateCandidate } from "./scoring.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const candidateName = process.argv[2] ?? "candidate_fixed_rule.json";
const [gold, candidate] = await Promise.all([
  readFile(path.join(here, "gold_standard.json"), "utf8").then(JSON.parse),
  readFile(path.resolve(here, candidateName), "utf8").then(JSON.parse)
]);

console.log(JSON.stringify(evaluateCandidate(gold, candidate), null, 2));
