import {
  AnalysisResult,
  AdmissionDraft,
  ExtractedFact,
  FactExtraction,
  SourceReference,
  certaintyLevels,
  encounterScopes,
  eventTypes,
  isValidAdmissionDraft,
  isValidFactExtraction,
} from "../../../lib/admission-record-contract";
import { yiyangRecordRules } from "../../../lib/yiyang-record-rules";
import { buildGuidedDraft } from "../../../lib/guided-review";

type ArkResponse = {
  output_text?: string;
  output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
};

const extractText = (response: ArkResponse) => {
  if (typeof response.output_text === "string") return response.output_text;
  for (const item of response.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && typeof content.text === "string") return content.text;
    }
  }
  return "";
};

const parseJson = (text: string) => {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(cleaned); } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error("模型没有返回可解析的JSON");
  }
};

const requestJson = async (baseUrl: string, apiKey: string, model: string, prompt: string, maxOutputTokens: number, timeoutMs = 50000) => {
  const upstream = await fetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      input: prompt,
      thinking: { type: "disabled" },
      text: { format: { type: "json_object" } },
      max_output_tokens: maxOutputTokens,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const rawText = await upstream.text();
  if (!upstream.ok) throw new Error(`上游模型请求失败：${upstream.status}`);
  return parseJson(extractText(JSON.parse(rawText) as ArkResponse));
};

const factExtractionIssue = (value: unknown) => {
  if (!value || typeof value !== "object") return "顶层不是JSON对象";
  const result = value as Record<string, unknown>;
  if (!(result.current_purpose === null || (typeof result.current_purpose === "string" && result.current_purpose.length <= 160))) return "current_purpose必须为null或160字内字符串";
  if (!Array.isArray(result.sources) || result.sources.length < 1 || result.sources.length > 40) return "sources数量必须为1至40";
  const sources = result.sources as Array<Record<string, unknown>>;
  for (const [index, source] of sources.entries()) {
    if (!source || typeof source !== "object") return `sources[${index}]不是对象`;
    if (typeof source.source_id !== "string" || !source.source_id.trim() || source.source_id.length > 40) return `sources[${index}].source_id无效`;
    if (typeof source.title !== "string" || !source.title.trim() || source.title.length > 160) return `sources[${index}].title无效或过长`;
    if (typeof source.evidence !== "string" || !source.evidence.trim() || source.evidence.length > 500) return `sources[${index}].evidence无效或超过500字`;
  }
  const sourceIds = sources.map((source) => source.source_id as string);
  if (new Set(sourceIds).size !== sourceIds.length) return "source_id重复";
  if (!Array.isArray(result.facts) || result.facts.length < 1 || result.facts.length > 120) return "facts数量必须为1至120";
  const facts = result.facts as Array<Record<string, unknown>>;
  for (const [index, fact] of facts.entries()) {
    if (!fact || typeof fact !== "object") return `facts[${index}]不是对象`;
    const boundedFields: Array<[string, number]> = [["fact_id", 60], ["field", 80], ["value", 800], ["event_time", 80]];
    for (const [field, max] of boundedFields) {
      if (typeof fact[field] !== "string" || !(fact[field] as string).trim() || (fact[field] as string).length > max) return `facts[${index}].${field}无效或超过${max}字`;
    }
    if (!eventTypes.includes(fact.event_type as typeof eventTypes[number])) return `facts[${index}].event_type不在允许值中`;
    if (!encounterScopes.includes(fact.encounter_scope as typeof encounterScopes[number])) return `facts[${index}].encounter_scope不在允许值中`;
    if (!certaintyLevels.includes(fact.certainty as typeof certaintyLevels[number])) return `facts[${index}].certainty不在允许值中`;
    if (!Array.isArray(fact.source_ids) || fact.source_ids.length < 1 || fact.source_ids.some((id) => typeof id !== "string" || !sourceIds.includes(id))) return `facts[${index}].source_ids缺失或引用了不存在的source_id`;
  }
  const factIds = facts.map((fact) => fact.fact_id as string);
  if (new Set(factIds).size !== factIds.length) return "fact_id重复";
  if (!Array.isArray(result.pending_fields) || result.pending_fields.length > 8) return "pending_fields数量必须为0至8";
  for (const [index, item] of result.pending_fields.entries()) {
    if (typeof item !== "string" || !item.trim() || item.length > 100) return `pending_fields[${index}]无效或超过100字`;
  }
  return "未识别的结构问题";
};

const boundSourceEvidence = (value: unknown) => {
  if (!value || typeof value !== "object") return value;
  const extraction = value as Record<string, unknown>;
  if (!Array.isArray(extraction.sources)) return value;
  return {
    ...extraction,
    sources: extraction.sources.map((source) => {
      if (!source || typeof source !== "object") return source;
      const record = source as Record<string, unknown>;
      return typeof record.evidence === "string"
        ? { ...record, evidence: record.evidence.trim().slice(0, 500) }
        : record;
    }),
  };
};

const admissionDraftIssue = (value: unknown) => {
  if (!value || typeof value !== "object") return "顶层不是JSON对象";
  const result = value as Record<string, unknown>;
  const fields = ["chief_complaint", "present_illness", "past_history", "personal_history", "family_history", "allergy_history", "specialist_exam", "diagnosis_summary", "plan_summary"];
  for (const field of fields) {
    if (typeof result[field] !== "string") return `${field}必须为字符串，无资料时返回空字符串`;
    if ((result[field] as string).length > 6000) return `${field}超过6000字`;
  }
  if (!(result.chief_complaint as string).trim()) return "chief_complaint不得为空";
  if ((result.chief_complaint as string).length > 100) return "chief_complaint超过100字";
  if ((result.present_illness as string).trim().length < 20) return "present_illness少于20字";
  if (!Array.isArray(result.pending_fields) || result.pending_fields.length > 8) return "pending_fields数量必须为0至8";
  for (const [index, item] of result.pending_fields.entries()) {
    if (typeof item !== "string" || !item.trim() || item.length > 100) return `pending_fields[${index}]无效或超过100字`;
  }
  return "未识别的结构问题";
};

const boundDraftPendingFields = (value: unknown) => {
  if (!value || typeof value !== "object") return value;
  const draft = value as Record<string, unknown>;
  if (!Array.isArray(draft.pending_fields)) return value;
  return {
    ...draft,
    pending_fields: draft.pending_fields
      .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
      .map((item) => item.trim().slice(0, 100))
      .slice(0, 8),
  };
};

const extractionShape = {
  current_purpose: "本次来院目的；没有则为null",
  sources: [{ source_id: "S1", title: "来源标题", evidence: "支持事实的简短原文或忠实摘要" }],
  facts: [{
    fact_id: "F1",
    field: "pathology",
    value: "最小化事实文本",
    event_time: "明确日期、相对时间或未提供",
    event_type: "onset_diagnosis | pathology_molecular | prior_treatment | progression_evidence | current_purpose | current_status | past_history | personal_history | family_history | allergy_history | specialist_exam | doctor_diagnosis | doctor_plan | other",
    encounter_scope: "prior | current | unclear",
    certainty: "explicit | doctor_confirmed | uncertain | pending",
    source_ids: ["S1"],
  }],
  pending_fields: ["仅会阻断安全落笔的字段：待核对"],
};

const draftShape: AdmissionDraft = {
  chief_complaint: "",
  present_illness: "",
  past_history: "",
  personal_history: "",
  family_history: "",
  allergy_history: "",
  specialist_exam: "",
  diagnosis_summary: "",
  plan_summary: "",
  pending_fields: [],
};
const narrativeDraftShape = { ...draftShape, present_illness_fact_ids: ["F1"] };

const cleanSourceMarkup = (value: string) => value
  .replace(/```(?:[a-z]+)?|```/gi, " ")
  .replace(/^\s*#{1,6}\s*/gm, "")
  .replace(/\*\*([^*]+)\*\*/g, "$1")
  .replace(/__([^_]+)__/g, "$1")
  .replace(/^\s*(?:[-*•])\s+/gm, "")
  .replace(/[ \t]+\n/g, "\n")
  .replace(/\n{3,}/g, "\n\n")
  .trim();

const hasNarrativePresentationFailure = (draft: AdmissionDraft) => {
  const combined = `${draft.chief_complaint}\n${draft.present_illness}`;
  const markdownLeak = /(?:^|\n)\s*#{1,6}\s|\*\*|```/.test(combined);
  const chiefComplaintLabelLeak = /(?:入院诊断|出院诊断|本次入院目的|确诊经过|肿瘤病史|住院治疗)\s*[:：]?/.test(draft.chief_complaint);
  const chiefComplaintIncompleteTail = /(?:由|自)?外院转入(?:我院)?$|转入$|进一步(?:诊治|治疗)?$|收治$/.test(draft.chief_complaint.trim());
  const presentIllnessLabelLeak = /(?:^|[。；;\n])\s*(?:入院诊断|出院诊断|确诊经过|肿瘤病史|住院治疗|治疗计划|诊疗计划|专科情况|诊断依据|鉴别诊断)\s*[:：]/.test(draft.present_illness);
  return markdownLeak || chiefComplaintLabelLeak || chiefComplaintIncompleteTail || presentIllnessLabelLeak;
};

const currentAdmissionPattern = /(?:由|自)?外院转入我院|转入我院|入我院(?:治疗|诊治)?|收治入院|来我院(?:进一步)?诊治/;
const externalReferralPattern = /(?:建议|拟)(?:转院|转(?:往|至|入)?[^，。；;\n]{0,10}医院)(?:进一步)?(?:治疗|诊治)?/;
const externalExamPattern = /外院|院外|当地医院|转院前|转入前|出院前/;
const currentExamPattern = /(?:本次|当前|今日|我院)[^。；;\n]{0,12}(?:查体|体检|专科情况)|入院后[^。；;\n]{0,12}(?:查体|体检|专科情况)/;
const missingExamPattern = /(?:尚未|未)(?:提供|完成|行|记录)(?:[^。；;\n]{0,40})?(?:查体|体检|专科情况)|(?:查体|体检|专科情况)(?:[^。；;\n]{0,20})?(?:待补充|待完善|待核对|未提供)/;

const lastPatternSpan = (value: string, pattern: RegExp) => {
  const globalPattern = new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`);
  let last: { index: number; end: number } | null = null;
  for (const match of value.matchAll(globalPattern)) {
    const index = match.index ?? -1;
    if (index >= 0) last = { index, end: index + match[0].length };
  }
  return last;
};

const hasCurrentAdmissionTransitionFailure = (extraction: FactExtraction, draft: AdmissionDraft, sourceText = "") => {
  const externalTransferConfirmed = extraction.facts.some((fact) => fact.encounter_scope === "current"
    && currentAdmissionPattern.test(fact.value));
  if (!externalTransferConfirmed) return false;
  const presentIllness = draft.present_illness.trim();
  const referral = lastPatternSpan(presentIllness, externalReferralPattern);
  const requiredClosurePattern = /收治入院/.test(sourceText) ? /收治入院/ : currentAdmissionPattern;
  const arrival = lastPatternSpan(presentIllness, requiredClosurePattern);
  return !arrival || Boolean(referral && arrival.index < referral.end);
};

const hasUnsupportedChiefComplaintDuration = (sourceText: string, currentPurpose: string, draft: AdmissionDraft) => {
  const durations = draft.chief_complaint.match(/\d+(?:\.\d+)?(?:余)?(?:小时|天|周|月|年)/g) || [];
  if (!durations.length) return false;
  const suppliedText = `${sourceText}\n${currentPurpose}`.replace(/\s+/g, "");
  return durations.some((duration) => !suppliedText.includes(duration.replace(/\s+/g, "")));
};

const buildExtractionPrompt = (sourceText: string, currentPurpose: string) => [
  "你是医疗AI作品中的结构化事实抽取器。只抽取，不写病历，不诊断，不提出治疗建议。",
  "使用场景是肿瘤科医生第一次接管该患者，不代表患者首次住院。既往外院诊断、手术、放疗、系统治疗、出院和未来计划都必须与本次就诊分开。",
  "当前固定为入院记录路由。来源若是出院记录、出院小结或带有‘出院诊断’标题，其中诊断属于既往住院事实：标为onset_diagnosis、encounter_scope=prior、certainty=explicit，不得标为本次doctor_diagnosis。只有本次医生明确写出的初步诊断、入院诊断或当前诊断，才能作为current的doctor_diagnosis。",
  "外院‘建议转上级医院/建议转院’只是既往转诊意见；只有‘已转入我院/入我院/收治入院’才是本次到院事实，二者不得互相替代。外院、院外、转院前或出院前的生命体征与查体一律标为prior，不能标为本次specialist_exam。",
  "每条事实必须绑定至少一个来源。保留原文的考虑、可能、倾向、疑似、待排等不确定性，不得升级为确定事实。未询问和未提供不等于阴性。未查体不等于正常。",
  "只有输入明确标注为医生判断、初步诊断、诊疗计划或医生已确认的内容，才能标为doctor_diagnosis/doctor_plan，certainty必须为doctor_confirmed。其他推断不得归入这两类。",
  "本次来院目的作为单独字段，判断本次就诊时优先于原始资料最后出现的住院、出院或未来日期。如果提供了单独目的，为它建立S-PURPOSE来源和current范围事实。",
  "你正在建立病例级临床事件账本，不是摘要。首发、每一线/周期关键治疗、手术、放疗、疗效或进展、复发证据、近期治疗、急性发病、外院处置、恶化与本次到院必须各自保留为可追溯事件。同日同场景的症状、关键检验与处置可合并，但不得删掉整个事件。免疫组化明细可合并在同一病理事件内，不得挤占临床时间线。",
  "基础病、长期用药、过敏、既往手术和输血也要入账。与当前肿瘤直接相关的手术/放化疗归入prior_treatment；无关旧手术归入past_history，术式或病理不清时标记pending。",
  "只输出一个JSON对象，不要Markdown或解释。每个分段sources最多24条，facts最多60条，pending_fields最多8条；每条value最多320字，source evidence最多400字：",
  JSON.stringify(extractionShape),
  `单独填写的本次来院目的：${currentPurpose || "未提供"}`,
  `待抽取资料：\n${sourceText}`,
].join("\n\n");

const SOURCE_CHUNK_CHARS = 2600;
const FACT_EXTRACTION_CONCURRENCY = 2;
const arrivalContexts = ["外院转入我院", "本院直接入院", "本次到院身份待确认"] as const;
type ArrivalContext = typeof arrivalContexts[number];
const splitSourceText = (sourceText: string) => {
  if (sourceText.length <= 2500) return [sourceText];
  const pages = sourceText.split(/(?=【[^】]+(?:AI识别|视觉(?:转录|提取))[^】]*】)/).map((part) => part.trim()).filter(Boolean);
  const units = pages.length > 1 ? pages : sourceText.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  for (const unit of units) {
    if (unit.length > SOURCE_CHUNK_CHARS) {
      if (current) { chunks.push(current); current = ""; }
      for (let start = 0; start < unit.length; start += SOURCE_CHUNK_CHARS) chunks.push(unit.slice(start, start + SOURCE_CHUNK_CHARS));
    } else if (!current || current.length + unit.length + 2 <= SOURCE_CHUNK_CHARS) current = current ? `${current}\n\n${unit}` : unit;
    else { chunks.push(current); current = unit; }
  }
  if (current) chunks.push(current);
  return chunks;
};

const withPrefix = (extraction: FactExtraction, chunkIndex: number): FactExtraction => {
  const prefix = `C${chunkIndex + 1}-`;
  const sourceMap = new Map(extraction.sources.map((source) => [source.source_id, `${prefix}${source.source_id}`]));
  return {
    ...extraction,
    sources: extraction.sources.map((source) => ({ ...source, source_id: sourceMap.get(source.source_id)! })),
    facts: extraction.facts.map((fact) => ({ ...fact, fact_id: `${prefix}${fact.fact_id}`, source_ids: fact.source_ids.map((id) => sourceMap.get(id)).filter((id): id is string => Boolean(id)) })),
  };
};

const mergeExtractions = (parts: FactExtraction[], currentPurpose: string, arrivalContext: ArrivalContext | ""): FactExtraction => {
  const sources: SourceReference[] = parts.flatMap((part) => part.sources).slice(0, 40);
  const allowedSources = new Set(sources.map((source) => source.source_id));
  const facts: ExtractedFact[] = parts.flatMap((part) => part.facts)
    .filter((fact) => fact.source_ids.every((id) => allowedSources.has(id)))
    .slice(0, 120);
  if (currentPurpose && !facts.some((fact) => fact.event_type === "current_purpose") && sources.length < 40 && facts.length < 120) {
    sources.push({ source_id: "S-PURPOSE", title: "本次来院目的", evidence: currentPurpose });
    facts.push({ fact_id: "F-PURPOSE", field: "current_purpose", value: currentPurpose, event_time: "本次", event_type: "current_purpose", encounter_scope: "current", certainty: "explicit", source_ids: ["S-PURPOSE"] });
  }
  if (arrivalContext && sources.length < 40 && facts.length < 120) {
    sources.push({ source_id: "S-ARRIVAL", title: "本次到院关系", evidence: arrivalContext });
    const arrivalConfirmed = arrivalContext !== "本次到院身份待确认";
    facts.push({
      fact_id: "F-ARRIVAL",
      field: "arrival_context",
      value: arrivalContext,
      event_time: arrivalConfirmed ? "本次" : "待核对",
      event_type: "current_status",
      encounter_scope: arrivalConfirmed ? "current" : "unclear",
      certainty: arrivalConfirmed ? "explicit" : "pending",
      source_ids: ["S-ARRIVAL"],
    });
  }
  return {
    current_purpose: currentPurpose || parts.find((part) => part.current_purpose)?.current_purpose || null,
    sources,
    facts,
    pending_fields: [...new Set(parts.flatMap((part) => part.pending_fields))].slice(0, 8),
  };
};

const priorDischargeDocumentPattern = /出院(?:记录|小结|诊断)|出院时诊断/;

const priorDiagnosisValue = (value: string) => {
  const dischargeIndex = value.search(/出院(?:时)?诊断\s*[:：]?/);
  const selected = dischargeIndex >= 0 ? value.slice(dischargeIndex) : value;
  const cleaned = selected
    .replace(/^.*?出院(?:时)?诊断\s*[:：]?\s*/, "")
    .replace(/^.*?入院诊断\s*[:：]?\s*/, "")
    .split(/(?:出院医嘱|诊疗经过|出院情况)\s*[:：]?/)[0]
    .replace(/[\s；;，,]+$/, "")
    .trim();
  return `既往住院记录明确诊断：${cleaned || "具体诊断内容待核对"}`.slice(0, 800);
};

const normalizeAdmissionFacts = (extraction: FactExtraction): FactExtraction => {
  const sourceTextById = new Map(extraction.sources.map((source) => [source.source_id, `${source.title}\n${source.evidence}`]));
  return {
    ...extraction,
    facts: extraction.facts.map((fact): ExtractedFact => {
      const sourceText = fact.source_ids.map((id) => sourceTextById.get(id) || "").join("\n");
      if (fact.event_type === "specialist_exam") {
        const factText = `${fact.field}\n${fact.value}\n${fact.event_time}`;
        if (missingExamPattern.test(factText)) {
          return { ...fact, encounter_scope: currentExamPattern.test(factText) ? "current" : "unclear", certainty: "pending" };
        }
        const factHasExternalClue = externalExamPattern.test(factText);
        const factHasCurrentClue = currentExamPattern.test(factText);
        const sourceHasExternalClue = externalExamPattern.test(sourceText);
        const sourceHasCurrentExamClue = currentExamPattern.test(sourceText);
        if (factHasExternalClue || (sourceHasExternalClue && !sourceHasCurrentExamClue && !factHasCurrentClue)) {
          return { ...fact, encounter_scope: "prior" };
        }
        if (sourceHasExternalClue && sourceHasCurrentExamClue && !factHasExternalClue && !factHasCurrentClue) {
          return { ...fact, encounter_scope: "unclear", certainty: "pending" };
        }
      }
      if (fact.event_type !== "doctor_diagnosis") return fact;
      const isPriorDischargeDiagnosis = priorDischargeDocumentPattern.test(`${fact.field}\n${fact.value}\n${sourceText}`);
      if (!isPriorDischargeDiagnosis) return fact;
      return {
        ...fact,
        field: "prior_record_diagnosis",
        value: priorDiagnosisValue(fact.value),
        event_type: "onset_diagnosis",
        encounter_scope: "prior",
        certainty: fact.certainty === "pending" ? "pending" : "explicit",
      };
    }),
  };
};

const extractFacts = async (baseUrl: string, apiKey: string, model: string, sourceText: string, currentPurpose: string, arrivalContext: ArrivalContext | "") => {
  const chunks = splitSourceText(sourceText);
  const extractChunk = async (chunk: string, chunkIndex: number) => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const retryInstruction = attempt === 0 ? "" : `\n\n上一次未通过的具体原因：${lastError instanceof Error ? lastError.message : "结构不完整"}。请重新逐项核对并只返回完整JSON；不得省略sources、facts、pending_fields，也不得输出解释。当前分段已含有可见的临床资料，facts不得为空；检验、影像、病理、用药或医生意见至少应提取一条忠实事实，不得因与肿瘤时间线关系不明而丢弃整页。`;
        const extracted = boundSourceEvidence(await requestJson(
          baseUrl,
          apiKey,
          model,
          buildExtractionPrompt(chunk, chunkIndex === 0 ? currentPurpose : "") + retryInstruction,
          8500,
          120_000,
        ));
        if (!isValidFactExtraction(extracted)) {
          const value = extracted && typeof extracted === "object" ? extracted as Record<string, unknown> : {};
          console.warn("[analyze] invalid fact extraction shape", {
            chunk: chunkIndex + 1,
            keys: Object.keys(value),
            sources: Array.isArray(value.sources) ? value.sources.length : "not-array",
            facts: Array.isArray(value.facts) ? value.facts.length : "not-array",
            pendingFields: Array.isArray(value.pending_fields) ? value.pending_fields.length : "not-array",
          });
          throw new Error(`结构不完整：${factExtractionIssue(extracted)}`);
        }
        return { part: withPrefix(extracted, chunkIndex), retried: attempt > 0 };
      } catch (error) {
        lastError = error;
        console.warn("[analyze] fact extraction attempt failed", {
          chunk: chunkIndex + 1,
          attempt: attempt + 1,
          error: error instanceof Error ? error.message : "unknown",
        });
      }
    }
    const detail = lastError instanceof Error ? lastError.message : "未知错误";
    throw new Error(`第${chunkIndex + 1}段事实抽取失败：${detail}`);
  };
  const results: Array<Awaited<ReturnType<typeof extractChunk>>> = Array(chunks.length);
  let nextChunkIndex = 0;
  const runWorker = async () => {
    while (nextChunkIndex < chunks.length) {
      const chunkIndex = nextChunkIndex++;
      results[chunkIndex] = await extractChunk(chunks[chunkIndex], chunkIndex);
    }
  };
  await Promise.all(Array.from({ length: Math.min(FACT_EXTRACTION_CONCURRENCY, chunks.length) }, runWorker));
  const merged = normalizeAdmissionFacts(mergeExtractions(results.map((result) => result.part), currentPurpose, arrivalContext));
  if (!isValidFactExtraction(merged)) throw new Error("合并后的事实结构不完整");
  return { extraction: merged, chunkCount: chunks.length, retryCount: results.filter((result) => result.retried).length };
};

const buildDraftPrompt = (extraction: FactExtraction) => [
  "你是医疗AI作品中的第一阶段入院病史整理器。本轮只写主诉、现病史、背景病史和已提供的本次专科查体；不生成诊断、检查建议或诊疗计划。你只能使用下方已经结构化并绑定来源的事件账本，禁止回看或补猜原始资料。",
  "服务对象是第一次接管该患者的肿瘤科住院医师或规培医师。输出是可编辑工作稿，必须由医生结合本院模板核对，不是最终病历。",
  yiyangRecordRules,
  "现病史按首发/确诊→病理或关键分子结果→既往治疗及疗效→复发或进展证据→本次入院原因及当前情况重建。current_purpose决定本次，不能把既往住院、出院或未来计划写成本次经过。",
  "外院‘建议转上级医院/建议转院’只能作为既往经过，不能作为本院入院记录的末句。若current_purpose或当前事实明确为‘外院转入我院/收治入院’，现病史必须以本次实际到院或收治事实收束；若只有转诊建议而没有实际到院信息，不能杜撰转入我院，需在pending_fields提示核对本次收治经过。",
  "certainty为uncertain的事实必须保留不确定词。不得把考虑/可能/倾向/疑似/待排写成确定分期、转移或疗效。",
  "主诉必须是临床问题或已明确疾病状态 + 时间锚点 + 必要时本次突出问题，不得输出‘入院诊断’‘本次入院目的’等栏目名，不得输出无病种无症状的泛化占位句。转入我院属于现病史收束，不要把‘由外院转入/进一步诊治’作为主诉结尾；信息不足时宁可保留待核对时间，也不能输出半句话。持续时间只能使用结构化事实中明确提供的‘1天、1周、8年余’等相对时长，不得根据绝对日期自行计算或猜测。",
  "现病史必须写成连续的临床叙述，不得复制Markdown标题、星号、井号、原始模块名或整段检查单。任何specialist_exam查体事件，无论外院旧查体还是本次查体，都不得写入现病史；它们只能进入专科查体或作为旧时点证据留在账本。出院计划不得冒充本次经过。",
  "既往史中完整整理已确认的高血压、糖尿病、冠心病、肝肾疾病等基础病，包括病程、长期用药、控制情况和已提供的并发症。无关旧手术写入既往史；若术式、原因或病理不清，保留‘待核实’并列入pending_fields。与当前肿瘤直接相关的手术和放化疗必须留在现病史时间线。",
  "既往史、个人史、家族史、过敏史、专科查体没有对应事实时输出空字符串，不得写否认、无特殊、正常或未见异常。专科查体只能使用encounter_scope=current的本次实际查体；外院、转院前或出院前查体不得复制到本次专科查体。",
  "diagnosis_summary和plan_summary本轮必须输出空字符串；它们将在后续独立模型调用中依次生成。",
  "当前是入院病史阶段，任何字段都不得输出‘出院诊断’栏目；既往出院记录中的诊断只能改写为既往诊疗事实。",
  "额外输出present_illness_fact_ids，列出现病史实际覆盖的fact_id。对账本中存在的首发/确诊、关键病理、每个时间点的既往治疗、复发/进展、本次急性发病与外院处置、实际到院事件，每个事件桶至少覆盖一条；不得用冗长免疫组化替代临床经过。",
  "只输出一个JSON对象，不要Markdown或解释。必须严格符合以下结构：",
  JSON.stringify(narrativeDraftShape),
  `唯一可用事实：\n${JSON.stringify(extraction)}`,
].join("\n\n");

const forceEvidenceBoundSections = (extraction: FactExtraction, draft: AdmissionDraft): AdmissionDraft => {
  const hasType = (type: string) => extraction.facts.some((fact) => fact.event_type === type);
  const hasCurrentUsableType = (type: string) => extraction.facts.some((fact) => fact.event_type === type
    && fact.encounter_scope === "current"
    && (fact.certainty === "explicit" || fact.certainty === "doctor_confirmed"));
  const pending = [...new Set([...extraction.pending_fields, ...draft.pending_fields])].slice(0, 8);
  return {
    ...draft,
    past_history: hasType("past_history") ? draft.past_history : "",
    personal_history: hasType("personal_history") ? draft.personal_history : "",
    family_history: hasType("family_history") ? draft.family_history : "",
    allergy_history: hasType("allergy_history") ? draft.allergy_history : "",
    specialist_exam: hasCurrentUsableType("specialist_exam") ? draft.specialist_exam : "",
    diagnosis_summary: "",
    plan_summary: "",
    pending_fields: pending,
  };
};

const coreNarrativeEventTypes = new Set(["onset_diagnosis", "pathology_molecular", "prior_treatment", "progression_evidence", "current_purpose", "current_status"]);

const missingNarrativeCoverage = (extraction: FactExtraction, candidate: unknown) => {
  const ids = candidate && typeof candidate === "object"
    ? (candidate as { present_illness_fact_ids?: unknown }).present_illness_fact_ids
    : null;
  const covered = new Set(Array.isArray(ids) ? ids.filter((item): item is string => typeof item === "string") : []);
  const buckets = new Map<string, ExtractedFact[]>();
  extraction.facts
    .filter((fact) => coreNarrativeEventTypes.has(fact.event_type)
      && fact.certainty !== "pending"
      && !(fact.event_type === "current_purpose" && /^(?:未提供|未确认|待核对)/.test(fact.event_time)))
    .forEach((fact) => {
      const key = `${fact.event_type}|${fact.event_time || "未提供"}`;
      buckets.set(key, [...(buckets.get(key) || []), fact]);
    });
  return [...buckets.entries()]
    .filter(([, facts]) => !facts.some((fact) => covered.has(fact.fact_id)))
    .map(([key]) => key);
};

const hasExamLeakInPresentIllness = (extraction: FactExtraction, draft: AdmissionDraft) => {
  const compactDraft = draft.present_illness.replace(/\s+/g, "").replace(/[：:]/g, "");
  return extraction.facts
    .filter((fact) => fact.event_type === "specialist_exam")
    .flatMap((fact) => fact.value.split(/[，,。；;\n]/))
    .map((clause) => clause.replace(/\s+/g, "").replace(/[：:]/g, ""))
    .filter((clause) => clause.length >= 6)
    .some((clause) => compactDraft.includes(clause));
};

const hasPriorSpecialistExamLeak = (extraction: FactExtraction, draft: AdmissionDraft) => {
  if (!draft.specialist_exam.trim()) return false;
  const priorExamText = extraction.facts
    .filter((fact) => fact.event_type === "specialist_exam" && fact.encounter_scope !== "current")
    .map((fact) => fact.value)
    .join("\n");
  if (!priorExamText) return false;
  if (externalExamPattern.test(draft.specialist_exam)) return true;
  const currentExamText = extraction.facts
    .filter((fact) => fact.event_type === "specialist_exam" && fact.encounter_scope === "current")
    .map((fact) => fact.value)
    .join("\n");
  const compact = (value: string) => value.replace(/\s+/g, "").replace(/[：:]/g, "");
  const priorClauses = priorExamText
    .split(/[，,。；;\n]/)
    .map((clause) => compact(clause.replace(/^(?:外院|院外|当地医院|转院前|转入前|出院前)(?:查体|体检|专科情况)?(?:示|见|为)?/, "")))
    .filter((clause) => clause.length >= 5);
  const compactDraft = compact(draft.specialist_exam);
  const compactCurrent = compact(currentExamText);
  if (priorClauses.some((clause) => compactDraft.includes(clause) && !compactCurrent.includes(clause))) return true;
  const priorMeasurements = priorExamText.match(/\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?(?:\s*(?:℃|次\/分|mmHg|%|分))?/gi) || [];
  return priorMeasurements.some((token) => {
    const compact = token.replace(/\s+/g, "");
    if (!/(?:\d{2,}|[./%℃]|mmHg|次\/分)/i.test(compact)) return false;
    return compactDraft.includes(compact)
      && !compactCurrent.includes(compact);
  });
};

export async function POST(request: Request) {
  try {
    const body = await request.json() as { source_text?: unknown; current_purpose?: unknown; arrival_context?: unknown };
    const sourceText = typeof body.source_text === "string" ? body.source_text.trim() : "";
    const currentPurpose = typeof body.current_purpose === "string" ? body.current_purpose.trim() : "";
    const arrivalContext = arrivalContexts.includes(body.arrival_context as ArrivalContext) ? body.arrival_context as ArrivalContext : "";
    if (sourceText.length < 20) return Response.json({ error: "请先粘贴需要整理的患者资料。" }, { status: 400 });
    if (sourceText.length > 32000) return Response.json({ error: "一次资料过长（超过32000字），请保留与本次病历最相关的页面后重试。" }, { status: 400 });
    if (currentPurpose.length > 160) return Response.json({ error: "本次来院目的请控制在160字以内。" }, { status: 400 });
    const sourceReferral = lastPatternSpan(sourceText, externalReferralPattern);
    const sourceArrival = lastPatternSpan(sourceText, currentAdmissionPattern);
    const sourceHasConfirmedCurrentAdmission = Boolean(sourceArrival && (!sourceReferral || sourceArrival.index >= sourceReferral.end));
    const sourceMentionsOnlyExternalReferral = Boolean(sourceReferral && !sourceHasConfirmedCurrentAdmission);
    if (sourceMentionsOnlyExternalReferral && !arrivalContext) {
      return Response.json({ error: "资料包含外院‘建议转院’，请先选择本次到院关系，避免把外院转诊意见错写成本次入院结尾。" }, { status: 400 });
    }
    const privacyText = `${sourceText}\n${currentPurpose}`;
    if (/(?:^|\D)\d{17}[\dXx](?:\D|$)/.test(privacyText) || /(?:^|\D)1[3-9]\d{9}(?:\D|$)/.test(privacyText)) {
      return Response.json({ error: "检测到疑似身份证号或手机号，请脱敏后再提交。" }, { status: 400 });
    }

    const apiKey = process.env.ARK_CODING_API_KEY;
    if (!apiKey) return Response.json({ error: "模型服务尚未配置，请稍后再试。" }, { status: 503 });
    const model = process.env.ARK_CODING_MODEL || "deepseek-v4-pro";
    const baseUrl = (process.env.ARK_CODING_BASE_URL || "https://ark.cn-beijing.volces.com/api/coding/v3").replace(/\/$/, "");

    const cleanedSourceText = cleanSourceMarkup(sourceText);
    const { extraction, chunkCount, retryCount } = await extractFacts(baseUrl, apiKey, model, cleanedSourceText, currentPurpose, arrivalContext);
    const baseDraftPrompt = buildDraftPrompt(extraction);
    let evidenceDraft: AdmissionDraft | null = null;
    let lastDraftError: unknown;
    let draftRetryCount = 0;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const retryInstruction = attempt === 0 ? "" : `\n\n上一版未通过病历质量门禁：${lastDraftError instanceof Error ? lastDraftError.message : "结构或证据不完整"}。请重新生成完整JSON，重点修正该问题；不得删除已提供的首发、病理、治疗、复发、本次症状和实际收治事件。`;
        const generated = boundDraftPendingFields(await requestJson(baseUrl, apiKey, model, baseDraftPrompt + retryInstruction, 8500, 120000));
        if (!isValidAdmissionDraft(generated)) throw new Error(`草稿包结构不完整：${admissionDraftIssue(generated)}`);
        const qualityIssues: string[] = [];
        if (hasNarrativePresentationFailure(generated)) qualityIssues.push("主诉或现病史出现不完整句、栏目或Markdown污染");
        if (hasUnsupportedChiefComplaintDuration(cleanedSourceText, currentPurpose, generated)) qualityIssues.push("主诉加入了资料未提供的持续时间");
        if (hasCurrentAdmissionTransitionFailure(extraction, generated, cleanedSourceText)) qualityIssues.push("草稿把外院转诊意见错写成本次入院结尾");
        const uncoveredBuckets = missingNarrativeCoverage(extraction, generated);
        if (uncoveredBuckets.length) qualityIssues.push(`现病史遗漏关键事件：${uncoveredBuckets.slice(0, 6).join("、")}`);
        const boundedDraft = forceEvidenceBoundSections(extraction, generated);
        if (hasExamLeakInPresentIllness(extraction, boundedDraft)) qualityIssues.push("草稿把查体事件混入现病史");
        if (hasPriorSpecialistExamLeak(extraction, boundedDraft)) qualityIssues.push("草稿把既往外院查体混入本次专科查体");
        if (qualityIssues.length) throw new Error(qualityIssues.join("；"));
        evidenceDraft = boundedDraft;
        draftRetryCount = attempt;
        break;
      } catch (error) {
        lastDraftError = error;
        console.warn("[analyze] narrative draft attempt failed", {
          attempt: attempt + 1,
          error: error instanceof Error ? error.message : "unknown",
        });
      }
    }
    if (!evidenceDraft) throw lastDraftError instanceof Error ? lastDraftError : new Error("草稿没有通过质量门禁");
    const guided = buildGuidedDraft(extraction, evidenceDraft);

    const result: AnalysisResult = {
      ...guided.draft,
      sources: extraction.sources,
      facts: extraction.facts,
      review_items: guided.review_items,
      template_mode: guided.template_mode,
      template_name: guided.template_name,
    };
    return Response.json({ model, processing_mode: chunkCount > 1 ? "chunked" : "single", processing_status: "model_generated", chunk_count: chunkCount, fact_retry_count: retryCount, draft_retry_count: draftRetryCount, fact_fallback_count: 0, rule_fallback_count: 0, raw_fallback_count: 0, result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "";
    const message = error instanceof Error && error.name === "TimeoutError"
      ? "模型响应超时；长资料已分段处理，但当前阶段仍超过等待上限，请重试。"
      : /第\d+段事实抽取结构不完整/.test(detail)
        ? `${detail}，请重试；系统不会丢弃已转录文字。`
        : /第\d+段事实抽取失败/.test(detail)
          ? `${detail.replace(/：.*/, "")}；V4 Pro已自动重试，仍未完成结构化事实抽取。系统未使用规则事实继续生成病历，请保留当前资料后重试。`
        : /合并后的事实结构不完整/.test(detail)
          ? "分段事实已返回，但合并校验未通过，请重试。"
        : /草稿把外院转诊意见错写成本次入院结尾/.test(detail)
          ? "V4 Pro没有把‘转入我院/收治入院’放在外院转诊意见之后；未展示错位草稿，请重试或补充本次收治描述。"
        : /草稿包结构不完整|主诉或现病史出现|主诉加入了资料未提供的持续时间|现病史遗漏关键事件|草稿把查体事件混入|草稿把既往外院查体混入/.test(detail)
            ? "V4 Pro已返回但未通过病历质量门禁；未展示规则拼接草稿，请直接重试生成。"
            : /模型没有返回可解析的JSON/.test(detail)
              ? "模型返回格式不完整，请重试；已转录文字仍保留在页面。"
              : "AI暂时没有完成事实核对和草稿整理，请重试一次。";
    return Response.json({ error: message }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
