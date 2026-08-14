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

type ModelRequestOptions = {
  maxOutputTokens?: number;
  timeoutMs?: number;
  thinking?: "enabled" | "disabled" | "auto";
  reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh" | "max";
  store?: boolean;
  jsonObject?: boolean;
};

const requestBody = (model: string, prompt: string, options: ModelRequestOptions, stream = false) => ({
  model,
  input: prompt,
  ...(stream ? { stream: true } : {}),
  ...(options.thinking ? { thinking: { type: options.thinking } } : {}),
  ...(options.reasoningEffort ? { reasoning: { effort: options.reasoningEffort } } : {}),
  ...(typeof options.store === "boolean" ? { store: options.store } : {}),
  ...(options.jsonObject ? { text: { format: { type: "json_object" } } } : {}),
  ...(options.maxOutputTokens ? { max_output_tokens: options.maxOutputTokens } : {}),
});

const streamDelta = (payload: unknown) => {
  if (!payload || typeof payload !== "object") return "";
  const event = payload as { type?: unknown; delta?: unknown; choices?: Array<{ delta?: { content?: unknown } }> };
  if (event.type === "response.output_text.delta" && typeof event.delta === "string") return event.delta;
  const choiceDelta = event.choices?.[0]?.delta?.content;
  return typeof choiceDelta === "string" ? choiceDelta : "";
};

export async function* requestModelStream(baseUrl: string, apiKey: string, model: string, prompt: string, options: ModelRequestOptions = {}) {
  const upstream = await fetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(requestBody(model, prompt, options, true)),
    signal: AbortSignal.timeout(options.timeoutMs || 75000),
  });
  if (!upstream.ok) throw new Error(`上游模型请求失败：${upstream.status}`);
  if (!upstream.body) throw new Error("模型没有返回可用内容");

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let yielded = false;
  const consumeBlock = (block: string) => {
    const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
    if (!data || data === "[DONE]") return "";
    try { return streamDelta(JSON.parse(data)); } catch { return ""; }
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let boundary = buffer.search(/\r?\n\r?\n/);
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      const separator = buffer.slice(boundary).match(/^\r?\n\r?\n/)?.[0] || "\n\n";
      buffer = buffer.slice(boundary + separator.length);
      const delta = consumeBlock(block);
      if (delta) { yielded = true; yield delta; }
      boundary = buffer.search(/\r?\n\r?\n/);
    }
    if (done) break;
  }

  if (!yielded && buffer.trim()) {
    try {
      const text = extractModelText(JSON.parse(buffer) as ModelResponse);
      if (text) { yielded = true; yield text; }
    } catch {
      const delta = consumeBlock(buffer);
      if (delta) { yielded = true; yield delta; }
    }
  }
  if (!yielded) throw new Error("模型没有返回可用内容");
}

export async function requestModel(baseUrl: string, apiKey: string, model: string, prompt: string, options: ModelRequestOptions = {}) {
  const upstream = await fetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(requestBody(model, prompt, options)),
    signal: AbortSignal.timeout(options.timeoutMs || 75000),
  });
  const raw = await upstream.text();
  if (!upstream.ok) throw new Error(`上游模型请求失败：${upstream.status}`);
  const text = extractModelText(JSON.parse(raw) as ModelResponse);
  if (!text) throw new Error("模型没有返回可用内容");
  return text;
}
