"use client";

import { ChangeEvent, FormEvent, ReactNode, useEffect, useState } from "react";
import Image from "next/image";
import {
  combineClinicalReferenceStages,
  type ClinicalReferenceBundle,
  type DiagnosisReferenceStage,
  type PlanReferenceStage,
} from "../lib/clinical-reference";

type Stage = "input" | "result";
type UploadStatus = "preparing" | "recognizing" | "done" | "error";
type ArrivalContext = "" | "外院转入我院" | "本院直接入院" | "本次到院身份待确认";
type ChatMode = "documentation" | "clinical_reference";
type DraftField = "chief_complaint" | "present_illness" | "past_history" | "personal_history" | "family_history" | "allergy_history" | "specialist_exam" | "diagnosis_summary" | "plan_summary";
type Fact = { fact_id: string; field: string; value: string; event_time: string; event_type: string; encounter_scope: "prior" | "current" | "unclear"; certainty: "explicit" | "doctor_confirmed" | "uncertain" | "pending"; source_ids: string[] };
type ReviewOption = { option_id: string; label: string; text: string; tone: "positive" | "negative" | "neutral"; detail_prompt?: string };
type ReviewItem = { choice_id: string; group: "发病与确诊" | "症状核对" | "其他病史" | "专科查体"; section: DraftField; prompt: string; help: string; options: ReviewOption[] };
type ReviewConfirmation = { choice_id: string; option_id: string; prompt: string; label: string; section: DraftField; text: string; detail: string };
type ChatModel = "deepseek-v4-flash" | "deepseek-v4-pro";
type ChatEntry = { role: "user" | "assistant"; content: string; modelLabel?: string; elapsedSeconds?: number };
type GenerationStatus = "waiting" | "loading" | "done" | "error";
type AnalysisResult = Record<DraftField, string> & { pending_fields: string[]; sources: Array<{ source_id: string; title: string; evidence: string }>; facts: Fact[]; review_items: ReviewItem[]; template_mode: boolean; template_name: string };
type UploadItem = { id: string; name: string; file: File; preview?: string; status: UploadStatus; error?: string; model?: string };
type PreparedInput = { name: string; file: File; preview?: string };

const MAX_ITEMS = 20;
const MAX_PDF_PAGES = 20;
const MAX_UPLOAD_BYTES = 480_000;
const MAX_EDGE = 1600;
const MAX_SOURCE_CHARS = 32_000;
const RECOGNITION_CONCURRENCY = 3;
const arrivalContextOptions: Array<{ value: Exclude<ArrivalContext, "">; label: string; note: string }> = [
  { value: "外院转入我院", label: "外院转入我院", note: "把外院转诊意见接成我院入院结尾" },
  { value: "本院直接入院", label: "本院直接入院", note: "本院门诊/急诊后收治" },
  { value: "本次到院身份待确认", label: "暂未确认", note: "不杜撰转入关系，保留待核对" },
];

const sectionLabels: Array<{ field: DraftField; label: string; hint: string; placeholder: string; large?: boolean }> = [
  { field: "chief_complaint", label: "主诉", hint: "疾病或主要症状 + 时间 + 本次目的", placeholder: "可在上方点选候选项，也可直接输入" },
  { field: "present_illness", label: "现病史", hint: "按时间线整理确诊、既往治疗、进展证据与本次情况", placeholder: "可在上方点选候选项，也可直接输入", large: true },
  { field: "past_history", label: "既往史", hint: "仅写资料中已确认的既往疾病和相关情况", placeholder: "可在上方点选候选项，也可直接输入" },
  { field: "personal_history", label: "个人史", hint: "未提供时留空，不自动写无特殊", placeholder: "可在上方点选候选项，也可直接输入" },
  { field: "family_history", label: "家族史", hint: "未提供时留空，不自动写否认", placeholder: "可在上方点选候选项，也可直接输入" },
  { field: "allergy_history", label: "过敏史", hint: "仅写已确认过敏或已确认无过敏", placeholder: "可在上方点选候选项，也可直接输入" },
  { field: "specialist_exam", label: "专科体格检查", hint: "只写医生实际查体/评分；影像异常不能代替触诊所见", placeholder: "按病种核对原发部位、术区、区域淋巴结、ECOG PS；存在疼痛时记录NRS", large: true },
  { field: "diagnosis_summary", label: "初步诊断整理", hint: "AI先按现有资料给候选，医生核对后使用", placeholder: "按“初步诊断｜诊断依据｜必要时鉴别诊断”整理" },
  { field: "plan_summary", label: "计划整理", hint: "AI先给有条件的检查与诊疗方向，可直接编辑", placeholder: "按“本次目标｜候选检查｜分层诊疗方向｜复评节点”整理", large: true },
];

const chatModelOptions: Array<{ id: ChatModel; label: string; note: string }> = [
  { id: "deepseek-v4-pro", label: "深入 · V4 Pro", note: "更强，可能等待更久" },
  { id: "deepseek-v4-flash", label: "快速 · V4 Flash", note: "仅在需要更快回答时手动选择" },
];

const doctorOutlines: Partial<Record<DraftField, string>> = {
  diagnosis_summary: "初步诊断：\n1. 【主要诊断待医生确认】（原发部位【】；病理类型【】；临床分期【】；分子状态【如已检测】）\n诊断依据：病理原文【】；专科查体【】；影像或其他证据【】。\n鉴别诊断：【仅在当前问题需要时填写，否则删除本行】。",
  plan_summary: "本次目标：【待医生确认】\n已决定补充或复核的资料：【】\n已决定的检查或评估：【】\n已决定的治疗或观察安排：【】\n复评节点及上级审核：【】",
};

const referenceDiagnosisDraft = (reference: DiagnosisReferenceStage) => [
  "【AI参考候选，待医生核对】",
  `初步诊断：${reference.preliminary_diagnosis}`,
  `诊断依据：${reference.diagnostic_basis.join("；") || "待结合原始报告补充"}`,
  `鉴别诊断：${reference.differential_diagnosis.join("；") || "结合当前主要问题判断是否需要"}`,
].join("\n");

const referencePlanDraft = (reference: PlanReferenceStage) => [
  "【AI参考候选，待医生核对】",
  `当前优先问题：${reference.current_priority}`,
  `判断理由：${reference.plan_reasoning.join("；")}`,
  "候选检查/评估：",
  ...reference.suggested_workup.map((item, index) => `${index + 1}. ${item.title}（条件：${item.trigger}；目的：${item.purpose}）`),
  "分层诊疗方向：",
  ...reference.treatment_pathways.map((item, index) => `${index + 1}. ${item.title}（条件：${item.trigger}；目的：${item.purpose}）`),
  `最能改变判断的资料：${reference.decision_changers.join("；")}`,
  `下一个问题：${reference.next_question}`,
].join("\n");

const eventTypeLabels: Record<string, string> = {
  onset_diagnosis: "首发/确诊",
  pathology_molecular: "病理/分子",
  prior_treatment: "既往治疗",
  progression_evidence: "复发/进展",
  current_purpose: "本次目的",
  current_status: "本次经过",
  past_history: "基础病/手术",
  personal_history: "个人史",
  family_history: "家族史",
  allergy_history: "过敏史",
  specialist_exam: "查体",
  doctor_diagnosis: "医生判断",
  doctor_plan: "医生计划",
  other: "其他",
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
  try { return JSON.parse(raw) as { extracted_text?: string; error?: string; model?: string; method?: string }; } catch {
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
  const [arrivalContext, setArrivalContext] = useState<ArrivalContext>("");
  const [draft, setDraft] = useState<AnalysisResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [analysisElapsed, setAnalysisElapsed] = useState(0);
  const [analysisNotice, setAnalysisNotice] = useState("");
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [selectedChoices, setSelectedChoices] = useState<Record<string, string>>({});
  const [choiceDetails, setChoiceDetails] = useState<Record<string, string>>({});
  const [, setAppliedChoiceText] = useState<Record<string, string>>({});
  const [recomposeLoading, setRecomposeLoading] = useState(false);
  const [recomposeNotice, setRecomposeNotice] = useState("");
  const [chatOpen, setChatOpen] = useState(false);
  const [chatMode, setChatMode] = useState<ChatMode>("documentation");
  const [chatContext, setChatContext] = useState("当前模板整体");
  const [chatMessages, setChatMessages] = useState<ChatEntry[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [chatModel, setChatModel] = useState<ChatModel>("deepseek-v4-pro");
  const [chatElapsed, setChatElapsed] = useState(0);
  const [clinicalReference, setClinicalReference] = useState<ClinicalReferenceBundle | null>(null);
  const [diagnosisStageResult, setDiagnosisStageResult] = useState<DiagnosisReferenceStage | null>(null);
  const [planStageResult, setPlanStageResult] = useState<PlanReferenceStage | null>(null);
  const [diagnosisStatus, setDiagnosisStatus] = useState<GenerationStatus>("waiting");
  const [planStatus, setPlanStatus] = useState<GenerationStatus>("waiting");
  const [referenceLoading, setReferenceLoading] = useState(false);
  const [referenceElapsed, setReferenceElapsed] = useState(0);
  const [referenceModel, setReferenceModel] = useState("");
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

  useEffect(() => {
    if (!loading) return;
    const timer = window.setInterval(() => setAnalysisElapsed((seconds) => seconds + 1), 1000);
    return () => window.clearInterval(timer);
  }, [loading]);

  useEffect(() => {
    if (!referenceLoading) return;
    const timer = window.setInterval(() => setReferenceElapsed((seconds) => seconds + 1), 1000);
    return () => window.clearInterval(timer);
  }, [referenceLoading]);

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
    if (chatMode !== "documentation") { setChatMessages([]); setChatInput(""); setChatElapsed(0); }
    setChatMode("documentation"); setChatContext(context); setChatOpen(true);
    if (item) setChatInput(`“${item.prompt}”这一项具体应该核对和记录哪些内容？`);
  };

  const effectiveCurrentPurpose = (result: AnalysisResult) => currentPurpose.trim()
    || result.facts.find((fact) => fact.event_type === "current_purpose" && fact.encounter_scope === "current")?.value
    || "";

  const openReferenceChat = (context = "当前病例的诊断与下一步", preset = "") => {
    setChatMode("clinical_reference"); setChatContext(context); setChatMessages([]); setChatInput(preset); setChatElapsed(0); setChatOpen(true);
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
      const referenceConversation = chatMode === "clinical_reference";
      // Sites currently requires a trailing slash for these streaming routes.
      const response = await fetch(referenceConversation ? "/api/clinical-reference-chat/" : "/api/template-chat/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(referenceConversation
          ? { message, history: chatMessages.slice(-6), facts: draft.facts, current_purpose: effectiveCurrentPurpose(draft), reference: clinicalReference, context: chatContext }
          : { message, history: chatMessages.slice(-6), template_name: draft.template_name, item_context: chatContext, model: selectedModel }),
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
    setReferenceLoading(true); setReferenceElapsed(0); setReferenceNotice(""); setClinicalReference(null);
    setDiagnosisStageResult(null); setPlanStageResult(null); setDiagnosisStatus("loading"); setPlanStatus("waiting");
    let diagnosisCompleted = false;
    try {
      const diagnosisResponse = await fetch("/api/clinical-reference", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "generate",
          stage: "diagnosis",
          facts: result.facts,
          current_purpose: effectiveCurrentPurpose(result),
          narrative: {
            chief_complaint: result.chief_complaint,
            present_illness: result.present_illness,
            past_history: result.past_history,
            allergy_history: result.allergy_history,
          },
        }),
      });
      const diagnosisPayload = await diagnosisResponse.json() as { result?: DiagnosisReferenceStage; model?: string; error?: string };
      if (!diagnosisResponse.ok || !diagnosisPayload.result) throw new Error(diagnosisPayload.error || "诊断阶段本次未完成。");
      const diagnosis = diagnosisPayload.result;
      diagnosisCompleted = true;
      setDiagnosisStageResult(diagnosis); setDiagnosisStatus("done"); setReferenceModel(diagnosisPayload.model || "deepseek-v4-pro");
      setDraft((current) => current ? { ...current, diagnosis_summary: referenceDiagnosisDraft(diagnosis) } : current);

      setPlanStatus("loading");
      const planResponse = await fetch("/api/clinical-reference", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "generate", stage: "plan", facts: result.facts, current_purpose: effectiveCurrentPurpose(result), diagnosis }),
      });
      const planPayload = await planResponse.json() as { result?: PlanReferenceStage; model?: string; error?: string };
      if (!planResponse.ok || !planPayload.result) throw new Error(planPayload.error || "诊疗计划阶段本次未完成。");
      const plan = planPayload.result;
      const reference = combineClinicalReferenceStages(diagnosis, plan);
      setPlanStageResult(plan); setPlanStatus("done"); setClinicalReference(reference);
      setDraft((current) => current ? { ...current, plan_summary: referencePlanDraft(plan) } : current);
      setChatMessages([]);
    } catch (caught) {
      if (!diagnosisCompleted) setDiagnosisStatus("error");
      else setPlanStatus("error");
      setReferenceNotice(caught instanceof Error ? caught.message : "AI分阶段参考本次没有完成。");
    }
    finally { setReferenceLoading(false); }
  };

  const verifyClinicalReference = async (action: "local" | "web") => {
    if (!draft || !clinicalReference || verificationLoading) return;
    setVerificationLoading(action); setReferenceNotice("");
    try {
      const response = await fetch("/api/clinical-reference", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, facts: draft.facts, current_purpose: effectiveCurrentPurpose(draft), reference: clinicalReference }) });
      const payload = await response.json() as { result?: ClinicalReferenceBundle; error?: string };
      if (!response.ok || !payload.result) throw new Error(payload.error || "交叉核验暂时失败。");
      setClinicalReference(payload.result);
    } catch (caught) { setReferenceNotice(caught instanceof Error ? caught.message : "交叉核验暂时失败。"); }
    finally { setVerificationLoading(null); }
  };

  const adoptReference = (field: "diagnosis_summary" | "plan_summary") => {
    if (field === "diagnosis_summary" && !diagnosisStageResult) return;
    if (field === "plan_summary" && !planStageResult) return;
    const content = field === "diagnosis_summary"
      ? referenceDiagnosisDraft(diagnosisStageResult!)
      : referencePlanDraft(planStageResult!);
    updateDraft(field, content);
    setReferenceNotice(field === "diagnosis_summary" ? "已填入初步诊断整理区，请医生逐项核对后删除候选标记；系统不会生成出院诊断。" : "已填入计划整理区，请医生按本院流程和患者实际情况核对。" );
  };

  const analyze = async () => {
    if (sourceText.trim().length < 20 || loading) return;
    setLoading(true); setAnalysisElapsed(0); setAnalysisNotice(""); setError("");
    try {
      const response = await fetch("/api/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source_text: sourceText, current_purpose: currentPurpose, arrival_context: arrivalContext }) });
      const payload = await readPayload(response) as { result?: AnalysisResult; model?: string; processing_status?: "model_generated"; fact_retry_count?: number; draft_retry_count?: number; error?: string };
      if (!response.ok || !payload.result) throw new Error(payload.error || "AI整理失败，请稍后重试。");
      const notices = [
        payload.fact_retry_count ? `${payload.fact_retry_count}段由V4 Pro自动重试后完成事实抽取；没有使用程序规则代替模型事实。` : "",
        payload.draft_retry_count ? "首版文书未通过质量门禁，已由V4 Pro自动重写后再展示。" : "",
        payload.processing_status === "model_generated" && payload.model ? `当前草稿由 ${payload.model} 根据结构化事实生成。` : "",
      ].filter(Boolean);
      if (notices.length) setAnalysisNotice(notices.join(" "));
      setDraft(payload.result); setClinicalReference(null); setDiagnosisStageResult(null); setPlanStageResult(null); setDiagnosisStatus("waiting"); setPlanStatus("waiting"); setChatMessages([]); setStage("result"); void generateClinicalReference(payload.result);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "AI整理失败，请稍后重试。";
      setError(/Failed to fetch|Load failed|NetworkError/i.test(message)
        ? "生成过程中连接中断，已转录的文字仍在页面上，可直接重试生成，无需重新上传。"
        : message);
    } finally { setLoading(false); }
  };

  const recognize = async (input: PreparedInput, existingId?: string): Promise<string | null> => {
    const id = existingId || crypto.randomUUID();
    if (existingId) updateUpload(id, { status: "recognizing", error: undefined });
    else setUploads((items) => [...items, { id, name: input.name, file: input.file, preview: input.preview, status: "recognizing" }]);
    try {
      const formData = new FormData(); formData.append("image", input.file);
      const response = await fetch("/api/extract-image", { method: "POST", body: formData });
      const payload = await readPayload(response);
      if (!response.ok || !payload.extracted_text) throw new Error(payload.error || "图片暂时没有识别出来。");
      updateUpload(id, { status: "done", model: payload.model });
      return `【${input.name}｜视觉转录，待核对】\n${payload.extracted_text.trim()}`;
    } catch (caught) { updateUpload(id, { status: "error", error: caught instanceof Error ? caught.message : "图片识别失败" }); return null; }
  };

  const retryUpload = async (item: UploadItem) => {
    const heading = await recognize({ name: item.name, file: item.file, preview: item.preview }, item.id);
    if (heading) setSourceText((current) => current.trim() ? `${current.trim()}\n\n${heading}` : heading);
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
      const identified = prepared.map((input) => ({ ...input, id: crypto.randomUUID() }));
      setUploads((items) => [...items, ...identified.map((input) => ({ id: input.id, name: input.name, file: input.file, preview: input.preview, status: "recognizing" as const }))]);
      const baseText = sourceText.trim();
      const results: Array<string | null> = Array(identified.length).fill(null);
      let nextIndex = 0;
      const runWorker = async () => {
        while (nextIndex < identified.length) {
          const index = nextIndex++;
          const input = identified[index];
          const heading = await recognize(input, input.id);
          if (!heading) continue;
          results[index] = heading;
          const extracted = results.filter((value): value is string => Boolean(value)).join("\n\n");
          setSourceText(baseText ? `${baseText}\n\n${extracted}` : extracted);
        }
      };
      await Promise.all(Array.from({ length: Math.min(RECOGNITION_CONCURRENCY, identified.length) }, runWorker));
    } catch (caught) { setError(caught instanceof Error ? caught.message : "文件处理失败，请重试。"); }
  };

  const chooseFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; if (!file) return;
    if (file.size > 100_000) { setError("演示版一次最多读取100KB文本，请精简后重试。"); return; }
    setSourceText(await file.text()); setError("");
  };

  const reset = () => { setStage("input"); setSourceText(""); setCurrentPurpose(""); setArrivalContext(""); setDraft(null); setUploads([]); setSelectedChoices({}); setChoiceDetails({}); setAppliedChoiceText({}); setRecomposeNotice(""); setChatOpen(false); setChatMode("documentation"); setChatContext("当前模板整体"); setChatMessages([]); setChatInput(""); setChatModel("deepseek-v4-pro"); setChatElapsed(0); setAnalysisElapsed(0); setAnalysisNotice(""); setClinicalReference(null); setDiagnosisStageResult(null); setPlanStageResult(null); setDiagnosisStatus("waiting"); setPlanStatus("waiting"); setReferenceLoading(false); setReferenceElapsed(0); setReferenceModel(""); setVerificationLoading(null); setReferenceNotice(""); setCopied(false); setError(""); };
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
  const timelineTypes = new Set(["onset_diagnosis", "pathology_molecular", "prior_treatment", "progression_evidence", "current_purpose", "current_status"]);
  const timelineFacts = draft ? draft.facts.filter((fact) => timelineTypes.has(fact.event_type)) : [];
  const backgroundFacts = draft ? draft.facts.filter((fact) => ["past_history", "personal_history", "family_history", "allergy_history"].includes(fact.event_type)) : [];

  return <main className="site-shell">
    <header className="site-header"><button type="button" className="wordmark" onClick={reset} aria-label="返回首页"><span>OP</span><div><strong>OncoPilot</strong><small>肿瘤入院记录草稿助手</small></div></button><div className="header-meta"><span className="version-pill">V0.13.0</span><a className="repository-link" href="/evaluation-lab">测评实验室</a><a className="repository-link" href="https://github.com/longjianw/oncopilot" target="_blank" rel="noreferrer">源码与迭代记录 ↗</a><div className="model-pill"><i /> 候选项需医生确认</div></div></header>
    <div className="stage-line two-steps" aria-label="当前流程"><span className={stage === "input" ? "active" : "done"}><b>1</b>放入资料</span><i /><span className={stage === "result" ? "active" : ""}><b>2</b>分阶段生成与核对</span></div>
    {stage === "input" && <section className="single-flow input-stage">
      <div className="hero-copy"><span className="eyebrow">单入口 · 入院记录草稿包</span><h1>资料再少，也先给你<br /><em>一套可选择、可补全的草稿</em></h1><p>已提供的内容先整理成事实；未提供的部分按肿瘤类型生成选择项。你点选确认后，句子才会加入草稿，不用从空白开始默写。</p></div>
      <div className="input-card">
        <div className="card-heading"><div><span>第一步只有这一个入口</span><h2>拍照、上传文件，或粘贴文字</h2></div><button type="button" onClick={() => { setSourceText(syntheticSample); setCurrentPurpose("进一步抗肿瘤治疗"); setError(""); }}>试试少量资料</button></div>
        <p className="reference-status"><b>真实病例测试</b> 可使用已取得必要授权并完成身份字段去标识化的真实临床资料；资料会发送给第三方模型处理，输出仍需医生结合原始资料审核。</p>
        <label className="purpose-field"><span>本次来院目的 <b>可选，但建议填写</b></span><input value={currentPurpose} onChange={(event) => setCurrentPurpose(event.target.value)} maxLength={160} placeholder="例如：继续治疗、复查评估、处理新出现的症状……" /><small>这行用于区分既往住院、出院计划与本次就诊。</small></label>
        <div className="arrival-context" aria-label="本次到院关系"><span>本次到院关系 <b>建议选择</b></span><div>{arrivalContextOptions.map((option) => <button type="button" key={option.value} className={arrivalContext === option.value ? "selected" : ""} aria-pressed={arrivalContext === option.value} onClick={() => setArrivalContext(option.value)}><strong>{option.label}</strong><small>{option.note}</small></button>)}</div><small>例如外院病历写“建议转上级医院”时，选择“外院转入我院”后，草稿会以本院收治作为本次结尾；若资料只有外院转诊意见而未选择，系统会先要求确认，不生成错位草稿。</small></div>
        <div className="image-actions" aria-label="资料文件输入"><label className="image-action camera-action">拍照<input type="file" accept="image/*" capture="environment" multiple onChange={chooseDocuments} /></label><label className="image-action">上传图片或 PDF<input type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif,application/pdf,.pdf" multiple onChange={chooseDocuments} /></label><span>最多 {MAX_ITEMS} 个资料页；PDF 最多 {MAX_PDF_PAGES} 页；HEIC 会先在本机转换</span></div>
        {uploads.length > 0 && <div className="upload-list">{uploads.map((item) => <div className={`upload-item ${item.status}`} key={item.id}>{item.preview ? <Image unoptimized src={item.preview} width={54} height={42} alt="待识别资料预览" /> : <span className="file-icon">PDF</span>}<span><strong>{item.name}</strong><small>{item.status === "recognizing" ? "正在用图像模型提取入院关键资料…" : item.status === "done" ? `已由 ${item.model || "图像模型"} 提取关键资料，请核对` : item.error || "文件处理失败"}</small>{item.status === "error" && <button type="button" onClick={() => void retryUpload(item)}>重试本页</button>}</span></div>)}</div>}
        <textarea value={sourceText} onChange={(event) => { setSourceText(event.target.value); setError(""); }} placeholder="把外院病理、检查、手术和治疗经过，本次症状，已询问的病史，实际查体，以及医生明确写下的诊断/计划放在这里……" aria-label="患者资料" maxLength={MAX_SOURCE_CHARS} />
        <div className="input-footer"><label className="file-choice">选择文本文件<input type="file" accept=".txt,.md,.json,text/plain" onChange={chooseFile} /></label><span>{sourceText.length}/{MAX_SOURCE_CHARS}</span></div>
        {error && <p className="error-message" role="alert">{error}</p>}
        <button type="button" className="primary-action" disabled={sourceText.trim().length < 20 || loading || busy} onClick={analyze}>{loading ? <><i className="spinner" />正在分段核对事实并生成草稿（{analysisElapsed}秒）</> : <>生成入院记录草稿包 <b>→</b></>}</button>
        <p className="privacy-copy">系统会提供候选阴性项和查体模板，但只有你点击确认后才加入草稿。</p>
      </div>
      <div className="output-promise three-items" aria-label="系统输出"><div><b>01</b><span><strong>先整理已知事实</strong><small>来源、时间、本次/既往、证据强度</small></span></div><div><b>02</b><span><strong>再给候选选项</strong><small>症状、病史、检查经过和专科查体</small></span></div><div><b>03</b><span><strong>点选后进入草稿</strong><small>保留人工判断，又不用从零书写</small></span></div></div>
    </section>}
    {stage === "result" && draft && <section className="single-flow result-stage draft-package">
      <div className="result-title"><div><span className="success-mark">✓</span><span><small>草稿骨架与候选项已生成</small><h1>先点选补全，再微调文字</h1></span></div><button type="button" className="copy-all" onClick={copyDraft}>{copied ? "已复制当前草稿" : unresolvedMarkers ? "复制当前草稿（含待完成标记）" : "复制当前草稿"}</button></div>
      {analysisNotice && <p className="analysis-notice">{analysisNotice}</p>}
      <div className="safety-banner"><strong>{draft.template_name}</strong><span>方括号是待完成项；下面的候选内容默认不算事实，只有点击后才加入对应草稿。</span></div>
      <section className="event-ledger">
        <div className="ledger-heading"><div><span>临床事件账本</span><h2>资料时间轴</h2><p>每个事件保留时间、本次/既往归属、证据强度和来源；现病史遗漏关键事件时不直接展示。</p></div><div><strong>{timelineFacts.length}</strong><small>时间线事件</small><strong>{backgroundFacts.length}</strong><small>背景病史</small></div></div>
        <details open><summary>查看临床时间轴</summary><div className="timeline-list">{timelineFacts.map((fact) => <article key={fact.fact_id}><div className="timeline-time"><strong>{fact.event_time}</strong><small>{eventTypeLabels[fact.event_type] || fact.event_type}</small></div><i /><div className="timeline-copy"><p>{fact.value}</p><small>{fact.encounter_scope === "current" ? "本次" : fact.encounter_scope === "prior" ? "既往" : "归属待核"} · {fact.certainty === "uncertain" ? "不确定" : fact.certainty === "pending" ? "待核对" : fact.certainty === "doctor_confirmed" ? "医生明确" : "资料明确"} · 来源 {fact.source_ids.join("、")}</small></div></article>)}</div></details>
        {backgroundFacts.length > 0 && <details><summary>查看基础病、旧手术、过敏等背景事件</summary><div className="background-ledger">{backgroundFacts.map((fact) => <div key={fact.fact_id}><b>{eventTypeLabels[fact.event_type] || fact.event_type}</b><span>{fact.value}<small>{fact.event_time} · 来源 {fact.source_ids.join("、")}</small></span></div>)}</div></details>}
      </section>
      {draft.review_items.length > 0 && <section className="guided-review">
        <div className="guided-heading"><div><span>快速补全</span><h2>先选择，再补细节，最后重新成稿</h2><p>已选择 {selectedCount}/{draft.review_items.length} 项。每次点击会先写入对应模块；完成几项后可一键整理成连贯文字。</p></div><div className="guided-tools"><div className="choice-legend"><span className="positive">有 / 异常</span><span className="negative">无 / 正常</span><span>未问 / 未查</span></div><button type="button" className="ask-ai" onClick={() => openTemplateChat()}>问 AI 这个模板</button></div></div>
        <div className="review-groups">{reviewGroups.map(({ group, items }) => <section className="review-group" key={group}><h3>{group}</h3><div className="review-items">{items.map((item) => {
          const selectedOption = item.options.find((option) => option.option_id === selectedChoices[item.choice_id]);
          return <div className={`review-item ${selectedOption ? "answered" : ""}`} key={item.choice_id}><div className="review-question"><strong>{item.prompt}</strong><small>{item.help}</small><button type="button" onClick={() => openTemplateChat(item)}>这项怎么问？</button></div><div><div className="review-options">{item.options.map((option) => <button type="button" key={option.option_id} className={`${option.tone} ${selectedChoices[item.choice_id] === option.option_id ? "selected" : ""}`} onClick={() => selectReviewOption(item, option)}>{option.label}</button>)}</div>{selectedOption?.detail_prompt && <label className="detail-fill"><span>补充这项（可选）</span><input value={choiceDetails[item.choice_id] || ""} onChange={(event) => updateChoiceDetail(item, event.target.value)} maxLength={500} placeholder={selectedOption.detail_prompt} /><small>已加入：{sectionLabels.find(({ field }) => field === item.section)?.label}</small></label>}</div></div>;
        })}</div></section>)}</div>
        <div className="recompose-bar"><div><strong>选择和填空完成后</strong><span>让 AI 去重、调整顺序，并重新组织主诉、现病史和其他模块。</span>{recomposeNotice && <small>{recomposeNotice}</small>}</div><button type="button" disabled={recomposeLoading || confirmations().length === 0} onClick={recomposeDraft}>{recomposeLoading ? "正在重新整理…" : "一键重新整理草稿"}</button></div>
      </section>}
      <section className="clinical-reference-panel">
        <div className="reference-heading"><div><span>诊断与下一步 · 分阶段生成</span><h2>一道一道生成，不再一次性端出整套答案</h2><p>时间轴和病史完成后，V4 Pro先单独整理诊断与依据；只有诊断阶段通过后，才生成当前优先问题、下一步和理由。</p></div><div className="reference-actions"><button type="button" disabled={referenceLoading} onClick={() => generateClinicalReference(draft)}>{referenceLoading ? `分阶段生成中 ${referenceElapsed}秒` : "重新分阶段生成"}</button><button type="button" disabled={!clinicalReference || Boolean(verificationLoading)} onClick={() => openReferenceChat("当前病例的诊断与下一步", "针对当前病例，我想进一步讨论：")} >继续问本病例</button><button type="button" disabled={!clinicalReference || Boolean(verificationLoading)} onClick={() => verifyClinicalReference("local")}>{verificationLoading === "local" ? "本地核验中…" : "核验已接入来源卡"}</button><button type="button" disabled={!clinicalReference || Boolean(verificationLoading)} onClick={() => verifyClinicalReference("web")}>{verificationLoading === "web" ? "联网核验中…" : "联网核验权威网页"}</button></div></div>
        <div className="generation-pipeline"><div className="done"><b>1</b><span><strong>事件账本</strong><small>已绑定来源</small></span></div><i /><div className="done"><b>2</b><span><strong>主诉与病史</strong><small>已通过完整性门禁</small></span></div><i /><div className={diagnosisStatus}><b>3</b><span><strong>初步诊断</strong><small>{diagnosisStatus === "loading" ? "V4 Pro正在整理" : diagnosisStatus === "done" ? "已完成" : diagnosisStatus === "error" ? "本次未完成" : "等待"}</small></span></div><i /><div className={planStatus}><b>4</b><span><strong>下一步与理由</strong><small>{planStatus === "loading" ? "V4 Pro正在分析" : planStatus === "done" ? "已完成" : planStatus === "error" ? "本次未完成" : "等待诊断阶段"}</small></span></div></div>
        {referenceLoading && <div className="reference-loading"><i className="spinner" /> {diagnosisStatus === "loading" ? "V4 Pro正在单独整理初步诊断、诊断依据与关键缺口" : "诊断阶段已完成，V4 Pro正在生成当前优先问题、下一步与理由"}，已等待 {referenceElapsed} 秒……</div>}
        {diagnosisStageResult && !clinicalReference && <div className="reference-content stage-preview"><div className="reference-state"><strong>诊断阶段已完成</strong><span>下一步正在独立生成；不需要等整套内容才能先看诊断。</span></div><div className="reference-grid"><article><h3>初步诊断与依据</h3><p><b>初步诊断：</b>{diagnosisStageResult.preliminary_diagnosis}</p><p><b>诊断依据：</b>{diagnosisStageResult.diagnostic_basis.join("；")}</p><p><b>鉴别诊断：</b>{diagnosisStageResult.differential_diagnosis.join("；") || "当前未必要机械罗列"}</p></article><article><h3>会改变诊断表达的关键缺口</h3><ul>{diagnosisStageResult.missing_prerequisites.map((item) => <li key={item}>{item}</li>)}</ul></article></div></div>}
        {clinicalReference && <div className="reference-content">
          <div className="reference-state"><strong>{clinicalReference.verification_state === "model_only" ? `${referenceModel || "V4 Pro"} 病例专属初稿 · 未交叉核验` : clinicalReference.verification_state === "local_checked" ? "已用本地来源卡核验" : "已联网读取权威网页核验"}</strong><span>{clinicalReference.disclaimer}</span></div>
          {clinicalReference.current_priority && <div className="priority-card"><span>当前优先问题</span><h3>{clinicalReference.current_priority}</h3><ul>{clinicalReference.plan_reasoning?.map((item) => <li key={item}>{item}</li>)}</ul></div>}
          <div className="reference-grid"><article><h3>初步诊断与依据</h3><p><b>初步诊断：</b>{clinicalReference.preliminary_diagnosis}</p><p><b>诊断依据：</b>{clinicalReference.diagnostic_basis.join("；") || "待补"}</p><p><b>鉴别诊断：</b>{clinicalReference.differential_diagnosis.join("；") || "待医生确认"}</p><button type="button" onClick={() => adoptReference("diagnosis_summary")}>填入初步诊断整理</button></article><article><h3>尚缺关键前提</h3><ul>{clinicalReference.missing_prerequisites.map((item) => <li key={item}>{item}</li>)}</ul></article></div>
          <div className="reference-paths"><article><h3>候选检查与评估</h3>{clinicalReference.suggested_workup.map((item) => <div key={`${item.title}-${item.trigger}`}><strong>{item.title}</strong><span>何时考虑：{item.trigger}</span><small>目的：{item.purpose}</small><button type="button" onClick={() => openReferenceChat(`候选检查：${item.title}`, `关于“${item.title}”，针对当前病例还需怎样判断、补齐哪些前提？`)}>继续问这一项</button></div>)}</article><article><h3>分层诊疗方向</h3>{clinicalReference.treatment_pathways.map((item) => <div key={`${item.title}-${item.trigger}`}><strong>{item.title}</strong><span>适用前提：{item.trigger}</span><small>讨论目的：{item.purpose}</small><button type="button" onClick={() => openReferenceChat(`诊疗方向：${item.title}`, `关于“${item.title}”，针对当前病例下一步怎样进一步判断？如涉及药物，请同时列出执行前必须核对的处方与药学字段。`)}>继续问这一项</button></div>)}</article></div>
          {clinicalReference.decision_changers?.length ? <div className="decision-changers"><h3>最能改变当前顺序的资料</h3><ul>{clinicalReference.decision_changers.map((item) => <li key={item}>{item}</li>)}</ul>{clinicalReference.next_question && <button type="button" onClick={() => openReferenceChat("当前最关键的一个问题", clinicalReference.next_question)}>继续问：{clinicalReference.next_question}</button>}</div> : null}
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
      {chatOpen && <aside className={`chat-drawer ${chatMode === "clinical_reference" ? "clinical-reference-chat" : "documentation-chat"}`} aria-label={chatMode === "clinical_reference" ? "本病例继续讨论窗口" : "AI文书核对窗口"}><div className="chat-header"><div><strong>{chatMode === "clinical_reference" ? "继续问本病例" : "问 AI · 文书核对"}</strong><small>{chatContext}</small></div><button type="button" onClick={() => setChatOpen(false)} aria-label="关闭聊天">×</button></div><div className="chat-boundary">{chatMode === "clinical_reference" ? "基于本病例结构化事实和本轮候选继续讨论。药物、剂量、溶媒、配伍和输注必须同时核对病情条件、院内药品信息与药师/上级审核；当前未接入本院药品字典时，系统不会编造成可直接发送的配液医嘱。" : "可以问“这项要核对什么、怎样记录”；AI不会替患者回答，也不做诊断和治疗建议。"}</div>{chatMode === "documentation" && <div className="chat-models" aria-label="回答模型">{chatModelOptions.map((option) => <button type="button" key={option.id} className={chatModel === option.id ? "selected" : ""} disabled={chatLoading} onClick={() => setChatModel(option.id)}><strong>{option.label}</strong><small>{option.note}</small></button>)}</div>}<div className="chat-messages">{chatMessages.length === 0 ? <div className="chat-empty"><p>例如：</p>{chatMode === "clinical_reference" ? <><button type="button" onClick={() => setChatInput("当前病例的抗感染方向有哪些候选？在决定具体药物前，我还必须核对哪些病情、病原学、肝肾功能、过敏与院内药学字段？")}>抗感染还要核对什么？</button><button type="button" onClick={() => setChatInput("如果上级建议某个抗菌药方案，开医嘱前应补齐哪些剂量、频次、溶媒、输注和配伍字段，避免护士退单？")}>避免护士退单要核对什么？</button></> : <><button type="button" onClick={() => setChatInput("区域淋巴结这一项，通常要记录哪些部位和查体特征？")}>区域淋巴结要记什么？</button><button type="button" onClick={() => setChatInput("一个阳性症状需要补充哪些时间和程度信息？")}>阳性症状怎么补细节？</button></>}</div> : chatMessages.map((message, index) => <div className={message.role} key={`${message.role}-${index}`}><div className="chat-copy">{renderChatContent(message.content)}</div>{message.role === "assistant" && message.modelLabel && <small className="chat-meta">{message.modelLabel} · {message.elapsedSeconds}秒</small>}</div>)}{chatLoading && <div className="assistant loading"><i className="spinner" />正在思考 {chatElapsed} 秒…</div>}</div><form onSubmit={sendChat}><textarea value={chatInput} onChange={(event) => setChatInput(event.target.value)} maxLength={1200} placeholder={chatMode === "clinical_reference" ? "例如：抗感染具体如何进一步判断？开立医嘱前还缺什么？" : "输入已授权并完成身份字段去标识化的临床资料……"} /><button type="submit" disabled={!chatInput.trim() || chatLoading}>发送</button></form></aside>}
    </section>}
    <footer className="site-footer"><div><strong>OncoPilot V0.13.0</strong><span>公开测试版 · AI 输出须由有资质医生审核</span></div><nav aria-label="项目链接"><a href="/evaluation-lab">内部测评实验室</a><a href="https://github.com/longjianw/oncopilot" target="_blank" rel="noreferrer">GitHub 源码与版本记录</a><a href="https://github.com/longjianw/oncopilot/issues" target="_blank" rel="noreferrer">提交问题或建议</a></nav><p>支持经授权的真实病例测试；姓名、住院号等身份字段需先去标识化，资料将发送给第三方模型处理。</p></footer>
  </main>;
}
