export const encounterScopes = ["prior", "current", "unclear"] as const;
export const certaintyLevels = ["explicit", "doctor_confirmed", "uncertain", "pending"] as const;
export const eventTypes = [
  "onset_diagnosis",
  "pathology_molecular",
  "prior_treatment",
  "progression_evidence",
  "current_purpose",
  "current_status",
  "past_history",
  "personal_history",
  "family_history",
  "allergy_history",
  "specialist_exam",
  "doctor_diagnosis",
  "doctor_plan",
  "other",
] as const;

export type EncounterScope = typeof encounterScopes[number];
export type CertaintyLevel = typeof certaintyLevels[number];
export type EventType = typeof eventTypes[number];

export type SourceReference = {
  source_id: string;
  title: string;
  evidence: string;
};

export type ExtractedFact = {
  fact_id: string;
  field: string;
  value: string;
  event_time: string;
  event_type: EventType;
  encounter_scope: EncounterScope;
  certainty: CertaintyLevel;
  source_ids: string[];
};

export type FactExtraction = {
  current_purpose: string | null;
  sources: SourceReference[];
  facts: ExtractedFact[];
  pending_fields: string[];
};

export type AdmissionDraft = {
  chief_complaint: string;
  present_illness: string;
  past_history: string;
  personal_history: string;
  family_history: string;
  allergy_history: string;
  specialist_exam: string;
  diagnosis_summary: string;
  plan_summary: string;
  pending_fields: string[];
};

export type AnalysisResult = AdmissionDraft & {
  sources: SourceReference[];
  facts: ExtractedFact[];
  review_items: import("./guided-review").GuidedReviewItem[];
  template_mode: boolean;
  template_name: string;
};

const isString = (value: unknown): value is string => typeof value === "string";
const isShortString = (value: unknown, max = 160) => isString(value) && value.trim().length > 0 && value.length <= max;
const hasUniqueIds = (ids: string[]) => new Set(ids).size === ids.length;

export const isValidFactExtraction = (value: unknown): value is FactExtraction => {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<FactExtraction>;
  if (!(result.current_purpose === null || (isString(result.current_purpose) && result.current_purpose.length <= 160))) return false;
  if (!Array.isArray(result.sources) || result.sources.length === 0 || result.sources.length > 40) return false;
  if (!result.sources.every((source) => source && isShortString(source.source_id, 40) && isShortString(source.title) && isShortString(source.evidence, 500))) return false;
  const sourceIds = result.sources.map((source) => source.source_id);
  if (!hasUniqueIds(sourceIds)) return false;
  if (!Array.isArray(result.facts) || result.facts.length === 0 || result.facts.length > 120) return false;
  if (!result.facts.every((fact) => fact
    && isShortString(fact.fact_id, 60)
    && isShortString(fact.field, 80)
    && isShortString(fact.value, 800)
    && isShortString(fact.event_time, 80)
    && eventTypes.includes(fact.event_type)
    && encounterScopes.includes(fact.encounter_scope)
    && certaintyLevels.includes(fact.certainty)
    && Array.isArray(fact.source_ids)
    && fact.source_ids.length > 0
    && fact.source_ids.every((id) => sourceIds.includes(id)))) return false;
  if (!hasUniqueIds(result.facts.map((fact) => fact.fact_id))) return false;
  return Array.isArray(result.pending_fields)
    && result.pending_fields.length <= 6
    && result.pending_fields.every((item) => isShortString(item, 100));
};

const draftFields: Array<keyof Omit<AdmissionDraft, "pending_fields">> = [
  "chief_complaint",
  "present_illness",
  "past_history",
  "personal_history",
  "family_history",
  "allergy_history",
  "specialist_exam",
  "diagnosis_summary",
  "plan_summary",
];

export const isValidAdmissionDraft = (value: unknown): value is AdmissionDraft => {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<AdmissionDraft>;
  if (!draftFields.every((field) => isString(result[field]) && result[field]!.length <= 6000)) return false;
  if (!result.chief_complaint?.trim() || result.chief_complaint.length > 100) return false;
  if (!result.present_illness || result.present_illness.trim().length < 20) return false;
  return Array.isArray(result.pending_fields)
    && result.pending_fields.length <= 6
    && result.pending_fields.every((item) => isShortString(item, 100));
};

export const hasUnsupportedDoctorJudgment = (extraction: FactExtraction, draft: AdmissionDraft) => {
  const diagnoses = extraction.facts.filter((fact) => fact.event_type === "doctor_diagnosis" && fact.certainty === "doctor_confirmed");
  const plans = extraction.facts.filter((fact) => fact.event_type === "doctor_plan" && fact.certainty === "doctor_confirmed");
  return (draft.diagnosis_summary.trim().length > 0 && diagnoses.length === 0)
    || (draft.plan_summary.trim().length > 0 && plans.length === 0);
};
