import assert from "node:assert/strict";
import test from "node:test";

const workerFor = async (suffix) => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("evaluation-lab-test", `${suffix}-${process.pid}-${Date.now()}`);
  return (await import(workerUrl.href)).default;
};

const environment = {
  ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
  ARK_CODING_API_KEY: "synthetic-test-key",
  ARK_CODING_MODEL: "deepseek-v4-pro",
  ARK_REFERENCE_MODEL: "deepseek-v4-pro",
  ARK_CODING_BASE_URL: "https://synthetic.example/v3",
  OPENAI_API_KEY: "synthetic-openai-test-key",
  OPENAI_EVAL_MODEL: "gpt-5.6-sol",
  OPENAI_BASE_URL: "https://openai.synthetic/v1",
};

const context = { waitUntil() {}, passThroughOnException() {} };

test("evaluation lab renders the blinded workflow and same-model boundary", async () => {
  const worker = await workerFor("render");
  const response = await worker.fetch(new Request("http://localhost/evaluation-lab", { headers: { accept: "text/html" } }), environment, context);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /内部测评实验室/);
  assert.match(html, /随机分配并开始盲评/);
  assert.match(html, /同一模型多视角/);
  assert.match(html, /用 GPT-5.6 Sol 自动生成对照/);
  assert.match(html, /市场与用户研究/);
  assert.match(html, /CEO 小龙虾/);
  assert.match(html, /不能称为临床准确率/);
  assert.doesNotMatch(html, /2刘三元|强哥的病人/);
});
test("evaluation board uses five isolated reviews and one executive synthesis without raw outputs", async () => {
  const worker = await workerFor("board");
  const originalFetch = globalThis.fetch;
  const prompts = [];
  let executiveCalls = 0;
  globalThis.fetch = async (_url, init) => {
    const requestBody = JSON.parse(init.body);
    assert.equal(requestBody.model, "deepseek-v4-pro");
    prompts.push(requestBody.input);
    const isExecutive = requestBody.input.includes("内部评审会的CEO");
    const output = isExecutive
      ? ++executiveCalls === 1
        ? { decision: "继续扩大样本。", rationale: ["回答A总分较高", "回答B出现P0硬失败"], disagreements: ["速度优势是否足以抵消修改成本仍未解决"], next_sprint: ["补充三个合成长病程病例", "再考虑修复问题"], stop_conditions: ["再次出现无依据分期即停止扩大试用"] }
        : { decision: "回答B出现P0，停止扩大试用并先修复。", rationale: ["回答A总分较高", "回答B出现P0硬失败"], disagreements: ["速度优势是否足以抵消修改成本仍未解决"], next_sprint: ["先复现并修复P0错误", "修复后补充三个合成长病程病例"], stop_conditions: ["再次出现无依据分期即停止扩大试用"] }
      : { headline: "先解决无依据断言。", evidence: ["回答A得分高于回答B", "回答B有1个P0错误"], recommendation: "下一轮只验证忠实度门禁是否稳定。", concern: "单病例不能代表总体效果。" };
    return new Response(JSON.stringify({ output_text: JSON.stringify(output) }), { status: 200 });
  };

  const perfectScores = Object.fromEntries(["event_coverage", "chronology", "encounter_separation", "unsupported_claims", "uncertainty_preservation", "section_placement", "diagnosis_evidence", "priority_quality", "actionability", "edit_cost"].map((id) => [id, 4]));
  const weakScores = Object.fromEntries(Object.keys(perfectScores).map((id) => [id, 1]));
  try {
    const response = await worker.fetch(new Request("http://localhost/api/evaluation-board", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        case_label: "完全合成试评",
        track: "generation_only",
        arm_a: { scores: perfectScores, p0Count: 0, p1Count: 1, latencySeconds: 80, retryCount: 0, reviewerNote: "时间线完整。", output: "这段完整回答不应发送给公司会议。" },
        arm_b: { scores: weakScores, p0Count: 1, p1Count: 3, latencySeconds: 12, retryCount: 2, reviewerNote: "存在无依据分期。", output: "另一段原始回答也不应发送。" },
      }),
    }), environment, context);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.result.reviews.length, 5);
    assert.equal(payload.result.sameModelReview, true);
    assert.equal(payload.result.model, "deepseek-v4-pro");
    assert.equal(prompts.length, 7);
    assert.equal(prompts.filter((prompt) => prompt.includes("同一高能力模型在隔离上下文")).length, 5);
    assert.ok(prompts.some((prompt) => prompt.includes("市场与用户研究小龙虾")));
    assert.match(prompts.at(-1), /独立角色意见/);
    assert.match(prompts.at(-1), /P0修复之前/);
    assert.ok(prompts.every((prompt) => !prompt.includes("这段完整回答不应发送")));
    assert.ok(prompts.every((prompt) => !prompt.includes("另一段原始回答也不应发送")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GPT-5.6 Sol baseline is blind, high-reasoning, and not stored", async () => {
  const worker = await workerFor("baseline");
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ output_text: "主诉：合成资料生成的盲化对照。" }), { status: 200 });
  };
  try {
    const response = await worker.fetch(new Request("http://localhost/api/evaluation-baseline", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        track: "generation_only",
        evaluation_input: "合成事件账本：2月前发现右肺占位；1月前接受一线全身治疗；1周前复查提示病灶增大。",
        gold_summary: "不得发送的人工金标准",
        oncopilot_output: "不得发送的OncoPilot答案",
      }),
    }), environment, context);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.model, "gpt-5.6-sol");
    assert.equal(captured.url, "https://openai.synthetic/v1/responses");
    assert.equal(captured.body.model, "gpt-5.6-sol");
    assert.equal(captured.body.store, false);
    assert.equal(captured.body.reasoning.effort, "high");
    assert.doesNotMatch(captured.body.input, /不得发送的人工金标准/);
    assert.doesNotMatch(captured.body.input, /不得发送的OncoPilot答案/);
    assert.match(captured.body.input, /2月前发现右肺占位/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("evaluation role retries when A/B score or latency attribution is reversed", async () => {
  const worker = await workerFor("metric-gate");
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    const output = calls === 1
      ? { headline: "A整体更稳。", evidence: ["A方案10秒。", "B方案30秒。"], recommendation: "继续核对。", concern: "样本较少。" }
      : { headline: "A整体更稳。", evidence: ["A方案75分、耗时30秒。", "B方案50分、耗时10秒。"], recommendation: "继续核对。", concern: "样本较少。" };
    return new Response(JSON.stringify({ output_text: JSON.stringify(output) }), { status: 200 });
  };
  const scoresA = Object.fromEntries(["event_coverage", "chronology", "encounter_separation", "unsupported_claims", "uncertainty_preservation", "section_placement", "diagnosis_evidence", "priority_quality", "actionability", "edit_cost"].map((id) => [id, 3]));
  const scoresB = Object.fromEntries(Object.keys(scoresA).map((id) => [id, 2]));
  try {
    const response = await worker.fetch(new Request("http://localhost/api/evaluation-board", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "role", role_id: "user_research", case_label: "合成数字门禁", arm_a: { scores: scoresA, latencySeconds: 30, reviewerNote: "合成A" }, arm_b: { scores: scoresB, latencySeconds: 10, reviewerNote: "合成B" } }),
    }), environment, context);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(calls, 2);
    assert.match(payload.result.review.evidence.join(" "), /A方案75分、耗时30秒/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
