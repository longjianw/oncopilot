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

async function extractWithVisionService() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("image-model-test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.model, "doubao-seed-2.1-turbo");
    assert.equal(body.input[0].content[1].type, "input_image");
    assert.equal(body.thinking.type, "disabled");
    assert.equal(body.max_output_tokens, 900);
    return new Response(JSON.stringify({ output_text: "完全合成病理资料" }), { status: 200 });
  };
  const formData = new FormData();
  formData.append("image", new File(["synthetic image"], "synthetic.jpg", { type: "image/jpeg" }));
  try {
    return await worker.fetch(
      new Request("http://localhost/api/extract-image", { method: "POST", body: formData }),
      { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) }, ARK_CODING_API_KEY: "synthetic-test-key" },
      { waitUntil() {}, passThroughOnException() {} },
    );
  } finally { globalThis.fetch = originalFetch; }
}

async function extractBatchWithVisionService() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("image-batch-test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.model, "doubao-seed-2.1-turbo");
    assert.equal(body.input[0].content.filter((item) => item.type === "input_image").length, 3);
    return new Response(JSON.stringify({ output_text: JSON.stringify({ pages: [
      { index: 1, text: "完全合成第1页" },
      { index: 2, text: "完全合成第2页" },
      { index: 3, text: "完全合成第3页" },
    ] }) }), { status: 200 });
  };
  const formData = new FormData();
  for (let index = 1; index <= 3; index += 1) formData.append("images", new File([`synthetic-${index}`], `synthetic-${index}.jpg`, { type: "image/jpeg" }));
  try {
    return await worker.fetch(
      new Request("http://localhost/api/extract-images", { method: "POST", body: formData }),
      { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) }, ARK_CODING_API_KEY: "synthetic-test-key" },
      { waitUntil() {}, passThroughOnException() {} },
    );
  } finally { globalThis.fetch = originalFetch; }
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
      present_illness_fact_ids: ["C1-F1", "C1-F2", "C1-F3", "C1-F4"],
    },
  ];
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    assert.equal(JSON.parse(init.body).model, "deepseek-v4-pro");
    return new Response(JSON.stringify({ output_text: JSON.stringify(responses[calls++]) }), { status: 200 });
  };
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

async function analyzePriorDischargeDiagnosisWithMockModel() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("prior-discharge-diagnosis-test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const responses = [
    {
      current_purpose: "进一步评估",
      sources: [{ source_id: "S1", title: "完全合成既往出院记录", evidence: "入院诊断与出院诊断均记载粒细胞缺乏、肺部感染及胸腺肿瘤相关诊断" }],
      facts: [{ fact_id: "F1", field: "doctor_diagnosis", value: "入院诊断：粒细胞缺乏、肺部感染；出院诊断：粒细胞缺乏、肺部感染、胸腺肿瘤术后放疗后复发", event_time: "本次", event_type: "doctor_diagnosis", encounter_scope: "current", certainty: "doctor_confirmed", source_ids: ["S1"] }],
      pending_fields: [],
    },
    {
      chief_complaint: "胸腺肿瘤诊疗后入院进一步评估",
      present_illness: "既往住院记录明确诊断为粒细胞缺乏、肺部感染及胸腺肿瘤术后放疗后复发，本次为进一步评估入院。",
      past_history: "", personal_history: "", family_history: "", allergy_history: "", specialist_exam: "",
      diagnosis_summary: "入院诊断：1.粒细胞缺乏；2.肺部感染。出院诊断：1.粒细胞缺乏；2.肺部感染。",
      plan_summary: "", pending_fields: [], present_illness_fact_ids: ["C1-F1", "F-PURPOSE"],
    },
  ];
  const originalFetch = globalThis.fetch;
  const prompts = [];
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    prompts.push(JSON.parse(init.body).input);
    return new Response(JSON.stringify({ output_text: JSON.stringify(responses[calls++]) }), { status: 200 });
  };
  try {
    const response = await worker.fetch(
      new Request("http://localhost/api/analyze", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source_text: "【完全合成既往出院记录】入院诊断与出院诊断均包含粒细胞缺乏、肺部感染及胸腺肿瘤相关诊断。", current_purpose: "进一步评估" }) }),
      { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) }, ARK_CODING_API_KEY: "synthetic-test-key" },
      { waitUntil() {}, passThroughOnException() {} },
    );
    return { response, prompts };
  } finally { globalThis.fetch = originalFetch; }
}

async function analyzeWithContaminatedModelDraft() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("contaminated-draft-test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const responses = [
    {
      current_purpose: "进一步评估",
      sources: [{ source_id: "S1", title: "完全合成纵隔肿瘤资料", evidence: "既往治疗后复发，近期出现血细胞减少" }],
      facts: [
        { fact_id: "F1", field: "diagnosis", value: "纵隔来源肿瘤治疗后复发", event_time: "6年前至近期", event_type: "onset_diagnosis", encounter_scope: "prior", certainty: "explicit", source_ids: ["S1"] },
        { fact_id: "F2", field: "current_status", value: "近期发现血细胞减少", event_time: "近期", event_type: "current_status", encounter_scope: "current", certainty: "explicit", source_ids: ["S1"] },
      ],
      pending_fields: [],
    },
    {
      chief_complaint: "### 入院诊断【病程时间待补】，**本次入院目的**：进一步评估",
      present_illness: "### 入院诊断；**确诊经过**：纵隔肿瘤。**住院治疗**：既往治疗后出院。**治疗计划**：进一步处理。",
      past_history: "", personal_history: "", family_history: "", allergy_history: "", specialist_exam: "", diagnosis_summary: "", plan_summary: "", pending_fields: [], present_illness_fact_ids: ["C1-F1", "C1-F2", "F-PURPOSE"],
    },
  ];
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => new Response(JSON.stringify({ output_text: JSON.stringify(responses[Math.min(calls++, responses.length - 1)]) }), { status: 200 });
  try {
    return await worker.fetch(
      new Request("http://localhost/api/analyze", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source_text: "完全合成纵隔肿瘤资料：既往治疗后复发，近期发现血细胞减少。", current_purpose: "进一步评估" }) }),
      { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) }, ARK_CODING_API_KEY: "synthetic-test-key" },
      { waitUntil() {}, passThroughOnException() {} },
    );
  } finally { globalThis.fetch = originalFetch; }
}

async function analyzeAfterRepeatedExtractionFailure() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("repeated-extraction-failure-test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const originalFetch = globalThis.fetch;
  let extractionCalls = 0;
  let draftCalls = 0;
  globalThis.fetch = async (_url, init) => {
    const prompt = JSON.parse(init.body).input;
    if (prompt.includes("结构化事实抽取器")) {
      extractionCalls += 1;
      return new Response(JSON.stringify({ output_text: "{}" }), { status: 200 });
    }
    draftCalls += 1;
    return new Response(JSON.stringify({ output_text: JSON.stringify({
      chief_complaint: "胸腺肿瘤诊疗后复发，近期发现中性粒细胞降低，入院进一步评估",
      present_illness: "患者6年前因前纵隔占位就诊，后接受胸腺肿瘤切除及术后放疗，具体治疗时间和疗效待核对。既往记录提示肿瘤复发，相关病理及影像原文仍需结合来源复核。近期血常规提示中性粒细胞降低，当前伴随症状、生命体征及器官功能资料尚未完整提供。本次为进一步评估肿瘤状态、明确血细胞异常相关情况并衔接后续诊疗入院。",
      past_history: "", personal_history: "", family_history: "", allergy_history: "", specialist_exam: "", diagnosis_summary: "", plan_summary: "", pending_fields: [],
    }) }), { status: 200 });
  };
  try {
    const response = await worker.fetch(
      new Request("http://localhost/api/analyze", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        source_text: "【完全合成既往出院记录】\n出院诊断：粒细胞缺乏；肺部感染；胸腺肿瘤术后放疗后复发。\n既往行胸腺肿瘤切除及术后放疗。\n近期血常规提示中性粒细胞降低。",
        current_purpose: "进一步评估及处理当前问题",
      }) }),
      { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) }, ARK_CODING_API_KEY: "synthetic-test-key" },
      { waitUntil() {}, passThroughOnException() {} },
    );
    return { response, extractionCalls, draftCalls };
  } finally { globalThis.fetch = originalFetch; }
}

async function analyzeLongSourceWithMockModel(draftFails = false, extractionFails = false) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("long-analyze-test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const sourceText = Array.from({ length: 10 }, (_, index) => `【完全合成资料 · 第${index + 1}页｜视觉转录，待核对】\n${"完全合成检查摘要，无身份信息。".repeat(55)}`).join("\n\n");
  const draft = {
    chief_complaint: "发现肿瘤相关异常，持续时间待核对",
    present_illness: "患者1月前发现肿瘤相关异常，已完成部分检查，本次为进一步评估入院。",
    past_history: "", personal_history: "", family_history: "", allergy_history: "", specialist_exam: "", diagnosis_summary: "", plan_summary: "", pending_fields: [], present_illness_fact_ids: ["F-PURPOSE"],
  };
  const originalFetch = globalThis.fetch;
  let extractionCalls = 0;
  let draftCalls = 0;
  let activeExtractions = 0;
  let maxActiveExtractions = 0;
  globalThis.fetch = async (_url, init) => {
    const prompt = JSON.parse(init.body).input;
    if (prompt.includes("结构化事实抽取器")) {
      extractionCalls += 1;
      activeExtractions += 1;
      maxActiveExtractions = Math.max(maxActiveExtractions, activeExtractions);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeExtractions -= 1;
      if (extractionFails) return new Response(JSON.stringify({ output_text: JSON.stringify({ current_purpose: null, sources: [], facts: [], pending_fields: [] }) }), { status: 200 });
      return new Response(JSON.stringify({ output_text: JSON.stringify({
        current_purpose: prompt.includes("进一步评估") ? "进一步评估" : null,
        sources: [{ source_id: "S1", title: `完全合成分段${extractionCalls}`, evidence: "完全合成检查摘要".repeat(80) }],
        facts: [{ fact_id: "F1", field: "other", value: `第${extractionCalls}段检查资料已提供`, event_time: "未提供", event_type: "other", encounter_scope: "prior", certainty: "explicit", source_ids: ["S1"] }],
        pending_fields: [],
      }) }), { status: 200 });
    }
    draftCalls += 1;
    if (draftFails) return new Response("upstream unavailable", { status: 504 });
    return new Response(JSON.stringify({ output_text: JSON.stringify(draft) }), { status: 200 });
  };
  try {
    const response = await worker.fetch(
      new Request("http://localhost/api/analyze", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source_text: sourceText, current_purpose: "进一步评估" }) }),
      { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) }, ARK_CODING_API_KEY: "synthetic-test-key" },
      { waitUntil() {}, passThroughOnException() {} },
    );
    return { response, extractionCalls, draftCalls, maxActiveExtractions };
  } finally { globalThis.fetch = originalFetch; }
}

async function analyzeMultiLineTreatmentHistory() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("multi-line-history-test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const sourceText = [
    "【完全合成长病程】",
    "2019年1月确诊某肿瘤，2019年2月开始一线治疗。",
    "2020年3月评估进展，2020年4月开始二线治疗。",
    "2021年6月再次进展，2021年7月开始三线治疗。",
    "2026年8月出现发热1天，本次为处理发热入院。",
    "高血压5年；20年前行阑尾切除术。",
  ].join("\n");
  const extraction = {
    current_purpose: "处理发热",
    sources: [{ source_id: "S1", title: "完全合成长病程", evidence: sourceText }],
    facts: [
      { fact_id: "F1", field: "diagnosis", value: "2019年1月确诊某肿瘤", event_time: "2019年1月", event_type: "onset_diagnosis", encounter_scope: "prior", certainty: "explicit", source_ids: ["S1"] },
      { fact_id: "F2", field: "first_line", value: "2019年2月开始一线治疗", event_time: "2019年2月", event_type: "prior_treatment", encounter_scope: "prior", certainty: "explicit", source_ids: ["S1"] },
      { fact_id: "F3", field: "progression", value: "2020年3月评估进展", event_time: "2020年3月", event_type: "progression_evidence", encounter_scope: "prior", certainty: "explicit", source_ids: ["S1"] },
      { fact_id: "F4", field: "second_line", value: "2020年4月开始二线治疗", event_time: "2020年4月", event_type: "prior_treatment", encounter_scope: "prior", certainty: "explicit", source_ids: ["S1"] },
      { fact_id: "F5", field: "progression", value: "2021年6月再次进展", event_time: "2021年6月", event_type: "progression_evidence", encounter_scope: "prior", certainty: "explicit", source_ids: ["S1"] },
      { fact_id: "F6", field: "third_line", value: "2021年7月开始三线治疗", event_time: "2021年7月", event_type: "prior_treatment", encounter_scope: "prior", certainty: "explicit", source_ids: ["S1"] },
      { fact_id: "F7", field: "current_status", value: "2026年8月出现发热1天", event_time: "2026年8月", event_type: "current_status", encounter_scope: "current", certainty: "explicit", source_ids: ["S1"] },
      { fact_id: "F8", field: "hypertension", value: "高血压5年", event_time: "5年", event_type: "past_history", encounter_scope: "prior", certainty: "explicit", source_ids: ["S1"] },
      { fact_id: "F9", field: "old_surgery", value: "20年前行阑尾切除术", event_time: "20年前", event_type: "past_history", encounter_scope: "prior", certainty: "explicit", source_ids: ["S1"] },
      { fact_id: "F10", field: "current_purpose", value: "本次为处理发热入院", event_time: "本次", event_type: "current_purpose", encounter_scope: "current", certainty: "explicit", source_ids: ["S1"] },
    ],
    pending_fields: [],
  };
  const draft = {
    chief_complaint: "某肿瘤多线治疗后，发热1天",
    present_illness: "患者2019年1月确诊某肿瘤，2019年2月开始一线治疗。2020年3月评估进展，2020年4月开始二线治疗。2021年6月再次进展，2021年7月开始三线治疗。2026年8月出现发热1天，本次为处理发热入院。",
    past_history: "高血压5年。20年前行阑尾切除术。",
    personal_history: "", family_history: "", allergy_history: "", specialist_exam: "", diagnosis_summary: "", plan_summary: "", pending_fields: [],
    present_illness_fact_ids: ["C1-F1", "C1-F2", "C1-F3", "C1-F4", "C1-F5", "C1-F6", "C1-F7", "C1-F10"],
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const prompt = JSON.parse(init.body).input;
    return new Response(JSON.stringify({ output_text: JSON.stringify(prompt.includes("结构化事实抽取器") ? extraction : draft) }), { status: 200 });
  };
  try {
    return await worker.fetch(
      new Request("http://localhost/api/analyze", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source_text: sourceText, current_purpose: "处理发热" }) }),
      { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) }, ARK_CODING_API_KEY: "synthetic-test-key" },
      { waitUntil() {}, passThroughOnException() {} },
    );
  } finally { globalThis.fetch = originalFetch; }
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
    const chunks = ["**重点**：建议核对具体淋巴引流区、", "部位、大小、质地、活动度及压痛；", "*记录示例*只能使用已核实内容，这些记录不能替代诊断。"];
    const sse = chunks.map((delta) => `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta })}\n\n`).join("") + "data: [DONE]\n\n";
    return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
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

async function clinicalReferenceChatWithMockModel(outputText = "候选方向一：结合当前发热及血细胞下降讨论广谱抗感染候选，具体选择取决于病原学、过敏史、肾功能、肝功能和既往抗菌药。开立前待核对：外院用药经过、院内药品规格、单次剂量、给药频次、稀释液、总体积、输注时间、配伍与复评节点。") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("clinical-reference-chat-test", `${process.pid}-${Date.now()}`);
  const originalFetch = globalThis.fetch;
  let upstreamBody;
  let upstreamCalls = 0;
  globalThis.fetch = async (_url, init) => {
    upstreamCalls += 1;
    upstreamBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ output_text: outputText }), { status: 200 });
  };
  const facts = [
    { fact_id: "F-SYNTHETIC-1", field: "current_status", value: "完全合成病例：今日发热伴白细胞下降", event_time: "今日", event_type: "current_status", encounter_scope: "current", certainty: "explicit", source_ids: ["S-SYNTHETIC-1"] },
    { fact_id: "F-RAW", field: "unparsed_source_segment", value: "RAW_UNPARSED_FACT_MUST_NOT_REACH_UPSTREAM", event_time: "待核对", event_type: "other", encounter_scope: "unclear", certainty: "pending", source_ids: ["S-RAW"] },
  ];
  const reference = {
    preliminary_diagnosis: "发热伴血细胞下降，感染风险待评估",
    diagnostic_basis: ["完全合成血常规提示白细胞下降"],
    differential_diagnosis: [],
    missing_prerequisites: ["过敏史与肾功能"],
    suggested_workup: [{ title: "复核病原学", trigger: "发热持续时", purpose: "支持抗感染路径讨论" }],
    treatment_pathways: [{ title: "经验性抗感染候选", trigger: "上级医师确认存在相应适应条件时", purpose: "结合本院规范讨论" }],
    verification_state: "model_only",
  };
  try {
    const { default: worker } = await import(workerUrl.href);
    const response = await worker.fetch(
      new Request("http://localhost/api/clinical-reference-chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        message: "抗感染方向下一步具体需要核对什么？",
        history: [
          { role: "user", content: "先讨论抗感染方向。" },
          { role: "assistant", content: "可以先按风险和缺失前提展开。" },
        ],
        facts,
        current_purpose: "外院转入我院后进一步评估发热",
        reference,
        context: "抗感染方向",
        source_text: "RAW_SOURCE_TEXT_MUST_NOT_REACH_UPSTREAM",
      }) }),
      { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) }, ARK_CODING_API_KEY: "synthetic-test-key" },
      { waitUntil() {}, passThroughOnException() {} },
    );
    const stream = await response.text();
    return { response, stream, upstreamBody, upstreamCalls };
  } finally { globalThis.fetch = originalFetch; }
}

async function clinicalReferenceChatRewritesExecutableAnswer() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("clinical-reference-chat-rewrite-test", `${process.pid}-${Date.now()}`);
  const originalFetch = globalThis.fetch;
  const upstreamBodies = [];
  const candidates = [
    "可直接使用某抗菌药4.5 g q8h静脉滴注。",
    "候选方向一：可讨论广谱抗感染方案候选，但选择取决于感染部位、既往抗菌药、病原学、过敏史、肾功能和肝功能。开立前待核对：外院用药经过、院内药品规格、单次剂量、给药频次、稀释液、总体积、输注时间、配伍禁忌及复评节点。",
  ];
  globalThis.fetch = async (_url, init) => {
    upstreamBodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ output_text: candidates[upstreamBodies.length - 1] }), { status: 200 });
  };
  try {
    const { default: worker } = await import(workerUrl.href);
    const response = await worker.fetch(
      new Request("http://localhost/api/clinical-reference-chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        message: "抗感染具体怎么继续讨论？",
        history: [],
        facts: [{ fact_id: "F-SYNTHETIC-2", field: "current_status", value: "完全合成病例：发热伴粒细胞下降", event_time: "今日", event_type: "current_status", encounter_scope: "current", certainty: "explicit", source_ids: ["S-SYNTHETIC-2"] }],
        current_purpose: "外院转入我院后进一步评估",
        context: "抗感染方向",
      }) }),
      { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) }, ARK_CODING_API_KEY: "synthetic-test-key" },
      { waitUntil() {}, passThroughOnException() {} },
    );
    const stream = await response.text();
    return { response, stream, upstreamBodies };
  } finally { globalThis.fetch = originalFetch; }
}

async function clinicalReferenceChatRewritesSpacedFrequency() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("clinical-reference-chat-spaced-frequency-test", `${process.pid}-${Date.now()}`);
  const originalFetch = globalThis.fetch;
  const upstreamBodies = [];
  const candidates = [
    "可直接使用某抗菌药4.5 g，静脉滴注，q 8 h。",
    "候选方向一：可讨论广谱抗感染方案候选，但需先核对感染部位、既往抗菌药暴露、病原学、过敏史、肾功能和肝功能。开立前待核对：院内药品规格、单次剂量、给药频次、溶媒、总体积、输注时间、配伍和复评节点。",
  ];
  globalThis.fetch = async (_url, init) => {
    upstreamBodies.push(JSON.parse(init.body));
    const candidate = candidates[Math.min(upstreamBodies.length - 1, candidates.length - 1)];
    return new Response(JSON.stringify({ output_text: candidate }), { status: 200 });
  };
  try {
    const { default: worker } = await import(workerUrl.href);
    const response = await worker.fetch(
      new Request("http://localhost/api/clinical-reference-chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        message: "抗感染具体怎么继续讨论？",
        history: [],
        facts: [{ fact_id: "F-SYNTHETIC-SPACED", field: "current_status", value: "完全合成病例：发热伴粒细胞下降", event_time: "今日", event_type: "current_status", encounter_scope: "current", certainty: "explicit", source_ids: ["S-SYNTHETIC-SPACED"] }],
        current_purpose: "外院转入我院后进一步评估",
        context: "抗感染方向",
      }) }),
      { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) }, ARK_CODING_API_KEY: "synthetic-test-key" },
      { waitUntil() {}, passThroughOnException() {} },
    );
    const stream = await response.text();
    return { response, stream, upstreamBodies };
  } finally { globalThis.fetch = originalFetch; }
}

async function clinicalReferenceChatRejectsCertaintyInflation() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("clinical-reference-chat-certainty-test", `${process.pid}-${Date.now()}`);
  const originalFetch = globalThis.fetch;
  const upstreamBodies = [];
  const candidates = [
    "该患者已明确为IV期转移性胸腺瘤，应按晚期疾病处理。",
    "现有资料仅支持影像考虑胸膜受累可能，尚不能据此确定转移或IV期；需核对原始影像、病理及分期依据。",
  ];
  globalThis.fetch = async (_url, init) => {
    upstreamBodies.push(JSON.parse(init.body));
    const candidate = candidates[Math.min(upstreamBodies.length - 1, candidates.length - 1)];
    return new Response(JSON.stringify({ output_text: candidate }), { status: 200 });
  };
  try {
    const { default: worker } = await import(workerUrl.href);
    const response = await worker.fetch(
      new Request("http://localhost/api/clinical-reference-chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        message: "目前怎样判断分期？",
        history: [],
        facts: [{ fact_id: "F-SYNTHETIC-UNCERTAIN", field: "progression_evidence", value: "影像考虑胸膜受累可能", event_time: "近期", event_type: "progression_evidence", encounter_scope: "current", certainty: "uncertain", source_ids: ["S-SYNTHETIC-UNCERTAIN"] }],
        current_purpose: "进一步评估",
        context: "分期判断",
      }) }),
      { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) }, ARK_CODING_API_KEY: "synthetic-test-key" },
      { waitUntil() {}, passThroughOnException() {} },
    );
    const stream = await response.text();
    return { response, stream, upstreamBodies };
  } finally { globalThis.fetch = originalFetch; }
}

async function clinicalReferenceChatRewritesUnverifiedThresholdsAndCompatibility() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("clinical-reference-chat-unverified-medication-detail-test", `${process.pid}-${Date.now()}`);
  const originalFetch = globalThis.fetch;
  const upstreamBodies = [];
  const candidates = [
    "若近90天用过三代头孢，必须升级为碳青霉烯；72-96小时复评。配伍禁忌：某抗菌药与另一药需分瓶输注。",
    "候选方向一：可讨论抗假单胞菌β-内酰胺类及按条件增加其他覆盖的候选，具体选择取决于过敏史、肾功能、肝功能、病原学和既往抗菌药。开立前待核对：外院用药经过、院内药品规格、单次剂量、给药频次、稀释液、总体积、输注时间、同通道配伍和复评时间；具体结论待本院资料及药师核对。",
  ];
  globalThis.fetch = async (_url, init) => {
    upstreamBodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ output_text: candidates[Math.min(upstreamBodies.length - 1, candidates.length - 1)] }), { status: 200 });
  };
  try {
    const { default: worker } = await import(workerUrl.href);
    const response = await worker.fetch(
      new Request("http://localhost/api/clinical-reference-chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        message: "抗感染候选和执行字段怎样继续核对？",
        history: [],
        facts: [{ fact_id: "F-SYNTHETIC-DETAIL", field: "current_status", value: "完全合成病例：发热伴白细胞下降", event_time: "今日", event_type: "current_status", encounter_scope: "current", certainty: "explicit", source_ids: ["S-SYNTHETIC-DETAIL"] }],
        current_purpose: "进一步评估",
        context: "抗感染方向",
      }) }),
      { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) }, ARK_CODING_API_KEY: "synthetic-test-key" },
      { waitUntil() {}, passThroughOnException() {} },
    );
    const stream = await response.text();
    return { response, stream, upstreamBodies };
  } finally { globalThis.fetch = originalFetch; }
}

async function clinicalReferenceChatSalvagesSafeDirectionsAfterRejectedRewrite(rewriteAnswer = "", options = {}) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("clinical-reference-chat-rewrite-salvage-test", `${process.pid}-${Date.now()}-${rewriteAnswer.length}`);
  const originalFetch = globalThis.fetch;
  const upstreamBodies = [];
  const firstAnswer = options.firstAnswer || [
    "候选一：抗假单胞菌β-内酰胺类候选",
    "启用条件：结合当前发热、呼吸道症状及外院抗感染经过讨论。",
    "可直接使用某抗菌药4.5 g q8h静脉滴注。",
    "候选二：加用抗MRSA覆盖",
    "若近90天用过三代头孢，必须升级为碳青霉烯；72-96小时复评。",
    "配伍禁忌：某抗菌药与另一药需分瓶输注。",
    "若存在休克可加用甲泼尼龙并准备机械通气。",
  ].join("\n");
  globalThis.fetch = async (_url, init) => {
    upstreamBodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ output_text: upstreamBodies.length === 1 ? firstAnswer : rewriteAnswer }), { status: 200 });
  };
  const facts = [
    { fact_id: "F-SYNTHETIC-SALVAGE-1", field: "current_status", value: "完全合成病例：高热伴咳嗽、咳痰及气促", event_time: "今日", event_type: "current_status", encounter_scope: "current", certainty: "explicit", source_ids: ["S-SYNTHETIC-SALVAGE"] },
    { fact_id: "F-SYNTHETIC-SALVAGE-2", field: "laboratory", value: "外院检验示白细胞下降、降钙素原升高", event_time: "转院前", event_type: "laboratory", encounter_scope: "prior", certainty: "explicit", source_ids: ["S-SYNTHETIC-SALVAGE"] },
    { fact_id: "F-SYNTHETIC-SALVAGE-3", field: "treatment", value: "近期接受全身治疗，具体药物未提供", event_time: "近期", event_type: "treatment", encounter_scope: "prior", certainty: "explicit", source_ids: ["S-SYNTHETIC-SALVAGE"] },
  ];
  const reference = {
    preliminary_diagnosis: "发热伴血细胞下降，感染风险待评估",
    diagnostic_basis: ["完全合成资料提示发热及白细胞下降"],
    differential_diagnosis: [],
    missing_prerequisites: ["外院具体抗菌药、起止时间及疗效"],
    suggested_workup: [],
    treatment_pathways: options.referencePathways || [],
    verification_state: "model_only",
  };
  try {
    const { default: worker } = await import(workerUrl.href);
    const response = await worker.fetch(
      new Request("http://localhost/api/clinical-reference-chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        message: "当前病例有哪些抗感染候选？开医嘱前需补齐哪些字段？",
        history: [],
        facts,
        current_purpose: "外院转入我院后进一步评估发热",
        reference,
        context: "抗感染方向",
      }) }),
      { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) }, ARK_CODING_API_KEY: "synthetic-test-key" },
      { waitUntil() {}, passThroughOnException() {} },
    );
    const stream = await response.text();
    return { response, stream, upstreamBodies };
  } finally { globalThis.fetch = originalFetch; }
}

async function clinicalReferenceChatWithSyntheticPhone() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("clinical-reference-chat-phone-test", `${process.pid}-${Date.now()}`);
  const originalFetch = globalThis.fetch;
  let upstreamCalls = 0;
  globalThis.fetch = async () => {
    upstreamCalls += 1;
    return new Response("upstream must not be called", { status: 500 });
  };
  try {
    const { default: worker } = await import(workerUrl.href);
    const response = await worker.fetch(
      new Request("http://localhost/api/clinical-reference-chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        message: "请结合这个号码继续讨论：13800138000",
        history: [],
        facts: [{ fact_id: "F-SYNTHETIC-1", value: "完全合成病例：今日发热" }],
        current_purpose: "进一步评估",
      }) }),
      { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) }, ARK_CODING_API_KEY: "synthetic-test-key" },
      { waitUntil() {}, passThroughOnException() {} },
    );
    return { response, upstreamCalls };
  } finally { globalThis.fetch = originalFetch; }
}

async function analyzeExternalTransferWithMockModel(referralOnlyEnding) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("external-transfer-test", `${process.pid}-${Date.now()}-${referralOnlyEnding}`);
  const extraction = {
    current_purpose: "进一步评估发热及血细胞下降",
    sources: [{ source_id: "S1", title: "完全合成外院转院前记录", evidence: "转院前体温39.1℃、脉搏132次/分，右肺呼吸音低；外院建议转上级医院进一步诊治" }],
    facts: [
      { fact_id: "F-EXAM", field: "external_specialist_exam", value: "转院前体温39.1℃、脉搏132次/分，右肺呼吸音低", event_time: "转院前", event_type: "specialist_exam", encounter_scope: "current", certainty: "explicit", source_ids: ["S1"] },
      { fact_id: "F-REFERRAL", field: "external_referral", value: "外院因病情无明显好转建议转上级医院进一步诊治", event_time: "转院前", event_type: "current_status", encounter_scope: "prior", certainty: "explicit", source_ids: ["S1"] },
    ],
    pending_fields: [],
  };
  const draft = {
    chief_complaint: "治疗后发热伴血细胞下降1天",
    present_illness: referralOnlyEnding
      ? "患者治疗后出现发热及血细胞下降，于外院处理后病情无明显好转，建议转上级医院进一步诊治。"
      : "患者治疗后出现发热及血细胞下降，于外院处理后病情无明显好转，建议转上级医院进一步诊治。现为求进一步诊治，由外院转入我院并收治入院。",
    past_history: "",
    personal_history: "",
    family_history: "",
    allergy_history: "",
    specialist_exam: "体温39.1℃、脉搏132次/分，右肺呼吸音低。",
    diagnosis_summary: "",
    plan_summary: "",
    pending_fields: [],
    present_illness_fact_ids: ["C1-F-REFERRAL", "F-PURPOSE", "F-ARRIVAL"],
  };
  const originalFetch = globalThis.fetch;
  const prompts = [];
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    const prompt = JSON.parse(init.body).input;
    prompts.push(prompt);
    const output = calls === 0 ? extraction : draft;
    calls += 1;
    return new Response(JSON.stringify({ output_text: JSON.stringify(output) }), { status: 200 });
  };
  try {
    const { default: worker } = await import(workerUrl.href);
    const response = await worker.fetch(
      new Request("http://localhost/api/analyze", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        source_text: "【完全合成外院转院前记录】治疗后出现发热及血细胞下降1天，外院处理后建议转院。转院前查体资料仅供既往经过核对。",
        current_purpose: "进一步评估发热及血细胞下降",
        arrival_context: "外院转入我院",
      }) }),
      { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) }, ARK_CODING_API_KEY: "synthetic-test-key" },
      { waitUntil() {}, passThroughOnException() {} },
    );
    return { response, prompts, calls };
  } finally { globalThis.fetch = originalFetch; }
}

async function analyzeSourceConfirmedTransferWithoutSelector() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("source-confirmed-transfer-without-selector-test", `${process.pid}-${Date.now()}`);
  const extraction = {
    current_purpose: "进一步诊治",
    sources: [{ source_id: "S1", title: "完全合成转院记录", evidence: "外院建议转上级医院；患者随后转入我院收治" }],
    facts: [
      { fact_id: "F1", field: "external_referral", value: "外院建议转上级医院进一步诊治", event_time: "转院前", event_type: "current_status", encounter_scope: "prior", certainty: "explicit", source_ids: ["S1"] },
      { fact_id: "F2", field: "current_status", value: "患者随后转入我院收治", event_time: "本次", event_type: "current_status", encounter_scope: "current", certainty: "explicit", source_ids: ["S1"] },
    ],
    pending_fields: [],
  };
  const draft = {
    chief_complaint: "治疗后发热1天",
    present_illness: "患者治疗后出现发热，随后转入我院收治。因外院处理后病情无明显好转，建议转上级医院进一步诊治。",
    past_history: "", personal_history: "", family_history: "", allergy_history: "", specialist_exam: "", diagnosis_summary: "", plan_summary: "", pending_fields: [], present_illness_fact_ids: ["C1-F1", "C1-F2", "F-PURPOSE"],
  };
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => new Response(JSON.stringify({ output_text: JSON.stringify(calls++ === 0 ? extraction : draft) }), { status: 200 });
  try {
    const { default: worker } = await import(workerUrl.href);
    const response = await worker.fetch(
      new Request("http://localhost/api/analyze", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        source_text: "【完全合成转院记录】患者治疗后出现发热，外院处理后病情无明显好转，建议转上级医院进一步诊治。患者随后转入我院收治。",
        current_purpose: "进一步诊治",
      }) }),
      { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) }, ARK_CODING_API_KEY: "synthetic-test-key" },
      { waitUntil() {}, passThroughOnException() {} },
    );
    return { response, calls };
  } finally { globalThis.fetch = originalFetch; }
}

async function analyzeMixedExternalAndCurrentExam() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("mixed-external-current-exam-test", `${process.pid}-${Date.now()}`);
  const extraction = {
    current_purpose: "进一步评估发热",
    sources: [
      { source_id: "S1", title: "完全合成外院转院前记录", evidence: "外院转院前胸部查体：右肺呼吸音低" },
      { source_id: "S2", title: "完全合成本次我院查体", evidence: "本次我院查体：神志清楚" },
    ],
    facts: [
      { fact_id: "F1", field: "external_specialist_exam", value: "右肺呼吸音低", event_time: "转院前", event_type: "specialist_exam", encounter_scope: "current", certainty: "explicit", source_ids: ["S1"] },
      { fact_id: "F2", field: "current_specialist_exam", value: "神志清楚", event_time: "本次我院查体", event_type: "specialist_exam", encounter_scope: "current", certainty: "explicit", source_ids: ["S2"] },
    ],
    pending_fields: [],
  };
  const draft = {
    chief_complaint: "发热1天",
    present_illness: "患者今日出现发热，由外院转入我院进一步评估。",
    past_history: "", personal_history: "", family_history: "", allergy_history: "",
    specialist_exam: "神志清楚，右肺呼吸音低。",
    diagnosis_summary: "", plan_summary: "", pending_fields: [], present_illness_fact_ids: ["F-PURPOSE", "F-ARRIVAL"],
  };
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => new Response(JSON.stringify({ output_text: JSON.stringify(calls++ === 0 ? extraction : draft) }), { status: 200 });
  try {
    const { default: worker } = await import(workerUrl.href);
    const response = await worker.fetch(
      new Request("http://localhost/api/analyze", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        source_text: "【完全合成】外院转院前胸部查体示右肺呼吸音低。本次我院查体仅记录神志清楚。患者今日发热，由外院转入我院进一步评估。",
        current_purpose: "进一步评估发热",
        arrival_context: "外院转入我院",
      }) }),
      { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) }, ARK_CODING_API_KEY: "synthetic-test-key" },
      { waitUntil() {}, passThroughOnException() {} },
    );
    return { response, calls };
  } finally { globalThis.fetch = originalFetch; }
}

async function analyzeRetriesUnsupportedChiefDurationAndMissingAdmissionClosure() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("chief-duration-admission-closure-test", `${process.pid}-${Date.now()}`);
  const extraction = {
    current_purpose: "高热伴血细胞减少，由外院转入我院进一步诊治",
    sources: [{ source_id: "S1", title: "完全合成转院记录", evidence: "2026年8月6日出现高热；外院建议转院；后转入我院并收治入院" }],
    facts: [
      { fact_id: "F1", field: "current_status", value: "2026年8月6日出现高热伴血细胞减少", event_time: "2026年8月6日", event_type: "current_status", encounter_scope: "prior", certainty: "explicit", source_ids: ["S1"] },
      { fact_id: "F2", field: "current_status", value: "由外院转入我院并收治入院", event_time: "本次", event_type: "current_status", encounter_scope: "current", certainty: "explicit", source_ids: ["S1"] },
    ],
    pending_fields: [],
  };
  const invalidDraft = {
    chief_complaint: "高热伴血细胞减少6天",
    present_illness: "患者2026年8月6日出现高热伴血细胞减少，外院处理后建议转院，后转入我院。",
    past_history: "", personal_history: "", family_history: "", allergy_history: "", specialist_exam: "", diagnosis_summary: "", plan_summary: "", pending_fields: [], present_illness_fact_ids: ["C1-F1", "C1-F2", "F-PURPOSE", "F-ARRIVAL"],
  };
  const correctedDraft = {
    chief_complaint: "高热伴血细胞减少，持续时间待核对",
    present_illness: "患者2026年8月6日出现高热伴血细胞减少，外院处理后建议转院，后转入我院并收治入院。",
    past_history: "", personal_history: "", family_history: "", allergy_history: "", specialist_exam: "", diagnosis_summary: "", plan_summary: "", pending_fields: [], present_illness_fact_ids: ["C1-F1", "C1-F2", "F-PURPOSE", "F-ARRIVAL"],
  };
  const originalFetch = globalThis.fetch;
  const outputs = [extraction, invalidDraft, correctedDraft];
  let calls = 0;
  globalThis.fetch = async () => new Response(JSON.stringify({ output_text: JSON.stringify(outputs[Math.min(calls++, outputs.length - 1)]) }), { status: 200 });
  try {
    const { default: worker } = await import(workerUrl.href);
    const response = await worker.fetch(
      new Request("http://localhost/api/analyze", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        source_text: "【完全合成】2026年8月6日出现高热伴血细胞减少，外院处理后建议转院，后由外院转入我院，现为进一步诊治收治入院。",
        current_purpose: "高热伴血细胞减少，由外院转入我院进一步诊治",
        arrival_context: "外院转入我院",
      }) }),
      { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) }, ARK_CODING_API_KEY: "synthetic-test-key" },
      { waitUntil() {}, passThroughOnException() {} },
    );
    return { response, calls };
  } finally { globalThis.fetch = originalFetch; }
}

async function clinicalReferenceWithMockModel(action = "generate") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("reference-test", `${process.pid}-${Date.now()}-${action}`);
  const { default: worker } = await import(workerUrl.href);
  const generated = {
    preliminary_diagnosis: "黑色素瘤（病理提示，分期待补）",
    diagnostic_basis: ["病理及免疫组化提示黑色素瘤"],
    differential_diagnosis: ["病理原文不完整时考虑病理复核"],
    missing_prerequisites: ["原发部位", "Breslow厚度与溃疡", "区域淋巴结和全身分期"],
    suggested_workup: [
      { title: "复核完整病理", trigger: "报告原文未提供", purpose: "补齐病理关键参数" },
      { title: "完善分期评估", trigger: "当前分期资料不足", purpose: "评估区域淋巴结与远处病灶" },
      { title: "评估分子检测", trigger: "系统治疗讨论需要分子状态时", purpose: "支持后续分层讨论" },
    ],
    treatment_pathways: [
      { title: "局限可切除路径", trigger: "分期支持局限可切除时", purpose: "进入外科和区域淋巴结管理评估" },
      { title: "不可切除或晚期路径", trigger: "上级医师结合分期确认时", purpose: "讨论系统治疗方向" },
    ],
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (action === "web") {
      if (String(url).includes("cancer.gov")) return new Response("Melanoma Stage I Stage II Stage III Stage IV Treatment Option Overview surgery immunotherapy targeted therapy BRAF", { status: 200 });
      return new Response("黑色素瘤诊疗指南", { status: 200 });
    }
    const requestBody = JSON.parse(init.body);
    assert.equal(requestBody.model, "deepseek-v4-pro");
    assert.equal(requestBody.max_output_tokens, 5200);
    return new Response(JSON.stringify({ output_text: JSON.stringify(generated) }), { status: 200 });
  };
  const facts = [{ fact_id: "F1", field: "diagnosis", value: "确诊黑色素瘤3天", event_time: "3天前", event_type: "onset_diagnosis", encounter_scope: "prior", certainty: "explicit", source_ids: ["S1"] }];
  const reference = { ...generated, verification_state: "model_only", disclaimer: "AI参考候选" };
  try {
    return await worker.fetch(
      new Request("http://localhost/api/clinical-reference", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, facts, current_purpose: "进一步评估", ...((action === "local" || action === "web") ? { reference } : {}) }) }),
      { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) }, ARK_CODING_API_KEY: "synthetic-test-key" },
      { waitUntil() {}, passThroughOnException() {} },
    );
  } finally { globalThis.fetch = originalFetch; }
}

async function clinicalReferenceStageWithMockModel(stage) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("reference-stage-test", `${process.pid}-${Date.now()}-${stage}`);
  const { default: worker } = await import(workerUrl.href);
  const diagnosis = {
    preliminary_diagnosis: "黑色素瘤（病理提示，分期待补）",
    diagnostic_basis: ["既往病理资料提示黑色素瘤"],
    differential_diagnosis: ["病理原文不完整时需考虑病理复核"],
    missing_prerequisites: ["原发部位会影响分期表达", "完整病理参数会影响风险分层"],
  };
  const plan = {
    current_priority: "先补齐完整病理与分期前提",
    plan_reasoning: ["当前只能确认病理类型", "治疗路径取决于分期与可切除性"],
    suggested_workup: [{ title: "复核完整病理", trigger: "原始报告未提供", purpose: "补齐关键病理参数" }],
    treatment_pathways: [{ title: "按分期进入后续路径讨论", trigger: "完整分期由医生确认后", purpose: "确定后续局部或系统治疗讨论方向" }],
    decision_changers: ["原发部位", "完整病理报告", "分期影像"],
    next_question: "请先补充完整病理报告的关键参数。",
  };
  const originalFetch = globalThis.fetch;
  let upstreamBody;
  globalThis.fetch = async (_url, init) => {
    upstreamBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ output_text: JSON.stringify(stage === "diagnosis" ? diagnosis : plan) }), { status: 200 });
  };
  const facts = [{ fact_id: "F1", field: "diagnosis", value: "确诊黑色素瘤3天", event_time: "3天前", event_type: "onset_diagnosis", encounter_scope: "prior", certainty: "explicit", source_ids: ["S1"] }];
  try {
    const response = await worker.fetch(
      new Request("http://localhost/api/clinical-reference", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        action: "generate",
        stage,
        facts,
        current_purpose: "进一步评估",
        narrative: { chief_complaint: "确诊黑色素瘤3天", present_illness: "既往病理提示黑色素瘤。" },
        diagnosis,
      }) }),
      { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) }, ARK_CODING_API_KEY: "synthetic-test-key" },
      { waitUntil() {}, passThroughOnException() {} },
    );
    return { response, upstreamBody };
  } finally { globalThis.fetch = originalFetch; }
}

async function clinicalReferenceStageRetriesMelanomaDetailError(stage) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("reference-stage-retry-test", `${process.pid}-${Date.now()}-${stage}`);
  const { default: worker } = await import(workerUrl.href);
  const diagnosis = {
    preliminary_diagnosis: "黑色素瘤（原发部位与分期待补）",
    diagnostic_basis: ["既往病理资料提示黑色素瘤"],
    differential_diagnosis: [],
    missing_prerequisites: ["原发部位", "完整病理参数", "分期评估"],
  };
  const invalidDiagnosis = { ...diagnosis, preliminary_diagnosis: "皮肤黑色素瘤（分期待补）" };
  const validPlan = {
    current_priority: "区分病理免疫组化与后续分子检测缺口",
    plan_reasoning: ["当前只确认做过免疫组化但未取得结果", "BRAF等分子状态需按临床情境另行核对"],
    suggested_workup: [{ title: "调取完整病理与免疫组化报告", trigger: "原报告未提供", purpose: "核对病理诊断依据" }],
    treatment_pathways: [{ title: "按完整分期讨论后续路径", trigger: "诊断与分期由医生确认后", purpose: "确定后续讨论方向" }],
    decision_changers: ["免疫组化原报告", "原发部位", "完整分期"],
    next_question: "请先提供完整病理与免疫组化报告。",
  };
  const invalidPlan = {
    ...validPlan,
    suggested_workup: [{ title: "获取免疫组化具体结果（包括BRAF、NRAS、KIT）", trigger: "结果未提供", purpose: "判断靶向治疗条件" }],
  };
  const outputs = stage === "diagnosis" ? [invalidDiagnosis, diagnosis] : [invalidPlan, validPlan];
  const originalFetch = globalThis.fetch;
  let calls = 0;
  const prompts = [];
  globalThis.fetch = async (_url, init) => {
    prompts.push(JSON.parse(init.body).input);
    return new Response(JSON.stringify({ output_text: JSON.stringify(outputs[Math.min(calls++, outputs.length - 1)]) }), { status: 200 });
  };
  const facts = [
    { fact_id: "F1", field: "diagnosis", value: "确诊黑色素瘤3天", event_time: "3天前", event_type: "onset_diagnosis", encounter_scope: "prior", certainty: "explicit", source_ids: ["S1"] },
    { fact_id: "F2", field: "pathology", value: "免疫组化已完成，具体结果未提供", event_time: "3天前", event_type: "pathology_molecular", encounter_scope: "prior", certainty: "explicit", source_ids: ["S1"] },
  ];
  try {
    const response = await worker.fetch(
      new Request("http://localhost/api/clinical-reference", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        action: "generate",
        stage,
        facts,
        current_purpose: "进一步评估",
        narrative: { chief_complaint: "确诊黑色素瘤3天", present_illness: "免疫组化已完成，具体结果未提供。" },
        diagnosis,
      }) }),
      { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) }, ARK_CODING_API_KEY: "synthetic-test-key" },
      { waitUntil() {}, passThroughOnException() {} },
    );
    return { response, calls, prompts };
  } finally { globalThis.fetch = originalFetch; }
}

async function clinicalReferenceWithUnsupportedStage() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("reference-certainty-test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ output_text: JSON.stringify({
    preliminary_diagnosis: "胸腺肿瘤复发伴胸膜转移，IV期",
    diagnostic_basis: ["胸膜结节提示胸腺肿瘤复发"],
    differential_diagnosis: [],
    missing_prerequisites: ["完整病理及分期资料"],
    suggested_workup: [
      { title: "复核病理", trigger: "原始报告未提供", purpose: "核对病理类型" },
      { title: "复核影像", trigger: "当前分期未明确", purpose: "明确病灶范围" },
    ],
    treatment_pathways: [
      { title: "当前问题评估", trigger: "感染风险未明确时", purpose: "先评估当前风险" },
      { title: "肿瘤路径讨论", trigger: "资料补齐并由上级确认后", purpose: "讨论后续方向" },
    ],
  }) }), { status: 200 });
  const facts = [{ fact_id: "F1", field: "diagnosis", value: "胸膜结节穿刺病理支持胸腺肿瘤复发", event_time: "近期", event_type: "onset_diagnosis", encounter_scope: "prior", certainty: "explicit", source_ids: ["S1"] }];
  try {
    return await worker.fetch(
      new Request("http://localhost/api/clinical-reference", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "generate", facts, current_purpose: "进一步评估" }) }),
      { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) }, ARK_CODING_API_KEY: "synthetic-test-key" },
      { waitUntil() {}, passThroughOnException() {} },
    );
  } finally { globalThis.fetch = originalFetch; }
}

async function clinicalReferenceFallbackWithPriorDiagnosis() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("reference-fallback-test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ output_text: "" }), { status: 200 });
  const facts = [
    { fact_id: "F1", field: "prior_record_diagnosis", value: "既往住院记录明确诊断：粒细胞缺乏；肺部感染；胸腺肿瘤术后放疗后复发", event_time: "既往", event_type: "onset_diagnosis", encounter_scope: "prior", certainty: "explicit", source_ids: ["S1"] },
    { fact_id: "F2", field: "current_status", value: "近期血常规提示中性粒细胞降低", event_time: "近期", event_type: "current_status", encounter_scope: "current", certainty: "explicit", source_ids: ["S1"] },
  ];
  try {
    return await worker.fetch(
      new Request("http://localhost/api/clinical-reference", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "generate", facts, current_purpose: "进一步评估及处理当前问题" }) }),
      { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) }, ARK_CODING_API_KEY: "synthetic-test-key" },
      { waitUntil() {}, passThroughOnException() {} },
    );
  } finally { globalThis.fetch = originalFetch; }
}

test("renders the single-entry admission draft package workflow", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  const html = await response.text();
  const pageSource = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const analyzeSource = await readFile(new URL("../app/api/analyze/route.ts", import.meta.url), "utf8");
  assert.match(html, /OncoPilot/);
  assert.match(html, /肿瘤入院记录草稿助手/);
  assert.match(html, /整理入院资料/);
  assert.match(html, /系统先建立事件账本，再生成可编辑的病史、诊断和下一步参考/);
  assert.match(html, /拍照、上传文件或粘贴文字/);
  assert.match(html, /上传图片/);
  assert.match(html, /上传图片或 PDF/);
  assert.match(html, /HEIC 会先在本机转换/);
  assert.match(html, /最多/);
  assert.match(html, /PDF 最多/);
  assert.match(html, /支持经授权的真实病例测试/);
  assert.match(html, /资料会发送给第三方模型/);
  assert.match(html, /生成内容用于医生复核/);
  assert.match(html, /本次来院目的/);
  assert.match(html, /生成入院记录草稿包/);
  assert.match(html, /事件账本/);
  assert.match(html, /病历草稿/);
  assert.match(html, /只有你点击确认后才加入草稿/);
  assert.match(pageSource, /api\/template-chat\//);
  assert.match(pageSource, /快速 · V4 Flash/);
  assert.match(pageSource, /深入 · V4 Pro/);
  assert.match(pageSource, /正在思考.*秒/);
  assert.match(pageSource, /renderChatContent/);
  assert.match(pageSource, /parseEventStream/);
  assert.doesNotMatch(pageSource, /补充记录：/);
  assert.match(pageSource, /插入医生确认大纲/);
  assert.match(pageSource, /<span>诊断与下一步<\/span><h2>分阶段生成<\/h2>/);
  assert.match(pageSource, /临床事件账本/);
  assert.match(pageSource, /资料时间轴/);
  assert.match(pageSource, /核验来源卡/);
  assert.match(pageSource, /联网核验/);
  assert.match(pageSource, /填入初步诊断整理/);
  assert.match(pageSource, /AI先按现有资料给候选/);
  assert.match(pageSource, /系统不会生成出院诊断/);
  assert.match(pageSource, /stage: "diagnosis"/);
  assert.match(pageSource, /stage: "plan"/);
  assert.match(pageSource, /generation-pipeline/);
  assert.doesNotMatch(pageSource, /action: "starter"/);
  assert.match(pageSource, /等待诊断阶段/);
  assert.match(pageSource, /把候选路径填入计划整理/);
  assert.match(pageSource, /继续问本病例/);
  assert.match(pageSource, /clinical-reference-chat/);
  assert.match(pageSource, /外院转入我院/);
  assert.match(pageSource, /本次到院关系/);
  assert.match(pageSource, /正在用图像模型提取入院关键资料/);
  assert.match(pageSource, /重试本页/);
  assert.doesNotMatch(pageSource, /fetch\("\/api\/extract-images/);
  assert.match(pageSource, /RECOGNITION_CONCURRENCY = 2/);
  assert.match(pageSource, /Math\.min\(RECOGNITION_CONCURRENCY, identified\.length\)/);
  assert.match(analyzeSource, /FACT_EXTRACTION_CONCURRENCY = 2/);
  assert.match(analyzeSource, /Math\.min\(FACT_EXTRACTION_CONCURRENCY, chunks\.length\)/);
  assert.match(pageSource, /const results: Array<string \| null>/);
  assert.match(pageSource, /setSourceText\(baseText/);
  assert.match(pageSource, /正在分段核对事实并生成草稿/);
  assert.match(pageSource, /V4 Pro自动重试后完成事实抽取/);
  assert.match(pageSource, /没有使用程序规则代替模型事实/);
  assert.match(pageSource, /本次未完成/);
  assert.doesNotMatch(pageSource, /连贯合成未完成/);
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

test("uses the configured multimodal Doubao model for image transcription", async () => {
  const response = await extractWithVisionService();
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  assert.equal(body.model, "doubao-seed-2.1-turbo");
  assert.equal(body.method, "vision_transcription");
  assert.equal(body.extracted_text, "完全合成病理资料");
});

test("transcribes several pages in one multimodal Doubao request", async () => {
  const response = await extractBatchWithVisionService();
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  assert.equal(body.model, "doubao-seed-2.1-turbo");
  assert.equal(body.method, "batched_vision_transcription");
  assert.deepEqual(body.pages.map((page) => page.text), ["完全合成第1页", "完全合成第2页", "完全合成第3页"]);
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
  assert.match(body.result.specialist_exam, /cm×/);
  assert.match(body.result.specialist_exam, /双侧颈部、腋窝及腹股沟/);
  assert.match(body.result.specialist_exam, /粘连/);
  assert.doesNotMatch(body.result.specialist_exam, /右侧腋窝.*肿大/);
  assert.deepEqual(body.result.pending_fields, ["过敏史：待核对"]);
});

test("keeps prior discharge diagnoses out of the current admission diagnosis section", async () => {
  const { response, prompts } = await analyzePriorDischargeDiagnosisWithMockModel();
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  const priorDiagnosis = body.result.facts.find((fact) => fact.fact_id === "C1-F1");
  assert.equal(priorDiagnosis.field, "prior_record_diagnosis");
  assert.equal(priorDiagnosis.event_type, "onset_diagnosis");
  assert.equal(priorDiagnosis.encounter_scope, "prior");
  assert.equal(priorDiagnosis.certainty, "explicit");
  assert.match(priorDiagnosis.value, /既往住院记录明确诊断/);
  assert.doesNotMatch(priorDiagnosis.value, /出院诊断/);
  assert.equal(body.result.diagnosis_summary, "");
  assert.doesNotMatch(body.result.present_illness, /出院诊断/);
  assert.match(prompts[0], /当前固定为入院记录路由/);
  assert.match(prompts[1], /不得输出‘出院诊断’/);
});

test("rejects an external-referral ending after the current transfer into our hospital is confirmed", async () => {
  const { response, prompts, calls } = await analyzeExternalTransferWithMockModel(true);
  const raw = await response.clone().text();
  assert.equal(response.status, 502, raw);
  assert.equal(calls, 3, raw);
  const body = await response.json();
  assert.match(body.error, /建议转院.*本次结尾|转入我院/);
  assert.match(prompts[1], /"fact_id":"F-ARRIVAL"/);
  assert.match(prompts[1], /"field":"arrival_context","value":"外院转入我院"/);
  assert.match(prompts[1], /"fact_id":"C1-F-EXAM"[^}]*"encounter_scope":"prior"/);
});

test("keeps transfer-before examination facts prior and out of the current specialist examination", async () => {
  const { response, prompts, calls } = await analyzeExternalTransferWithMockModel(false);
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(calls, 2);
  const body = await response.json();
  const arrivalFact = body.result.facts.find((fact) => fact.fact_id === "F-ARRIVAL");
  const priorExam = body.result.facts.find((fact) => fact.fact_id === "C1-F-EXAM");
  assert.equal(arrivalFact.value, "外院转入我院");
  assert.equal(arrivalFact.encounter_scope, "current");
  assert.equal(priorExam.encounter_scope, "prior");
  assert.match(prompts[1], /"fact_id":"C1-F-EXAM"[^}]*"encounter_scope":"prior"/);
  assert.match(body.result.present_illness, /转入我院.*收治入院/);
  assert.doesNotMatch(body.result.specialist_exam, /39\.1|132次\/分|右肺呼吸音低/);
  assert.match(body.result.specialist_exam, /待查体/);
});

test("keeps the current transfer after the external referral even when arrival is only present in source facts", async () => {
  const { response } = await analyzeSourceConfirmedTransferWithoutSelector();
  const body = await response.json();
  if (!response.ok) {
    assert.ok(response.status === 400 || response.status === 502);
    assert.equal(body.result, undefined);
    assert.match(body.error, /转入我院|建议转院|到院关系|质量门禁/);
    return;
  }
  const presentIllness = body.result.present_illness;
  const referralIndex = presentIllness.lastIndexOf("建议转上级医院");
  const arrivalIndex = Math.max(presentIllness.lastIndexOf("转入我院"), presentIllness.lastIndexOf("收治入院"));
  assert.ok(referralIndex >= 0, presentIllness);
  assert.ok(arrivalIndex > referralIndex, presentIllness);
});

test("does not mix a non-numeric external examination finding into a partial current examination", async () => {
  const { response } = await analyzeMixedExternalAndCurrentExam();
  const body = await response.json();
  if (!response.ok) {
    assert.equal(response.status, 502);
    assert.equal(body.result, undefined);
    assert.match(body.error, /查体|质量门禁/);
    return;
  }
  assert.match(body.result.specialist_exam, /神志清楚/);
  assert.doesNotMatch(body.result.specialist_exam, /右肺呼吸音低/);
});

test("retries when chief-complaint duration is invented or explicit admission closure is omitted", async () => {
  const { response, calls } = await analyzeRetriesUnsupportedChiefDurationAndMissingAdmissionClosure();
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(calls, 3);
  const body = await response.json();
  assert.equal(body.draft_retry_count, 1);
  assert.doesNotMatch(body.result.chief_complaint, /6天/);
  assert.match(body.result.present_illness, /收治入院/);
});

test("rejects markdown headings and source module labels instead of showing them as a draft", async () => {
  const response = await analyzeWithContaminatedModelDraft();
  assert.equal(response.status, 502, await response.clone().text());
  const body = await response.json();
  assert.match(body.error, /质量门禁|未展示规则拼接草稿/);
  assert.equal(body.result, undefined);
});

test("stops after two failed fact-extraction attempts instead of generating from rule fallback", async () => {
  const { response, extractionCalls, draftCalls } = await analyzeAfterRepeatedExtractionFailure();
  assert.equal(response.status, 502, await response.clone().text());
  const body = await response.json();
  assert.equal(extractionCalls, 2);
  assert.equal(draftCalls, 0);
  assert.equal(body.result, undefined);
  assert.match(body.error, /事实|结构|重试|质量门禁/);
});

test("segments a ten-page source, limits concurrency, and bounds source evidence", async () => {
  const { response, extractionCalls, draftCalls, maxActiveExtractions } = await analyzeLongSourceWithMockModel();
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  assert.equal(body.processing_mode, "chunked");
  assert.ok(body.chunk_count >= 2);
  assert.equal(extractionCalls, body.chunk_count);
  assert.equal(maxActiveExtractions, Math.min(2, body.chunk_count));
  assert.equal(draftCalls, 1);
  assert.ok(body.result.sources.every((source) => source.evidence.length <= 500));
  assert.equal(body.result.facts.length, body.chunk_count + 1);
  assert.ok(body.result.facts.some((fact) => fact.fact_id === "F-PURPOSE"));
  assert.ok(body.result.facts.filter((fact) => fact.fact_id !== "F-PURPOSE").every((fact) => /^C\d+-F1$/.test(fact.fact_id)));
});

test("keeps first-, second-, and third-line treatment plus unrelated history in their sections", async () => {
  const response = await analyzeMultiLineTreatmentHistory();
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  const narrative = body.result.present_illness;
  const milestones = ["确诊某肿瘤", "一线治疗", "2020年3月评估进展", "二线治疗", "2021年6月再次进展", "三线治疗", "发热1天"];
  for (const milestone of milestones) assert.match(narrative, new RegExp(milestone));
  assert.match(body.result.past_history, /高血压5年/);
  assert.match(body.result.past_history, /阑尾切除术/);
  assert.doesNotMatch(narrative, /阑尾切除术/);
});

test("returns an error instead of a program-built draft when long-source prose generation fails", async () => {
  const { response, extractionCalls, draftCalls } = await analyzeLongSourceWithMockModel(true);
  assert.equal(response.status, 502, await response.clone().text());
  const body = await response.json();
  assert.ok(extractionCalls >= 2);
  assert.equal(draftCalls, 2);
  assert.match(body.error, /未展示规则拼接草稿|重试/);
  assert.equal(body.result, undefined);
});

test("does not expose raw unparsed reports when prose generation also fails", async () => {
  const { response } = await analyzeLongSourceWithMockModel(true, true);
  assert.equal(response.status, 502, await response.clone().text());
  const body = await response.json();
  assert.equal(body.result, undefined);
  assert.doesNotMatch(JSON.stringify(body), /完全合成检查摘要|视觉转录|###|已核验事实顺序稿/);
});

test("stops after repeated long-source extraction failure instead of retaining raw fallback facts", async () => {
  const { response, extractionCalls, draftCalls } = await analyzeLongSourceWithMockModel(false, true);
  assert.equal(response.status, 502, await response.clone().text());
  const body = await response.json();
  assert.ok(extractionCalls >= 4);
  assert.equal(extractionCalls % 2, 0);
  assert.equal(draftCalls, 0);
  assert.equal(body.result, undefined);
  assert.match(body.error, /自动重试.*未使用规则事实/);
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
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  const stream = await response.text();
  assert.ok(stream.indexOf("event: delta") < stream.indexOf("event: done"));
  assert.match(stream, /deepseek-v4-pro/);
  assert.match(stream, /\*\*重点\*\*/);
  assert.doesNotMatch(stream, /\*记录示例\*/);
  assert.match(stream, /部位、大小、质地、活动度及压痛/);
});

test("template chat rejects models outside the documented selector", async () => {
  const { response } = await templateChatWithMockModel("unknown-model");
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.match(body.error, /不支持的模型/);
});

test("clinical reference chat uses V4 Pro with filtered structured context and streams buffered delta then done", async () => {
  const { response, stream, upstreamBody, upstreamCalls } = await clinicalReferenceChatWithMockModel();
  assert.equal(response.status, 200);
  assert.equal(upstreamCalls, 1);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  assert.equal(upstreamBody.model, "deepseek-v4-pro");
  assert.equal(upstreamBody.stream, undefined);
  assert.equal(upstreamBody.max_output_tokens, 3600);
  assert.deepEqual(upstreamBody.thinking, { type: "disabled" });
  assert.match(upstreamBody.input, /完全合成病例：今日发热伴白细胞下降/);
  assert.match(upstreamBody.input, /本次来院目的：外院转入我院后进一步评估发热/);
  assert.match(upstreamBody.input, /发热伴血细胞下降，感染风险待评估/);
  assert.match(upstreamBody.input, /先讨论抗感染方向/);
  assert.match(upstreamBody.input, /可以先按风险和缺失前提展开/);
  assert.doesNotMatch(upstreamBody.input, /RAW_SOURCE_TEXT_MUST_NOT_REACH_UPSTREAM/);
  assert.doesNotMatch(upstreamBody.input, /RAW_UNPARSED_FACT_MUST_NOT_REACH_UPSTREAM/);
  assert.ok(stream.indexOf("event: delta") < stream.indexOf("event: done"));
  assert.match(stream, /deepseek-v4-pro/);
  assert.match(stream, /候选方向一/);
  assert.match(stream, /病原学、过敏史、肾功能、肝功能/);
  assert.match(stream, /单次剂量、给药频次、稀释液、总体积、输注时间、配伍与复评节点/);
  assert.match(stream, /"mode":"model"/);
});

test("clinical reference chat limits a model list to three medication candidates", async () => {
  const answer = [
    "候选方向一：讨论第一类抗菌药候选。",
    "候选方向二：讨论第二类抗菌药候选。",
    "候选方向三：讨论第三类抗菌药候选。",
    "候选方向四：讨论第四类抗菌药候选。",
    "开立前待核对：过敏史、肾功能、肝功能、病原学、既往抗菌药、院内药品规格、单次剂量、给药频次、稀释液、总体积、输注时间、配伍与复评节点。",
  ].join("\n");
  const { response, stream, upstreamCalls } = await clinicalReferenceChatWithMockModel(answer);
  assert.equal(response.status, 200);
  assert.equal(upstreamCalls, 2);
  assert.match(stream, /第一类抗菌药候选|第二类抗菌药候选|第三类抗菌药候选/);
  assert.doesNotMatch(stream, /第四类抗菌药候选/);
  assert.match(stream, /"mode":"salvaged"/);
  assert.doesNotMatch(stream, /event: error/);
});

test("clinical reference chat rewrites an executable medication answer before showing it", async () => {
  const { response, stream, upstreamBodies } = await clinicalReferenceChatRewritesExecutableAnswer();
  assert.equal(response.status, 200);
  assert.equal(upstreamBodies.length, 2);
  assert.equal(upstreamBodies[0].max_output_tokens, 3600);
  assert.equal(upstreamBodies[1].max_output_tokens, 3600);
  assert.deepEqual(upstreamBodies[0].thinking, { type: "disabled" });
  assert.deepEqual(upstreamBodies[1].thinking, { type: "disabled" });
  assert.equal(upstreamBodies[0].stream, undefined);
  assert.equal(upstreamBodies[1].stream, undefined);
  assert.match(upstreamBodies[1].input, /上一版出现了未经审核即可执行(?:的剂量、频次和给药方式组合|或容易被误抄的用药格式)/);
  assert.ok(stream.indexOf("event: delta") < stream.indexOf("event: done"));
  assert.doesNotMatch(stream, /4\.5\s*g|q8h|可直接使用/);
  assert.match(stream, /开立前待核对：外院用药经过、院内药品规格/);
  assert.match(stream, /"mode":"model"/);
  assert.doesNotMatch(stream, /event: error/);
});

test("clinical reference chat also rewrites a spaced q 8 h medication instruction", async () => {
  const { response, stream, upstreamBodies } = await clinicalReferenceChatRewritesSpacedFrequency();
  assert.equal(response.status, 200);
  assert.equal(upstreamBodies.length, 2);
  assert.match(upstreamBodies[1].input, /未经审核即可执行|删除所有具体剂量/);
  assert.doesNotMatch(stream, /4\.5\s*g|q\s*8\s*h|可直接使用/);
  assert.match(stream, /单次剂量、给药频次、溶媒、总体积、输注时间、配伍和复评节点/);
  assert.match(stream, /"mode":"model"/);
  assert.doesNotMatch(stream, /event: error/);
});

test("clinical reference chat does not upgrade uncertain imaging to definite stage or metastasis", async () => {
  const { response, stream, upstreamBodies } = await clinicalReferenceChatRejectsCertaintyInflation();
  assert.equal(response.status, 200);
  assert.ok(upstreamBodies.length >= 1);
  assert.doesNotMatch(stream, /已明确为IV期转移性胸腺瘤|应按晚期疾病处理/);
  assert.match(stream, /event: error|仅支持影像考虑|尚不能据此确定/);
});

test("clinical reference chat rewrites unverified thresholds and compatibility claims", async () => {
  const { response, stream, upstreamBodies } = await clinicalReferenceChatRewritesUnverifiedThresholdsAndCompatibility();
  assert.equal(response.status, 200);
  assert.equal(upstreamBodies.length, 2);
  assert.match(upstreamBodies[1].input, /数值阈值、强制升级规则|具体配伍结论/);
  assert.doesNotMatch(stream, /90天|72-96小时|必须升级|需分瓶/);
  assert.match(stream, /单次剂量、给药频次、稀释液、总体积、输注时间、同通道配伍和复评时间/);
  assert.match(stream, /"mode":"model"/);
  assert.doesNotMatch(stream, /event: error/);
});

test("clinical reference chat keeps safe case-specific directions when the rewrite is empty", async () => {
  const { response, stream, upstreamBodies } = await clinicalReferenceChatSalvagesSafeDirectionsAfterRejectedRewrite();
  assert.equal(response.status, 200);
  assert.equal(upstreamBodies.length, 2);
  assert.ok(stream.indexOf("event: delta") < stream.indexOf("event: done"));
  assert.doesNotMatch(stream, /event: error/);
  assert.match(stream, /抗假单胞菌β-内酰胺类候选/);
  assert.match(stream, /是否增加抗MRSA覆盖/);
  assert.match(stream, /高热伴咳嗽、咳痰及气促/);
  assert.match(stream, /V4 Pro本轮候选（已删除未核验执行细节）/);
  assert.match(stream, /系统补充的开立前待核对字段（不是V4 Pro处方）/);
  assert.match(stream, /"mode":"salvaged"/);
  for (const field of ["本院药品信息", "单次剂量", "给药频次", "稀释液", "总体积", "输注时间", "配伍禁忌", "复评时点"]) assert.match(stream, new RegExp(field));
  assert.doesNotMatch(stream, /4\.5\s*g|q8h|90天|72-96小时|必须升级|需分瓶|甲泼尼龙|机械通气|化疗/);
});

test("clinical reference chat safely reduces both model answers when the rewrite still violates a gate", async () => {
  const unsafeRewrite = [
    "候选一：在重度粒细胞缺乏背景下调整抗菌药物类别的候选",
    "若近90天用过某药，必须升级为另一类；72小时复评。",
    "配伍禁忌：某药与另一药必须分瓶。",
  ].join("\n");
  const { response, stream, upstreamBodies } = await clinicalReferenceChatSalvagesSafeDirectionsAfterRejectedRewrite(unsafeRewrite);
  assert.equal(response.status, 200);
  assert.equal(upstreamBodies.length, 2);
  assert.match(stream, /抗假单胞菌β-内酰胺类候选/);
  assert.match(stream, /V4 Pro本轮候选（已删除未核验执行细节）/);
  assert.match(stream, /系统补充的开立前待核对字段/);
  assert.match(stream, /"mode":"salvaged"/);
  assert.doesNotMatch(stream, /event: error|90天|72小时|必须升级|必须分瓶|重度粒细胞缺乏/);
});

test("clinical reference chat never labels an old reference pathway as this round model candidate", async () => {
  const { response, stream } = await clinicalReferenceChatSalvagesSafeDirectionsAfterRejectedRewrite("", {
    firstAnswer: "当前资料不足，暂不能形成病例化回答。",
    referencePathways: [{ title: "旧参考中的抗感染候选", trigger: "旧条件", purpose: "旧目的" }],
  });
  assert.equal(response.status, 200);
  assert.match(stream, /event: error/);
  assert.doesNotMatch(stream, /event: done|旧参考中的抗感染候选|V4 Pro本轮候选/);
});

test("clinical reference chat rejects a suspected phone number before calling the model", async () => {
  const { response, upstreamCalls } = await clinicalReferenceChatWithSyntheticPhone();
  assert.equal(response.status, 400, await response.clone().text());
  const body = await response.json();
  assert.match(body.error, /疑似身份证号或手机号/);
  assert.equal(upstreamCalls, 0);
});

test("generates a useful conditional clinical reference without executable prescriptions", async () => {
  const response = await clinicalReferenceWithMockModel();
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  assert.equal(body.result.verification_state, "model_only");
  assert.match(body.result.preliminary_diagnosis, /黑色素瘤/);
  assert.doesNotMatch(body.result.preliminary_diagnosis, /皮肤|黏膜|眼/);
  assert.ok(body.result.suggested_workup.length >= 3);
  assert.ok(body.result.treatment_pathways.length >= 2);
  assert.doesNotMatch(JSON.stringify(body.result), /每日|每次|mg|静滴/);
});

test("generates diagnosis and plan as two independent model stages", async () => {
  const diagnosisRun = await clinicalReferenceStageWithMockModel("diagnosis");
  assert.equal(diagnosisRun.response.status, 200, await diagnosisRun.response.clone().text());
  const diagnosisBody = await diagnosisRun.response.json();
  assert.equal(diagnosisBody.stage, "diagnosis");
  assert.match(diagnosisBody.result.preliminary_diagnosis, /黑色素瘤/);
  assert.equal(diagnosisRun.upstreamBody.max_output_tokens, 3000);
  assert.match(diagnosisRun.upstreamBody.input, /本轮只整理初步诊断/);

  const planRun = await clinicalReferenceStageWithMockModel("plan");
  assert.equal(planRun.response.status, 200, await planRun.response.clone().text());
  const planBody = await planRun.response.json();
  assert.equal(planBody.stage, "plan");
  assert.match(planBody.result.current_priority, /病理与分期/);
  assert.equal(planRun.upstreamBody.max_output_tokens, 3600);
  assert.match(planRun.upstreamBody.input, /当前先解决什么/);
});

test("retries unsupported melanoma site and IHC-molecular conflation in staged generation", async () => {
  const diagnosisRun = await clinicalReferenceStageRetriesMelanomaDetailError("diagnosis");
  assert.equal(diagnosisRun.response.status, 200, await diagnosisRun.response.clone().text());
  assert.equal(diagnosisRun.calls, 2);
  assert.match(diagnosisRun.prompts[1], /未通过诊断质量门禁/);
  const diagnosisBody = await diagnosisRun.response.json();
  assert.doesNotMatch(diagnosisBody.result.preliminary_diagnosis, /皮肤/);

  const planRun = await clinicalReferenceStageRetriesMelanomaDetailError("plan");
  assert.equal(planRun.response.status, 200, await planRun.response.clone().text());
  assert.equal(planRun.calls, 2);
  assert.match(planRun.prompts[1], /未通过计划质量门禁/);
  const planBody = await planRun.response.json();
  assert.doesNotMatch(JSON.stringify(planBody.result), /免疫组化具体结果（包括BRAF/);
});

test("returns an error instead of a generic built-in reference when V4 Pro is empty", async () => {
  const response = await clinicalReferenceFallbackWithPriorDiagnosis();
  assert.equal(response.status, 502, await response.clone().text());
  const body = await response.json();
  assert.match(body.error, /V4 Pro.*未展示通用套话/);
  assert.equal(body.result, undefined);
});

test("rejects an unsupported stage or metastasis claim in the model reference", async () => {
  const response = await clinicalReferenceWithUnsupportedStage();
  assert.equal(response.status, 502, await response.clone().text());
  const body = await response.json();
  assert.match(body.error, /未展示通用套话/);
  assert.equal(body.result, undefined);
});

test("cross-checks the generated reference against the local CSCO source card", async () => {
  const response = await clinicalReferenceWithMockModel("local");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.result.verification_state, "local_checked");
  assert.ok(body.result.checks.some((check) => /2025 CSCO/.test(check.source)));
  assert.ok(body.result.checks.some((check) => /治疗方向/.test(check.topic) && check.status === "conditional"));
});

test("cross-checks official web sources without requiring another model JSON response", async () => {
  const response = await clinicalReferenceWithMockModel("web");
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  assert.equal(body.result.verification_state, "web_checked");
  assert.ok(body.result.checks.some((check) => /NCI/.test(check.source)));
  assert.ok(body.result.checks.some((check) => /国家卫生健康委/.test(check.source)));
  assert.ok(body.result.checks.every((check) => check.url));
});
