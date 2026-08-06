"use client";

import { ChangeEvent, useEffect, useState } from "react";

type Stage = "input" | "result";
type QuestionPriority = "high" | "medium";

type AnalysisResult = {
  present_illness: string;
  follow_up_questions: Array<{
    question: string;
    reason: string;
    priority: QuestionPriority;
  }>;
  sources: Array<{ source_id: string; title: string; evidence: string }>;
};

const syntheticSample = `【S1 外院出院记录｜完全合成】
患者，女，50-59岁。外院诊断为淋巴系统恶性肿瘤，已完成2周期抗肿瘤治疗，具体方案、末次治疗日期及病理原文未提供。

【S2 本次就诊资料｜完全合成】
患者为继续治疗来院，自述目前“没有明显不舒服”。未提供近期体温、体重变化、出血、感染及胃肠道症状的系统问诊结果。

【S3 外院检查摘要｜完全合成】
08-01血常规：白细胞3.2×10^9/L，中性粒细胞绝对值1.5×10^9/L，血红蛋白108g/L，血小板136×10^9/L。`;

export default function Home() {
  const [stage, setStage] = useState<Stage>("input");
  const [sourceText, setSourceText] = useState("");
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [imageLoading, setImageLoading] = useState(false);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [imageName, setImageName] = useState("");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => () => {
    if (imagePreview) URL.revokeObjectURL(imagePreview);
  }, [imagePreview]);

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

  const chooseImage = async (event: ChangeEvent<HTMLInputElement>) => {
    const image = event.target.files?.[0];
    event.target.value = "";
    if (!image) return;
    if (!image.type.startsWith("image/")) {
      setError("请选择图片文件。");
      return;
    }
    if (image.size > 8_000_000) {
      setError("单张图片请控制在 8MB 以内；拍报告时尽量只拍一页。");
      return;
    }

    if (imagePreview) URL.revokeObjectURL(imagePreview);
    setImagePreview(URL.createObjectURL(image));
    setImageName(image.name || "拍摄的图片");
    setImageLoading(true);
    setError("");

    try {
      const formData = new FormData();
      formData.append("image", image);
      const response = await fetch("/api/extract-image", { method: "POST", body: formData });
      const payload = await response.json() as { extracted_text?: string; error?: string };
      if (!response.ok || !payload.extracted_text) throw new Error(payload.error || "图片暂时没有识别出来。");
      const heading = `【图片资料｜AI识别，待核对】\n${payload.extracted_text.trim()}`;
      setSourceText((current) => current.trim() ? `${current.trim()}\n\n${heading}` : heading);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "图片暂时没有识别出来。");
    } finally {
      setImageLoading(false);
    }
  };

  const clearImage = () => {
    if (imagePreview) URL.revokeObjectURL(imagePreview);
    setImagePreview(null);
    setImageName("");
  };

  const reset = () => {
    setStage("input");
    setSourceText("");
    setAnalysis(null);
    setDraft("");
    setCopied(false);
    clearImage();
    setError("");
  };

  const copyDraft = async () => {
    await navigator.clipboard.writeText(draft);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <main className="site-shell">
      <header className="site-header">
        <button type="button" className="wordmark" onClick={reset} aria-label="返回首页">
          <span>OP</span>
          <div><strong>OncoPilot</strong><small>肿瘤病史整理助手</small></div>
        </button>
        <div className="model-pill"><i /> AI整理已接入</div>
      </header>

      <div className="stage-line two-steps" aria-label="当前流程">
        <span className={stage === "input" ? "active" : "done"}><b>1</b>粘贴资料</span>
        <i />
        <span className={stage === "result" ? "active" : ""}><b>2</b>核对病史与补问</span>
      </div>

      {stage === "input" && (
        <section className="single-flow input-stage">
          <div className="hero-copy">
            <span className="eyebrow">先只做好一件事</span>
            <h1>把一堆患者资料，变成<br /><em>现病史和待补问清单</em></h1>
            <p>适用于你第一次接管一名肿瘤相关患者，包括实体瘤、淋巴瘤和白血病；不要求患者是第一次住院。</p>
          </div>

          <div className="input-card">
            <div className="card-heading">
              <div><span>把你现在掌握的都放进来</span><h2>拍照、上传图片，或粘贴文字</h2></div>
              <button type="button" onClick={() => { setSourceText(syntheticSample); setError(""); }}>先看一个假病例</button>
            </div>
            <p className="reference-status"><b>已启用本地规则</b> 益阳市中心医院肿瘤内科入院记录结构 · 仅约束病史结构，不替代上级审核</p>
            <div className="image-actions" aria-label="图片资料输入">
              <label className="image-action camera-action">拍照<input type="file" accept="image/*" capture="environment" onChange={chooseImage} /></label>
              <label className="image-action">上传图片<input type="file" accept="image/jpeg,image/png,image/webp" onChange={chooseImage} /></label>
              <span>支持单页报告、病理或检查单照片</span>
            </div>
            {imagePreview && (
              <div className="image-preview">
                {/* Local object URL preview; image optimization is not applicable. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={imagePreview} alt="待识别的资料预览" />
                <span><strong>{imageLoading ? "正在识别图片…" : "图片已识别并填入下方"}</strong><small>{imageName} · 请核对识别文字</small></span>
                <button type="button" onClick={clearImage} aria-label="移除图片预览">×</button>
              </div>
            )}
            <textarea
              value={sourceText}
              onChange={(event) => { setSourceText(event.target.value); setError(""); }}
              placeholder="图片识别的文字会自动放到这里。也可以补充：患者为什么来、外院做过什么、既往治疗、现在有什么不舒服……"
              aria-label="患者资料"
              maxLength={12000}
            />
            <div className="input-footer">
              <label className="file-choice">选择文本文件<input type="file" accept=".txt,.md,.json,text/plain" onChange={chooseFile} /></label>
              <span>{sourceText.length}/12000</span>
            </div>
            {error && <p className="error-message" role="alert">{error}</p>}
            <button type="button" className="primary-action" disabled={sourceText.trim().length < 20 || loading || imageLoading} onClick={analyze}>
              {loading ? <><i className="spinner" />正在整理</> : <>生成现病史，并告诉我还要问什么 <b>→</b></>}
            </button>
            <p className="privacy-copy">演示版请勿上传含姓名、住院号、二维码、电话、身份证号或可识别信息的真实患者图片。</p>
          </div>

          <div className="output-promise two-items" aria-label="系统输出">
            <div><b>01</b><span><strong>现病史初稿</strong><small>按时间顺序整理已有事实</small></span></div>
            <div><b>02</b><span><strong>还要问什么</strong><small>列出需要向患者确认的关键问题</small></span></div>
          </div>
        </section>
      )}

      {stage === "result" && analysis && (
        <section className="single-flow result-stage">
          <div className="result-title">
            <div><span className="success-mark">✓</span><span><small>整理完成</small><h1>先核对，再写进正式病历</h1></span></div>
            <p>下面只有两件事：改病史，补问患者。</p>
          </div>

          <div className="history-editor">
            <div className="editor-heading"><label htmlFor="history-draft">① 现病史初稿</label><button type="button" onClick={copyDraft}>{copied ? "已复制" : "复制现病史"}</button></div>
            <textarea id="history-draft" value={draft} onChange={(event) => setDraft(event.target.value)} />
            <span>可以直接修改；未经确认的阴性症状不会自动写成事实。</span>
          </div>

          <section className="follow-up-card">
            <div className="section-heading"><span>② 补问</span><h2>还需要问患者什么</h2></div>
            <p className="section-explain">患者只说“没什么不舒服”还不够。以下问题问过并确认后，再把相应阴性或阳性症状写入现病史。</p>
            <div className="follow-up-list">
              {analysis.follow_up_questions.map((item, index) => (
                <div key={`${item.question}-${index}`} className={item.priority}>
                  <b>{index + 1}</b>
                  <span><strong>{item.question}</strong><small>{item.reason}</small></span>
                </div>
              ))}
            </div>
          </section>

          <details className="source-details">
            <summary>查看这份现病史用了哪些资料</summary>
            <div className="source-list">
              {analysis.sources.map((source) => (
                <div key={source.source_id}><b>{source.source_id}</b><span><strong>{source.title}</strong><small>{source.evidence}</small></span></div>
              ))}
            </div>
          </details>

          <div className="result-actions">
            <button type="button" className="secondary-action" onClick={() => setStage("input")}>返回补充原始资料</button>
            <button type="button" className="primary-action compact" onClick={reset}>整理另一名患者</button>
          </div>
        </section>
      )}
    </main>
  );
}
