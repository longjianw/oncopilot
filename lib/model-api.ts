type ModelResponse = {
  output_text?: string;
  output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
};

export const containsSensitiveIdentifier = (text: string) =>
  /(?:^|\D)\d{17}[\dXx](?:\D|$)/.test(text) || /(?:^|\D)1[3-9]\d{9}(?:\D|$)/.test(text);

export const extractModelText = (response: ModelResponse) => {
  if (typeof response.output_text === "string") return response.output_text.trim();
  for (const item of response.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && typeof content.text === "string") return content.text.trim();
    }
  }
  return "";
};

export const parseModelJson = (text: string) => {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(cleaned) as unknown; } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1)) as unknown;
    throw new Error("模型没有返回可解析的JSON");
  }
};

export async function requestModel(baseUrl: string, apiKey: string, model: string, prompt: string) {
  const upstream = await fetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: prompt }),
    signal: AbortSignal.timeout(75000),
  });
  const raw = await upstream.text();
  if (!upstream.ok) throw new Error(`上游模型请求失败：${upstream.status}`);
  const text = extractModelText(JSON.parse(raw) as ModelResponse);
  if (!text) throw new Error("模型没有返回可用内容");
  return text;
}
