type VisionResponse = {
  choices?: Array<{ message?: { content?: string } }>;
  output_text?: string;
  output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
};

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

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const image = formData.get("image");
    if (!(image instanceof File)) return Response.json({ error: "请先选择一张图片。" }, { status: 400 });
    if (!image.type.startsWith("image/")) return Response.json({ error: "只支持图片文件。" }, { status: 400 });
    if (image.size > 2_000_000) return Response.json({ error: "图片过大，请在设备上压缩或裁剪为单页后重试。" }, { status: 400 });

    // 图片可复用 Coding Plan 的服务端密钥；视觉变量仅用于有独立服务时覆盖。
    const apiKey = process.env.ARK_VISION_API_KEY || process.env.ARK_CODING_API_KEY;
    if (!apiKey) return Response.json({ error: "图片识别服务尚未配置。请先配置服务端密钥。" }, { status: 503 });

    const hasSeparateVisionService = Boolean(process.env.ARK_VISION_BASE_URL);
    const model = process.env.ARK_VISION_MODEL || "doubao-seed-2.1-turbo";
    const baseUrl = (process.env.ARK_VISION_BASE_URL || process.env.ARK_CODING_BASE_URL || "https://ark.cn-beijing.volces.com/api/coding/v3").replace(/\/$/, "");
    const bytes = new Uint8Array(await image.arrayBuffer());
    const dataUrl = `data:${image.type};base64,${toBase64(bytes)}`;
    const prompt = [
      "你是肿瘤科入院资料提取助手。只提取会进入入院记录的关键资料，不做逐字全文OCR。",
      "优先保留日期、确诊经过、病理/免疫组化/分子结果、手术和既往治疗、影像与关键检验、医生已写明的诊断/计划、本次症状和来院目的。",
      "保留原文数值、单位、阴阳性和不确定词；不要诊断、解释、补全或推测。只输出提取结果，尽量不超过700字。",
    ].join("\n");

    const requestBody = hasSeparateVisionService
      ? {
          model,
          temperature: 0,
          messages: [{ role: "user", content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: dataUrl } },
          ] }],
        }
      : {
          model,
          input: [{ role: "user", content: [
            { type: "input_text", text: prompt },
            { type: "input_image", image_url: dataUrl },
          ] }],
          thinking: { type: "disabled" },
        };

    const upstream = await fetch(`${baseUrl}/${hasSeparateVisionService ? "chat/completions" : "responses"}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(hasSeparateVisionService ? requestBody : { ...requestBody, max_output_tokens: 900 }),
      signal: AbortSignal.timeout(75000),
    });

    if (!upstream.ok) {
      const detail = await upstream.text();
      throw new Error(`视觉模型请求失败：${upstream.status} ${detail.slice(0, 120)}`);
    }
    const data = await upstream.json() as VisionResponse;
    const extractedText = responseText(data);
    if (!extractedText) throw new Error("视觉模型没有返回可用文字");

    return Response.json({ extracted_text: extractedText, model, method: "vision_transcription" }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error && error.name === "TimeoutError"
      ? "本页超过75秒仍未完成，请稍后只重试本页。"
      : error instanceof Error && /413|Payload Too Large/.test(error.message)
        ? "图片仍然过大，请裁剪到单页后重试。"
        : "图片暂时没有识别出来，请重试一次。";
    return Response.json({ error: message }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
