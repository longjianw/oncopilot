"use client";

import { ChangeEvent, FormEvent, ReactNode, useEffect, useState } from "react";
import Image from "next/image";
import type { ClinicalReferenceBundle } from "../lib/clinical-reference";

type Stage = "input" | "result";
type UploadStatus = "preparing" | "recognizing" | "done" | "error";
type DraftField = "chief_complaint" | "present_illness" | "past_history" | "personal_history" | "family_history" | "allergy_history" | "specialist_exam" | "diagnosis_summary" | "plan_summary";
type Fact = { fact_id: string; field: string; value: string; event_time: string; event_type: string; encounter_scope: "prior" | "current" | "unclear"; certainty: "explicit" | "doctor_confirmed" | "uncertain" | "pending"; source_ids: string[] };
type ReviewOption = { option_id: string; label: string; text: string; tone: "positive" | "negative" | "neutral"; detail_prompt?: string };
type ReviewItem = { choice_id: string; group: "发病与确诊" | "症状核对" | "其他病史" | "专科查体"; section: DraftField; prompt: string; help: string; options: ReviewOption[] };
type ReviewConfirmation = { choice_id: string; option_id: string; prompt: string; label: string; section: DraftField; text: string; detail: string };
type ChatModel = "deepseek-v4-flash" | "deepseek-v4-pro";
type ChatEntry = { role: "user" | "assistant"; content: string; modelLabel?: string; elapsedSeconds?: number };
type AnalysisResult = Record<DraftField, string> & { pending_fields: string[]; sources: Array<{ source_id: string; title: string; evidence: string }>; facts: Fact[]; review_items: ReviewItem[]; template_mode: boolean; template_name: string };
type UploadItem = { id: string; name: string; preview?: string; status: UploadStatus; error?: string };
type PreparedInput = { name: string; file: File; preview?: string };

const MAX_ITEMS = 20;
const MAX_PDF_PAGES = 20;
const MAX_UPLOAD_BYTES = 900_000;
const MAX_EDGE = 1800;
const MAX_SOURCE_CHARS = 32_000;
const RECOGNITION_CONCURRENCY = 3;

const sectionLabels: Array<{ field: DraftField; label: string; hint: string; placeholder: string; large?: boolean }> = [
  { field: "chief_complaint", label: "主诉", hint: "疾病或主要症状 + 时间 + 本次目的", placeholder: "可在上方点选候选项，也可直接输入" },
  { field: "present_illness", label: "现病史", hint: "按时间线整理确诊、既往治疗、进展证据与本次情况", placeholder: "可在上方点选候选项，也可直接输入", large: true },
  { field: "past_history", label: "既往史", hint: "仅写资料中已确认的既往疾病和相关情况", placeholder: "可在上方点选候选项，也可直接输入" },
  { field: "personal_history", label: "个人史", hint: "未提供时留空，不自动写无特殊", placeholder: "可在上方点选候选项，也可直接输入" },
  { field: "family_history", label: "家族史", hint: "未提供时留空，不自动写否认", placeholder: "可在上方点选候选项，也可直接输入" },
  { field: "allergy_history", label: "过敏史", hint: "仅写已确认过敏或已确认无过敏", placeholder: "可在上方点选候选项，也可直接输入" },
  { field: "specialist_exam", label: "专科体格检查", hint: "只写医生实际查体/评分；影像异常不能代替触诊所见", placeholder: "按病种核对原发部位、术区、区域淋巴结、ECOG PS；存在疼痛时记录NRS", large: true },
  { field: "diagnosis_summary", label: "诊断整理", hint: "只整理医生已明确给出的判断，不由 AI 诊断", placeholder: "填写医生已明确判断；可按“主要诊断｜病理/分期依据｜并存疾病待确认”整理" },
  { field: "plan_summary", label: "计划整理", hint: "只整理医生已明确给出的计划，不新增治疗建议", placeholder: "填写医生已明确计划；可按“本次目标｜已决定检查｜已决定治疗/观察｜复评节点”整理", large: true },
];

const chatModelOptions: Array<{ id: ChatModel; label: string; note: string }> = [
  { id: "deepseek-v4-flash", label: "快速 · V4 Flash", note: "更快，适合问字段" },
  { id: "deepseek-v4-pro", label: "深入 · V4 Pro", note: "更强，可能等待更久" },
];

const doctorOutlines: Partial<Record<DraftField, string>> = {
  diagnosis_summary: "1. 【主要诊断待医生确认】（原发部位【】；病理类型【】；临床分期【】；分子状态【如已检测】）\n诊断依据：病理原文【】；专科查体【】；影像或其他证据【】。\n鉴别诊断：【是否需要及具体内容待医生确认】。",
  plan_summary: "本次目标：【待医生确认】\n已决定补充或复核的资料：【】\n已决定的检查或评估：【】\n已决定的治疗或观察安排：【】\n复评节点及上级审核：【】",
};

const renderInlineMarkdown = (text: string): ReactNode[] => text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean).map((part, index) =>
  part.startsWith("**") && part.endsWith("**") ? <strong key={index}>{part.slice(2, -2)}</strong> : <span key={index}>{part}</span>);

const renderChatContent = (content: string) => content.split("\n").filter((line) => line.trim()).map((line, index) => {
  const cleanLine = line.replace(/^\s*(?:[-*•]|\d+[.、])\s*/, "");
  return <p key={index}>{renderInlineMarkdown(cleanLine)}</p>;
});

const syntheticSample = `【S1 完全合成简要资料】
患者已确诊黑色素瘤3天，免疫组化已完成，具体结果未提供。其他检查、既往病史、近期症状及专科查体均未提供。`;

const renderConfirmedText = (option: ReviewOption, detail: string) => {
  if (!option.text) return "";
  const cleanDetail = detail.trim();
  if (!cleanDetail) return option.text;
  if (/【[^】]+】/.test(option.text)) return option.text.replace(/【[^】]+】/, cleanDetail);
  const cleanBase = option.text
    .replace(/，[^，。]*(?:待补充|待核对)。?$/, "")
    .replace(/[。；，\s]+$/, "");
  return `${cleanBase}，${cleanDetail.replace(/[。；\s]+$/, "")}。`;
};

const parseEventStream = async (response: Response, onEvent: (name: string, payload: Record<string, unknown>) => void) => {
  if (!response.body) throw new Error("浏览器没有收到流式回答。");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let boundary = buffer.search(/\r?\n\r?\n/);
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      const separator = buffer.slice(boundary).match(/^\r?\n\r?\n/)?.[0] || "\n\n";
      buffer = buffer.slice(boundary + separator.length);
      const name = block.match(/^event:\s*(.+)$/m)?.[1]?.trim() || "message";
      const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
      if (data) {
        try { onEvent(name, JSON.parse(data) as Record<string, unknown>); } catch { /* ignore malformed event */ }
      }
      boundary = buffer.search(/\r?\n\r?\n/);
    }
    if (done) break;
  }
};

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
  const [choiceDetails, setChoiceDetails] = useState<Record<string, string>>({});
  const [, setAppliedChoiceText] = useState<Record<string, string>>({});
  const [recomposeLoading, setRecomposeLoading] = useState(false);
  const [recomposeNotice, setRecomposeNotice] = useState("");
  const [chatOpen, setChatOpen] = useState(false);
  const [chatContext, setChatContext] = useState("当前模板整体");
  const [chatMessages, setChatMessages] = useState<ChatEntry[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [chatModel, setChatModel] = useState<ChatModel>("deepseek-v4-flash");
  const [chatElapsed, setChatElapsed] = useState(0);
  const [clinicalReference, setClinicalReference] = useState<ClinicalReferenceBundle | null>(null);
  const [referenceLoading, setReferenceLoading] = useState(false);
  const [verificationLoading, setVerificationLoading] = useState<"local" | "web" | null>(null);
  const [referenceNotice, setReferenceNotice] = useState("");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const busy = uploads.some((item) => item.status === "preparing" || item.status === "recognizing");

  useEffect(() => {
    if (!chatLoading) return;
    const timer = window.setInterval(() => setChatElapsed((seconds) => seconds + 1), 1000);
    return () => window.clearInterval(timer);
  }, [chatLoading]);

  const updateUpload = (id: string, patch: Partial<UploadItem>) => setUploads((items) => items.map((item) => item.id === id ? { ...item, ...patch } : item));
  const updateDraft = (field: DraftField, value: string) => setDraft((current) => current ? { ...current, [field]: value } : current);
  const applyReviewText = (item: ReviewItem, nextText: string) => {
    setAppliedChoiceText((applied) => {
      const previousText = applied[item.choice_id] || "";
      setDraft((current) => {
        if (!current) return current;
        let sectionText = current[item.section];
        if (previousText && sectionText.includes(previousText)) sectionText = sectionText.replace(previousText, "").replace(/\s{2,}/g, " ").trim();
        if (nextText) sectionText = [sectionText.trim(), nextText].filter(Boolean).join(" ");
        return { ...current, [item.section]: sectionText };
      });
      return { ...applied, [item.choice_id]: nextText };
    });
    setRecomposeNotice("选择已写入对应模块；完成几项后可让 AI 重新整理成连贯草稿。");
  };
  const selectReviewOption = (item: ReviewItem, selected: ReviewOption) => {
    setSelectedChoices((current) => ({ ...current, [item.choice_id]: selected.option_id }));
    applyReviewText(item, renderConfirmedText(selected, choiceDetails[item.choice_id] || ""));
  };
  const updateChoiceDetail = (item: ReviewItem, detail: string) => {
    setChoiceDetails((current) => ({ ...current, [item.choice_id]: detail }));
    const optionId = selectedChoices[item.choice_id];
    const selected = item.options.find((option) => option.option_id === optionId);
    if (selected) applyReviewText(item, renderConfirmedText(selected, detail));
  };

  const confirmations = (): ReviewConfirmation[] => {
    if (!draft) return [];
    return draft.review_items.flatMap((item) => {
      const option = item.options.find((candidate) => candidate.option_id === selectedChoices[item.choice_id]);
      if (!option?.text) return [];
      return [{
        choice_id: item.choice_id,
        option_id: option.option_id,
        prompt: item.prompt,
        label: option.label,
        section: item.section,
        text: option.text,
        detail: (choiceDetails[item.choice_id] || "").trim(),
      }];
    });
  };

  const recomposeDraft = async () => {
    if (!draft || recomposeLoading) return;
    const selected = confirmations();
    if (!selected.length) { setRecomposeNotice("请先至少选择一项“有 / 无 / 已查”等有效内容。"); return; }
    setRecomposeLoading(true); setRecomposeNotice("");
    try {
      const response = await fetch("/api/recompose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ draft, confirmations: selected, facts: draft.facts, template_name: draft.template_name }),
      });
      const payload = await response.json() as { result?: Omit<AnalysisResult, "sources" | "facts" | "review_items" | "template_mode" | "template_name">; error?: string };
      if (!response.ok || !payload.result) throw new Error(payload.error || "AI重新整理失败，请稍后重试。");
      setDraft((current) => current ? { ...current, ...payload.result } : current);
      setAppliedChoiceText({});
      setRecomposeNotice("已根据当前选择和填空重新整理；未选择项目仍保留为待完成项。");
    } catch (caught) { setRecomposeNotice(caught instanceof Error ? caught.message : "AI重新整理失败，请稍后重试。"); }
    finally { setRecomposeLoading(false); }
  };

  const openTemplateChat = (item?: ReviewItem) => {
    const context = item ? `${item.prompt}；提示：${item.help}` : "当前模板整体与未完成核对项";
    setChatContext(context); setChatOpen(true);
    if (item) setChatInput(`“${item.prompt}”这一项具体应该核对和记录哪些内容？`);
  };

  const sendChat = async (event: FormEvent) => {
    event.preventDefault();
    const message = chatInput.trim();
    if (!draft || !message || chatLoading) return;
    const nextHistory: ChatEntry[] = [...chatMessages, { role: "user", content: message }];
    const selectedModel = chatModel;
    const startedAt = Date.now();
    setChatMessages([...nextHistory, { role: "assistant", content: "" }]); setChatInput(""); setChatElapsed(0); setChatLoading(true);
    try {
      // Sites currently requires the trailing slash for this newly added route.
      const response = await fetch("/api/template-chat/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, history: chatMessages.slice(-6), template_name: draft.template_name, item_context: chatContext, model: selectedModel }),
      });
      if (!response.ok) {
        const payload = await response.json() as { error?: string };
        throw new Error(payload.error || "AI暂时没有回答，请重试。");
      }
      let fullAnswer = "";
      await parseEventStream(response, (name, payload) => {
        if (name === "delta" && typeof payload.answer === "string") {
          fullAnswer = payload.answer;
          setChatMessages((current) => current.map((entry, index) => index === current.length - 1 ? { ...entry, content: fullAnswer } : entry));
        }
        if (name === "done" && typeof payload.answer === "string") {
          const model = typeof payload.model === "string" ? payload.model as ChatModel : selectedModel;
          const modelLabel = chatModelOptions.find((option) => option.id === model)?.label || model;
          setChatMessages((current) => current.map((entry, index) => index === current.length - 1 ? { ...entry, content: payload.answer as string, modelLabel, elapsedSeconds: Math.max(1, Math.round((Date.now() - startedAt) / 1000)) } : entry));
        }
        if (name === "error") throw new Error(typeof payload.error === "string" ? payload.error : "AI暂时没有回答，请重试。");
      });
      if (!fullAnswer) throw new Error("AI暂时没有回答，请重试。");
    } catch (caught) { setChatMessages((current) => current.map((entry, index) => index === current.length - 1 && entry.role === "assistant" ? { ...entry, content: caught instanceof Error ? caught.message : "AI暂时没有回答，请重试。" } : entry)); }
    finally { setChatLoading(false); }
  };

  const generateClinicalReference = async (result: AnalysisResult) => {
    setReferenceLoading(true); setReferenceNotice(""); setClinicalReference(null);
    try {
      const response = await fetch("/api/clinical-reference", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "generate", facts: result.facts, current_purpose: currentPurpose }) });
      const payload = await response.json() as { result?: ClinicalReferenceBundle; error?: string };
      if (!response.ok || !payload.result) throw new Error(payload.error || "AI参考暂时没有生成出来。");
      setClinicalReference(payload.result);
    } catch (caught) { setReferenceNotice(caught instanceof Error ? caught.message : "AI参考暂时没有生成出来。"); }
    finally { setReferenceLoading(false); }
  };

  const verifyClinicalReference = async (action: "local" | "web") => {
    if (!draft || !clinicalReference || verificationLoading) return;
    setVerificationLoading(action); setReferenceNotice("");
    try {
      const response = await fetch("/api/clinical-reference", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, facts: draft.facts, current_purpose: currentPurpose, reference: clinicalReference }) });
      const payload = await response.json() as { result?: ClinicalReferenceBundle; error?: string };
      if (!response.ok || !payload.result) throw new Error(payload.error || "交叉核验暂时失败。");
      setClinicalReference(payload.result);
    } catch (caught) { setReferenceNotice(caught instanceof Error ? caught.message : "交叉核验暂时失败。"); }
    finally { setVerificationLoading(null); }
  };

  const adoptReference = (field: "diagnosis_summary" | "plan_summary") => {
    if (!clinicalReference) return;
    const content = field === "diagnosis_summary"
      ? [`【AI参考候选，待医生核对】`, `初步诊断：${clinicalReference.preliminary_diagnosis}`, `诊断依据：${clinicalReference.diagnostic_basis.join("；") || "待结合原始报告补充"}`, `鉴别诊断：${clinicalReference.differential_diagnosis.join("；") || "待医生确认是否需要"}`].join("\n")
      : [`【AI参考候选，待医生核对】`, `尚缺前提：${clinicalReference.missing_prerequisites.join("；")}`, `候选检查/评估：`, ...clinicalReference.suggested_workup.map((item, index) => `${index + 1}. ${item.title}（条件：${item.trigger}；目的：${item.purpose}）`), `分层诊疗方向：`, ...clinicalReference.treatment_pathways.map((item, index) => `${index + 1}. ${item.title}（条件：${item.trigger}；目的：${item.purpose}）`)].join("\n");
    updateDraft(field, content);
    setReferenceNotice(field === "diagnosis_summary" ? "已填入诊断整理区，请医生逐项核对后删除候选标记。" : "已填入计划整理区，请医生按本院流程和患者实际情况核对。" );
  };

  const analyze = async () => {
    if (sourceText.trim().length < 20 || loading) return;
    setLoading(true); setError("");
    try {
      const response = await fetch("/api/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source_text: sourceText, current_purpose: currentPurpose }) });
      const payload = await readPayload(response) as { result?: AnalysisResult; error?: string };
      if (!response.ok || !payload.result) throw new Error(payload.error || "AI整理失败，请稍后重试。");
      setDraft(payload.result); setStage("result"); void generateClinicalReference(payload.result);
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

  const reset = () => { setStage("input"); setSourceText(""); setCurrentPurpose(""); setDraft(null); setUploads([]); setSelectedChoices({}); setChoiceDetails({}); setAppliedChoiceText({}); setRecomposeNotice(""); setChatOpen(false); setChatContext("当前模板整体"); setChatMessages([]); setChatInput(""); setChatModel("deepseek-v4-flash"); setChatElapsed(0); setClinicalReference(null); setReferenceLoading(false); setVerificationLoading(null); setReferenceNotice(""); setCopied(false); setError(""); };
  const copyDraft = async () => {
    if (!draft) return;
    const text = sectionLabels.map(({ field, label }) => draft[field].trim() ? `${label}：\n${draft[field].trim()}` : "").filter(Boolean).join("\n\n");
    await navigator.clipboard.writeText(text); setCopied(true); window.setTimeout(() => setCopied(false), 1600);
  };
  const insertDoctorOutline = (field: DraftField) => {
    const outline = doctorOutlines[field];
    if (!outline) return;
    updateDraft(field, draft?.[field].trim() ? `${draft[field].trim()}\n${outline}` : outline);
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
        <div className="guided-heading"><div><span>快速补全</span><h2>先选择，再补细节，最后重新成稿</h2><p>已选择 {selectedCount}/{draft.review_items.length} 项。每次点击会先写入对应模块；完成几项后可一键整理成连贯文字。</p></div><div className="guided-tools"><div className="choice-legend"><span className="positive">有 / 异常</span><span className="negative">无 / 正常</span><span>未问 / 未查</span></div><button type="button" className="ask-ai" onClick={() => openTemplateChat()}>问 AI 这个模板</button></div></div>
        <div className="review-groups">{reviewGroups.map(({ group, items }) => <section className="review-group" key={group}><h3>{group}</h3><div className="review-items">{items.map((item) => {
          const selectedOption = item.options.find((option) => option.option_id === selectedChoices[item.choice_id]);
          return <div className={`review-item ${selectedOption ? "answered" : ""}`} key={item.choice_id}><div className="review-question"><strong>{item.prompt}</strong><small>{item.help}</small><button type="button" onClick={() => openTemplateChat(item)}>这项怎么问？</button></div><div><div className="review-options">{item.options.map((option) => <button type="button" key={option.option_id} className={`${option.tone} ${selectedChoices[item.choice_id] === option.option_id ? "selected" : ""}`} onClick={() => selectReviewOption(item, option)}>{option.label}</button>)}</div>{selectedOption?.detail_prompt && <label className="detail-fill"><span>补充这项（可选）</span><input value={choiceDetails[item.choice_id] || ""} onChange={(event) => updateChoiceDetail(item, event.target.value)} maxLength={500} placeholder={selectedOption.detail_prompt} /><small>已加入：{sectionLabels.find(({ field }) => field === item.section)?.label}</small></label>}</div></div>;
        })}</div></section>)}</div>
        <div className="recompose-bar"><div><strong>选择和填空完成后</strong><span>让 AI 去重、调整顺序，并重新组织主诉、现病史和其他模块。</span>{recomposeNotice && <small>{recomposeNotice}</small>}</div><button type="button" disabled={recomposeLoading || confirmations().length === 0} onClick={recomposeDraft}>{recomposeLoading ? "正在重新整理…" : "一键重新整理草稿"}</button></div>
      </section>}
      <section className="clinical-reference-panel">
        <div className="reference-heading"><div><span>诊断与下一步 · AI参考候选</span><h2>先快速给一版，再用资料和网络交叉核验</h2><p>这里允许AI提出有条件的检查和分层诊疗方向；它与正式病历分开，只有医生主动采纳后才进入诊断/计划整理。</p></div><div className="reference-actions"><button type="button" disabled={referenceLoading} onClick={() => generateClinicalReference(draft)}>{referenceLoading ? "正在快速生成…" : "重新生成AI参考"}</button><button type="button" disabled={!clinicalReference || Boolean(verificationLoading)} onClick={() => verifyClinicalReference("local")}>{verificationLoading === "local" ? "本地核验中…" : "用CSCO来源卡核验"}</button><button type="button" disabled={!clinicalReference || Boolean(verificationLoading)} onClick={() => verifyClinicalReference("web")}>{verificationLoading === "web" ? "联网核验中…" : "联网核验权威网页"}</button></div></div>
        {referenceLoading && <div className="reference-loading"><i className="spinner" /> 正在根据结构化事实生成初步诊断、候选检查和分层诊疗路径……</div>}
        {clinicalReference && <div className="reference-content">
          <div className="reference-state"><strong>{clinicalReference.verification_state === "model_only" ? "模型初稿 · 未核验" : clinicalReference.verification_state === "local_checked" ? "已用本地来源卡核验" : "已联网读取权威网页核验"}</strong><span>{clinicalReference.disclaimer}</span></div>
          <div className="reference-grid"><article><h3>初步诊断与依据</h3><p><b>初步诊断：</b>{clinicalReference.preliminary_diagnosis}</p><p><b>诊断依据：</b>{clinicalReference.diagnostic_basis.join("；") || "待补"}</p><p><b>鉴别诊断：</b>{clinicalReference.differential_diagnosis.join("；") || "待医生确认"}</p><button type="button" onClick={() => adoptReference("diagnosis_summary")}>填入诊断整理</button></article><article><h3>尚缺关键前提</h3><ul>{clinicalReference.missing_prerequisites.map((item) => <li key={item}>{item}</li>)}</ul></article></div>
          <div className="reference-paths"><article><h3>候选检查与评估</h3>{clinicalReference.suggested_workup.map((item) => <div key={`${item.title}-${item.trigger}`}><strong>{item.title}</strong><span>何时考虑：{item.trigger}</span><small>目的：{item.purpose}</small></div>)}</article><article><h3>分层诊疗方向</h3>{clinicalReference.treatment_pathways.map((item) => <div key={`${item.title}-${item.trigger}`}><strong>{item.title}</strong><span>适用前提：{item.trigger}</span><small>讨论目的：{item.purpose}</small></div>)}</article></div>
          <button type="button" className="adopt-plan" onClick={() => adoptReference("plan_summary")}>把候选路径填入计划整理</button>
          {clinicalReference.checks && <div className="reference-checks"><h3>交叉核验结果</h3>{clinicalReference.checks.map((check) => <div key={`${check.topic}-${check.source}`} className={check.status}><b>{check.status === "supported" ? "来源支持" : check.status === "conditional" ? "有条件支持" : "本次未找到"}</b><span><strong>{check.topic}</strong><small>{check.note}</small><em>{check.url ? <a href={check.url} target="_blank" rel="noreferrer">{check.source}</a> : check.source}</em></span></div>)}</div>}
        </div>}
        {referenceNotice && <p className="reference-notice">{referenceNotice}</p>}
      </section>
      <div className="draft-grid">
        {sectionLabels.map(({ field, label, hint, placeholder, large }) => <section className={`draft-section ${large ? "wide" : ""} ${field === "diagnosis_summary" || field === "plan_summary" ? "doctor-only" : ""}`} key={field}>
          <div><label htmlFor={field}>{label}</label><span className="draft-heading-actions"><small>{hint}</small>{doctorOutlines[field] && !draft[field].trim() && <button type="button" onClick={() => insertDoctorOutline(field)}>插入医生确认大纲</button>}</span></div>
          <textarea id={field} value={draft[field]} onChange={(event) => updateDraft(field, event.target.value)} placeholder={placeholder} rows={large ? 7 : 4} />
        </section>)}
      </div>
      {draft.pending_fields.length > 0 && <section className="follow-up-card pending-card"><div className="section-heading"><span>待核对</span><h2>这些缺口可能影响草稿落笔</h2></div><div className="pending-list">{draft.pending_fields.map((item) => <span key={item}>{item}</span>)}</div></section>}
      <details className="source-details"><summary>查看结构化事实与资料来源（{draft.facts.length} 条事实）</summary><div className="fact-list">{draft.facts.map((fact) => <div key={fact.fact_id}><span className={`certainty ${fact.certainty}`}>{fact.certainty === "uncertain" ? "不确定" : fact.certainty === "doctor_confirmed" ? "医生明确" : fact.certainty === "pending" ? "待核对" : "资料明确"}</span><p><strong>{fact.value}</strong><small>{fact.event_time} · {fact.encounter_scope === "current" ? "本次" : fact.encounter_scope === "prior" ? "既往" : "归属待核对"} · 来源 {fact.source_ids.join("、")}</small></p></div>)}</div><div className="source-list">{draft.sources.map((source) => <div key={source.source_id}><b>{source.source_id}</b><span><strong>{source.title}</strong><small>{source.evidence}</small></span></div>)}</div></details>
      <div className="result-actions"><button type="button" className="secondary-action" onClick={() => setStage("input")}>返回补充原始资料</button><button type="button" className="primary-action compact" onClick={reset}>整理另一名患者</button></div>
      <button type="button" className="floating-chat" onClick={() => openTemplateChat()}>问 AI · 文书核对</button>
      {chatOpen && <aside className="chat-drawer" aria-label="AI文书核对窗口"><div className="chat-header"><div><strong>问 AI · 文书核对</strong><small>{chatContext}</small></div><button type="button" onClick={() => setChatOpen(false)} aria-label="关闭聊天">×</button></div><div className="chat-boundary">可以问“这项要核对什么、怎样记录”；AI不会替患者回答，也不做诊断和治疗建议。</div><div className="chat-models" aria-label="回答模型">{chatModelOptions.map((option) => <button type="button" key={option.id} className={chatModel === option.id ? "selected" : ""} disabled={chatLoading} onClick={() => setChatModel(option.id)}><strong>{option.label}</strong><small>{option.note}</small></button>)}</div><div className="chat-messages">{chatMessages.length === 0 ? <div className="chat-empty"><p>例如：</p><button type="button" onClick={() => setChatInput("区域淋巴结这一项，通常要记录哪些部位和查体特征？")}>区域淋巴结要记什么？</button><button type="button" onClick={() => setChatInput("一个阳性症状需要补充哪些时间和程度信息？")}>阳性症状怎么补细节？</button></div> : chatMessages.map((message, index) => <div className={message.role} key={`${message.role}-${index}`}><div className="chat-copy">{renderChatContent(message.content)}</div>{message.role === "assistant" && message.modelLabel && <small className="chat-meta">{message.modelLabel} · {message.elapsedSeconds}秒</small>}</div>)}{chatLoading && <div className="assistant loading"><i className="spinner" />正在思考 {chatElapsed} 秒…</div>}</div><form onSubmit={sendChat}><textarea value={chatInput} onChange={(event) => setChatInput(event.target.value)} maxLength={1200} placeholder="只输入完全合成或严格脱敏内容……" /><button type="submit" disabled={!chatInput.trim() || chatLoading}>发送</button></form></aside>}
    </section>}
  </main>;
}
