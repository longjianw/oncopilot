import { yiyangRecordRules } from "../../../lib/yiyang-record-rules";

type ArkResponse = {
  output_text?: string;
  output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
};

type AnalysisResult = {
  chief_complaint: string;
  present_illness: string;
  pending_fields: string[];
  sources: Array<{ source_id: string; title: string; evidence: string }>;
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

const isValidResult = (value: unknown): value is AnalysisResult => {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<AnalysisResult>;
  return typeof result.chief_complaint === "string"
    && result.chief_complaint.trim().length >= 4
    && result.chief_complaint.trim().length <= 80
    && typeof result.present_illness === "string"
    && result.present_illness.trim().length > 20
    && Array.isArray(result.pending_fields)
    && result.pending_fields.length <= 3
    && result.pending_fields.every((item) => typeof item === "string" && item.length > 3 && item.length <= 80)
    && Array.isArray(result.sources)
    && result.sources.length > 0
    && result.sources.every((item) => item && typeof item.source_id === "string" && typeof item.title === "string" && typeof item.evidence === "string");
};

export async function POST(request: Request) {
  try {
    const body = await request.json() as { source_text?: unknown };
    const sourceText = typeof body.source_text === "string" ? body.source_text.trim() : "";
    if (sourceText.length < 20) return Response.json({ error: "请先粘贴需要整理的患者资料。" }, { status: 400 });
    if (sourceText.length > 32000) return Response.json({ error: "一次资料过长（超过32000字），请保留与本次病历最相关的页面后重试。" }, { status: 400 });
    if (/(?:^|\D)\d{17}[\dXx](?:\D|$)/.test(sourceText) || /(?:^|\D)1[3-9]\d{9}(?:\D|$)/.test(sourceText)) {
      return Response.json({ error: "检测到疑似身份证号或手机号，请脱敏后再提交。" }, { status: 400 });
    }

    const apiKey = process.env.ARK_CODING_API_KEY;
    if (!apiKey) return Response.json({ error: "模型服务尚未配置，请稍后再试。" }, { status: 503 });
    const model = process.env.ARK_CODING_MODEL || "deepseek-v4-flash";
    const baseUrl = (process.env.ARK_CODING_BASE_URL || "https://ark.cn-beijing.volces.com/api/coding/v3").replace(/\/$/, "");

    const prompt = [
      "你是医疗AI作品中的病历整理器，服务于第一次接管该患者的肿瘤科住院医师或规培医师。患者可以是实体瘤、淋巴瘤或白血病，也可能已在外院确诊、手术、放疗或接受其他治疗。",
      "任务是生成可直接粘贴到入院记录里的‘病历核心草稿’：主诉和现病史。目标是节约病历书写时间，不是让医生重新做一整套入院问诊。不作最终诊断，不提供检查医嘱、穿刺决定、处方、剂量或治疗方案。",
      "以下是经本地模板提炼的病历结构规则，优先用于本次输出：",
      yiyangRecordRules,
      "主诉要简洁、可直接用于入院记录。现病史要尽量完整、连贯且可直接粘贴：优先整合已有外院病理、检查、治疗时间线、疗效或不良反应、本次来院目的和近期已确认情况。",
      "不能为了凑篇幅而编造任何阴性症状、一般情况、既往史、查体、诊断、剂量或疗效。只有确实阻断病历落笔、且无法从资料补出的内容，才输出pending_fields，最多3条；写成简短的‘字段：待核对’，例如‘末次治疗日期及方案：待核对’。不要提问式长清单；若现有资料已足以形成病史，可输出空数组。",
      "只输出一个JSON对象，不要Markdown代码块，不要解释。输出结构必须严格为：",
      JSON.stringify({
        chief_complaint: "可直接用于入院记录的主诉",
        present_illness: "一段较完整的中文现病史初稿，按时间顺序整合已有事实",
        pending_fields: ["仅保留阻断书写的字段：待核对"],
        sources: [{ source_id: "S1", title: "资料名称", evidence: "该资料支持的关键事实" }],
      }),
      "主诉和现病史不得出现姓名、身份证号、手机号、住院号。sources只列输入中明确出现的来源编号。",
      `唯一输入：\n${sourceText}`,
    ].join("\n\n");

    const upstream = await fetch(`${baseUrl}/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: prompt }),
      signal: AbortSignal.timeout(75000),
    });

    const rawText = await upstream.text();
    if (!upstream.ok) throw new Error(`上游模型请求失败：${upstream.status}`);
    const raw = JSON.parse(rawText) as ArkResponse;
    const result = parseJson(extractText(raw));
    if (!isValidResult(result)) throw new Error("模型输出结构不完整");

    return Response.json({ model, result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error && error.name === "TimeoutError"
      ? "模型响应超时，请稍后重试。"
      : "AI暂时没有完成整理，请重试一次。";
    return Response.json({ error: message }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
