"use client";

import { ChangeEvent, useState } from "react";
import Image from "next/image";

type Stage = "input" | "result";
type UploadStatus = "preparing" | "recognizing" | "done" | "error";
type DraftField = "chief_complaint" | "present_illness" | "past_history" | "personal_history" | "family_history" | "allergy_history" | "specialist_exam" | "diagnosis_summary" | "plan_summary";
type Fact = { fact_id: string; field: string; value: string; event_time: string; event_type: string; encounter_scope: "prior" | "current" | "unclear"; certainty: "explicit" | "doctor_confirmed" | "uncertain" | "pending"; source_ids: string[] };
type ReviewOption = { option_id: string; label: string; text: string; tone: "positive" | "negative" | "neutral" };
type ReviewItem = { choice_id: string; group: "发病与确诊" | "症状核对" | "其他病史" | "专科查体"; section: DraftField; prompt: string; help: string; options: ReviewOption[] };
type AnalysisResult = Record<DraftField, string> & { pending_fields: string[]; sources: Array<{ source_id: string; title: string; evidence: string }>; facts: Fact[]; review_items: ReviewItem[]; template_mode: boolean; template_name: string };
type UploadItem = { id: string; name: string; preview?: string; status: UploadStatus; error?: string };
type PreparedInput = { name: string; file: File; preview?: string };

const MAX_ITEMS = 20;
const MAX_PDF_PAGES = 20;
const MAX_UPLOAD_BYTES = 900_000;
const MAX_EDGE = 1800;
const MAX_SOURCE_CHARS = 32_000;
const RECOGNITION_CONCURRENCY = 3;

const sectionLabels: Array<{ field: DraftField; label: string; hint: string; large?: boolean }> = [
  { field: "chief_complaint", label: "主诉", hint: "疾病或主要症状 + 时间 + 本次目的" },
  { field: "present_illness", label: "现病史", hint: "按时间线整理确诊、既往治疗、进展证据与本次情况", large: true },
  { field: "past_history", label: "既往史", hint: "仅写资料中已确认的既往疾病和相关情况" },
  { field: "personal_history", label: "个人史", hint: "未提供时留空，不自动写无特殊" },
  { field: "family_history", label: "家族史", hint: "未提供时留空，不自动写否认" },
  { field: "allergy_history", label: "过敏史", hint: "仅写已确认过敏或已确认无过敏" },
  { field: "specialist_exam", label: "专科体格检查", hint: "只整理医生实际查体所见；未查体不写正常", large: true },
  { field: "diagnosis_summary", label: "诊断整理", hint: "只整理医生已明确给出的判断，不由 AI 诊断" },
  { field: "plan_summary", label: "计划整理", hint: "只整理医生已明确给出的计划，不新增治疗建议", large: true },
];

const syntheticSample = `【S1 完全合成简要资料】
患者已确诊黑色素瘤3天，免疫组化已完成，具体结果未提供。其他检查、既往病史、近期症状及专科查体均未提供。`;

const isHeic = (file: File) => file.type === "image/heic" || file.type === "image/heif" || /\.hei[cf]$/i.test(file.name);
const isPdf = (file: File) => file.type === "application/pdf" || /\.pdf$/i.test(file.name);

const readPayload = async (response: Response) => {
  const raw = await response.text();
  try { return JSON.parse(raw) as { extracted_text?: string; error?: string }; } catch {
    return { error: response.status === 413 ? "文件过大，已停止上传。请改用更清晰但更小的图片，或拆分 PDF。" : `图片服务返回异常（${response.status}），请重试。` };
  }
};

const canvasToFile = (canvas: HTMLCanvasElement, name: string, quality: number) => new Promise<File>((resolve, reject) => {
  canvas.toBlob((blob) => blob ? resolve(new File([blob], name, { type: "image/jpeg" })) : reject(new Error("图片转换失败")), "image/jpeg", quality);
});

const compressImage = async (input: File, displayName: string) => {
  let source: Blob = input;
  if (isHeic(input)) {
    const { default: heic2any } = await import("heic2any");
    const converted = await heic2any({ blob: input, toType: "image/jpeg", quality: 0.88 });
    source = Array.isArray(converted) ? converted[0] : converted;
  }
  const bitmap = await createImageBitmap(source);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("图片预处理失败");
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  for (const quality of [0.82, 0.7, 0.58, 0.45]) {
    const file = await canvasToFile(canvas, displayName.replace(/\.[^.]+$/, "") + ".jpg", quality);
    if (file.size <= MAX_UPLOAD_BYTES) return file;
  }
  throw new Error("图片压缩后仍然过大，请裁剪到单页或拍得更近一些");
};

const pdfToImages = async (file: File): Promise<PreparedInput[]> => {
  const pdfjs = await import("pdfjs-dist");
  const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  if (pdf.numPages > MAX_PDF_PAGES) throw new Error(`PDF 共 ${pdf.numPages} 页；演示版一次最多识别 ${MAX_PDF_PAGES} 页，请拆分后上传。`);
  const pages: PreparedInput[] = [];
  for (let index = 1; index <= pdf.numPages; index += 1) {
    const page = await pdf.getPage(index);
    const viewport = page.getViewport({ scale: 1.7 });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("PDF 页面转换失败");
    await page.render({ canvas, canvasContext: context, viewport }).promise;
    const raw = await canvasToFile(canvas, `${file.name.replace(/\.pdf$/i, "")}-第${index}页.jpg`, 0.88);
    const compressed = await compressImage(raw, raw.name);
    pages.push({ name: `${file.name} · 第${index}页`, file: compressed, preview: URL.createObjectURL(compressed) });
  }
  return pages;
};

export default function Home() {
  const [stage, setStage] = useState<Stage>("input");
  const [sourceText, setSourceText] = useState("");
  const [currentPurpose, setCurrentPurpose] = useState("");
  const [draft, setDraft] = useState<AnalysisResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [selectedChoices, setSelectedChoices] = useState<Record<string, string>>({});
  const [appliedChoiceText, setAppliedChoiceText] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const busy = uploads.some((item) => item.status === "preparing" || item.status === "recognizing");

  const updateUpload = (id: string, patch: Partial<UploadItem>) => setUploads((items) => items.map((item) => item.id === id ? { ...item, ...patch } : item));
  const updateDraft = (field: DraftField, value: string) => setDraft((current) => current ? { ...current, [field]: value } : current);
  const selectReviewOption = (item: ReviewItem, selected: ReviewOption) => {
    const previousText = appliedChoiceText[item.choice_id] || "";
    setDraft((current) => {
      if (!current) return current;
      let sectionText = current[item.section];
      if (previousText && sectionText.includes(previousText)) sectionText = sectionText.replace(previousText, "").replace(/\s{2,}/g, " ").trim();
      if (selected.text) sectionText = [sectionText.trim(), selected.text].filter(Boolean).join(" ");
      return { ...current, [item.section]: sectionText };
    });
    setSelectedChoices((current) => ({ ...current, [item.choice_id]: selected.option_id }));
    setAppliedChoiceText((current) => ({ ...current, [item.choice_id]: selected.text }));
  };

  const analyze = async () => {
    if (sourceText.trim().length < 20 || loading) return;
    setLoading(true); setError("");
    try {
      const response = await fetch("/api/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source_text: sourceText, current_purpose: currentPurpose }) });
      const payload = await readPayload(response) as { result?: AnalysisResult; error?: string };
      if (!response.ok || !payload.result) throw new Error(payload.error || "AI整理失败，请稍后重试。");
      setDraft(payload.result); setStage("result");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "AI整理失败，请稍后重试。"); } finally { setLoading(false); }
  };

  const recognize = async (input: PreparedInput): Promise<string | null> => {
    const id = crypto.randomUUID();
    setUploads((items) => [...items, { id, name: input.name, preview: input.preview, status: "recognizing" }]);
    try {
      const formData = new FormData(); formData.append("image", input.file);
      const response = await fetch("/api/extract-image", { method: "POST", body: formData });
      const payload = await readPayload(response);
      if (!response.ok || !payload.extracted_text) throw new Error(payload.error || "图片暂时没有识别出来。");
      updateUpload(id, { status: "done" });
      return `【${input.name}｜AI识别，待核对】\n${payload.extracted_text.trim()}`;
    } catch (caught) { updateUpload(id, { status: "error", error: caught instanceof Error ? caught.message : "图片识别失败" }); return null; }
  };

  const chooseDocuments = async (event: ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(event.target.files || []); event.target.value = "";
    if (!selected.length) return;
    if (busy) { setError("正在识别上一批资料，请完成后再继续添加。"); return; }
    setError("");
    try {
      const prepared: PreparedInput[] = [];
      for (const file of selected) {
        if (isPdf(file)) prepared.push(...await pdfToImages(file));
        else if (file.type.startsWith("image/") || isHeic(file)) {
          const compressed = await compressImage(file, file.name);
          prepared.push({ name: file.name, file: compressed, preview: URL.createObjectURL(compressed) });
        } else throw new Error("仅支持图片或 PDF 文件。");
      }
      if (uploads.length + prepared.length > MAX_ITEMS) {
        prepared.forEach((item) => item.preview && URL.revokeObjectURL(item.preview));
        throw new Error(`一次最多识别 ${MAX_ITEMS} 张图或 PDF 页面，请分批上传。`);
      }
      for (let offset = 0; offset < prepared.length; offset += RECOGNITION_CONCURRENCY) {
        const batch = prepared.slice(offset, offset + RECOGNITION_CONCURRENCY);
        const headings = (await Promise.all(batch.map(recognize))).filter((heading): heading is string => Boolean(heading));
        if (headings.length) setSourceText((current) => current.trim() ? `${current.trim()}\n\n${headings.join("\n\n")}` : headings.join("\n\n"));
      }
    } catch (caught) { setError(caught instanceof Error ? caught.message : "文件处理失败，请重试。"); }
  };

  const chooseFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; if (!file) return;
    if (file.size > 100_000) { setError("演示版一次最多读取100KB文本，请精简后重试。"); return; }
    setSourceText(await file.text()); setError("");
  };

  const reset = () => { setStage("input"); setSourceText(""); setCurrentPurpose(""); setDraft(null); setUploads([]); setSelectedChoices({}); setAppliedChoiceText({}); setCopied(false); setError(""); };
  const copyDraft = async () => {
    if (!draft) return;
    const text = sectionLabels.map(({ field, label }) => draft[field].trim() ? `${label}：\n${draft[field].trim()}` : "").filter(Boolean).join("\n\n");
    await navigator.clipboard.writeText(text); setCopied(true); window.setTimeout(() => setCopied(false), 1600);
  };
  const selectedCount = Object.keys(selectedChoices).length;
  const unresolvedMarkers = draft ? sectionLabels.filter(({ field }) => /【[^】]+】/.test(draft[field])).length : 0;
  const reviewGroups = draft ? (["发病与确诊", "症状核对", "其他病史", "专科查体"] as const).map((group) => ({ group, items: draft.review_items.filter((item) => item.group === group) })).filter(({ items }) => items.length) : [];

  return <main className="site-shell">
    <header className="site-header"><button type="button" className="wordmark" onClick={reset} aria-label="返回首页"><span>OP</span><div><strong>OncoPilot</strong><small>肿瘤入院记录草稿助手</small></div></button><div className="model-pill"><i /> 候选项需医生确认</div></header>
    <div className="stage-line two-steps" aria-label="当前流程"><span className={stage === "input" ? "active" : "done"}><b>1</b>放入资料</span><i /><span className={stage === "result" ? "active" : ""}><b>2</b>核对草稿包</span></div>
    {stage === "input" && <section className="single-flow input-stage">
      <div className="hero-copy"><span className="eyebrow">单入口 · 入院记录草稿包</span><h1>资料再少，也先给你<br /><em>一套可选择、可补全的草稿</em></h1><p>已提供的内容先整理成事实；未提供的部分按肿瘤类型生成选择项。你点选确认后，句子才会加入草稿，不用从空白开始默写。</p></div>
      <div className="input-card">
        <div className="card-heading"><div><span>第一步只有这一个入口</span><h2>拍照、上传文件，或粘贴文字</h2></div><button type="button" onClick={() => { setSourceText(syntheticSample); setCurrentPurpose("进一步抗肿瘤治疗"); setError(""); }}>试试少量资料</button></div>
        <p className="reference-status"><b>安全边界</b> 仅使用完全合成或严格脱敏资料；本地规则只约束草稿结构，不替代本院模板和上级审核。</p>
        <label className="purpose-field"><span>本次来院目的 <b>可选，但建议填写</b></span><input value={currentPurpose} onChange={(event) => setCurrentPurpose(event.target.value)} maxLength={160} placeholder="例如：继续治疗、复查评估、处理新出现的症状……" /><small>这行用于区分既往住院、出院计划与本次就诊。</small></label>
        <div className="image-actions" aria-label="资料文件输入"><label className="image-action camera-action">拍照<input type="file" accept="image/*" capture="environment" multiple onChange={chooseDocuments} /></label><label className="image-action">上传图片或 PDF<input type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif,application/pdf,.pdf" multiple onChange={chooseDocuments} /></label><span>最多 {MAX_ITEMS} 个资料页；PDF 最多 {MAX_PDF_PAGES} 页；HEIC 会先在本机转换</span></div>
        {uploads.length > 0 && <div className="upload-list">{uploads.map((item) => <div className={`upload-item ${item.status}`} key={item.id}>{item.preview ? <Image unoptimized src={item.preview} width={54} height={42} alt="待识别资料预览" /> : <span className="file-icon">PDF</span>}<span><strong>{item.name}</strong><small>{item.status === "recognizing" ? "正在识别并填入下方…" : item.status === "done" ? "已识别并填入下方，请核对文字" : item.error || "文件处理失败"}</small></span></div>)}</div>}
        <textarea value={sourceText} onChange={(event) => { setSourceText(event.target.value); setError(""); }} placeholder="把外院病理、检查、手术和治疗经过，本次症状，已询问的病史，实际查体，以及医生明确写下的诊断/计划放在这里……" aria-label="患者资料" maxLength={MAX_SOURCE_CHARS} />
        <div className="input-footer"><label className="file-choice">选择文本文件<input type="file" accept=".txt,.md,.json,text/plain" onChange={chooseFile} /></label><span>{sourceText.length}/{MAX_SOURCE_CHARS}</span></div>
        {error && <p className="error-message" role="alert">{error}</p>}
        <button type="button" className="primary-action" disabled={sourceText.trim().length < 20 || loading || busy} onClick={analyze}>{loading ? <><i className="spinner" />正在先核对事实，再生成草稿</> : <>生成入院记录草稿包 <b>→</b></>}</button>
        <p className="privacy-copy">系统会提供候选阴性项和查体模板，但只有你点击确认后才加入草稿。</p>
      </div>
      <div className="output-promise three-items" aria-label="系统输出"><div><b>01</b><span><strong>先整理已知事实</strong><small>来源、时间、本次/既往、证据强度</small></span></div><div><b>02</b><span><strong>再给候选选项</strong><small>症状、病史、检查经过和专科查体</small></span></div><div><b>03</b><span><strong>点选后进入草稿</strong><small>保留人工判断，又不用从零书写</small></span></div></div>
    </section>}
    {stage === "result" && draft && <section className="single-flow result-stage draft-package">
      <div className="result-title"><div><span className="success-mark">✓</span><span><small>草稿骨架与候选项已生成</small><h1>先点选补全，再微调文字</h1></span></div><button type="button" className="copy-all" onClick={copyDraft}>{copied ? "已复制当前草稿" : unresolvedMarkers ? "复制当前草稿（含待完成标记）" : "复制当前草稿"}</button></div>
      <div className="safety-banner"><strong>{draft.template_name}</strong><span>方括号是待完成项；下面的候选内容默认不算事实，只有点击后才加入对应草稿。</span></div>
      {draft.review_items.length > 0 && <section className="guided-review">
        <div className="guided-heading"><div><span>快速补全</span><h2>把问诊和查体改成选择题</h2><p>已选择 {selectedCount}/{draft.review_items.length} 项。阳性结果仍可在草稿中补具体时间、部位和程度。</p></div><div className="choice-legend"><span className="positive">有 / 异常</span><span className="negative">无 / 正常</span><span>未问 / 未查</span></div></div>
        <div className="review-groups">{reviewGroups.map(({ group, items }) => <section className="review-group" key={group}><h3>{group}</h3><div className="review-items">{items.map((item) => <div className="review-item" key={item.choice_id}><div className="review-question"><strong>{item.prompt}</strong><small>{item.help}</small></div><div className="review-options">{item.options.map((option) => <button type="button" key={option.option_id} className={`${option.tone} ${selectedChoices[item.choice_id] === option.option_id ? "selected" : ""}`} onClick={() => selectReviewOption(item, option)}>{option.label}</button>)}</div></div>)}</div></section>)}</div>
      </section>}
      <div className="draft-grid">
        {sectionLabels.map(({ field, label, hint, large }) => <section className={`draft-section ${large ? "wide" : ""} ${field === "diagnosis_summary" || field === "plan_summary" ? "doctor-only" : ""}`} key={field}>
          <div><label htmlFor={field}>{label}</label><small>{hint}</small></div>
          <textarea id={field} value={draft[field]} onChange={(event) => updateDraft(field, event.target.value)} placeholder="可在上方点选候选项，也可直接输入" rows={large ? 7 : 4} />
        </section>)}
      </div>
      {draft.pending_fields.length > 0 && <section className="follow-up-card pending-card"><div className="section-heading"><span>待核对</span><h2>这些缺口可能影响草稿落笔</h2></div><div className="pending-list">{draft.pending_fields.map((item) => <span key={item}>{item}</span>)}</div></section>}
      <details className="source-details"><summary>查看结构化事实与资料来源（{draft.facts.length} 条事实）</summary><div className="fact-list">{draft.facts.map((fact) => <div key={fact.fact_id}><span className={`certainty ${fact.certainty}`}>{fact.certainty === "uncertain" ? "不确定" : fact.certainty === "doctor_confirmed" ? "医生明确" : fact.certainty === "pending" ? "待核对" : "资料明确"}</span><p><strong>{fact.value}</strong><small>{fact.event_time} · {fact.encounter_scope === "current" ? "本次" : fact.encounter_scope === "prior" ? "既往" : "归属待核对"} · 来源 {fact.source_ids.join("、")}</small></p></div>)}</div><div className="source-list">{draft.sources.map((source) => <div key={source.source_id}><b>{source.source_id}</b><span><strong>{source.title}</strong><small>{source.evidence}</small></span></div>)}</div></details>
      <div className="result-actions"><button type="button" className="secondary-action" onClick={() => setStage("input")}>返回补充原始资料</button><button type="button" className="primary-action compact" onClick={reset}>整理另一名患者</button></div>
    </section>}
  </main>;
}
