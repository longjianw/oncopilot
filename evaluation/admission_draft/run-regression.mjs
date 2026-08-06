import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateAdmissionCase } from "./evaluator.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const caseDir = path.join(here, "cases");
const files = (await readdir(caseDir)).filter((name) => name.endsWith(".json")).sort();
const results = [];

for (const file of files) {
  const testCase = JSON.parse(await readFile(path.join(caseDir, file), "utf8"));
  const reference = evaluateAdmissionCase(testCase, testCase.reference_output);
  const failure = evaluateAdmissionCase(testCase, testCase.constructed_failure);
  const failureCaught = !failure.passed && testCase.expected_failure_labels.every((label) => failure.errors.includes(label));
  results.push({ case_id: testCase.case_id, reference_passed: reference.passed, constructed_failure_caught: failureCaught, reference_errors: reference.errors, failure_errors: failure.errors });
}

const passed = results.every((result) => result.reference_passed && result.constructed_failure_caught);
console.log(JSON.stringify({ passed, cases: results }, null, 2));
if (!passed) process.exitCode = 1;
