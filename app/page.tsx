"use client";

import { ChangeEvent, useState } from "react";
import Image from "next/image";

type Stage = "input" | "result";
type UploadStatus = "preparing" | "recognizing" | "done" | "error";
type DraftField = "chief_complaint" | "present_illness" | "past_history" | "personal_history" | "family_history" | "allergy_history" | "specialist_exam" | "diagnosis_summary" | "plan_summary";
type Fact = { fact_id: string; field: string; value: string; event_time: string; event_type: string; encounter_scope: "prior" | "current" | "unclear"; certainty: "explicit" | "doctor_confirmed" | "uncertain" | "pending"; source_ids: string[] };
type AnalysisResult = Record<DraftField, string> & { pending_fields: string[]; sources: Array<{ source_id: string; title: string; evidence: string }>; facts: Fact[] };
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

const syntheticSample = `【S1 外院病理与治疗摘要｜完全合成】
患者，女，50-59岁。2026-01因颈部淋巴结肿大于外院行淋巴结活检，病理提示弥漫大B细胞淋巴瘤。2026-02至2026-06完成4周期既往系统治疗，具体剂量未提供。治疗后颈部肿大较前缩小。

【S2 本次情况｜完全合成】
近1周精神、食纳尚可，无发热、寒战及皮肤出血点。既往有高血压病史5年，规律口服药物，具体药名待核对。青霉素过敏，曾出现皮疹。个人史及家族史未提供。

【S3 医生本次查体与明确判断｜完全合成】
专科查体：左颈部可触及约1.5cm×1.0cm淋巴结，质韧，活动度尚可，无明显压痛。
医生记录的初步诊断：弥漫大B细胞淋巴瘤治疗后。
医生记录的计划：核对外院病理及既往治疗资料，完善本次评估后由上级医师确认后续安排。`;

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
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const busy = uploads.some((item) => item.status === "preparing" || item.status === "recognizing");

  const updateUpload = (id: string, patch: Partial<UploadItem>) => setUploads((items) => items.map((item) => item.id === id ? { ...item, ...patch } : item));
  const updateDraft = (field: DraftField, value: string) => setDraft((current) => current ? { ...current, [field]: value } : current);

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

  const reset = () => { setStage("input"); setSourceText(""); setCurrentPurpose(""); setDraft(null); setUploads([]); setCopied(false); setError(""); };
  const copyDraft = async () => {
    if (!draft) return;
    const text = sectionLabels.map(({ field, label }) => draft[field].trim() ? `${label}：\n${draft[field].trim()}` : "").filter(Boolean).join("\n\n");
    await navigator.clipboard.writeText(text); setCopied(true); window.setTimeout(() => setCopied(false), 1600);
  };

  return <main className="site-shell">
    <header className="site-header"><button type="button" className="wordmark" onClick={reset} aria-label="返回首页"><span>OP</span><div><strong>OncoPilot</strong><small>肿瘤入院记录草稿助手</small></div></button><div className="model-pill"><i /> 事实核对后生成</div></header>
    <div className="stage-line two-steps" aria-label="当前流程"><span className={stage === "input" ? "active" : "done"}><b>1</b>放入资料</span><i /><span className={stage === "result" ? "active" : ""}><b>2</b>核对草稿包</span></div>
    {stage === "input" && <section className="single-flow input-stage">
      <div className="hero-copy"><span className="eyebrow">单入口 · 入院记录草稿包</span><h1>把分散的患者资料，整理成<br /><em>一套可编辑的入院记录草稿</em></h1><p>先核对来源、时间和“既往/本次”，再整理主诉、现病史、各项病史、专科查体，以及医生已明确判断后的诊断与计划。</p></div>
      <div className="input-card">
        <div className="card-heading"><div><span>第一步只有这一个入口</span><h2>拍照、上传文件，或粘贴文字</h2></div><button type="button" onClick={() => { setSourceText(syntheticSample); setCurrentPurpose("继续评估既往治疗效果并核对后续安排"); setError(""); }}>先看一个假病例</button></div>
        <p className="reference-status"><b>安全边界</b> 仅使用完全合成或严格脱敏资料；本地规则只约束草稿结构，不替代本院模板和上级审核。</p>
        <label className="purpose-field"><span>本次来院目的 <b>可选，但建议填写</b></span><input value={currentPurpose} onChange={(event) => setCurrentPurpose(event.target.value)} maxLength={160} placeholder="例如：继续治疗、复查评估、处理新出现的症状……" /><small>这行用于区分既往住院、出院计划与本次就诊。</small></label>
        <div className="image-actions" aria-label="资料文件输入"><label className="image-action camera-action">拍照<input type="file" accept="image/*" capture="environment" multiple onChange={chooseDocuments} /></label><label className="image-action">上传图片或 PDF<input type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif,application/pdf,.pdf" multiple onChange={chooseDocuments} /></label><span>最多 {MAX_ITEMS} 个资料页；PDF 最多 {MAX_PDF_PAGES} 页；HEIC 会先在本机转换</span></div>
        {uploads.length > 0 && <div className="upload-list">{uploads.map((item) => <div className={`upload-item ${item.status}`} key={item.id}>{item.preview ? <Image unoptimized src={item.preview} width={54} height={42} alt="待识别资料预览" /> : <span className="file-icon">PDF</span>}<span><strong>{item.name}</strong><small>{item.status === "recognizing" ? "正在识别并填入下方…" : item.status === "done" ? "已识别并填入下方，请核对文字" : item.error || "文件处理失败"}</small></span></div>)}</div>}
        <textarea value={sourceText} onChange={(event) => { setSourceText(event.target.value); setError(""); }} placeholder="把外院病理、检查、手术和治疗经过，本次症状，已询问的病史，实际查体，以及医生明确写下的诊断/计划放在这里……" aria-label="患者资料" maxLength={MAX_SOURCE_CHARS} />
        <div className="input-footer"><label className="file-choice">选择文本文件<input type="file" accept=".txt,.md,.json,text/plain" onChange={chooseFile} /></label><span>{sourceText.length}/{MAX_SOURCE_CHARS}</span></div>
        {error && <p className="error-message" role="alert">{error}</p>}
        <button type="button" className="primary-action" disabled={sourceText.trim().length < 20 || loading || busy} onClick={analyze}>{loading ? <><i className="spinner" />正在先核对事实，再生成草稿</> : <>生成入院记录草稿包 <b>→</b></>}</button>
        <p className="privacy-copy">不会用未询问内容补写阴性病史，也不会把未查体内容写成正常。</p>
      </div>
      <div className="output-promise three-items" aria-label="系统输出"><div><b>01</b><span><strong>结构化事实</strong><small>来源、时间、本次/既往、证据强度</small></span></div><div><b>02</b><span><strong>完整草稿包</strong><small>九个可编辑模块，一次复制</small></span></div><div><b>03</b><span><strong>医生最终核对</strong><small>诊断和计划只整理已明确判断</small></span></div></div>
    </section>}
    {stage === "result" && draft && <section className="single-flow result-stage draft-package">
      <div className="result-title"><div><span className="success-mark">✓</span><span><small>草稿包已生成</small><h1>逐项核对，再放进入院记录</h1></span></div><button type="button" className="copy-all" onClick={copyDraft}>{copied ? "已复制全部非空模块" : "复制全部非空模块"}</button></div>
      <div className="safety-banner"><strong>这是一份可编辑工作稿</strong><span>空白表示资料未提供，不代表阴性或正常；诊断与计划仍由医生负责确认。</span></div>
      <div className="draft-grid">
        {sectionLabels.map(({ field, label, hint, large }) => <section className={`draft-section ${large ? "wide" : ""} ${field === "diagnosis_summary" || field === "plan_summary" ? "doctor-only" : ""}`} key={field}>
          <div><label htmlFor={field}>{label}</label><small>{hint}</small></div>
          <textarea id={field} value={draft[field]} onChange={(event) => updateDraft(field, event.target.value)} placeholder="资料未提供，留空待医生核对" rows={large ? 7 : 4} />
        </section>)}
      </div>
      {draft.pending_fields.length > 0 && <section className="follow-up-card pending-card"><div className="section-heading"><span>待核对</span><h2>这些缺口可能影响草稿落笔</h2></div><div className="pending-list">{draft.pending_fields.map((item) => <span key={item}>{item}</span>)}</div></section>}
      <details className="source-details"><summary>查看结构化事实与资料来源（{draft.facts.length} 条事实）</summary><div className="fact-list">{draft.facts.map((fact) => <div key={fact.fact_id}><span className={`certainty ${fact.certainty}`}>{fact.certainty === "uncertain" ? "不确定" : fact.certainty === "doctor_confirmed" ? "医生明确" : fact.certainty === "pending" ? "待核对" : "资料明确"}</span><p><strong>{fact.value}</strong><small>{fact.event_time} · {fact.encounter_scope === "current" ? "本次" : fact.encounter_scope === "prior" ? "既往" : "归属待核对"} · 来源 {fact.source_ids.join("、")}</small></p></div>)}</div><div className="source-list">{draft.sources.map((source) => <div key={source.source_id}><b>{source.source_id}</b><span><strong>{source.title}</strong><small>{source.evidence}</small></span></div>)}</div></details>
      <div className="result-actions"><button type="button" className="secondary-action" onClick={() => setStage("input")}>返回补充原始资料</button><button type="button" className="primary-action compact" onClick={reset}>整理另一名患者</button></div>
    </section>}
  </main>;
}
