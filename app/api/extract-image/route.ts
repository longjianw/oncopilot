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
    const model = process.env.ARK_VISION_MODEL || "doubao-seed-2.0-code";
    const baseUrl = (process.env.ARK_VISION_BASE_URL || process.env.ARK_CODING_BASE_URL || "https://ark.cn-beijing.volces.com/api/coding/v3").replace(/\/$/, "");
    const bytes = new Uint8Array(await image.arrayBuffer());
    const dataUrl = `data:${image.type};base64,${toBase64(bytes)}`;
    const prompt = [
      "你是病历资料转录助手。请逐行转录图片中能看清的文字、数值、日期、单位和表格字段。",
      "不要诊断、解释、补全、推测或改写；看不清的内容明确标记为[识别不清]。",
      "输出纯文本，尽量保留报告原有层级。图片可能来自完全合成或严格脱敏资料。",
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
        };

    const upstream = await fetch(`${baseUrl}/${hasSeparateVisionService ? "chat/completions" : "responses"}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(110000),
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
      ? "视觉模型超过110秒仍未完成，请重试本页；字迹模糊、旋转或并发繁忙都可能导致变慢。"
      : error instanceof Error && /413|Payload Too Large/.test(error.message)
        ? "图片仍然过大，请裁剪到单页后重试。"
        : "图片暂时没有识别出来，请重试一次。";
    return Response.json({ error: message }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
