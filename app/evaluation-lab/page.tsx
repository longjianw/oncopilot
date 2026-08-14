"use client";
/* eslint-disable @next/next/no-html-link-for-pages -- vinext dev currently loads a duplicate React renderer through next/link on this client page. */

import { useEffect, useMemo, useState } from "react";
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
import styles from "./page.module.css";

type SourceId = "oncopilot" | "baseline";
type Assignment = { A: SourceId; B: SourceId };
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

const syntheticOncoPilot = `主诉：发现右肺占位2月，完成一线治疗后复查提示进展1周。

现病史：患者2月前因咳嗽检查发现右肺占位，后续病理提示恶性肿瘤，具体分型原文待核对。1月前开始一线全身治疗，方案及疗效评价标准未提供。1周前复查影像提示病灶较前增大，本次为进一步评估入院。既往高血压病史5年，具体用药待核对。`;

const syntheticBaseline = `主诉：肺癌治疗后进展1周。

现病史：患者2月前确诊右肺癌，已接受一线化疗。近期复查提示肺癌进展并出现转移，现为调整二线方案收入院。患者一般情况尚可，无明显不适。`;

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
  <span>{review.roleLabel}</span>
  <h3>{review.headline}</h3>
  <ul>{review.evidence.map((item) => <li key={item}>{item}</li>)}</ul>
  <p><b>本轮优先动作：</b>{review.recommendation}</p>
  <small>可能误导结论：{review.concern}</small>
</article>;

export default function EvaluationLabPage() {
  const [session, setSession] = useState<EvaluationSession>(() => emptyEvaluationSession());
  const [oncopilotOutput, setOncopilotOutput] = useState("");
  const [baselineOutput, setBaselineOutput] = useState("");
  const [baselineLabel, setBaselineLabel] = useState("GPT-5.6 Sol · 手动导入");
  const [evaluationInput, setEvaluationInput] = useState("");
  const [baselineLoading, setBaselineLoading] = useState(false);
  const [baselineError, setBaselineError] = useState("");
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
    setSession((current) => ({
      ...current,
      armA: { ...current.armA, output: nextAssignment.A === "oncopilot" ? oncopilotOutput : baselineOutput },
      armB: { ...current.armB, output: nextAssignment.B === "oncopilot" ? oncopilotOutput : baselineOutput },
    }));
    requestAnimationFrame(() => document.getElementById("blind-review")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };

  const loadSynthetic = () => {
    setSession((current) => ({ ...emptyEvaluationSession(), evaluator: current.evaluator, goldSummary: "合成事实：右肺占位2月；病理仅明确恶性，分型缺失；1月前开始一线全身治疗，方案缺失；1周前影像提示病灶增大；高血压5年；本次目的为进一步评估。" }));
    setOncopilotOutput(syntheticOncoPilot);
    setBaselineOutput(syntheticBaseline);
    setEvaluationInput(syntheticEvaluationInput);
    setBaselineLabel("GPT-5.6 Sol · 合成示例");
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
    setAssignment(null);
    setRevealed(false);
    setBoardResult(null);
    setMeetingReviews([]);
    setBoardError("");
    setRatedDimensions({});
    window.localStorage.removeItem(STORAGE_KEY);
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
    } catch (error) {
      setBaselineError(error instanceof Error ? error.message : "自动对照暂时失败。");
    } finally { setBaselineLoading(false); }
  };

  const runBoard = async () => {
    if (!boardReady) {
      setBoardError("请先完成 A/B 的全部20项评分，并分别写一句评审摘要，再召开内部评审会。");
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
      setBoardResult({ reviews, executive: executivePayload.result.executive, model: executivePayload.result.model || "deepseek-v4-pro", elapsedSeconds: Math.round((performance.now() - startedAt) / 100) / 10, sameModelReview: true });
      setRevealed(true);
    } catch (error) {
      setBoardError(error instanceof Error ? error.message : "内部评审会暂时失败。");
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
      <a href="/" className={styles.brand}><span>OP</span><div><strong>OncoPilot</strong><small>内部测评实验室</small></div></a>
      <div><span className={styles.version}>V0.13.0</span><a href="/">返回病历助手</a></div>
    </header>

    <section className={styles.hero}>
      <div><span className={styles.eyebrow}>EVALUATION LAB · PILOT</span><h1>先知道哪里不够好，<br />再决定下一版改什么。</h1><p>同一病例、盲化 A/B、统一评分；同一模型多视角下，产品经理、市场与用户研究、技术、临床质量、测评师五只小龙虾独立发言，最后由 CEO 小龙虾汇总。</p></div>
      <aside><strong>当前实验边界</strong><p>病例原文和两组完整回答只停留在当前页面；“公司会议”只接收分数、错误数、耗时和简短评语。</p><small>两例试评只能验证流程与发现问题，不能称为临床准确率。</small></aside>
    </section>

    <nav className={styles.steps} aria-label="测评流程"><span className={!assignment ? styles.active : styles.done}><b>1</b>准备对照</span><i /><span className={assignment && !revealed ? styles.active : assignment ? styles.done : ""}><b>2</b>盲评 A/B</span><i /><span className={revealed ? styles.active : ""}><b>3</b>揭盲与开会</span></nav>

    <section className={styles.card}>
      <div className={styles.cardHeading}><div><span>01 · 实验设置</span><h2>先固定比较条件</h2></div><button type="button" onClick={loadSynthetic}>装入合成示例</button></div>
      <div className={styles.formGrid}>
        <label><span>试评编号</span><input value={session.caseLabel} maxLength={80} onChange={(event) => setSession((current) => ({ ...current, caseLabel: event.target.value }))} /></label>
        <label><span>评审者</span><input value={session.evaluator} maxLength={80} placeholder="例如：肿瘤科住院医师 01" onChange={(event) => setSession((current) => ({ ...current, evaluator: event.target.value }))} /></label>
        <label className={styles.wide}><span>评测轨道</span><select value={session.track} onChange={(event) => setSession((current) => ({ ...current, track: event.target.value as EvaluationSession["track"] }))}><option value="generation_only">统一临床事件账本后，只比较生成质量</option><option value="end_to_end">从资料输入到最终结果的端到端比较</option></select><small>建议先跑“统一账本”，能区分是资料抽取差，还是正文生成差。</small></label>
        <label className={styles.wide}><span>人工金标准 / 必须覆盖的关键事实</span><textarea value={session.goldSummary} maxLength={4000} placeholder="由医生先写出关键事件、不可新增的事实和本次核心问题。该内容不会发送给内部公司会议。" onChange={(event) => setSession((current) => ({ ...current, goldSummary: event.target.value }))} /></label>
      </div>
    </section>

    <section className={styles.card}>
      <div className={styles.cardHeading}><div><span>02 · 双路回答</span><h2>收齐两份结果，再随机分配 A/B</h2></div><a href="https://developers.openai.com/api/docs/models/gpt-5.6-sol" target="_blank" rel="noreferrer">GPT‑5.6 Sol 官方说明 ↗</a></div>
      <div className={styles.modelNote}><div><b>OncoPilot 组</b><span>当前正式流程 · DeepSeek V4 Pro</span></div><i /><div><b>文本基线组</b><input value={baselineLabel} maxLength={100} onChange={(event) => setBaselineLabel(event.target.value)} /></div><p>自动基线使用 GPT-5.6 Sol 高推理强度；也保留手动导入，便于比较不同外部模型。</p></div>
      <div className={styles.baselineInput}>
        <label><span>{session.track === "generation_only" ? "本轮统一临床事件账本" : "本轮端到端源资料"}</span><textarea value={evaluationInput} maxLength={100000} onChange={(event) => setEvaluationInput(event.target.value)} placeholder={session.track === "generation_only" ? "粘贴同一份、已人工确认的临床事件账本" : "粘贴本轮去标识化源资料"} /><small>只在点击自动生成时发送给对照模型；不会与 OncoPilot 回答或人工金标准一起发送，也不写入本机草稿。</small></label>
        <button type="button" disabled={baselineLoading || evaluationInput.trim().length < 20} onClick={generateBaseline}>{baselineLoading ? "GPT-5.6 Sol 正在生成，可能需要1–4分钟…" : "用 GPT-5.6 Sol 自动生成对照"}</button>
      </div>
      {baselineError && <p className={styles.error}>{baselineError}</p>}
      <div className={styles.outputGrid}>
        <label><span>OncoPilot 完整回答</span><textarea value={oncopilotOutput} onChange={(event) => setOncopilotOutput(event.target.value)} placeholder="粘贴 OncoPilot 本次完整结果" /></label>
        <label><span>ChatGPT / 对照模型完整回答</span><textarea value={baselineOutput} onChange={(event) => setBaselineOutput(event.target.value)} placeholder="粘贴同一输入条件下的对照答案" /></label>
      </div>
      <button type="button" className={styles.primary} disabled={!oncopilotOutput.trim() || !baselineOutput.trim()} onClick={startBlindReview}>随机分配并开始盲评 <b>→</b></button>
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
      <div className={styles.actions}><button type="button" disabled={ratingCount < evaluationDimensions.length * 2} onClick={() => setRevealed(true)}>{revealed ? "身份已经揭盲" : "完成评分并揭盲"}</button><button type="button" className={styles.primaryInline} disabled={boardLoading || !boardReady} onClick={runBoard}>{boardLoading ? `${meetingReviews.length}/5 只小龙虾已发言…` : "召开 AI 公司评审会"}</button></div>
      {boardError && <p className={styles.error}>{boardError}</p>}
    </section>}

    {boardStarted && <section className={`${styles.card} ${styles.board}`}>
      <div className={styles.cardHeading}><div><span>04 · 内部公司会议</span><h2>先独立审阅，再保留分歧</h2></div><span className={styles.sameModel}>{boardResult ? `同一模型多视角 · ${boardResult.model} · ${boardResult.elapsedSeconds}秒` : `会议进行中 · ${meetingReviews.length}/5 已发言`}</span></div>
      <p className={styles.boardBoundary}>这不是五位真实专家会诊：五个角色使用同一模型、隔离上下文独立分析同一份评分汇总；全部发言完成后，CEO 才读取他们的意见并形成决策。</p>
      <div className={styles.roleGrid}>{meetingRoles.map((role) => {
        const review = meetingReviews.find((item) => item.role === role.id) || boardResult?.reviews.find((item) => item.role === role.id);
        return review ? <RoleCard key={role.id} review={review} /> : <article className={`${styles.roleCard} ${styles.roleWaiting}`} key={role.id}><span>{role.label}</span><h3>{boardLoading ? "正在独立分析…" : "等待发言"}</h3><p>{role.focus}</p><i /></article>;
      })}</div>
      {!boardResult && <div className={styles.ceoWaiting}><span>CEO 小龙虾</span><strong>{meetingReviews.length < meetingRoles.length ? `等待 ${meetingRoles.length - meetingReviews.length} 位角色完成发言` : "正在汇总分歧与下一轮动作…"}</strong></div>}
      {boardResult && <article className={styles.executive}><span>CEO 小龙虾结论</span><h2>{boardResult.executive.decision}</h2><div><section><h3>为什么</h3><ul>{boardResult.executive.rationale.map((item) => <li key={item}>{item}</li>)}</ul></section><section><h3>尚未解决的分歧</h3><ul>{boardResult.executive.disagreements.length ? boardResult.executive.disagreements.map((item) => <li key={item}>{item}</li>) : <li>本轮未识别到明确分歧，仍需用下一病例复核稳定性。</li>}</ul></section><section><h3>下一轮只做这些</h3><ol>{boardResult.executive.nextSprint.map((item) => <li key={item}>{item}</li>)}</ol></section><section><h3>停止扩大试用条件</h3><ul>{boardResult.executive.stopConditions.map((item) => <li key={item}>{item}</li>)}</ul></section></div></article>}
      {boardResult && <div className={styles.actions}><button type="button" onClick={exportResult}>导出本次 JSON 记录</button><button type="button" onClick={reset}>开始新的试评</button></div>}
    </section>}

    <footer className={styles.footer}><div><strong>OncoPilot Evaluation Lab V0.13.0</strong><span>内部小样本测评框架 · 结果不等同于临床准确率</span></div><nav><a href="/">病历助手</a><a href="https://github.com/longjianw/oncopilot" target="_blank" rel="noreferrer">GitHub 迭代记录</a></nav></footer>
  </main>;
}
