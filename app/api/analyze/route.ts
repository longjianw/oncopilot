type ArkResponse = {
  output_text?: string;
  output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
};

type AnalysisResult = {
  present_illness: string;
  sources: Array<{ source_id: string; title: string; evidence: string }>;
  quality_checks: Array<{ level: "missing" | "verify" | "passed"; text: string }>;
  patient_card: {
    label: string;
    diagnosis: string;
    age_band: string;
    risk_label: string;
    today_focus: string;
  };
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
    && Array.isArray(result.quality_checks)
    && result.quality_checks.length > 0
    && result.quality_checks.every((item) => item && ["missing", "verify", "passed"].includes(item.level) && typeof item.text === "string")
    && Boolean(result.patient_card)
    && typeof result.patient_card?.label === "string"
    && typeof result.patient_card?.diagnosis === "string"
    && typeof result.patient_card?.age_band === "string"
    && typeof result.patient_card?.risk_label === "string"
    && typeof result.patient_card?.today_focus === "string";
};

export async function POST(request: Request) {
  try {
    const body = await request.json() as { source_text?: unknown };
    const sourceText = typeof body.source_text === "string" ? body.source_text.trim() : "";
    if (sourceText.length < 20) return Response.json({ error: "请先粘贴完整的合成病例资料。" }, { status: 400 });
    if (sourceText.length > 12000) return Response.json({ error: "演示版一次最多处理12000字。" }, { status: 400 });
    if (/(?:^|\D)\d{17}[\dXx](?:\D|$)/.test(sourceText) || /(?:^|\D)1[3-9]\d{9}(?:\D|$)/.test(sourceText)) {
      return Response.json({ error: "检测到疑似身份证号或手机号，请脱敏后再提交。" }, { status: 400 });
    }

    const apiKey = process.env.ARK_CODING_API_KEY;
    if (!apiKey) return Response.json({ error: "模型服务尚未配置，请稍后再试。" }, { status: 503 });
    const model = process.env.ARK_CODING_MODEL || "deepseek-v4-flash";
    const baseUrl = (process.env.ARK_CODING_BASE_URL || "https://ark.cn-beijing.volces.com/api/coding/v3").replace(/\/$/, "");

    const prompt = [
      "你是医疗AI作品中的病例资料整理器。输入只允许是完全合成或严格脱敏资料。",
      "任务是整理资料，不作最终诊断，不提供具体处方、剂量或可直接执行的治疗决定，不补写输入中没有的事实。",
      "只输出一个JSON对象，不要Markdown代码块，不要解释。",
      "输出结构必须严格为：",
      JSON.stringify({
        present_illness: "一段中文现病史初稿，按时间顺序整合，缺失内容不得猜测",
        sources: [{ source_id: "S1", title: "资料名称", evidence: "该资料支持的关键事实" }],
        quality_checks: [{ level: "missing或verify或passed", text: "简明质控提醒" }],
        patient_card: { label: "合成患者 A01", diagnosis: "资料中已有诊断或待核实", age_band: "年龄段或待核实", risk_label: "待核实", today_focus: "仅描述下一步需核实的信息，不给治疗方案" },
      }),
      "现病史不得出现姓名、身份证号、手机号、住院号。sources只列输入中明确出现的来源编号。quality_checks输出2至5条。",
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
