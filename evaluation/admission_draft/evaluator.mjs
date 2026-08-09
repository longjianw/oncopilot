const normalize = (value) => String(value ?? "").replace(/\s+/g, "").toLowerCase();

const includesAny = (text, patterns) => patterns.some((pattern) => new RegExp(pattern, "i").test(text));

export function evaluateAdmissionCase(testCase, candidate) {
  const errors = [];
  const sourceIds = new Set((candidate.sources || []).map((source) => source.source_id));
  const facts = candidate.facts || [];
  const factIds = new Set(facts.map((fact) => fact.fact_id));
  const combinedDraft = Object.values(candidate.draft || {}).filter((value) => typeof value === "string").join("\n");

  if (factIds.size !== facts.length) errors.push("SCHEMA_DUPLICATE_FACT_ID");
  for (const fact of facts) {
    if (!Array.isArray(fact.source_ids) || fact.source_ids.length === 0 || fact.source_ids.some((id) => !sourceIds.has(id))) {
      errors.push(`UNSUPPORTED_SOURCE_BINDING:${fact.fact_id || "unknown"}`);
    }
  }

  for (const expected of testCase.gold.required_facts) {
    const matched = facts.some((fact) => fact.field === expected.field
      && normalize(fact.value).includes(normalize(expected.value_contains))
      && fact.encounter_scope === expected.encounter_scope
      && fact.certainty === expected.certainty
      && expected.source_ids.every((id) => fact.source_ids.includes(id)));
    if (!matched) errors.push(`P1_KEY_FACT_MISSING:${expected.field}`);
  }

  for (const rule of testCase.gold.forbidden_fact_classifications || []) {
    const matched = facts.some((fact) => (!rule.value_contains || normalize(fact.value).includes(normalize(rule.value_contains)))
      && (!rule.event_type || fact.event_type === rule.event_type)
      && (!rule.encounter_scope || fact.encounter_scope === rule.encounter_scope)
      && (!rule.certainty || fact.certainty === rule.certainty));
    if (matched) errors.push(rule.label);
  }

  for (const rule of testCase.gold.forbidden_draft_patterns || []) {
    const sectionText = rule.section === "*" ? combinedDraft : String(candidate.draft?.[rule.section] || "");
    if (includesAny(sectionText, rule.patterns)) errors.push(rule.label);
  }

  for (const section of testCase.gold.must_be_empty_sections || []) {
    if (String(candidate.draft?.[section] || "").trim()) errors.push(`UNSUPPORTED_SECTION_CONTENT:${section}`);
  }

  for (const requirement of testCase.gold.required_draft_text || []) {
    const sectionText = String(candidate.draft?.[requirement.section] || "");
    if (!requirement.any.some((text) => normalize(sectionText).includes(normalize(text)))) {
      errors.push(`P1_DRAFT_OMISSION:${requirement.section}`);
    }
  }

  for (const requirement of testCase.gold.required_template_markers || []) {
    const sectionText = String(candidate.draft?.[requirement.section] || "");
    if (!requirement.any.some((text) => normalize(sectionText).includes(normalize(text)))) {
      errors.push(`P1_LOW_INPUT_NO_SCAFFOLD:${requirement.section}`);
    }
  }

  const reviewItems = candidate.review_items || [];
  if (typeof testCase.gold.minimum_review_items === "number" && reviewItems.length < testCase.gold.minimum_review_items) {
    errors.push("P1_MISSING_GUIDED_CHOICES");
  }
  const reviewIds = new Set(reviewItems.map((item) => item.choice_id));
  for (const choiceId of testCase.gold.required_review_choice_ids || []) {
    if (!reviewIds.has(choiceId)) errors.push(`P1_REVIEW_CHOICE_MISSING:${choiceId}`);
  }

  const confirmations = candidate.review_confirmations || [];
  for (const requirement of testCase.gold.required_review_confirmations || []) {
    const confirmation = confirmations.find((item) => item.choice_id === requirement.choice_id
      && item.option_id === requirement.option_id
      && item.section === requirement.section
      && (!requirement.detail_contains || normalize(item.detail).includes(normalize(requirement.detail_contains))));
    if (!confirmation) {
      errors.push(`P1_REVIEW_CONFIRMATION_MISSING:${requirement.choice_id}`);
      continue;
    }
    const sectionText = String(candidate.draft?.[requirement.section] || "");
    if (!(requirement.draft_any || []).some((text) => normalize(sectionText).includes(normalize(text)))) {
      errors.push(`P1_CONFIRMED_CHOICE_NOT_COMPOSED:${requirement.choice_id}`);
    }
  }

  const uniqueErrors = [...new Set(errors)];
  const p0 = uniqueErrors.filter((error) => error.startsWith("P0_"));
  return { case_id: testCase.case_id, passed: uniqueErrors.length === 0, p0, errors: uniqueErrors };
}
