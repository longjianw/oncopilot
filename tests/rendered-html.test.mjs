import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

async function extractWithoutVisionService() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("image-test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const formData = new FormData();
  formData.append("image", new File(["synthetic image"], "synthetic.jpg", { type: "image/jpeg" }));
  return worker.fetch(
    new Request("http://localhost/api/extract-image", { method: "POST", body: formData }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

async function analyzeWithMockModel() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("analyze-test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const responses = [
    {
      current_purpose: "进一步抗肿瘤治疗",
      sources: [
        { source_id: "S1", title: "完全合成资料", evidence: "确诊黑色素瘤及免疫组化" },
        { source_id: "S-PURPOSE", title: "本次来院目的", evidence: "进一步抗肿瘤治疗" },
      ],
      facts: [
        { fact_id: "F1", field: "diagnosis", value: "确诊黑色素瘤3天", event_time: "3天前", event_type: "onset_diagnosis", encounter_scope: "prior", certainty: "explicit", source_ids: ["S1"] },
        { fact_id: "F2", field: "pathology", value: "免疫组化已完成，具体结果未提供", event_time: "未提供", event_type: "pathology_molecular", encounter_scope: "prior", certainty: "explicit", source_ids: ["S1"] },
        { fact_id: "F3", field: "current_purpose", value: "进一步抗肿瘤治疗", event_time: "本次", event_type: "current_purpose", encounter_scope: "current", certainty: "explicit", source_ids: ["S-PURPOSE"] },
        { fact_id: "F4", field: "imaging", value: "影像报告提示右侧腋窝淋巴结肿大", event_time: "2天前", event_type: "progression_evidence", encounter_scope: "prior", certainty: "explicit", source_ids: ["S1"] },
      ],
      pending_fields: ["过敏史：待核对"],
    },
    {
      chief_complaint: "确诊黑色素瘤3天，入院进一步抗肿瘤治疗",
      present_illness: "患者3天前确诊黑色素瘤，免疫组化已完成，具体结果未提供。本次为进一步抗肿瘤治疗来院。",
      past_history: "模型不应保留这段无来源既往史",
      personal_history: "无特殊",
      family_history: "否认相关家族史",
      allergy_history: "否认药物过敏",
      specialist_exam: "未见异常",
      diagnosis_summary: "模型自行诊断",
      plan_summary: "模型自行制定计划",
      pending_fields: [],
    },
  ];
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => new Response(JSON.stringify({ output_text: JSON.stringify(responses[calls++]) }), { status: 200 });
  try {
    const response = await worker.fetch(
      new Request("http://localhost/api/analyze", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source_text: "【S1 完全合成资料】患者已确诊黑色素瘤3天，免疫组化已完成，具体结果未提供。", current_purpose: "进一步抗肿瘤治疗" }) }),
      { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) }, ARK_CODING_API_KEY: "synthetic-test-key" },
      { waitUntil() {}, passThroughOnException() {} },
    );
    return { response, calls };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function recomposeWithMockModel() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("recompose-test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const candidate = {
    chief_complaint: "确诊黑色素瘤3天",
    present_illness: "患者3天前确诊黑色素瘤。近期右侧腋窝触及肿大淋巴结；无恶心、呕吐及明显腹部不适。",
    past_history: "【待选择：既往疾病】",
    personal_history: "【待选择：个人史】",
    family_history: "【待选择：家族史】",
    allergy_history: "【待选择：过敏史】",
    specialist_exam: "【待查体：原发灶及区域淋巴结】",
    diagnosis_summary: "模型不应新增的淋巴结转移诊断",
    plan_summary: "模型不应新增的治疗计划",
    pending_fields: [],
  };
  const originalFetch = globalThis.fetch;
  let prompt = "";
  globalThis.fetch = async (_url, init) => {
    prompt = JSON.parse(init.body).input;
    return new Response(JSON.stringify({ output_text: JSON.stringify(candidate) }), { status: 200 });
  };
  try {
    const draft = { ...candidate, present_illness: "患者3天前经病理检查确诊黑色素瘤，免疫组化具体结果待核对。", diagnosis_summary: "", plan_summary: "", pending_fields: ["病理：待核对"] };
    const response = await worker.fetch(
      new Request("http://localhost/api/recompose", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        draft,
        facts: [{ fact_id: "F1", event_type: "onset_diagnosis", certainty: "explicit" }],
        template_name: "黑色素瘤入院病史候选模板",
        confirmations: [
          { choice_id: "melanoma_nodes", option_id: "yes", prompt: "区域淋巴结有肿大或不适吗？", label: "有", section: "present_illness", text: "近期发现区域淋巴结肿大或不适。", detail: "右侧腋窝触及肿大淋巴结" },
          { choice_id: "melanoma_general_gi", option_id: "no", prompt: "食欲、体重或消化道症状有变化吗？", label: "无", section: "present_illness", text: "无恶心、呕吐及明显腹部不适。", detail: "" },
        ],
      }) }),
      { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) }, ARK_CODING_API_KEY: "synthetic-test-key" },
      { waitUntil() {}, passThroughOnException() {} },
    );
    return { response, prompt };
  } finally { globalThis.fetch = originalFetch; }
}

async function templateChatWithMockModel(model = "deepseek-v4-pro") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("chat-test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const originalFetch = globalThis.fetch;
  let prompt = "";
  globalThis.fetch = async (_url, init) => {
    prompt = JSON.parse(init.body).input;
    return new Response(JSON.stringify({ output_text: "**重点**：建议核对具体淋巴引流区、部位、大小、质地、活动度及压痛；*记录示例*只能使用已核实内容，这些记录不能替代诊断。" }), { status: 200 });
  };
  try {
    const response = await worker.fetch(
      new Request("http://localhost/api/template-chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "区域淋巴结要记录什么？", history: [], template_name: "黑色素瘤入院病史候选模板", item_context: "区域淋巴结实际查体", model }) }),
      { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) }, ARK_CODING_API_KEY: "synthetic-test-key" },
      { waitUntil() {}, passThroughOnException() {} },
    );
    return { response, prompt };
  } finally { globalThis.fetch = originalFetch; }
}

test("renders the single-entry admission draft package workflow", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  const html = await response.text();
  const pageSource = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(html, /OncoPilot/);
  assert.match(html, /肿瘤入院记录草稿助手/);
  assert.match(html, /资料再少/);
  assert.match(html, /一套可选择、可补全的草稿/);
  assert.match(html, /拍照、上传文件，或粘贴文字/);
  assert.match(html, /上传图片/);
  assert.match(html, /上传图片或 PDF/);
  assert.match(html, /HEIC 会先在本机转换/);
  assert.match(html, /最多/);
  assert.match(html, /PDF 最多/);
  assert.match(html, /本地规则只约束草稿结构/);
  assert.match(html, /不替代本院模板和上级审核/);
  assert.match(html, /本次来院目的/);
  assert.match(html, /生成入院记录草稿包/);
  assert.match(html, /先整理已知事实/);
  assert.match(html, /再给候选选项/);
  assert.match(html, /只有你点击确认后才加入草稿/);
  assert.match(pageSource, /fetch\("\/api\/template-chat\/"/);
  assert.match(pageSource, /快速 · V4 Flash/);
  assert.match(pageSource, /深入 · V4 Pro/);
  assert.match(pageSource, /正在思考.*秒/);
  assert.match(pageSource, /renderChatContent/);
  assert.doesNotMatch(html, /进入管床/);
  assert.doesNotMatch(html, /合成患者 A02/);
  assert.doesNotMatch(html, /codex-preview/);
  assert.doesNotMatch(html, /react-loading-skeleton/);
});

test("rejects image extraction clearly when no vision service is configured", async () => {
  const response = await extractWithoutVisionService();
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.match(body.error, /图片识别服务尚未配置/);
});

test("extracts facts first and adds melanoma scaffolds plus guided choices", async () => {
  const { response, calls } = await analyzeWithMockModel();
  assert.equal(response.status, 200);
  assert.equal(calls, 2);
  const body = await response.json();
  assert.equal(body.result.facts.length, 4);
  assert.equal(body.result.current_purpose, undefined);
  assert.match(body.result.present_illness, /首次发现时间/);
  assert.match(body.result.past_history, /待选择/);
  assert.match(body.result.personal_history, /待选择/);
  assert.match(body.result.family_history, /待选择/);
  assert.match(body.result.allergy_history, /待选择/);
  assert.match(body.result.specialist_exam, /待查体/);
  assert.equal(body.result.diagnosis_summary, "");
  assert.equal(body.result.plan_summary, "");
  assert.equal(body.result.template_name, "黑色素瘤入院病史候选模板");
  assert.ok(body.result.review_items.length >= 12);
  assert.ok(body.result.review_items.some((item) => item.choice_id === "melanoma_neurologic"));
  assert.ok(body.result.review_items.some((item) => item.choice_id === "melanoma_exam_nodes"));
  assert.match(body.result.review_items.find((item) => item.choice_id === "melanoma_exam_nodes").help, /影像.*实际触诊/);
  assert.ok(body.result.review_items.some((item) => item.choice_id === "oncology_performance_status"));
  assert.ok(body.result.review_items.find((item) => item.choice_id === "melanoma_sampling").options.find((option) => option.option_id === "node").detail_prompt.includes("取材"));
  assert.equal(body.result.review_items.find((item) => item.choice_id === "melanoma_pathology_detail").options.find((option) => option.option_id === "none").detail_prompt, undefined);
  assert.match(body.result.specialist_exam, /ECOG PS/);
  assert.doesNotMatch(body.result.specialist_exam, /右侧腋窝.*肿大/);
  assert.deepEqual(body.result.pending_fields, ["过敏史：待核对"]);
});

test("recomposes confirmed choices and free text without adding diagnosis or plan", async () => {
  const { response, prompt } = await recomposeWithMockModel();
  assert.equal(response.status, 200);
  assert.match(prompt, /右侧腋窝触及肿大淋巴结/);
  assert.match(prompt, /确认项是医生核对后的新事实/);
  const body = await response.json();
  assert.match(body.result.present_illness, /右侧腋窝/);
  assert.match(body.result.present_illness, /无恶心、呕吐/);
  assert.equal(body.result.diagnosis_summary, "");
  assert.equal(body.result.plan_summary, "");
  assert.deepEqual(body.result.pending_fields, ["病理：待核对"]);
});

test("template chat explains documentation fields without replacing clinical judgment", async () => {
  const { response, prompt } = await templateChatWithMockModel();
  assert.equal(response.status, 200);
  assert.match(prompt, /不能替患者回答有或无/);
  assert.match(prompt, /不能推荐检查、药物、剂量、治疗/);
  assert.match(prompt, /不超过180个汉字/);
  const body = await response.json();
  assert.equal(body.model, "deepseek-v4-pro");
  assert.match(body.answer, /\*\*重点\*\*/);
  assert.doesNotMatch(body.answer, /\*记录示例\*/);
  assert.match(body.answer, /部位、大小、质地、活动度及压痛/);
});

test("template chat rejects models outside the documented selector", async () => {
  const { response } = await templateChatWithMockModel("unknown-model");
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.match(body.error, /不支持的模型/);
});
