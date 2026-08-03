import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateCandidate } from "./scoring.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const apiKey = process.env.ARK_CODING_API_KEY;
const baseUrl = (process.env.ARK_CODING_BASE_URL ?? "https://ark.cn-beijing.volces.com/api/coding/v3").replace(/\/$/, "");
if (!apiKey) throw new Error("缺少 ARK_CODING_API_KEY。请通过本机秘密环境变量配置，不要写入文件或聊天。");
if (!baseUrl.endsWith("/api/coding/v3") && process.env.ALLOW_NON_CODING_ARK_BASE_URL !== "1") throw new Error("为避免套餐外费用，默认只允许 Coding Plan 专用 /api/coding/v3 地址。");

const [input, schema, contract, gold, matrix] = await Promise.all([
  readFile(path.join(here, "input.json"), "utf8").then(JSON.parse),
  readFile(path.join(here, "candidate_schema.json"), "utf8").then(JSON.parse),
  readFile(path.join(here, "MODEL_CONTRACT.md"), "utf8"),
  readFile(path.join(here, "gold_standard.json"), "utf8").then(JSON.parse),
  readFile(path.join(here, "ark_model_matrix.json"), "utf8").then(JSON.parse)
]);

const requested = process.argv.slice(2);
const models = requested.length ? requested : matrix.models.filter((item) => item.enabled).map((item) => item.model);
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const runDir = path.join(here, "runs", runId);
await mkdir(runDir, { recursive: true });

const prompt = [
  "你是医疗AI结构化抽取评测中的候选模型。只处理完全合成数据。",
  contract,
  "必须只输出一个JSON对象，不要Markdown代码块，不要解释。",
  "ID约定：当前事实F-A01-{CODE}-CURRENT；下降变化C-A01-{CODE}-DOWN；缺失项只能使用M-A01-VITALS、M-A01-SYMPTOMS、M-A01-CURRENT-PLAN；任务只能使用T-A01-BEDSIDE、T-A01-SOURCE、T-A01-ESCALATE。",
  `输出JSON Schema：${JSON.stringify(schema)}`,
  `唯一输入：${JSON.stringify(input)}`
].join("\n\n");

const extractText = (response) => {
  if (typeof response.output_text === "string") return response.output_text;
  for (const item of response.output ?? []) for (const content of item.content ?? []) if (content.type === "output_text" && typeof content.text === "string") return content.text;
  return "";
};

const parseCandidate = (text) => {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(trimmed); } catch {
    const start = trimmed.indexOf("{"); const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error("模型响应中未找到可解析JSON");
  }
};

const results = [];
for (const model of models) {
  const startedAt = Date.now();
  const record = { model, provider: "volcengine_ark_coding_plan", base_url: baseUrl, started_at: new Date(startedAt).toISOString() };
  try {
    const response = await fetch(`${baseUrl}/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: prompt }),
      signal: AbortSignal.timeout(120000)
    });
    const rawText = await response.text();
    record.http_status = response.status;
    record.latency_ms = Date.now() - startedAt;
    await writeFile(path.join(runDir, `${model}.raw.json`), rawText);
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${rawText.slice(0, 300)}`);
    const raw = JSON.parse(rawText);
    const candidate = parseCandidate(extractText(raw));
    candidate.case_id = "A01";
    candidate.candidate_id = `ark-${model}-${runId}`;
    candidate.candidate_type = "volcengine_ark_coding_plan_model";
    candidate.is_real_model_output = true;
    await writeFile(path.join(runDir, `${model}.candidate.json`), JSON.stringify(candidate, null, 2));
    record.json_parse_success = true;
    record.evaluation = evaluateCandidate(gold, candidate);
  } catch (error) {
    record.latency_ms ??= Date.now() - startedAt;
    record.json_parse_success = false;
    record.error = error instanceof Error ? error.message : String(error);
  }
  results.push(record);
}

const summary = {
  run_id: runId,
  data_policy: "synthetic_only",
  model_count: models.length,
  results: results.sort((a, b) => (b.evaluation?.score_percent ?? -1) - (a.evaluation?.score_percent ?? -1))
};
await writeFile(path.join(runDir, "summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
