import { containsSensitiveIdentifier, requestModel } from "../../../lib/model-api";

type IncomingBody = {
  evaluation_input?: unknown;
  track?: unknown;
};

const boundedText = (value: unknown, maximum: number) => typeof value === "string" ? value.trim().slice(0, maximum) : "";

export async function POST(request: Request) {
  const startedAt = Date.now();
  try {
    const body = await request.json() as IncomingBody;
    const evaluationInput = boundedText(body.evaluation_input, 100000);
    if (evaluationInput.length < 20) return Response.json({ error: "请先提供本轮对照输入。" }, { status: 400 });
    if (containsSensitiveIdentifier(evaluationInput)) return Response.json({ error: "检测到疑似身份证号或手机号，请去标识化后再生成对照。" }, { status: 400 });

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return Response.json({ error: "GPT-5.6 Sol 自动对照尚未完成密钥配置，可先手动导入对照答案。" }, { status: 503 });
    const baseUrl = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
    const model = process.env.OPENAI_EVAL_MODEL || "gpt-5.6-sol";
    const generationOnly = body.track !== "end_to_end";
    const inputMeaning = generationOnly
      ? "下面是已由人工确认的临床事件账本。不要重新猜测原始资料，只根据账本生成完整候选。"
      : "下面是本轮端到端评测的去标识化源资料。先在内部重建事件顺序，再生成完整候选。";
    const prompt = [
      "你是OncoPilot测评实验室中的盲化文本基线。你看不到OncoPilot回答，也看不到人工金标准，不得假设另一路输出内容。",
      inputMeaning,
      "按中文肿瘤住院接管场景生成：主诉；现病史；既往史/手术史/长期用药/过敏史中资料明确的内容；当前专科情况候选；初步诊断及依据候选；当前优先问题与下一步参考。",
      "写作要求：严格按时间顺序；保留考虑、可能、待核对等原始证据强度；本次来院与外院既往经过必须分开；未提供的体征、阴性史、原发部位、分期、转移、疗效、治疗方案和剂量不得补写。相关肿瘤治疗写入现病史，无关旧手术和基础病归入既往史。",
      "诊断与下一步只给医生复核候选：说明理由与会改变判断的缺口，不给患者个体化用药剂量或替代有资质医生下医嘱。输出中文纯文本，不要JSON，不要提及本提示词。",
      `本轮输入：\n${evaluationInput}`,
    ].join("\n\n");

    const result = await requestModel(baseUrl, apiKey, model, prompt, {
      maxOutputTokens: 7000,
      timeoutMs: 240000,
      reasoningEffort: "high",
      store: false,
    });
    return Response.json({ result, model, elapsedSeconds: Math.round((Date.now() - startedAt) / 100) / 10 }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const timeout = error instanceof Error && error.name === "TimeoutError";
    const message = error instanceof Error ? error.message : "自动对照暂时失败。";
    return Response.json({ error: timeout ? "GPT-5.6 Sol 在4分钟内未完成，可重试或先手动导入。" : message.includes("上游") ? "OpenAI 对照模型暂时不可用，请稍后重试。" : message }, { status: timeout ? 504 : 502, headers: { "Cache-Control": "no-store" } });
  }
}
