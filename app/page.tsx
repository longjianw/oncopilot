"use client";

import { ChangeEvent, useState } from "react";

type Stage = "input" | "result" | "ward";
type QualityLevel = "missing" | "verify" | "passed";

type AnalysisResult = {
  present_illness: string;
  sources: Array<{ source_id: string; title: string; evidence: string }>;
  quality_checks: Array<{ level: QualityLevel; text: string }>;
  patient_card: {
    label: string;
    diagnosis: string;
    age_band: string;
    risk_label: string;
    today_focus: string;
  };
};

const syntheticSample = `【S1 门诊记录｜完全合成】
患者，女，50-59岁。因间断发热2天就诊，最高体温38.5℃，伴乏力，无明确咳嗽、咳痰。既往诊断为淋巴系统恶性肿瘤，近期接受过抗肿瘤治疗，具体方案与日期尚未提供。

【S2 既往血常规｜完全合成｜08-01】
白细胞3.2×10^9/L，中性粒细胞绝对值1.5×10^9/L，血红蛋白108g/L，血小板136×10^9/L。

【S3 新血常规｜完全合成｜08-03】
白细胞1.8×10^9/L，中性粒细胞绝对值0.8×10^9/L，血红蛋白108g/L，血小板92×10^9/L。

【S4 床旁补充｜完全合成】
目前生命体征、发热具体时间规律、用药情况及感染相关检查结果尚未提供。`;

const qualityLabels: Record<QualityLevel, string> = {
  missing: "资料缺失",
  verify: "需要核对",
  passed: "已通过",
};

export default function Home() {
  const [stage, setStage] = useState<Stage>("input");
  const [sourceText, setSourceText] = useState("");
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const analyze = async () => {
    if (sourceText.trim().length < 20 || loading) return;
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source_text: sourceText }),
      });
      const payload = await response.json() as { result?: AnalysisResult; error?: string };
      if (!response.ok || !payload.result) throw new Error(payload.error || "AI整理失败，请稍后重试。");
      setAnalysis(payload.result);
      setDraft(payload.result.present_illness);
      setStage("result");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "AI整理失败，请稍后重试。");
    } finally {
      setLoading(false);
    }
  };

  const chooseFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > 100_000) {
      setError("演示版一次最多读取100KB文本，请精简后重试。");
      return;
    }
    setSourceText(await file.text());
    setError("");
  };

  const reset = () => {
    setStage("input");
    setSourceText("");
    setAnalysis(null);
    setDraft("");
    setError("");
  };

  return (
    <main className="site-shell">
      <header className="site-header">
        <button type="button" className="wordmark" onClick={reset} aria-label="返回首页">
          <span>OP</span>
          <div><strong>OncoPilot</strong><small>肿瘤病例整理助手</small></div>
        </button>
        <div className="model-pill"><i /> DeepSeek V4 Flash · 已接入</div>
      </header>

      <div className="stage-line" aria-label="当前流程">
        <span className={stage === "input" ? "active" : "done"}><b>1</b>粘贴资料</span>
        <i />
        <span className={stage === "result" ? "active" : stage === "ward" ? "done" : ""}><b>2</b>确认病史</span>
        <i />
        <span className={stage === "ward" ? "active" : ""}><b>3</b>进入管床</span>
      </div>

      {stage === "input" && (
        <section className="single-flow input-stage">
          <div className="hero-copy">
            <span className="eyebrow">AI MEDICAL PORTFOLIO · V0.5</span>
            <h1>把零散资料，整理成<br /><em>可核实的现病史</em></h1>
            <p>像聊天窗口一样简单，但结果不再散乱：一次得到现病史、质控提醒和资料来源。</p>
          </div>

          <div className="input-card">
            <div className="card-heading">
              <div><span>第一步</span><h2>粘贴患者资料</h2></div>
              <button type="button" onClick={() => { setSourceText(syntheticSample); setError(""); }}>使用合成示例</button>
            </div>
            <textarea
              value={sourceText}
              onChange={(event) => { setSourceText(event.target.value); setError(""); }}
              placeholder="把门诊记录、既往病史、检查和检验结果粘贴到这里……"
              aria-label="患者资料"
              maxLength={12000}
            />
            <div className="input-footer">
              <label className="file-choice">选择文本文件<input type="file" accept=".txt,.md,.json,text/plain" onChange={chooseFile} /></label>
              <span>{sourceText.length}/12000</span>
            </div>
            {error && <p className="error-message" role="alert">{error}</p>}
            <button type="button" className="primary-action" disabled={sourceText.trim().length < 20 || loading} onClick={analyze}>
              {loading ? <><i className="spinner" />AI正在整理，通常约30秒</> : <>AI整理病史 <b>→</b></>}
            </button>
            <p className="privacy-copy">仅使用合成或严格脱敏资料；演示版不保存输入，不替代医生审核。</p>
          </div>

          <div className="output-promise" aria-label="系统输出">
            <div><b>01</b><span><strong>现病史</strong><small>按时间顺序形成初稿</small></span></div>
            <div><b>02</b><span><strong>质控提醒</strong><small>指出遗漏、矛盾与待核实项</small></span></div>
            <div><b>03</b><span><strong>资料来源</strong><small>重要内容可回看原始依据</small></span></div>
          </div>
        </section>
      )}

      {stage === "result" && analysis && (
        <section className="single-flow result-stage">
          <div className="result-title">
            <div><span className="success-mark">✓</span><span><small>AI整理完成</small><h1>现病史初稿</h1></span></div>
            <p>模型只负责整理，医生可直接修改后确认。</p>
          </div>

          <div className="history-editor">
            <label htmlFor="history-draft">现病史</label>
            <textarea id="history-draft" value={draft} onChange={(event) => setDraft(event.target.value)} />
            <span>内容可编辑 · 最终由医生确认</span>
          </div>

          <div className="review-grid">
            <section className="quality-card">
              <div className="section-heading"><span>质控</span><h2>需要确认的地方</h2></div>
              <div className="quality-list">
                {analysis.quality_checks.map((item, index) => (
                  <div key={`${item.level}-${index}`} className={`quality-item ${item.level}`}>
                    <b>{qualityLabels[item.level]}</b><p>{item.text}</p>
                  </div>
                ))}
              </div>
            </section>

            <section className="source-card">
              <div className="section-heading"><span>来源</span><h2>这段病史依据什么</h2></div>
              <div className="source-list">
                {analysis.sources.map((source) => (
                  <div key={source.source_id}><b>{source.source_id}</b><span><strong>{source.title}</strong><small>{source.evidence}</small></span></div>
                ))}
              </div>
            </section>
          </div>

          <div className="result-actions">
            <button type="button" className="secondary-action" onClick={() => setStage("input")}>返回修改资料</button>
            <button type="button" className="primary-action compact" onClick={() => setStage("ward")}>医生确认，进入管床 <b>→</b></button>
          </div>
        </section>
      )}

      {stage === "ward" && analysis && (
        <section className="single-flow ward-stage">
          <div className="ward-banner">
            <div><span className="success-mark">✓</span><span><small>医生已确认</small><h1>已加入我的分管患者</h1></span></div>
            <button type="button" onClick={reset}>整理另一份资料</button>
          </div>

          <div className="ward-layout">
            <aside className="simple-patient-list">
              <div className="list-title"><span>我的分管患者</span><b>3</b></div>
              <button type="button" className="selected"><i>A-03</i><span><strong>{analysis.patient_card.label}</strong><small>{analysis.patient_card.diagnosis}</small></span><b>{analysis.patient_card.risk_label}</b></button>
              <button type="button"><i>A-12</i><span><strong>合成患者 A02</strong><small>肺部恶性肿瘤</small></span></button>
              <button type="button"><i>B-06</i><span><strong>合成患者 A03</strong><small>乳腺恶性肿瘤</small></span></button>
            </aside>

            <article className="simple-patient-card">
              <header><div><small>A-03 · SYN-A01</small><h2>{analysis.patient_card.label}</h2><p>{analysis.patient_card.age_band} · 我的分管患者</p></div><span>{analysis.patient_card.risk_label}</span></header>
              <div className="confirmed-history"><span>已确认现病史</span><p>{draft}</p></div>
              <div className="today-focus"><span>今日关注</span><p>{analysis.patient_card.today_focus}</p></div>
              <div className="wait-state"><i>✓</i><span><strong>病例整理已完成</strong><small>后续有新检验或检查时，再由AI提示变化；无需重复录入整份病史。</small></span></div>
            </article>
          </div>

          <div className="portfolio-proof">
            <span>作品展示</span>
            <p><strong>不是复制HIS：</strong>只保留“资料整理 → 人工确认 → 管床衔接”一条主线。</p>
            <p><strong>真实模型：</strong>DeepSeek V4 Flash；A01合成病例初测100/100。</p>
          </div>
        </section>
      )}
    </main>
  );
}
