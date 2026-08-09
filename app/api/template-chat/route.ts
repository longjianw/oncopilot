import { containsSensitiveIdentifier, requestModelStream } from "../../../lib/model-api";

type ChatMessage = { role: "user" | "assistant"; content: string };
const chatModels = ["deepseek-v4-flash", "deepseek-v4-pro"] as const;
type ChatModel = typeof chatModels[number];

const cleanChatAnswer = (value: string) => {
  const cleaned = value
    .replace(/```[\s\S]*?```/g, "")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/^\s*[-_=]{3,}\s*$/gm, "")
    .replace(/(?<!\*)\*(?!\*)/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (cleaned.length <= 420) return cleaned;
  const clipped = cleaned.slice(0, 420);
  const sentenceEnd = Math.max(clipped.lastIndexOf("。"), clipped.lastIndexOf("；"), clipped.lastIndexOf("\n"));
  const compact = (sentenceEnd > 260 ? clipped.slice(0, sentenceEnd + 1) : clipped).trim() + "…";
  return (compact.match(/\*\*/g)?.length || 0) % 2 === 0 ? compact : compact.replace(/\*\*/g, "");
};

const validHistory = (value: unknown): value is ChatMessage[] => Array.isArray(value)
  && value.length <= 8
  && value.every((item) => item && typeof item === "object"
    && ((item as ChatMessage).role === "user" || (item as ChatMessage).role === "assistant")
    && typeof (item as ChatMessage).content === "string"
    && (item as ChatMessage).content.trim().length > 0
    && (item as ChatMessage).content.length <= 1200);

export async function POST(request: Request) {
  try {
    const body = await request.json() as { message?: unknown; history?: unknown; template_name?: unknown; item_context?: unknown; model?: unknown };
    const message = typeof body.message === "string" ? body.message.trim() : "";
    const history = validHistory(body.history) ? body.history.slice(-6) : [];
    const templateName = typeof body.template_name === "string" ? body.template_name.slice(0, 120) : "肿瘤入院病史模板";
    const itemContext = typeof body.item_context === "string" ? body.item_context.slice(0, 600) : "未指定具体核对项";
    const requestedModel = typeof body.model === "string" ? body.model : "deepseek-v4-flash";
    if (!message || message.length > 1200) return Response.json({ error: "请输入一个简短的文书核对问题。" }, { status: 400 });
    if (!chatModels.includes(requestedModel as ChatModel)) return Response.json({ error: "不支持的模型，请选择快速或深入模式。" }, { status: 400 });
    const privacyText = JSON.stringify({ message, history });
    if (containsSensitiveIdentifier(privacyText)) return Response.json({ error: "检测到疑似身份证号或手机号，请脱敏后再提问。" }, { status: 400 });

    const apiKey = process.env.ARK_CODING_API_KEY;
    if (!apiKey) return Response.json({ error: "模型服务尚未配置，请稍后再试。" }, { status: 503 });
    const model = requestedModel as ChatModel;
    const baseUrl = (process.env.ARK_CODING_BASE_URL || "https://ark.cn-beijing.volces.com/api/coding/v3").replace(/\/$/, "");
    const prompt = [
      "你是OncoPilot中的肿瘤入院文书核对助手。你的任务是解释某个候选项应询问或查体哪些细节、怎样记录更清楚，并帮助医生学习模板。",
      "不能替患者回答有或无；不能根据一个症状推断诊断、转移或分期；不能推荐检查、药物、剂量、治疗、处置或去向。若问题涉及这些内容，简短说明边界，并把回答收敛到病史/查体记录字段。",
      "回答不超过180个汉字。严格使用这一格式：一句怎么问；随后3至5行“**字段**：核对内容”；最多一句文书句式。不要寒暄、背景解释、注意事项或分隔线。",
      "只允许用**重点词**做少量加粗，不要使用其他Markdown符号，也不要输出裸露的星号。不要声称本院必须如此记录。",
      `当前模板：${templateName}`,
      `当前核对项：${itemContext}`,
      `最近对话：${JSON.stringify(history)}`,
      `医生问题：${message}`,
    ].join("\n\n");
    const encoder = new TextEncoder();
    const event = (name: string, payload: unknown) => encoder.encode(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`);
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let answer = "";
        controller.enqueue(event("meta", { model }));
        try {
          for await (const delta of requestModelStream(baseUrl, apiKey, model, prompt, { maxOutputTokens: model === "deepseek-v4-flash" ? 640 : 1000, timeoutMs: 60000 })) {
            answer += delta;
            controller.enqueue(event("delta", { answer: cleanChatAnswer(answer) }));
          }
          controller.enqueue(event("done", { model, answer: cleanChatAnswer(answer) }));
        } catch (error) {
          const message = error instanceof Error && error.name === "TimeoutError" ? "AI解释超时，请稍后重试。" : "AI暂时没有完成解释，请重试一次。";
          controller.enqueue(event("error", { error: message }));
        } finally { controller.close(); }
      },
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no" } });
  } catch (error) {
    const message = error instanceof Error && error.name === "TimeoutError"
      ? "AI解释超时，请稍后重试。"
      : "AI暂时没有完成解释，请重试一次。";
    return Response.json({ error: message }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
