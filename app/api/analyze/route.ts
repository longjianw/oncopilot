import {
  AnalysisResult,
  AdmissionDraft,
  ExtractedFact,
  FactExtraction,
  SourceReference,
  hasUnsupportedDoctorJudgment,
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
    body: JSON.stringify({ model, input: prompt, max_output_tokens: maxOutputTokens }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const rawText = await upstream.text();
  if (!upstream.ok) throw new Error(`上游模型请求失败：${upstream.status}`);
  return parseJson(extractText(JSON.parse(rawText) as ArkResponse));
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

const buildExtractionPrompt = (sourceText: string, currentPurpose: string) => [
  "你是医疗AI作品中的结构化事实抽取器。只抽取，不写病历，不诊断，不提出治疗建议。",
  "使用场景是肿瘤科医生第一次接管该患者，不代表患者首次住院。既往外院诊断、手术、放疗、系统治疗、出院和未来计划都必须与本次就诊分开。",
  "当前固定为入院记录路由。来源若是出院记录、出院小结或带有‘出院诊断’标题，其中诊断属于既往住院事实：标为onset_diagnosis、encounter_scope=prior、certainty=explicit，不得标为本次doctor_diagnosis。只有本次医生明确写出的初步诊断、入院诊断或当前诊断，才能作为current的doctor_diagnosis。",
  "每条事实必须绑定至少一个来源。保留原文的考虑、可能、倾向、疑似、待排等不确定性，不得升级为确定事实。未询问和未提供不等于阴性。未查体不等于正常。",
  "只有输入明确标注为医生判断、初步诊断、诊疗计划或医生已确认的内容，才能标为doctor_diagnosis/doctor_plan，certainty必须为doctor_confirmed。其他推断不得归入这两类。",
  "本次来院目的作为单独字段，判断本次就诊时优先于原始资料最后出现的住院、出院或未来日期。如果提供了单独目的，为它建立S-PURPOSE来源和current范围事实。",
  "只输出一个JSON对象，不要Markdown或解释。sources最多12条，facts最多30条，pending_fields最多6条；事实只保留会影响入院记录的内容，避免逐字重复检验单。每条value尽量不超过160字，source evidence尽量不超过200字：",
  JSON.stringify(extractionShape),
  `单独填写的本次来院目的：${currentPurpose || "未提供"}`,
  `待抽取资料：\n${sourceText}`,
].join("\n\n");

const SOURCE_CHUNK_CHARS = 2600;
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

const mergeExtractions = (parts: FactExtraction[], currentPurpose: string): FactExtraction => {
  const sources: SourceReference[] = parts.flatMap((part) => part.sources).slice(0, 40);
  const allowedSources = new Set(sources.map((source) => source.source_id));
  const facts: ExtractedFact[] = parts.flatMap((part) => part.facts)
    .filter((fact) => fact.source_ids.every((id) => allowedSources.has(id)))
    .slice(0, 120);
  if (currentPurpose && !facts.some((fact) => fact.event_type === "current_purpose") && sources.length < 40 && facts.length < 120) {
    sources.push({ source_id: "S-PURPOSE", title: "本次来院目的", evidence: currentPurpose });
    facts.push({ fact_id: "F-PURPOSE", field: "current_purpose", value: currentPurpose, event_time: "本次", event_type: "current_purpose", encounter_scope: "current", certainty: "explicit", source_ids: ["S-PURPOSE"] });
  }
  return {
    current_purpose: currentPurpose || parts.find((part) => part.current_purpose)?.current_purpose || null,
    sources,
    facts,
    pending_fields: [...new Set(parts.flatMap((part) => part.pending_fields))].slice(0, 6),
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
      if (fact.event_type !== "doctor_diagnosis") return fact;
      const sourceText = fact.source_ids.map((id) => sourceTextById.get(id) || "").join("\n");
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

const rawChunkExtraction = (chunk: string, chunkIndex: number): FactExtraction => {
  const rawSourceId = "RAW";
  const pieces = Array.from({ length: Math.ceil(chunk.length / 700) }, (_, index) => chunk.slice(index * 700, (index + 1) * 700)).filter((piece) => piece.trim());
  return {
    current_purpose: null,
    sources: [{ source_id: rawSourceId, title: `第${chunkIndex + 1}段资料（结构化待复核）`, evidence: chunk.slice(0, 500) }],
    facts: pieces.map((piece, index) => ({
      fact_id: `RAW-F${index + 1}`,
      field: "unparsed_source_segment",
      value: piece,
      event_time: "待核对",
      event_type: "other",
      encounter_scope: "unclear",
      certainty: "pending",
      source_ids: [rawSourceId],
    })),
    pending_fields: [`第${chunkIndex + 1}段资料需人工复核`],
  };
};

const heuristicClinicalPattern = /诊断|病理|免疫组化|分子|基因|手术|切除|放疗|化疗|靶向|免疫治疗|治疗|复发|进展|转移|感染|发热|疼痛|咳嗽|气促|恶心|呕吐|腹泻|CT|MRI|PET|超声|血常规|白细胞|中性粒细胞|血红蛋白|血小板|既往史|过敏史|家族史|个人史|查体|PS评分|ECOG|NRS|入院|来院/iu;

const heuristicEventType = (text: string): ExtractedFact["event_type"] => {
  if (/病理|免疫组化|分子|基因|BRAF|c-KIT|NRAS/i.test(text)) return "pathology_molecular";
  if (/出院(?:时)?诊断|入院诊断|初步诊断|明确诊断|确诊/.test(text)) return "onset_diagnosis";
  if (/手术|切除|放疗|化疗|靶向|免疫治疗|治疗\d*周期|治疗后/.test(text)) return "prior_treatment";
  if (/复发|进展|转移|较前增大|新发病灶|考虑|可能|倾向|疑似|待排|不除外/.test(text)) return "progression_evidence";
  if (/本次(?:入院|来院)|此次(?:入院|来院)|来院目的|入院目的/.test(text)) return "current_purpose";
  if (/既往史|高血压|糖尿病|冠心病|传染病/.test(text)) return "past_history";
  if (/个人史|吸烟|饮酒|婚育/.test(text)) return "personal_history";
  if (/家族史|家族中/.test(text)) return "family_history";
  if (/过敏史|药物过敏|食物过敏/.test(text)) return "allergy_history";
  if (/查体|触及|皮损|瘢痕|PS评分|ECOG|NRS/.test(text)) return "specialist_exam";
  if (/感染|发热|疼痛|咳嗽|气促|恶心|呕吐|腹泻|血常规|白细胞|中性粒细胞|血红蛋白|血小板|CT|MRI|PET|超声|检查/.test(text)) return "current_status";
  return "other";
};

const heuristicChunkExtraction = (chunk: string, chunkIndex: number): FactExtraction | null => {
  const sourceId = "RULE";
  const sentences = [...new Set(chunk
    .replace(/```[a-z]*|```/gi, " ")
    .split(/\n+|(?<=[。！？])/)
    .map((item) => item
      .replace(/(?:患者姓名|姓名|住院号|病案号|门诊号|身份证号|联系电话|电话|详细地址|地址)\s*[:：]\s*[^，,；;\s]+/g, (matched) => `${matched.split(/[:：]/)[0]}：【已隐藏】`)
      .replace(/^\s*(?:[-*•]|\d+[.、])\s*/, "")
      .replace(/\s+/g, " ")
      .trim())
    .filter((item) => item.length >= 4 && heuristicClinicalPattern.test(item))
    .map((item) => item.slice(0, 500)))]
    .slice(0, 12);
  if (!sentences.length) return null;
  const facts: ExtractedFact[] = sentences.map((value, index) => {
    const eventType = heuristicEventType(value);
    const isPriorRecordDiagnosis = /出院(?:记录|小结|诊断)|出院时诊断/.test(`${chunk.slice(0, 160)}\n${value}`) && eventType === "onset_diagnosis";
    const relativeTime = value.match(/(?:\d{4}[-年.]\d{1,2}[-月.]\d{1,2}日?|\d+(?:小时|天|周|月|年)前|近\d+(?:天|周|月|年)|既往|目前|本次)/)?.[0] || "未提供";
    const currentClue = /本次|此次|目前|现(?:有|为|因)|入院后|近期/.test(value);
    const priorClue = /既往|曾|外院|术后|治疗后|出院/.test(value) || eventType === "prior_treatment" || isPriorRecordDiagnosis;
    return {
      fact_id: `RULE-F${index + 1}`,
      field: isPriorRecordDiagnosis ? "prior_record_diagnosis" : eventType,
      value: isPriorRecordDiagnosis ? priorDiagnosisValue(value) : value,
      event_time: relativeTime,
      event_type: eventType,
      encounter_scope: priorClue ? "prior" : currentClue ? "current" : "unclear",
      certainty: /考虑|可能|倾向|疑似|待排|不除外/.test(value) ? "uncertain" : "explicit",
      source_ids: [sourceId],
    };
  });
  return {
    current_purpose: facts.find((fact) => fact.event_type === "current_purpose")?.value || null,
    sources: [{ source_id: sourceId, title: `第${chunkIndex + 1}段资料（规则提取待核对）`, evidence: "AI结构化未完成；已按资料中的明确标题和临床关键词提取可编辑事实。" }],
    facts,
    pending_fields: [`第${chunkIndex + 1}段采用规则提取，请结合原文核对`],
  };
};

const extractFacts = async (baseUrl: string, apiKey: string, model: string, sourceText: string, currentPurpose: string) => {
  const chunks = splitSourceText(sourceText);
  const parts: FactExtraction[] = [];
  let fallbackCount = 0;
  let ruleFallbackCount = 0;
  let rawFallbackCount = 0;
  const results = await Promise.all(chunks.map(async (chunk, chunkIndex) => {
      let extracted: unknown;
      try {
        extracted = await requestJson(baseUrl, apiKey, model, buildExtractionPrompt(chunk, chunkIndex === 0 ? currentPurpose : ""), 2600);
        if (!isValidFactExtraction(extracted)) throw new Error("结构不完整");
        return { part: withPrefix(extracted, chunkIndex), fallbackMode: "none" as const };
      } catch {
        const heuristic = heuristicChunkExtraction(chunk, chunkIndex);
        return heuristic
          ? { part: withPrefix(heuristic, chunkIndex), fallbackMode: "rule" as const }
          : { part: withPrefix(rawChunkExtraction(chunk, chunkIndex), chunkIndex), fallbackMode: "raw" as const };
      }
  }));
  parts.push(...results.map((result) => result.part));
  fallbackCount += results.filter((result) => result.fallbackMode !== "none").length;
  ruleFallbackCount += results.filter((result) => result.fallbackMode === "rule").length;
  rawFallbackCount += results.filter((result) => result.fallbackMode === "raw").length;
  const merged = normalizeAdmissionFacts(mergeExtractions(parts, currentPurpose));
  if (!isValidFactExtraction(merged)) throw new Error("合并后的事实结构不完整");
  return { extraction: merged, chunkCount: chunks.length, fallbackCount, ruleFallbackCount, rawFallbackCount };
};

const currentDoctorDiagnoses = (extraction: FactExtraction) => extraction.facts.filter((fact) => fact.event_type === "doctor_diagnosis"
  && fact.certainty === "doctor_confirmed"
  && fact.encounter_scope === "current");

const currentDoctorPlans = (extraction: FactExtraction) => extraction.facts.filter((fact) => fact.event_type === "doctor_plan"
  && fact.certainty === "doctor_confirmed"
  && fact.encounter_scope === "current");

const sanitizeAdmissionDiagnosisSummary = (value: string) => value
  .split(/出院(?:时)?诊断\s*[:：]?/)[0]
  .replace(/[\s；;，,]+$/, "")
  .trim();

const tumorDiagnosisFromPriorRecord = (value: string) => value
  .replace(/^既往住院记录明确诊断\s*[:：]?/, "")
  .split(/[；;，,\n]/)
  .map((item) => item.replace(/^\s*\d+[.、]\s*/, "").trim())
  .find((item) => /癌|瘤|白血病|淋巴瘤/.test(item))
  ?.slice(0, 60) || "";

const fallbackDraftFromFacts = (extraction: FactExtraction): AdmissionDraft => {
  const usableFacts = extraction.facts.filter((fact) => fact.certainty !== "pending" && fact.field !== "unparsed_source_segment");
  const values = (eventType: string) => usableFacts.filter((fact) => fact.event_type === eventType).map((fact) => fact.value);
  const join = (items: string[]) => [...new Set(items.map((item) => item.trim()).filter(Boolean))].join("；");
  const diagnosis = usableFacts.find((fact) => fact.event_type === "onset_diagnosis" && fact.field !== "prior_record_diagnosis")?.value.trim()
    || usableFacts.filter((fact) => fact.field === "prior_record_diagnosis").map((fact) => tumorDiagnosisFromPriorRecord(fact.value)).find(Boolean)
    || "";
  const purpose = extraction.current_purpose || values("current_purpose")[0] || "";
  const diagnosisHasDuration = /(?:\d+|[一二三四五六七八九十数半两]+)\s*(?:小时|天|周|月|年)/.test(diagnosis);
  const chiefComplaint = `${diagnosis || "【疾病或主要症状待补】"}${diagnosisHasDuration ? "" : "【病程时间待补】"}，${purpose || "【本次来院目的待补】"}`;
  const onset = join(values("onset_diagnosis"));
  const pathology = join(values("pathology_molecular"));
  const priorTreatment = join(values("prior_treatment"));
  const progression = join([...values("progression_evidence"), ...values("current_status")]);
  const presentIllness = [
    onset ? `${onset}。` : "患者【首发或确诊时间、发现方式及诊断经过待补】。",
    pathology ? `${pathology}。` : "病理及关键检查结果【待核对】。",
    priorTreatment ? `${priorTreatment}。` : "既往治疗经过及疗效【待补】。",
    progression ? `${progression}。` : "近期病情变化及伴随症状【待核对】。",
    purpose ? `本次因${purpose}入院。` : "本次来院目的【待补】。",
  ].join("");
  return {
    chief_complaint: chiefComplaint.slice(0, 100),
    present_illness: presentIllness,
    past_history: join(values("past_history")),
    personal_history: join(values("personal_history")),
    family_history: join(values("family_history")),
    allergy_history: join(values("allergy_history")),
    specialist_exam: join(values("specialist_exam")),
    diagnosis_summary: join(currentDoctorDiagnoses(extraction).map((fact) => fact.value)),
    plan_summary: join(currentDoctorPlans(extraction).map((fact) => fact.value)),
    pending_fields: extraction.pending_fields,
  };
};

const buildDraftPrompt = (extraction: FactExtraction) => [
  "你是医疗AI作品中的入院记录草稿整理器。你只能使用下方已经结构化并绑定来源的事实，禁止回看或补猜原始资料。",
  "服务对象是第一次接管该患者的肿瘤科住院医师或规培医师。输出是可编辑工作稿，必须由医生结合本院模板核对，不是最终病历。",
  yiyangRecordRules,
  "现病史按首发/确诊→病理或关键分子结果→既往治疗及疗效→复发或进展证据→本次入院原因及当前情况重建。current_purpose决定本次，不能把既往住院、出院或未来计划写成本次经过。",
  "certainty为uncertain的事实必须保留不确定词。不得把考虑/可能/倾向/疑似/待排写成确定分期、转移或疗效。",
  "既往史、个人史、家族史、过敏史、专科查体没有对应事实时输出空字符串，不得写否认、无特殊、正常或未见异常。",
  "当前固定生成入院记录，不生成出院记录。diagnosis_summary只允许整理encounter_scope=current且doctor_confirmed的doctor_diagnosis，按初步诊断/入院诊断、诊断依据、必要时鉴别诊断组织；既往出院记录中的入院诊断或出院诊断只能作为既往诊疗事实，不得写入当前诊断区，更不得输出‘出院诊断’。plan_summary同样只允许整理current且doctor_confirmed的doctor_plan；没有时输出空字符串。不得自行新增诊断、检查、处方、剂量、治疗或处置建议。",
  "只输出一个JSON对象，不要Markdown或解释。必须严格符合以下结构：",
  JSON.stringify(draftShape),
  `唯一可用事实：\n${JSON.stringify(extraction)}`,
].join("\n\n");

const forceEvidenceBoundSections = (extraction: FactExtraction, draft: AdmissionDraft): AdmissionDraft => {
  const hasType = (type: string) => extraction.facts.some((fact) => fact.event_type === type);
  const pending = [...new Set([...extraction.pending_fields, ...draft.pending_fields])].slice(0, 6);
  return {
    ...draft,
    past_history: hasType("past_history") ? draft.past_history : "",
    personal_history: hasType("personal_history") ? draft.personal_history : "",
    family_history: hasType("family_history") ? draft.family_history : "",
    allergy_history: hasType("allergy_history") ? draft.allergy_history : "",
    specialist_exam: hasType("specialist_exam") ? draft.specialist_exam : "",
    diagnosis_summary: currentDoctorDiagnoses(extraction).length ? sanitizeAdmissionDiagnosisSummary(draft.diagnosis_summary) : "",
    plan_summary: currentDoctorPlans(extraction).length ? draft.plan_summary : "",
    pending_fields: pending,
  };
};

export async function POST(request: Request) {
  try {
    const body = await request.json() as { source_text?: unknown; current_purpose?: unknown };
    const sourceText = typeof body.source_text === "string" ? body.source_text.trim() : "";
    const currentPurpose = typeof body.current_purpose === "string" ? body.current_purpose.trim() : "";
    if (sourceText.length < 20) return Response.json({ error: "请先粘贴需要整理的患者资料。" }, { status: 400 });
    if (sourceText.length > 32000) return Response.json({ error: "一次资料过长（超过32000字），请保留与本次病历最相关的页面后重试。" }, { status: 400 });
    if (currentPurpose.length > 160) return Response.json({ error: "本次来院目的请控制在160字以内。" }, { status: 400 });
    const privacyText = `${sourceText}\n${currentPurpose}`;
    if (/(?:^|\D)\d{17}[\dXx](?:\D|$)/.test(privacyText) || /(?:^|\D)1[3-9]\d{9}(?:\D|$)/.test(privacyText)) {
      return Response.json({ error: "检测到疑似身份证号或手机号，请脱敏后再提交。" }, { status: 400 });
    }

    const apiKey = process.env.ARK_CODING_API_KEY;
    if (!apiKey) return Response.json({ error: "模型服务尚未配置，请稍后再试。" }, { status: 503 });
    const model = process.env.ARK_CODING_MODEL || "deepseek-v4-flash";
    const baseUrl = (process.env.ARK_CODING_BASE_URL || "https://ark.cn-beijing.volces.com/api/coding/v3").replace(/\/$/, "");

    const { extraction, chunkCount, fallbackCount, ruleFallbackCount, rawFallbackCount } = await extractFacts(baseUrl, apiKey, model, sourceText, currentPurpose);
    let rawDraft: AdmissionDraft;
    let processingStatus: "complete" | "draft_fallback" = "complete";
    try {
      const generated = await requestJson(baseUrl, apiKey, model, buildDraftPrompt(extraction), 3200, 50000);
      if (!isValidAdmissionDraft(generated)) throw new Error("草稿包结构不完整");
      rawDraft = generated;
    } catch {
      rawDraft = fallbackDraftFromFacts(extraction);
      processingStatus = "draft_fallback";
    }
    const evidenceDraft = forceEvidenceBoundSections(extraction, rawDraft);
    if (hasUnsupportedDoctorJudgment(extraction, evidenceDraft)) throw new Error("诊断或计划缺少医生明确判断来源");
    const guided = buildGuidedDraft(extraction, evidenceDraft);

    const result: AnalysisResult = {
      ...guided.draft,
      sources: extraction.sources,
      facts: extraction.facts,
      review_items: guided.review_items,
      template_mode: guided.template_mode,
      template_name: guided.template_name,
    };
    return Response.json({ model, processing_mode: chunkCount > 1 ? "chunked" : "single", processing_status: processingStatus, chunk_count: chunkCount, fact_fallback_count: fallbackCount, rule_fallback_count: ruleFallbackCount, raw_fallback_count: rawFallbackCount, result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "";
    const message = error instanceof Error && error.name === "TimeoutError"
      ? "模型响应超时；长资料已分段处理，但当前阶段仍超过等待上限，请重试。"
      : /第\d+段事实抽取结构不完整/.test(detail)
        ? `${detail}，请重试；系统不会丢弃已转录文字。`
        : /第\d+段事实抽取失败/.test(detail)
          ? `${detail.replace(/上游模型请求失败/g, "模型服务返回错误")}；已转录文字仍保留，可直接重试生成。`
        : /合并后的事实结构不完整/.test(detail)
          ? "分段事实已返回，但合并校验未通过，请重试。"
          : /草稿包结构不完整|诊断或计划缺少/.test(detail)
            ? "事实抽取已完成，但草稿结构校验未通过，请重试生成。"
            : /模型没有返回可解析的JSON/.test(detail)
              ? "模型返回格式不完整，请重试；已转录文字仍保留在页面。"
              : "AI暂时没有完成事实核对和草稿整理，请重试一次。";
    return Response.json({ error: message }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
