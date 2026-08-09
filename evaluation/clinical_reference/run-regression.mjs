import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateClinicalReference } from "./evaluator.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const caseDir = path.join(here, "cases");
const files = (await readdir(caseDir)).filter((name) => name.endsWith(".json")).sort();
const cases = [];
for (const file of files) {
  const testCase = JSON.parse(await readFile(path.join(caseDir, file), "utf8"));
  const reference = evaluateClinicalReference(testCase, testCase.reference_output);
  const failure = evaluateClinicalReference(testCase, testCase.constructed_failure);
  const caught = testCase.expected_failure_labels.every((label) => failure.errors.includes(label));
  cases.push({ case_id: testCase.case_id, reference_passed: reference.passed, constructed_failure_caught: caught, reference_errors: reference.errors, failure_errors: failure.errors });
}
const passed = cases.every((item) => item.reference_passed && item.constructed_failure_caught);
console.log(JSON.stringify({ passed, cases }, null, 2));
if (!passed) process.exitCode = 1;
