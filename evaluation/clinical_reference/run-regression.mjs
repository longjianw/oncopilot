import { readFile } from "node:fs/promises";
import { evaluateClinicalReference } from "./evaluator.mjs";

const testCase = JSON.parse(await readFile(new URL("./cases/R01.json", import.meta.url), "utf8"));
const reference = evaluateClinicalReference(testCase, testCase.reference_output);
const failure = evaluateClinicalReference(testCase, testCase.constructed_failure);
const caught = testCase.expected_failure_labels.every((label) => failure.errors.includes(label));
const passed = reference.passed && caught;
console.log(JSON.stringify({ passed, reference, constructed_failure: failure }, null, 2));
if (!passed) process.exitCode = 1;
