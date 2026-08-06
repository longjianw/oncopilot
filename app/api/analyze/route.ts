import {
  AnalysisResult,
  AdmissionDraft,
  FactExtraction,
  hasUnsupportedDoctorJudgment,
  isValidAdmissionDraft,
  isValidFactExtraction,
} from "../../../lib/admission-record-contract";
import { yiyangRecordRules } from "../../../lib/yiyang-record-rules";

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

const requestJson = async (baseUrl: string, apiKey: string, model: string, prompt: string) => {
  const upstream = await fetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: prompt }),
    signal: AbortSignal.timeout(75000),
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
  "每条事实必须绑定至少一个来源。保留原文的考虑、可能、倾向、疑似、待排等不确定性，不得升级为确定事实。未询问和未提供不等于阴性。未查体不等于正常。",
  "只有输入明确标注为医生判断、初步诊断、诊疗计划或医生已确认的内容，才能标为doctor_diagnosis/doctor_plan，certainty必须为doctor_confirmed。其他推断不得归入这两类。",
  "本次来院目的作为单独字段，判断本次就诊时优先于原始资料最后出现的住院、出院或未来日期。如果提供了单独目的，为它建立S-PURPOSE来源和current范围事实。",
  "只输出一个JSON对象，不要Markdown或解释。必须严格符合以下结构，pending_fields最多6条：",
  JSON.stringify(extractionShape),
  `单独填写的本次来院目的：${currentPurpose || "未提供"}`,
  `待抽取资料：\n${sourceText}`,
].join("\n\n");

const buildDraftPrompt = (extraction: FactExtraction) => [
  "你是医疗AI作品中的入院记录草稿整理器。你只能使用下方已经结构化并绑定来源的事实，禁止回看或补猜原始资料。",
  "服务对象是第一次接管该患者的肿瘤科住院医师或规培医师。输出是可编辑工作稿，必须由医生结合本院模板核对，不是最终病历。",
  yiyangRecordRules,
  "现病史按首发/确诊→病理或关键分子结果→既往治疗及疗效→复发或进展证据→本次入院原因及当前情况重建。current_purpose决定本次，不能把既往住院、出院或未来计划写成本次经过。",
  "certainty为uncertain的事实必须保留不确定词。不得把考虑/可能/倾向/疑似/待排写成确定分期、转移或疗效。",
  "既往史、个人史、家族史、过敏史、专科查体没有对应事实时输出空字符串，不得写否认、无特殊、正常或未见异常。",
  "diagnosis_summary和plan_summary只允许整理doctor_confirmed的doctor_diagnosis或doctor_plan事实；没有时输出空字符串。不得自行新增诊断、检查、处方、剂量、治疗或处置建议。",
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
    diagnosis_summary: extraction.facts.some((fact) => fact.event_type === "doctor_diagnosis" && fact.certainty === "doctor_confirmed") ? draft.diagnosis_summary : "",
    plan_summary: extraction.facts.some((fact) => fact.event_type === "doctor_plan" && fact.certainty === "doctor_confirmed") ? draft.plan_summary : "",
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

    const extraction = await requestJson(baseUrl, apiKey, model, buildExtractionPrompt(sourceText, currentPurpose));
    if (!isValidFactExtraction(extraction)) throw new Error("事实抽取结构不完整");
    const rawDraft = await requestJson(baseUrl, apiKey, model, buildDraftPrompt(extraction));
    if (!isValidAdmissionDraft(rawDraft)) throw new Error("草稿包结构不完整");
    const draft = forceEvidenceBoundSections(extraction, rawDraft);
    if (hasUnsupportedDoctorJudgment(extraction, draft)) throw new Error("诊断或计划缺少医生明确判断来源");

    const result: AnalysisResult = { ...draft, sources: extraction.sources, facts: extraction.facts };
    return Response.json({ model, result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error && error.name === "TimeoutError"
      ? "模型响应超时，请稍后重试。"
      : "AI暂时没有完成事实核对和草稿整理，请重试一次。";
    return Response.json({ error: message }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
