import { containsSensitiveIdentifier, requestModel } from "../../../lib/model-api";

type ChatMessage = { role: "user" | "assistant"; content: string };

const validHistory = (value: unknown): value is ChatMessage[] => Array.isArray(value)
  && value.length <= 8
  && value.every((item) => item && typeof item === "object"
    && ((item as ChatMessage).role === "user" || (item as ChatMessage).role === "assistant")
    && typeof (item as ChatMessage).content === "string"
    && (item as ChatMessage).content.trim().length > 0
    && (item as ChatMessage).content.length <= 1200);

export async function POST(request: Request) {
  try {
    const body = await request.json() as { message?: unknown; history?: unknown; template_name?: unknown; item_context?: unknown };
    const message = typeof body.message === "string" ? body.message.trim() : "";
    const history = validHistory(body.history) ? body.history.slice(-6) : [];
    const templateName = typeof body.template_name === "string" ? body.template_name.slice(0, 120) : "肿瘤入院病史模板";
    const itemContext = typeof body.item_context === "string" ? body.item_context.slice(0, 600) : "未指定具体核对项";
    if (!message || message.length > 1200) return Response.json({ error: "请输入一个简短的文书核对问题。" }, { status: 400 });
    const privacyText = JSON.stringify({ message, history });
    if (containsSensitiveIdentifier(privacyText)) return Response.json({ error: "检测到疑似身份证号或手机号，请脱敏后再提问。" }, { status: 400 });

    const apiKey = process.env.ARK_CODING_API_KEY;
    if (!apiKey) return Response.json({ error: "模型服务尚未配置，请稍后再试。" }, { status: 503 });
    const model = process.env.ARK_CODING_MODEL || "deepseek-v4-flash";
    const baseUrl = (process.env.ARK_CODING_BASE_URL || "https://ark.cn-beijing.volces.com/api/coding/v3").replace(/\/$/, "");
    const prompt = [
      "你是OncoPilot中的肿瘤入院文书核对助手。你的任务是解释某个候选项应询问或查体哪些细节、怎样记录更清楚，并帮助医生学习模板。",
      "不能替患者回答有或无；不能根据一个症状推断诊断、转移或分期；不能推荐检查、药物、剂量、治疗、处置或去向。若问题涉及这些内容，简短说明边界，并把回答收敛到病史/查体记录字段。",
      "回答用简明中文。优先给3至6个可直接核对的字段；必要时给一句不带患者事实的文书句式示例。不要声称本院必须如此记录。",
      `当前模板：${templateName}`,
      `当前核对项：${itemContext}`,
      `最近对话：${JSON.stringify(history)}`,
      `医生问题：${message}`,
    ].join("\n\n");
    const answer = (await requestModel(baseUrl, apiKey, model, prompt)).slice(0, 3000);
    return Response.json({ model, answer }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error && error.name === "TimeoutError"
      ? "AI解释超时，请稍后重试。"
      : "AI暂时没有完成解释，请重试一次。";
    return Response.json({ error: message }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
