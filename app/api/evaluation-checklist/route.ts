import { containsSensitiveIdentifier, parseModelJson, requestModel } from "../../../lib/model-api";

const boundedText = (value: unknown, maximum: number) => typeof value === "string" ? value.trim().slice(0, maximum) : "";
const stringList = (value: unknown, maximumItems: number, maximumLength: number) => Array.isArray(value)
  ? value.map((item) => boundedText(item, maximumLength)).filter(Boolean).slice(0, maximumItems)
  : [];

export async function POST(request: Request) {
  try {
    const body = await request.json() as { evaluation_input?: unknown; track?: unknown };
    const evaluationInput = boundedText(body.evaluation_input, 100000);
    if (evaluationInput.length < 20) return Response.json({ error: "请先提供本轮资料。" }, { status: 400 });
    if (containsSensitiveIdentifier(evaluationInput)) return Response.json({ error: "检测到疑似身份证号或手机号，请先处理身份字段。" }, { status: 400 });

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return Response.json({ error: "核对清单模型尚未配置。" }, { status: 503 });
    const baseUrl = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
    const model = process.env.OPENAI_CHECKLIST_MODEL || "gpt-5.4";
    const track = body.track === "end_to_end" ? "原始资料转录" : "已确认临床事件账本";
    const prompt = [
      "你为中文肿瘤入院记录A/B测评起草人工核对清单。它只是草稿，医生会逐条确认；不要生成完整病历，也不要给患者个体诊疗决定。",
      `本轮输入类型：${track}。`,
      "从输入中列出6至15条必须保留的事实。每条只写时间、事件、原始证据强度和本次/既往归属，不补充资料没有的诊断、分期、原发部位、转移、疗效、阴性史或治疗方案。",
      "再列出2至8条本轮明确禁止新增或升级的内容，并用一句话写本次核心问题。资料不支持时直接写待核对。",
      "只返回JSON：{\"required_facts\":[\"\"],\"forbidden_claims\":[\"\"],\"core_question\":\"\"}",
      `本轮资料：\n${evaluationInput}`,
    ].join("\n\n");
    const raw = await requestModel(baseUrl, apiKey, model, prompt, { maxOutputTokens: 3000, timeoutMs: 120000, reasoningEffort: "high", store: false, jsonObject: true });
    const parsed = parseModelJson(raw) as Record<string, unknown>;
    const requiredFacts = stringList(parsed.required_facts, 15, 260);
    const forbiddenClaims = stringList(parsed.forbidden_claims, 8, 220);
    const coreQuestion = boundedText(parsed.core_question, 320);
    if (requiredFacts.length < 3 || !coreQuestion) throw new Error("模型没有完成核对清单");
    const summary = [
      "必须覆盖：",
      ...requiredFacts.map((item, index) => `${index + 1}. ${item}`),
      "",
      "不得新增或升级：",
      ...(forbiddenClaims.length ? forbiddenClaims.map((item, index) => `${index + 1}. ${item}`) : ["1. 由医生结合原始资料补充"]),
      "",
      `本次核心问题：${coreQuestion}`,
    ].join("\n");
    return Response.json({ result: { summary, requiredFacts, forbiddenClaims, coreQuestion }, model }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const timeout = error instanceof Error && error.name === "TimeoutError";
    const message = error instanceof Error ? error.message : "核对清单暂时没有生成。";
    return Response.json({ error: timeout ? "核对清单在2分钟内没有完成，请保留资料后重试。" : message.includes("上游") ? "核对清单模型暂时不可用。" : message }, { status: timeout ? 504 : 502, headers: { "Cache-Control": "no-store" } });
  }
}
