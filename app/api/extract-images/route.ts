type VisionResponse = {
  choices?: Array<{ message?: { content?: string } }>;
  output_text?: string;
  output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
};

type PageResult = { index: number; text: string };

const responseText = (data: VisionResponse) => {
  if (data.output_text?.trim()) return data.output_text.trim();
  const parts = data.output?.flatMap((item) => item.content || [])
    .filter((item) => item.type === "output_text" && item.text)
    .map((item) => item.text!.trim())
    .filter(Boolean);
  return parts?.join("\n").trim() || data.choices?.[0]?.message?.content?.trim();
};

const toBase64 = (bytes: Uint8Array) => {
  let output = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    output += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(output);
};

const parsePages = (text: string, expected: number): PageResult[] => {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let parsed: unknown;
  try { parsed = JSON.parse(cleaned); } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("视觉模型未返回分页JSON");
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  }
  const pages = (parsed as { pages?: unknown })?.pages;
  if (!Array.isArray(pages)) throw new Error("视觉模型未返回分页结果");
  const normalized = pages.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const index = Number((item as { index?: unknown }).index);
    const value = (item as { text?: unknown }).text;
    return Number.isInteger(index) && index >= 1 && index <= expected && typeof value === "string" && value.trim()
      ? [{ index, text: value.trim() }]
      : [];
  });
  if (new Set(normalized.map((item) => item.index)).size !== expected) throw new Error("视觉模型遗漏了部分页");
  return normalized.sort((a, b) => a.index - b.index);
};

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const images = formData.getAll("images");
    if (!images.length || images.length > 4) return Response.json({ error: "每批请选1至4张图片。" }, { status: 400 });
    if (!images.every((image) => image instanceof File && image.type.startsWith("image/") && image.size <= 2_000_000)) {
      return Response.json({ error: "每页必须是小于2MB的图片。" }, { status: 400 });
    }

    const apiKey = process.env.ARK_VISION_API_KEY || process.env.ARK_CODING_API_KEY;
    if (!apiKey) return Response.json({ error: "图片识别服务尚未配置。请先配置服务端密钥。" }, { status: 503 });

    const hasSeparateVisionService = Boolean(process.env.ARK_VISION_BASE_URL);
    const model = process.env.ARK_VISION_MODEL || "doubao-seed-2.0-code";
    const baseUrl = (process.env.ARK_VISION_BASE_URL || process.env.ARK_CODING_BASE_URL || "https://ark.cn-beijing.volces.com/api/coding/v3").replace(/\/$/, "");
    const dataUrls = await Promise.all((images as File[]).map(async (image) => {
      const bytes = new Uint8Array(await image.arrayBuffer());
      return `data:${image.type};base64,${toBase64(bytes)}`;
    }));
    const prompt = [
      `下面共有${images.length}张病历资料页。请分页提取用于肿瘤科入院记录的关键资料，不做逐字全文OCR。`,
      "优先保留：日期和时间、首发/确诊经过、病理与免疫组化/分子结果、手术与既往抗肿瘤治疗、影像与关键检验、医生已写明的诊断/计划、本次症状和来院目的。",
      "数值、单位、阴阳性和不确定词必须忠实保留。不要诊断、解释、补全或推测；看不清的关键字段标记为[识别不清]。",
      "只输出JSON，不要Markdown。格式为：{\"pages\":[{\"index\":1,\"text\":\"第1张的关键资料，尽量不超过1200字\"}]}。pages必须按输入顺序包含全部页面。",
    ].join("\n");
    const responseContent = [
      hasSeparateVisionService ? { type: "text", text: prompt } : { type: "input_text", text: prompt },
      ...dataUrls.map((imageUrl) => hasSeparateVisionService
        ? { type: "image_url", image_url: { url: imageUrl } }
        : { type: "input_image", image_url: imageUrl }),
    ];
    const requestBody = hasSeparateVisionService
      ? { model, temperature: 0, messages: [{ role: "user", content: responseContent }] }
      : { model, input: [{ role: "user", content: responseContent }], max_output_tokens: 3200 };

    const upstream = await fetch(`${baseUrl}/${hasSeparateVisionService ? "chat/completions" : "responses"}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(75000),
    });
    if (!upstream.ok) throw new Error(`视觉模型请求失败：${upstream.status}`);
    const data = await upstream.json() as VisionResponse;
    const text = responseText(data);
    if (!text) throw new Error("视觉模型没有返回可用文字");
    const pages = parsePages(text, images.length);
    return Response.json({ pages, model, method: "batched_vision_transcription" }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
      ? "这一批超过75秒仍未完成，请只重试这一批中的失败页。"
      : "这一批未完整返回，请只重试失败页。";
    return Response.json({ error: message }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
