type VisionResponse = {
  choices?: Array<{ message?: { content?: string } }>;
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
    if (image.size > 8_000_000) return Response.json({ error: "单张图片请控制在 8MB 以内。" }, { status: 400 });

    const apiKey = process.env.ARK_VISION_API_KEY;
    if (!apiKey) return Response.json({ error: "图片识别服务尚未配置。请先配置视觉模型密钥。" }, { status: 503 });

    const model = process.env.ARK_VISION_MODEL || "doubao-1.5-vision-pro-32k";
    const baseUrl = (process.env.ARK_VISION_BASE_URL || "https://ark.cn-beijing.volces.com/api/v3").replace(/\/$/, "");
    const bytes = new Uint8Array(await image.arrayBuffer());
    const dataUrl = `data:${image.type};base64,${toBase64(bytes)}`;
    const prompt = [
      "你是病历资料转录助手。请逐行转录图片中能看清的文字、数值、日期、单位和表格字段。",
      "不要诊断、解释、补全、推测或改写；看不清的内容明确标记为[识别不清]。",
      "输出纯文本，尽量保留报告原有层级。图片可能来自完全合成或严格脱敏资料。",
    ].join("\n");

    const upstream = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [{ role: "user", content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: dataUrl } },
        ] }],
      }),
      signal: AbortSignal.timeout(75000),
    });

    if (!upstream.ok) throw new Error(`视觉模型请求失败：${upstream.status}`);
    const data = await upstream.json() as VisionResponse;
    const extractedText = data.choices?.[0]?.message?.content?.trim();
    if (!extractedText) throw new Error("视觉模型没有返回可用文字");

    return Response.json({ extracted_text: extractedText }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error && error.name === "TimeoutError"
      ? "图片识别超时，请拍得更清楚或缩小图片后重试。"
      : "图片暂时没有识别出来，请重试一次。";
    return Response.json({ error: message }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
