type ArkResponse = {
  output_text?: string;
  output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
};

type AnalysisResult = {
  present_illness: string;
  follow_up_questions: Array<{
    question: string;
    reason: string;
    priority: "high" | "medium";
  }>;
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
  return typeof result.present_illness === "string"
    && result.present_illness.trim().length > 20
    && Array.isArray(result.sources)
    && result.sources.length > 0
    && result.sources.every((item) => item && typeof item.source_id === "string" && typeof item.title === "string" && typeof item.evidence === "string")
    && Array.isArray(result.follow_up_questions)
    && result.follow_up_questions.length >= 2
    && result.follow_up_questions.length <= 8
    && result.follow_up_questions.every((item) => item
      && typeof item.question === "string"
      && typeof item.reason === "string"
      && ["high", "medium"].includes(item.priority));
};

export async function POST(request: Request) {
  try {
    const body = await request.json() as { source_text?: unknown };
    const sourceText = typeof body.source_text === "string" ? body.source_text.trim() : "";
    if (sourceText.length < 20) return Response.json({ error: "请先粘贴需要整理的患者资料。" }, { status: 400 });
    if (sourceText.length > 12000) return Response.json({ error: "演示版一次最多处理12000字。" }, { status: 400 });
    if (/(?:^|\D)\d{17}[\dXx](?:\D|$)/.test(sourceText) || /(?:^|\D)1[3-9]\d{9}(?:\D|$)/.test(sourceText)) {
      return Response.json({ error: "检测到疑似身份证号或手机号，请脱敏后再提交。" }, { status: 400 });
    }

    const apiKey = process.env.ARK_CODING_API_KEY;
    if (!apiKey) return Response.json({ error: "模型服务尚未配置，请稍后再试。" }, { status: 503 });
    const model = process.env.ARK_CODING_MODEL || "deepseek-v4-flash";
    const baseUrl = (process.env.ARK_CODING_BASE_URL || "https://ark.cn-beijing.volces.com/api/coding/v3").replace(/\/$/, "");

    const prompt = [
      "你是医疗AI作品中的病史整理器，服务于第一次接管该患者的肿瘤科住院医师或规培医师。患者可以是实体瘤、淋巴瘤或白血病，也可能已在外院确诊、手术、放疗或接受其他治疗。",
      "任务只有两个：整理现病史；列出还需要向患者补问或核对的关键问题。不作最终诊断，不提供检查医嘱、穿刺决定、处方、剂量或治疗方案。",
      "以下是经本地模板提炼的病历结构规则，优先用于本次输出：",
      yiyangRecordRules,
      "现病史只能写输入中已经明确的事实。输入没有明确问过的发热、寒战、恶心、呕吐、腹痛等阴性症状，不得直接写成无；应根据本次就诊目的和已有疾病，把最重要的内容放入follow_up_questions，提醒医生问过后再补写。",
      "只输出一个JSON对象，不要Markdown代码块，不要解释。",
      "输出结构必须严格为：",
      JSON.stringify({
        present_illness: "一段简洁中文现病史初稿，按时间顺序整合已有事实",
        follow_up_questions: [{ question: "需要直接询问患者的一句话", reason: "为什么这次需要问", priority: "high或medium" }],
        sources: [{ source_id: "S1", title: "资料名称", evidence: "该资料支持的关键事实" }],
      }),
      "follow_up_questions输出2至8条，按重要程度排序，使用医生可以直接问患者的简短语言；不要罗列与本病例无关的全套系统回顾。现病史不得出现姓名、身份证号、手机号、住院号。sources只列输入中明确出现的来源编号。",
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
import { yiyangRecordRules } from "../../../lib/yiyang-record-rules";
