"use client";
/* eslint-disable @next/next/no-html-link-for-pages -- vinext dev currently loads a duplicate React renderer through next/link on this client page. */

import { type ChangeEvent, useEffect, useMemo, useState } from "react";
import Image from "next/image";
import {
  calculateArmScore,
  emptyEvaluationSession,
  evaluationDimensions,
  scoreGuide,
  winnerLabel,
  type BoardRoleReview,
  type BoardRoleId,
  type EvaluationArm,
  type EvaluationBoardResult,
  type EvaluationDimensionId,
  type EvaluationSession,
} from "../../lib/evaluation-lab";
import {
  MAX_DOCUMENT_ITEMS,
  MAX_PDF_PAGES,
  compressDocumentImage,
  documentPdfToImages,
  isHeicDocument,
  isPdfDocument,
  type PreparedDocumentInput,
} from "../../lib/client-document-input";
import styles from "./page.module.css";

type SourceId = "oncopilot" | "baseline";
type Assignment = { A: SourceId; B: SourceId };
type UploadStatus = "recognizing" | "done" | "error";
type EvalUploadItem = PreparedDocumentInput & { id: string; status: UploadStatus; error?: string; model?: string };
type EvalFact = { value: string; event_time: string; event_type: string; encounter_scope: string; certainty: string; source_ids: string[] };
type EvalDraft = {
  chief_complaint: string;
  present_illness: string;
  past_history: string;
  personal_history: string;
  family_history: string;
  allergy_history: string;
  specialist_exam: string;
  facts: EvalFact[];
};
type SourceMetrics = { elapsedSeconds: number; retries: number };
type SavedState = {
  caseLabel: string;
  track: EvaluationSession["track"];
  evaluator: string;
  armA: Omit<EvaluationArm, "output">;
  armB: Omit<EvaluationArm, "output">;
};

const STORAGE_KEY = "oncopilot-evaluation-lab-v1";

const sourceLabels: Record<SourceId, string> = {
  oncopilot: "OncoPilot · V4 Pro",
  baseline: "GPT-5.6 Sol 文本基线",
};

const meetingRoles: Array<{ id: BoardRoleId; label: string; focus: string }> = [
  { id: "product", label: "产品经理小龙虾", focus: "首印象与编辑负担" },
  { id: "user_research", label: "市场与用户研究小龙虾", focus: "继续使用或放弃的原因" },
  { id: "engineering", label: "技术负责人小龙虾", focus: "模型、门禁与失败根因" },
  { id: "clinical_quality", label: "临床质量小龙虾", focus: "记录忠实度与安全风险" },
  { id: "evaluation", label: "测评师小龙虾", focus: "盲法、证据与可复现性" },
];

const syntheticEvaluationInput = `临床事件账本：
1. 2月前：因咳嗽发现右肺占位；病理仅支持恶性肿瘤，具体分型待核对。
2. 1月前：开始一线全身治疗；方案和疗效评价标准未提供。
3. 1周前：复查影像提示病灶较前增大；未提供远处转移依据。
4. 背景史：高血压5年，具体用药待核对。
5. 本次目的：进一步评估近期影像变化。`;

const cloneWithoutOutput = (arm: EvaluationArm): Omit<EvaluationArm, "output"> => ({
  scores: { ...arm.scores },
  p0Count: arm.p0Count,
  p1Count: arm.p1Count,
  latencySeconds: arm.latencySeconds,
  retryCount: arm.retryCount,
  reviewerNote: arm.reviewerNote,
});

const hydrateArm = (arm: Omit<EvaluationArm, "output"> | undefined): EvaluationArm => ({
  ...emptyEvaluationSession().armA,
  ...(arm || {}),
  scores: { ...emptyEvaluationSession().armA.scores, ...(arm?.scores || {}) },
  output: "",
});

const RoleCard = ({ review }: { review: BoardRoleReview }) => <article className={styles.roleCard}>
  <span>{review.roleLabel} · {review.model}</span>
  <h3>{review.headline}</h3>
  <ul>{review.evidence.map((item) => <li key={item}>{item}</li>)}</ul>
  <p><b>本轮先做：</b>{review.recommendation}</p>
  <small>需注意：{review.concern}</small>
</article>;

export default function EvaluationLabPage() {
  const [session, setSession] = useState<EvaluationSession>(() => emptyEvaluationSession());
  const [oncopilotOutput, setOncopilotOutput] = useState("");
  const [baselineOutput, setBaselineOutput] = useState("");
  const [baselineLabel, setBaselineLabel] = useState("GPT-5.6 Sol · 手动导入");
  const [evaluationInput, setEvaluationInput] = useState("");
  const [baselineLoading, setBaselineLoading] = useState(false);
  const [oncopilotLoading, setOncopilotLoading] = useState(false);
  const [dualLoading, setDualLoading] = useState(false);
  const [oncopilotError, setOncopilotError] = useState("");
  const [baselineError, setBaselineError] = useState("");
  const [uploads, setUploads] = useState<EvalUploadItem[]>([]);
  const [uploadError, setUploadError] = useState("");
  const [checklistLoading, setChecklistLoading] = useState(false);
  const [checklistModel, setChecklistModel] = useState("");
  const [oncoMetrics, setOncoMetrics] = useState<SourceMetrics>({ elapsedSeconds: 0, retries: 0 });
  const [baselineMetrics, setBaselineMetrics] = useState<SourceMetrics>({ elapsedSeconds: 0, retries: 0 });
  const [assignment, setAssignment] = useState<Assignment | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [boardResult, setBoardResult] = useState<EvaluationBoardResult | null>(null);
  const [meetingReviews, setMeetingReviews] = useState<BoardRoleReview[]>([]);
  const [boardLoading, setBoardLoading] = useState(false);
  const [boardError, setBoardError] = useState("");
  const [storageReady, setStorageReady] = useState(false);
  const [ratedDimensions, setRatedDimensions] = useState<Record<string, true>>({});

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const stored = window.localStorage.getItem(STORAGE_KEY);
        if (stored) {
          const saved = JSON.parse(stored) as SavedState;
          setSession((current) => ({
            ...current,
            caseLabel: saved.caseLabel || current.caseLabel,
            track: saved.track === "end_to_end" ? "end_to_end" : "generation_only",
            evaluator: saved.evaluator || "",
            armA: hydrateArm(saved.armA),
            armB: hydrateArm(saved.armB),
          }));
        }
      } catch { /* device-local draft is optional */ }
      setStorageReady(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!storageReady) return;
    const saved: SavedState = {
      caseLabel: session.caseLabel,
      track: session.track,
      evaluator: session.evaluator,
      armA: cloneWithoutOutput(session.armA),
      armB: cloneWithoutOutput(session.armB),
    };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
  }, [session, storageReady]);

  const scoreA = useMemo(() => calculateArmScore(session.armA), [session.armA]);
  const scoreB = useMemo(() => calculateArmScore(session.armB), [session.armB]);
  const winner = winnerLabel(scoreA, scoreB);
  const ratingCount = Object.keys(ratedDimensions).length;
  const boardReady = ratingCount === evaluationDimensions.length * 2 && Boolean(session.armA.reviewerNote.trim()) && Boolean(session.armB.reviewerNote.trim());
  const boardStarted = boardLoading || meetingReviews.length > 0 || Boolean(boardResult);

  const updateArm = (arm: "armA" | "armB", patch: Partial<EvaluationArm>) => {
    setSession((current) => ({ ...current, [arm]: { ...current[arm], ...patch } }));
    setBoardResult(null);
    setMeetingReviews([]);
  };

  const updateScore = (arm: "armA" | "armB", id: EvaluationDimensionId, value: number) => {
    updateArm(arm, { scores: { ...session[arm].scores, [id]: value } });
    setRatedDimensions((current) => ({ ...current, [`${arm}:${id}`]: true }));
  };

  const startBlindReview = () => {
    if (!oncopilotOutput.trim() || !baselineOutput.trim()) return;
    const oncoIsA = crypto.getRandomValues(new Uint8Array(1))[0] % 2 === 0;
    const nextAssignment: Assignment = oncoIsA ? { A: "oncopilot", B: "baseline" } : { A: "baseline", B: "oncopilot" };
    setAssignment(nextAssignment);
    setRevealed(false);
    setBoardResult(null);
    setMeetingReviews([]);
    setRatedDimensions({});
    const armFor = (source: SourceId): EvaluationArm => {
      const empty = emptyEvaluationSession().armA;
      const metrics = source === "oncopilot" ? oncoMetrics : baselineMetrics;
      return { ...empty, output: source === "oncopilot" ? oncopilotOutput : baselineOutput, latencySeconds: metrics.elapsedSeconds, retryCount: metrics.retries };
    };
    setSession((current) => ({ ...current, armA: armFor(nextAssignment.A), armB: armFor(nextAssignment.B) }));
    requestAnimationFrame(() => document.getElementById("blind-review")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };

  const loadSynthetic = () => {
    uploads.forEach((item) => item.preview && URL.revokeObjectURL(item.preview));
    setUploads([]);
    setUploadError("");
    setChecklistModel("");
    setSession((current) => ({ ...emptyEvaluationSession(), evaluator: current.evaluator, goldSummary: "合成事实：右肺占位2月；病理仅明确恶性，分型缺失；1月前开始一线全身治疗，方案缺失；1周前影像提示病灶增大；高血压5年；本次目的为进一步评估。" }));
    setOncopilotOutput("");
    setBaselineOutput("");
    setEvaluationInput(syntheticEvaluationInput);
    setBaselineLabel("GPT-5.6 Sol · 等待现场生成");
    setOncoMetrics({ elapsedSeconds: 0, retries: 0 });
    setBaselineMetrics({ elapsedSeconds: 0, retries: 0 });
    setAssignment(null);
    setRevealed(false);
    setBoardResult(null);
    setMeetingReviews([]);
    setRatedDimensions({});
  };

  const reset = () => {
    setSession(emptyEvaluationSession());
    setOncopilotOutput("");
    setBaselineOutput("");
    setEvaluationInput("");
    setBaselineLabel("GPT-5.6 Sol · 手动导入");
    setBaselineError("");
    setOncopilotError("");
    setUploadError("");
    uploads.forEach((item) => item.preview && URL.revokeObjectURL(item.preview));
    setUploads([]);
    setChecklistModel("");
    setOncoMetrics({ elapsedSeconds: 0, retries: 0 });
    setBaselineMetrics({ elapsedSeconds: 0, retries: 0 });
    setAssignment(null);
    setRevealed(false);
    setBoardResult(null);
    setMeetingReviews([]);
    setBoardError("");
    setRatedDimensions({});
    window.localStorage.removeItem(STORAGE_KEY);
  };

  const updateUpload = (id: string, patch: Partial<EvalUploadItem>) => setUploads((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item));

  const recognizeDocument = async (item: EvalUploadItem) => {
    try {
      const formData = new FormData();
      formData.append("image", item.file);
      const response = await fetch("/api/extract-image", { method: "POST", body: formData });
      const raw = await response.text();
      let payload: { extracted_text?: string; error?: string; model?: string } = {};
      try { payload = JSON.parse(raw) as typeof payload; } catch { payload.error = `图片服务返回异常（${response.status}）`; }
      if (!response.ok || !payload.extracted_text) throw new Error(payload.error || "本页没有识别成功。");
      updateUpload(item.id, { status: "done", model: payload.model });
      return `【${item.name}｜视觉转录，待核对】\n${payload.extracted_text.trim()}`;
    } catch (error) {
      updateUpload(item.id, { status: "error", error: error instanceof Error ? error.message : "本页没有识别成功" });
      return null;
    }
  };

  const chooseDocuments = async (event: ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(event.target.files || []);
    event.target.value = "";
    if (!selected.length) return;
    setUploadError("");
    try {
      const prepared: PreparedDocumentInput[] = [];
      for (const file of selected) {
        if (isPdfDocument(file)) prepared.push(...await documentPdfToImages(file));
        else if (file.type.startsWith("image/") || isHeicDocument(file)) {
          const compressed = await compressDocumentImage(file, file.name);
          prepared.push({ name: file.name, file: compressed, preview: URL.createObjectURL(compressed) });
        } else throw new Error("这里只读取图片或PDF。");
      }
      if (uploads.length + prepared.length > MAX_DOCUMENT_ITEMS) {
        prepared.forEach((item) => item.preview && URL.revokeObjectURL(item.preview));
        throw new Error(`一次最多读取 ${MAX_DOCUMENT_ITEMS} 个资料页。`);
      }
      const items = prepared.map((input) => ({ ...input, id: crypto.randomUUID(), status: "recognizing" as const }));
      setUploads((current) => [...current, ...items]);
      const baseText = evaluationInput.trim();
      const results: Array<string | null> = Array(items.length).fill(null);
      let nextIndex = 0;
      const worker = async () => {
        while (nextIndex < items.length) {
          const index = nextIndex++;
          results[index] = await recognizeDocument(items[index]);
          const recognized = results.filter((value): value is string => Boolean(value)).join("\n\n");
          setEvaluationInput(baseText && recognized ? `${baseText}\n\n${recognized}` : baseText || recognized);
        }
      };
      await Promise.all(Array.from({ length: Math.min(2, items.length) }, worker));
    } catch (error) { setUploadError(error instanceof Error ? error.message : "资料没有读取成功。"); }
  };

  const generateChecklist = async () => {
    if (evaluationInput.trim().length < 20 || checklistLoading) return;
    setChecklistLoading(true); setUploadError("");
    try {
      const response = await fetch("/api/evaluation-checklist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ evaluation_input: evaluationInput, track: session.track }),
      });
      const payload = await response.json() as { result?: { summary?: string }; model?: string; error?: string };
      if (!response.ok || !payload.result?.summary) throw new Error(payload.error || "核对清单没有生成成功。");
      setSession((current) => ({ ...current, goldSummary: payload.result!.summary! }));
      setChecklistModel(payload.model || "gpt-5.4");
    } catch (error) { setUploadError(error instanceof Error ? error.message : "核对清单没有生成成功。"); }
    finally { setChecklistLoading(false); }
  };

  const generateBaseline = async () => {
    if (!evaluationInput.trim()) {
      setBaselineError("请先填写本轮统一输入；生成质量轨道填事件账本，端到端轨道填源资料。");
      return;
    }
    setBaselineLoading(true);
    setBaselineError("");
    try {
      const response = await fetch("/api/evaluation-baseline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ evaluation_input: evaluationInput, track: session.track }),
      });
      const payload = await response.json() as { result?: string; model?: string; elapsedSeconds?: number; error?: string };
      if (!response.ok || !payload.result) throw new Error(payload.error || "自动对照暂时失败。");
      setBaselineOutput(payload.result);
      setBaselineLabel(`${payload.model || "gpt-5.6-sol"} · 自动生成 · ${payload.elapsedSeconds || 0}秒`);
      setBaselineMetrics({ elapsedSeconds: Number(payload.elapsedSeconds || 0), retries: 0 });
    } catch (error) {
      setBaselineOutput("");
      setBaselineMetrics({ elapsedSeconds: 0, retries: 0 });
      setBaselineError(error instanceof Error ? error.message : "自动对照暂时失败。");
    } finally { setBaselineLoading(false); }
  };

  const formatOncoPilotOutput = (draft: EvalDraft, diagnosis: Record<string, unknown>, plan: Record<string, unknown>) => {
    const list = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) : [];
    const paths = (value: unknown) => Array.isArray(value) ? value.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const candidate = item as { title?: unknown; trigger?: unknown; purpose?: unknown };
      if (![candidate.title, candidate.trigger, candidate.purpose].every((field) => typeof field === "string")) return [];
      return [`${candidate.title}（条件：${candidate.trigger}；目的：${candidate.purpose}）`];
    }) : [];
    const sections = [
      ["主诉", draft.chief_complaint],
      ["现病史", draft.present_illness],
      ["既往史", draft.past_history],
      ["个人史", draft.personal_history],
      ["家族史", draft.family_history],
      ["过敏史", draft.allergy_history],
      ["专科情况", draft.specialist_exam],
      ["初步诊断", typeof diagnosis.preliminary_diagnosis === "string" ? diagnosis.preliminary_diagnosis : ""],
      ["诊断依据", list(diagnosis.diagnostic_basis).map((item, index) => `${index + 1}. ${item}`).join("\n")],
      ["鉴别诊断", list(diagnosis.differential_diagnosis).map((item, index) => `${index + 1}. ${item}`).join("\n")],
      ["当前优先问题", typeof plan.current_priority === "string" ? plan.current_priority : ""],
      ["判断理由", list(plan.plan_reasoning).map((item, index) => `${index + 1}. ${item}`).join("\n")],
      ["候选检查与评估", paths(plan.suggested_workup).map((item, index) => `${index + 1}. ${item}`).join("\n")],
      ["分层诊疗方向", paths(plan.treatment_pathways).map((item, index) => `${index + 1}. ${item}`).join("\n")],
      ["最能改变判断的资料", list(plan.decision_changers).map((item, index) => `${index + 1}. ${item}`).join("\n")],
      ["下一个问题", typeof plan.next_question === "string" ? plan.next_question : ""],
    ];
    return sections.filter(([, value]) => value).map(([label, value]) => `${label}：\n${value}`).join("\n\n");
  };

  const generateOncoPilot = async () => {
    if (evaluationInput.trim().length < 20) { setOncopilotError("请先放入本轮资料。"); return; }
    setOncopilotLoading(true); setOncopilotError("");
    const startedAt = performance.now();
    try {
      const analysisResponse = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source_text: evaluationInput, current_purpose: "", arrival_context: "本次到院身份待确认" }),
      });
      const analysisPayload = await analysisResponse.json() as { result?: EvalDraft; fact_retry_count?: number; draft_retry_count?: number; error?: string };
      if (!analysisResponse.ok || !analysisPayload.result) throw new Error(analysisPayload.error || "OncoPilot病史阶段没有完成。");
      const draft = analysisPayload.result;
      const diagnosisResponse = await fetch("/api/clinical-reference", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "generate", stage: "diagnosis", facts: draft.facts, narrative: draft }),
      });
      const diagnosisPayload = await diagnosisResponse.json() as { result?: Record<string, unknown>; error?: string };
      if (!diagnosisResponse.ok || !diagnosisPayload.result) throw new Error(diagnosisPayload.error || "OncoPilot诊断阶段没有完成。");
      const planResponse = await fetch("/api/clinical-reference", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "generate", stage: "plan", facts: draft.facts, diagnosis: diagnosisPayload.result }),
      });
      const planPayload = await planResponse.json() as { result?: Record<string, unknown>; error?: string };
      if (!planResponse.ok || !planPayload.result) throw new Error(planPayload.error || "OncoPilot计划阶段没有完成。");
      const elapsedSeconds = Math.round((performance.now() - startedAt) / 100) / 10;
      const retries = Number(analysisPayload.fact_retry_count || 0) + Number(analysisPayload.draft_retry_count || 0);
      setOncopilotOutput(formatOncoPilotOutput(draft, diagnosisPayload.result, planPayload.result));
      setOncoMetrics({ elapsedSeconds, retries });
    } catch (error) {
      setOncopilotOutput("");
      setOncopilotError(error instanceof Error ? error.message : "OncoPilot本次没有完成。");
    } finally { setOncopilotLoading(false); }
  };

  const generateBoth = async () => {
    if (evaluationInput.trim().length < 20 || dualLoading) return;
    setDualLoading(true); setAssignment(null); setRevealed(false); setBoardResult(null); setMeetingReviews([]); setRatedDimensions({});
    setOncopilotOutput(""); setBaselineOutput("");
    setOncoMetrics({ elapsedSeconds: 0, retries: 0 }); setBaselineMetrics({ elapsedSeconds: 0, retries: 0 });
    try { await Promise.all([generateOncoPilot(), generateBaseline()]); }
    finally { setDualLoading(false); }
  };

  const runBoard = async () => {
    if (!boardReady) {
      setBoardError("请先完成 A/B 的20项评分，并分别写一句评审摘要，再开龙虾评审会。");
      return;
    }
    setBoardLoading(true);
    setBoardError("");
    setBoardResult(null);
    setMeetingReviews([]);
    try {
      const startedAt = performance.now();
      const basePayload = { case_label: session.caseLabel, track: session.track, arm_a: { ...session.armA, output: "" }, arm_b: { ...session.armB, output: "" } };
      const reviews = await Promise.all(meetingRoles.map(async (role) => {
        const response = await fetch("/api/evaluation-board", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...basePayload, mode: "role", role_id: role.id }),
        });
        const payload = await response.json() as { result?: { review?: BoardRoleReview; model?: string }; error?: string };
        if (!response.ok || !payload.result?.review) throw new Error(payload.error || `${role.label}暂时没有完成发言。`);
        setMeetingReviews((current) => [...current.filter((item) => item.role !== role.id), payload.result!.review!]);
        return payload.result.review;
      }));
      const executiveResponse = await fetch("/api/evaluation-board", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...basePayload, mode: "executive", reviews }),
      });
      const executivePayload = await executiveResponse.json() as { result?: { executive?: EvaluationBoardResult["executive"]; model?: string }; error?: string };
      if (!executiveResponse.ok || !executivePayload.result?.executive) throw new Error(executivePayload.error || "CEO汇总暂时失败。");
      setBoardResult({ reviews, executive: executivePayload.result.executive, ceoModel: executivePayload.result.model || "gpt-5.6-sol", models: [...new Set(reviews.map((review) => review.model))], elapsedSeconds: Math.round((performance.now() - startedAt) / 100) / 10, mixedModelReview: true });
      setRevealed(true);
    } catch (error) {
      setBoardError(error instanceof Error ? error.message : "龙虾评审会本次没有完成。");
    } finally { setBoardLoading(false); }
  };

  const exportResult = () => {
    const report = {
      exported_at: new Date().toISOString(),
      case_label: session.caseLabel,
      track: session.track,
      evaluator: session.evaluator,
      baseline_label: baselineLabel,
      assignment,
      scores: { A: scoreA, B: scoreB, winner },
      arms: session,
      board: boardResult,
      evidence_boundary: "小样本试评结果，不等同于临床准确率或临床有效性。",
    };
    const href = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = `oncopilot-eval-${session.caseLabel.replace(/[^\w\u4e00-\u9fa5-]+/g, "-") || "session"}.json`;
    anchor.click();
    URL.revokeObjectURL(href);
  };

  return <main className={styles.shell}>
    <header className={styles.header}>
      <a href="/" className={styles.brand}><span>OP</span><div><strong>OncoPilot</strong><small>A/B 测评实验室</small></div></a>
      <div><span className={styles.version}>V0.15.1</span><a href="/">返回病历助手</a></div>
    </header>

    <section className={styles.hero}>
      <div><span className={styles.eyebrow}>A/B 盲测</span><h1>病例测评</h1><p>同一份输入由OncoPilot和GPT-5.6 Sol现场生成。评分时隐藏模型名称，完成后再揭盲。</p></div>
      <aside><strong>本页记录什么</strong><p>两份回答、医生评分、错误类型、耗时和重试次数。</p><small>少量病例用于找问题，不用于计算临床准确率。</small></aside>
    </section>

    <nav className={styles.steps} aria-label="测评流程"><span className={!assignment ? styles.active : styles.done}><b>1</b>准备病例</span><i /><span className={assignment && !revealed ? styles.active : assignment ? styles.done : ""}><b>2</b>盲评 A/B</span><i /><span className={revealed ? styles.active : ""}><b>3</b>揭盲并开会</span></nav>

    <section className={styles.card}>
      <div className={styles.cardHeading}><div><span>01 · 测试设置</span><h2>填写病例编号和评分依据</h2></div><button type="button" onClick={loadSynthetic}>装入合成资料</button></div>
      <div className={styles.formGrid}>
        <label><span>试评编号</span><input value={session.caseLabel} maxLength={80} onChange={(event) => setSession((current) => ({ ...current, caseLabel: event.target.value }))} /></label>
        <label><span>评审者</span><input value={session.evaluator} maxLength={80} placeholder="例如：肿瘤科住院医师 01" onChange={(event) => setSession((current) => ({ ...current, evaluator: event.target.value }))} /></label>
        <label className={styles.wide}><span>评测轨道</span><select value={session.track} onChange={(event) => setSession((current) => ({ ...current, track: event.target.value as EvaluationSession["track"] }))}><option value="generation_only">使用已确认的临床事件账本</option><option value="end_to_end">上传资料并使用同一份视觉转录</option></select><small>第二条轨道比较资料整理和生成，不比较两个视觉模型；两边读取同一份转录文字。</small></label>
        <label className={styles.wide}><span>医生核对清单</span><textarea value={session.goldSummary} maxLength={6000} placeholder="记录必须覆盖的事实、不得新增的内容和本次核心问题。GPT可以起草，医生按原始资料修改后再评分。" onChange={(event) => setSession((current) => ({ ...current, goldSummary: event.target.value }))} /><small>{checklistModel ? `清单由 ${checklistModel} 起草，尚需医生确认。` : "这不是标准答案，只是评分时的事实依据。"}</small></label>
      </div>
      <div className={styles.actions}><button type="button" disabled={checklistLoading || evaluationInput.trim().length < 20} onClick={generateChecklist}>{checklistLoading ? "正在起草核对清单…" : "根据本轮资料起草核对清单"}</button></div>
    </section>

    <section className={styles.card}>
      <div className={styles.cardHeading}><div><span>02 · 同场生成</span><h2>放入同一份资料</h2></div><a href="https://developers.openai.com/api/docs/models/gpt-5.6-sol" target="_blank" rel="noreferrer">模型说明</a></div>
      <div className={styles.modelNote}><div><b>OncoPilot 组</b><span>当前正式流程 · DeepSeek V4 Pro</span></div><i /><div><b>文本基线组</b><input value={baselineLabel} maxLength={100} onChange={(event) => setBaselineLabel(event.target.value)} /></div><p>自动基线使用 GPT-5.6 Sol 高推理强度；也保留手动导入，便于比较不同外部模型。</p></div>
      <div className={styles.documentInput}>
        <div><strong>图片或PDF</strong><span>上传后逐页转录，最多{MAX_DOCUMENT_ITEMS}页；PDF最多{MAX_PDF_PAGES}页。</span></div>
        <label>拍照<input type="file" accept="image/*" capture="environment" multiple onChange={chooseDocuments} /></label>
        <label>选择文件<input type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif,application/pdf,.pdf" multiple onChange={chooseDocuments} /></label>
      </div>
      {uploads.length > 0 && <div className={styles.uploadList}>{uploads.map((item) => <div className={item.status === "error" ? styles.uploadError : ""} key={item.id}>{item.preview ? <Image unoptimized src={item.preview} width={52} height={40} alt="资料页预览" /> : null}<span><strong>{item.name}</strong><small>{item.status === "recognizing" ? "正在转录" : item.status === "done" ? `${item.model || "图像模型"} 已转录，请核对下方文字` : item.error || "本页失败"}</small></span></div>)}</div>}
      <div className={styles.baselineInput}>
        <label><span>{session.track === "generation_only" ? "已确认的临床事件账本" : "视觉转录和补充文字"}</span><textarea value={evaluationInput} maxLength={100000} onChange={(event) => setEvaluationInput(event.target.value)} placeholder={session.track === "generation_only" ? "粘贴经过核对的临床事件账本" : "上传资料后在这里核对转录结果，也可以补充文字"} /><small>两边只接收这份共同输入；医生核对清单不会发送给生成模型。</small></label>
        <button type="button" disabled={dualLoading || oncopilotLoading || baselineLoading || evaluationInput.trim().length < 20} onClick={generateBoth}>{dualLoading ? "两边正在生成…" : "同时生成两份回答"}</button>
      </div>
      <div className={styles.secondaryRun}><button type="button" disabled={oncopilotLoading || evaluationInput.trim().length < 20} onClick={generateOncoPilot}>{oncopilotLoading ? "OncoPilot生成中…" : "只重跑OncoPilot"}</button><button type="button" disabled={baselineLoading || evaluationInput.trim().length < 20} onClick={generateBaseline}>{baselineLoading ? "GPT-5.6 Sol生成中…" : "只重跑GPT基线"}</button></div>
      {uploadError && <p className={styles.error}>{uploadError}</p>}
      {oncopilotError && <p className={styles.error}>OncoPilot：{oncopilotError}</p>}
      {baselineError && <p className={styles.error}>{baselineError}</p>}
      <div className={styles.outputGrid}>
        <label><span>OncoPilot完整回答 · {oncoMetrics.elapsedSeconds || 0}秒 · 重试{oncoMetrics.retries}次</span><textarea value={oncopilotOutput} onChange={(event) => setOncopilotOutput(event.target.value)} placeholder="等待现场生成，也可以粘贴外部结果" /></label>
        <label><span>GPT-5.6 Sol完整回答 · {baselineMetrics.elapsedSeconds || 0}秒</span><textarea value={baselineOutput} onChange={(event) => setBaselineOutput(event.target.value)} placeholder="等待现场生成，也可以粘贴其他对照答案" /></label>
      </div>
      <button type="button" className={styles.primary} disabled={!oncopilotOutput.trim() || !baselineOutput.trim()} onClick={startBlindReview}>随机分配并开始盲评</button>
    </section>

    {assignment && <section className={styles.card} id="blind-review">
      <div className={styles.cardHeading}><div><span>03 · 盲化评分</span><h2>先看证据和错误，不猜模型</h2></div><span className={styles.blindBadge}>{revealed ? "已揭盲" : "A/B 身份已隐藏"}</span></div>
      <div className={styles.blindOutputs}>
        {(["A", "B"] as const).map((label) => <details key={label} open><summary>回答 {label}{revealed ? ` · ${sourceLabels[assignment[label]]}${assignment[label] === "baseline" ? `（${baselineLabel}）` : ""}` : ""}</summary><pre>{label === "A" ? session.armA.output : session.armB.output}</pre></details>)}
      </div>
      <div className={styles.scoreGuide}>{scoreGuide.map((item) => <span key={item}>{item}</span>)}</div>
      <div className={styles.scoreTable}>
        <div className={styles.scoreHeader}><span>评分维度</span><b>A</b><b>B</b></div>
        {evaluationDimensions.map((dimension) => <div className={styles.scoreRow} key={dimension.id}><span><strong>{dimension.label}</strong><small>{dimension.guide} · 权重 {dimension.weight}%</small></span>{(["armA", "armB"] as const).map((arm) => <div key={arm}>{[0, 1, 2, 3, 4].map((value) => <button type="button" key={value} aria-label={`${dimension.label} 回答${arm === "armA" ? "A" : "B"} ${value}分`} className={session[arm].scores[dimension.id] === value ? styles.selected : ""} onClick={() => updateScore(arm, dimension.id, value)}>{value}</button>)}</div>)}</div>)}
      </div>
      <div className={styles.errorGrid}>{(["armA", "armB"] as const).map((arm, index) => <section key={arm}><h3>回答 {index === 0 ? "A" : "B"} · 错误与效率</h3><div><label><span>P0 致命错误</span><input type="number" min="0" max="99" value={session[arm].p0Count} onChange={(event) => updateArm(arm, { p0Count: Number(event.target.value) })} /></label><label><span>P1 重要错误</span><input type="number" min="0" max="99" value={session[arm].p1Count} onChange={(event) => updateArm(arm, { p1Count: Number(event.target.value) })} /></label><label><span>耗时（秒）</span><input type="number" min="0" max="3600" value={session[arm].latencySeconds} onChange={(event) => updateArm(arm, { latencySeconds: Number(event.target.value) })} /></label><label><span>重试次数</span><input type="number" min="0" max="20" value={session[arm].retryCount} onChange={(event) => updateArm(arm, { retryCount: Number(event.target.value) })} /></label></div><label><span>评审摘要（只写错误类型与修改成本）</span><textarea maxLength={1200} value={session[arm].reviewerNote} onChange={(event) => updateArm(arm, { reviewerNote: event.target.value })} placeholder="例如：漏掉二线治疗；把外院建议转院写成当前计划；修改约需8分钟。" /></label></section>)}</div>
      <div className={styles.scoreSummary}><article><span>回答 A</span><strong>{scoreA.score}</strong><small>/ 100 {scoreA.hardFail ? "· P0 硬失败" : ""}</small></article><article><span>回答 B</span><strong>{scoreB.score}</strong><small>/ 100 {scoreB.hardFail ? "· P0 硬失败" : ""}</small></article><div><span>当前盲评结果</span><h3>{winner === "接近" ? "A / B 暂无明确优势" : `回答 ${winner} 暂时领先`}</h3><p>P0 优先于总分；差距小于 1 分视为接近。</p></div></div>
      <p className={styles.ratingProgress}>已完成 {ratingCount}/{evaluationDimensions.length * 2} 项评分 · 两组评审摘要均填写后才可开会</p>
      <div className={styles.actions}><button type="button" disabled={ratingCount < evaluationDimensions.length * 2} onClick={() => setRevealed(true)}>{revealed ? "已揭盲" : "完成评分并揭盲"}</button><button type="button" className={styles.primaryInline} disabled={boardLoading || !boardReady} onClick={runBoard}>{boardLoading ? `${meetingReviews.length}/5 个角色已发言…` : "召开龙虾评审会"}</button></div>
      {boardError && <p className={styles.error}>{boardError}</p>}
    </section>}

    {boardStarted && <section className={`${styles.card} ${styles.board}`}>
      <div className={styles.cardHeading}><div><span>04 · 龙虾评审会</span><h2>五个岗位分别发言，CEO最后汇总</h2></div><span className={styles.sameModel}>{boardResult ? `CEO ${boardResult.ceoModel} · ${boardResult.elapsedSeconds}秒` : `会议进行中 · ${meetingReviews.length}/5 已发言`}</span></div>
      <p className={styles.boardBoundary}>产品、技术和临床质量岗位使用GPT-5.4与DeepSeek V4 Pro交叉审阅；CEO使用GPT-5.6 Sol。它们是模型角色，不是真实专家。</p>
      <div className={styles.roleGrid}>{meetingRoles.map((role) => {
        const review = meetingReviews.find((item) => item.role === role.id) || boardResult?.reviews.find((item) => item.role === role.id);
        return review ? <RoleCard key={role.id} review={review} /> : <article className={`${styles.roleCard} ${styles.roleWaiting}`} key={role.id}><span>{role.label}</span><h3>{boardLoading ? "正在独立分析…" : "等待发言"}</h3><p>{role.focus}</p><i /></article>;
      })}</div>
      {!boardResult && <div className={styles.ceoWaiting}><span>CEO 小龙虾</span><strong>{meetingReviews.length < meetingRoles.length ? `等待 ${meetingRoles.length - meetingReviews.length} 位角色完成发言` : "正在汇总分歧与下一轮动作…"}</strong></div>}
      {boardResult && <article className={styles.executive}><span>CEO 结论</span><h2>{boardResult.executive.decision}</h2><div><section><h3>理由</h3><ul>{boardResult.executive.rationale.map((item) => <li key={item}>{item}</li>)}</ul></section><section><h3>还有哪些分歧</h3><ul>{boardResult.executive.disagreements.length ? boardResult.executive.disagreements.map((item) => <li key={item}>{item}</li>) : <li>本轮没有明确分歧，下一个病例再看是否稳定。</li>}</ul></section><section><h3>下一轮要做的事</h3><ol>{boardResult.executive.nextSprint.map((item) => <li key={item}>{item}</li>)}</ol></section><section><h3>什么情况下暂停扩大试用</h3><ul>{boardResult.executive.stopConditions.map((item) => <li key={item}>{item}</li>)}</ul></section></div></article>}
      {boardResult && <div className={styles.actions}><button type="button" onClick={exportResult}>导出本次 JSON 记录</button><button type="button" onClick={reset}>开始新的试评</button></div>}
    </section>}

    <footer className={styles.footer}><div><strong>OncoPilot Evaluation Lab V0.15.1</strong><span>小样本测评 · 用来发现问题，不用来宣称临床准确率</span></div><nav><a href="/">病历助手</a><a href="https://github.com/longjianw/oncopilot" target="_blank" rel="noreferrer">GitHub 迭代记录</a></nav></footer>
  </main>;
}
