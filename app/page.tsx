"use client";

import { ChangeEvent, useState } from "react";

type Stage = "input" | "result";
type UploadStatus = "preparing" | "recognizing" | "done" | "error";
type AnalysisResult = { chief_complaint: string; present_illness: string; pending_fields: string[]; sources: Array<{ source_id: string; title: string; evidence: string }> };
type UploadItem = { id: string; name: string; preview?: string; status: UploadStatus; error?: string };
type PreparedInput = { name: string; file: File; preview?: string };

const MAX_ITEMS = 20;
const MAX_PDF_PAGES = 20;
const MAX_UPLOAD_BYTES = 900_000;
const MAX_EDGE = 1800;
const MAX_SOURCE_CHARS = 32_000;
const RECOGNITION_CONCURRENCY = 3;

const syntheticSample = `【S1 外院病理与治疗摘要｜完全合成】
患者，女，50-59岁。2026-06因反复颈部淋巴结肿大于外院就诊；外院淋巴结活检提示淋巴系统恶性肿瘤，病理分型及免疫组化报告原文未随带。2026-06下旬及07中旬于外院完成2周期抗肿瘤治疗，具体方案及末次治疗日期未提供。治疗后颈部肿大较前缩小，期间未诉发热、寒战、出血及明显恶心、呕吐。

【S2 本次就诊资料｜完全合成】
患者此次为继续治疗及疗效评估来院。近1周精神、食纳及睡眠尚可，大小便如常，体重无明显变化；否认发热、寒战、咳嗽咳痰、恶心呕吐、腹痛腹泻及皮肤出血点。未提供是否由其他医疗机构转入及当前入院次数。

【S3 外院检查摘要｜完全合成】
08-01血常规：白细胞3.2×10^9/L，中性粒细胞绝对值1.5×10^9/L，血红蛋白108g/L，血小板136×10^9/L。`;

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
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [chiefComplaint, setChiefComplaint] = useState("");
  const [presentIllness, setPresentIllness] = useState("");
  const [loading, setLoading] = useState(false);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");

  const updateUpload = (id: string, patch: Partial<UploadItem>) => setUploads((items) => items.map((item) => item.id === id ? { ...item, ...patch } : item));

  const analyze = async () => {
    if (sourceText.trim().length < 20 || loading) return;
    setLoading(true); setError("");
    try {
      const response = await fetch("/api/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source_text: sourceText }) });
      const payload = await readPayload(response) as { result?: AnalysisResult; error?: string };
      if (!response.ok || !payload.result) throw new Error(payload.error || "AI整理失败，请稍后重试。");
      setAnalysis(payload.result); setChiefComplaint(payload.result.chief_complaint); setPresentIllness(payload.result.present_illness); setStage("result");
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
      const heading = `【${input.name}｜AI识别，待核对】\n${payload.extracted_text.trim()}`;
      updateUpload(id, { status: "done" });
      return heading;
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

  const reset = () => { setStage("input"); setSourceText(""); setAnalysis(null); setChiefComplaint(""); setPresentIllness(""); setUploads([]); setCopied(false); setError(""); };
  const copyDraft = async () => { await navigator.clipboard.writeText(`主诉：${chiefComplaint}\n现病史：${presentIllness}`); setCopied(true); window.setTimeout(() => setCopied(false), 1600); };
  const busy = uploads.some((item) => item.status === "preparing" || item.status === "recognizing");

  return <main className="site-shell">
    <header className="site-header"><button type="button" className="wordmark" onClick={reset} aria-label="返回首页"><span>OP</span><div><strong>OncoPilot</strong><small>肿瘤病历草稿助手</small></div></button><div className="model-pill"><i /> AI整理已接入</div></header>
    <div className="stage-line two-steps" aria-label="当前流程"><span className={stage === "input" ? "active" : "done"}><b>1</b>粘贴资料</span><i /><span className={stage === "result" ? "active" : ""}><b>2</b>编辑病历草稿</span></div>
    {stage === "input" && <section className="single-flow input-stage">
      <div className="hero-copy"><span className="eyebrow">先只做好一件事</span><h1>把一堆患者资料，变成<br /><em>可直接粘贴的病历草稿</em></h1><p>适用于你第一次接管一名肿瘤相关患者，包括实体瘤、淋巴瘤和白血病；不要求患者是第一次住院。</p></div>
      <div className="input-card">
        <div className="card-heading"><div><span>把你现在掌握的都放进来</span><h2>拍照、上传文件，或粘贴文字</h2></div><button type="button" onClick={() => { setSourceText(syntheticSample); setError(""); }}>先看一个假病例</button></div>
        <p className="reference-status"><b>已启用本地规则</b> 益阳市中心医院肿瘤内科入院记录结构 · 仅约束病史结构，不替代上级审核</p>
        <div className="image-actions" aria-label="资料文件输入"><label className="image-action camera-action">拍照<input type="file" accept="image/*" capture="environment" multiple onChange={chooseDocuments} /></label><label className="image-action">上传图片或 PDF<input type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif,application/pdf,.pdf" multiple onChange={chooseDocuments} /></label><span>最多 {MAX_ITEMS} 个资料页（图片与 PDF 页面合计）；每份 PDF 最多 {MAX_PDF_PAGES} 页，3 页并行识别；HEIC 会先在本机转为 JPEG</span></div>
        {uploads.length > 0 && <div className="upload-list">{uploads.map((item) => <div className={`upload-item ${item.status}`} key={item.id}>{item.preview ? <img src={item.preview} alt="待识别资料预览" /> : <span className="file-icon">PDF</span>}<span><strong>{item.name}</strong><small>{item.status === "recognizing" ? "正在识别并填入下方…" : item.status === "done" ? "已识别并填入下方，请核对文字" : item.error || "文件处理失败"}</small></span></div>)}</div>}
        <textarea value={sourceText} onChange={(event) => { setSourceText(event.target.value); setError(""); }} placeholder="图片或 PDF 识别出的文字会自动放到这里。也可以补充：患者为什么来、外院做过什么、既往治疗、现在有什么不舒服……" aria-label="患者资料" maxLength={MAX_SOURCE_CHARS} />
        <div className="input-footer"><label className="file-choice">选择文本文件<input type="file" accept=".txt,.md,.json,text/plain" onChange={chooseFile} /></label><span>{sourceText.length}/{MAX_SOURCE_CHARS}</span></div>
        {error && <p className="error-message" role="alert">{error}</p>}
        <button type="button" className="primary-action" disabled={sourceText.trim().length < 20 || loading || busy} onClick={analyze}>{loading ? <><i className="spinner" />正在整理</> : <>生成主诉和现病史草稿 <b>→</b></>}</button>
        <p className="privacy-copy">文件先在设备本地压缩或分页，再发送识别；演示版请勿上传含可识别患者信息的真实资料。</p>
      </div>
      <div className="output-promise two-items" aria-label="系统输出"><div><b>01</b><span><strong>主诉 + 现病史</strong><small>直接生成可编辑、可复制草稿</small></span></div><div><b>02</b><span><strong>极少量待核对项</strong><small>只保留真正阻断书写的缺口</small></span></div></div>
    </section>}
    {stage === "result" && analysis && <section className="single-flow result-stage">
      <div className="result-title"><div><span className="success-mark">✓</span><span><small>草稿已生成</small><h1>改一改，就能粘进入院记录</h1></span></div><p>先给你文书，不把问诊清单甩回来。</p></div>
      <div className="history-editor"><div className="editor-heading"><label htmlFor="chief-complaint">① 主诉 + 现病史</label><button type="button" onClick={copyDraft}>{copied ? "已复制" : "复制病历草稿"}</button></div><label className="field-label" htmlFor="chief-complaint">主诉</label><input id="chief-complaint" className="chief-complaint" value={chiefComplaint} onChange={(event) => setChiefComplaint(event.target.value)} /><label className="field-label" htmlFor="history-draft">现病史</label><textarea id="history-draft" value={presentIllness} onChange={(event) => setPresentIllness(event.target.value)} /><span>可直接改写和复制；模型不为凑篇幅自行补造阴性症状。</span></div>
      {analysis.pending_fields.length > 0 && <section className="follow-up-card pending-card"><div className="section-heading"><span>② 待核对</span><h2>只剩这些再补一下</h2></div><div className="pending-list">{analysis.pending_fields.map((item) => <span key={item}>{item}</span>)}</div></section>}
      <details className="source-details"><summary>查看这份病历草稿用了哪些资料</summary><div className="source-list">{analysis.sources.map((source) => <div key={source.source_id}><b>{source.source_id}</b><span><strong>{source.title}</strong><small>{source.evidence}</small></span></div>)}</div></details>
      <div className="result-actions"><button type="button" className="secondary-action" onClick={() => setStage("input")}>返回补充原始资料</button><button type="button" className="primary-action compact" onClick={reset}>整理另一名患者</button></div>
    </section>}
  </main>;
}
