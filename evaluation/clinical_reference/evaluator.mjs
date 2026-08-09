const text = (value) => JSON.stringify(value || "");

export function evaluateClinicalReference(testCase, candidate) {
  const errors = [];
  const combined = text(candidate);
  for (const required of testCase.gold.required_patterns || []) {
    if (!new RegExp(required.pattern, "i").test(text(candidate[required.field]))) errors.push(required.label);
  }
  for (const forbidden of testCase.gold.forbidden_patterns || []) {
    if (new RegExp(forbidden.pattern, "i").test(combined)) errors.push(forbidden.label);
  }
  if (!Array.isArray(candidate.suggested_workup) || candidate.suggested_workup.length < testCase.gold.minimum_workup_items) errors.push("P1_REFERENCE_WORKUP_TOO_THIN");
  if (!Array.isArray(candidate.treatment_pathways) || candidate.treatment_pathways.length < testCase.gold.minimum_pathway_items) errors.push("P1_REFERENCE_PATHWAY_TOO_THIN");
  for (const item of [...(candidate.suggested_workup || []), ...(candidate.treatment_pathways || [])]) {
    if (!String(item.trigger || "").trim() || !String(item.purpose || "").trim()) errors.push("P1_REFERENCE_MISSING_CONDITION_OR_PURPOSE");
  }
  const unique = [...new Set(errors)];
  return { case_id: testCase.case_id, passed: unique.length === 0, errors: unique };
}
