import {
  AdmissionDraft,
  ExtractedFact,
  isValidAdmissionDraft,
  isValidReviewConfirmations,
} from "../../../lib/admission-record-contract";
import { containsSensitiveIdentifier, parseModelJson, requestModel } from "../../../lib/model-api";

const outputShape: AdmissionDraft = {
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

const validFacts = (value: unknown): value is ExtractedFact[] => Array.isArray(value)
  && value.length <= 120
  && value.every((fact) => fact && typeof fact === "object" && typeof (fact as ExtractedFact).event_type === "string" && typeof (fact as ExtractedFact).certainty === "string");

export async function POST(request: Request) {
  try {
    const body = await request.json() as { draft?: unknown; confirmations?: unknown; facts?: unknown; template_name?: unknown };
    if (!isValidAdmissionDraft(body.draft)) return Response.json({ error: "当前草稿结构不完整，请返回后重新生成。" }, { status: 400 });
    if (!isValidReviewConfirmations(body.confirmations)) return Response.json({ error: "请至少完成一个有效选择后再重新整理。" }, { status: 400 });
    if (!validFacts(body.facts)) return Response.json({ error: "结构化事实不完整，请返回后重新生成。" }, { status: 400 });
    const templateName = typeof body.template_name === "string" ? body.template_name.slice(0, 120) : "肿瘤入院病史候选模板";
    const privacyText = JSON.stringify({ draft: body.draft, confirmations: body.confirmations });
    if (privacyText.length > 30000) return Response.json({ error: "本次选择和草稿内容过长，请精简后重试。" }, { status: 400 });
    if (containsSensitiveIdentifier(privacyText)) return Response.json({ error: "检测到疑似身份证号或手机号，请脱敏后再提交。" }, { status: 400 });

    const apiKey = process.env.ARK_CODING_API_KEY;
    if (!apiKey) return Response.json({ error: "模型服务尚未配置，请稍后再试。" }, { status: 503 });
    const model = process.env.ARK_CODING_MODEL || "deepseek-v4-flash";
    const baseUrl = (process.env.ARK_CODING_BASE_URL || "https://ark.cn-beijing.volces.com/api/coding/v3").replace(/\/$/, "");
    const prompt = [
      "你是入院记录草稿重新合成器。只根据当前草稿和医生刚刚明确选择/填写的确认项重新组织文字。",
      "确认项是医生核对后的新事实，可以写入其指定section；没有选择的候选项仍不是事实，不得补写。自由填空detail优先于候选句中的方括号占位。",
      "每个choice_id的当前确认项都是该问题唯一有效的新版本；如果当前草稿含同一问题的旧选项措辞、旧细节或冲突内容，必须先删除，再按当前确认项重写。",
      "合并重复句，保持现病史时间线清楚；阳性或阴性症状只按确认项写。主诉只有在确认项明确属于本次主要就诊原因时才调整，不把偶然阳性症状自动升为主诉。",
      "不得把淋巴结肿大等症状或查体直接写成转移、分期或诊断。不得新增检查、治疗、药物、剂量、处置和未来计划。保留原有不确定词。",
      "diagnosis_summary和plan_summary必须原样返回，不能依据本次选择改写。未完成的方括号骨架可以继续保留，供医生后续选择。",
      "只输出一个JSON对象，不要Markdown或解释，结构必须为：",
      JSON.stringify(outputShape),
      `模板：${templateName}`,
      `当前草稿：${JSON.stringify(body.draft)}`,
      `医生确认项：${JSON.stringify(body.confirmations)}`,
    ].join("\n\n");
    const candidate = parseModelJson(await requestModel(baseUrl, apiKey, model, prompt));
    if (!isValidAdmissionDraft(candidate)) throw new Error("重新合成结构不完整");
    const recomposed: AdmissionDraft = {
      ...candidate,
      diagnosis_summary: body.draft.diagnosis_summary,
      plan_summary: body.draft.plan_summary,
      pending_fields: body.draft.pending_fields,
    };
    return Response.json({ model, result: recomposed }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error && error.name === "TimeoutError"
      ? "重新整理超时，请稍后重试。"
      : "AI暂时没有完成重新整理，请重试一次。";
    return Response.json({ error: message }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
