"use client";

import { useMemo, useState } from "react";

type PageKey = "input" | "overview" | "today" | "documents" | "evaluation";
type ReviewState = "pending" | "accepted" | "rejected";

const navItems: { key: PageKey; label: string; eyebrow: string }[] = [
  { key: "input", label: "病例输入", eyebrow: "01" },
  { key: "overview", label: "患者总览", eyebrow: "02" },
  { key: "today", label: "今日管床", eyebrow: "03" },
  { key: "documents", label: "文书与交班", eyebrow: "04" },
  { key: "evaluation", label: "评测看板", eyebrow: "05" },
];

const initialTasks = [
  { id: "t1", label: "确认当前生命体征与发热起始时间", meta: "立即 · 关联 P01", done: false },
  { id: "t2", label: "核对血常规报告原图中的中性粒细胞绝对值", meta: "立即 · 来源 S04", done: false },
  { id: "t3", label: "确认本周期治疗日期：7月12日或7月13日", meta: "今日 · 时间冲突", done: false },
  { id: "t4", label: "请上级医师复核风险分层与后续处理", meta: "今日 · 人工闸门", done: true },
];

const timeline = [
  { date: "07.12", title: "完成本周期抗肿瘤治疗", detail: "治疗摘要记载为7月12日；护理交接记录为7月13日。", source: "S01 · S02", tone: "warning" },
  { date: "07.18", title: "出现乏力与食欲下降", detail: "患者补充描述；严重程度及饮水量尚未核实。", source: "S03", tone: "neutral" },
  { date: "07.19", title: "自测体温升高", detail: "口述最高38.4℃，当前生命体征未提供。", source: "S03", tone: "danger" },
  { date: "07.19", title: "血常规报告上传", detail: "白细胞降低；中性粒细胞绝对值图像识别不清。", source: "S04", tone: "danger" },
];

const problems = [
  { id: "P01", title: "治疗后发热", status: "重要 · 待评估", description: "体温来源为患者自述，当前体温、血压、血氧及感染相关症状待补。", color: "red" },
  { id: "P02", title: "血细胞下降", status: "重要 · 部分确认", description: "白细胞降低已确认；关键分类数值需回看原图。", color: "amber" },
  { id: "P03", title: "治疗日期冲突", status: "待核实", description: "两份资料相差1天，影响病例时钟与风险判断。", color: "blue" },
];

const sources = [
  { id: "S01", title: "治疗摘要", type: "本院文书", status: "清晰", time: "07.12" },
  { id: "S02", title: "护理交接记录", type: "本院文书", status: "日期冲突", time: "07.13" },
  { id: "S03", title: "患者补充描述", type: "患者自述", status: "待核实", time: "07.19" },
  { id: "S04", title: "血常规报告截图", type: "合成图片", status: "部分不清", time: "07.19" },
];

const documentText = {
  progress: [
    { id: "d1", text: "患者于本周期抗肿瘤治疗后出现乏力、食欲下降，7月19日自述体温最高38.4℃。", tag: "来源明确", source: "F06 · F07" },
    { id: "d2", text: "本周期治疗日期在治疗摘要与护理记录中记载不一致，分别为7月12日和7月13日，需核对。", tag: "待核实", source: "F01 · F02" },
    { id: "d3", text: "血常规提示白细胞降低，中性粒细胞绝对值因图片识别不清暂不录入。", tag: "安全改写", source: "F09 · S04" },
    { id: "d4", text: "患者无寒战、无咳嗽、无腹泻。", tag: "禁止写入", source: "原始资料未询问" },
  ],
  handoff: [
    { id: "h1", text: "当前主要问题为治疗后发热及血细胞下降，风险分层尚待补齐生命体征与关键血常规数值。", tag: "工作稿", source: "P01 · P02" },
    { id: "h2", text: "已请上级医师复核；尚需追踪原始报告、核对治疗日期并明确复评节点。", tag: "执行状态已区分", source: "T02 · T03 · T04" },
    { id: "h3", text: "如出现生命体征不稳定或意识改变，应立即启动本院急救流程并升级处置。", tag: "升级条件", source: "安全规则 R01" },
  ],
  communication: [
    { id: "c1", text: "目前已经确认存在发热和部分血细胞指标下降，需要尽快补齐当前生命体征和报告原值。", tag: "已知", source: "P01 · P02" },
    { id: "c2", text: "现阶段不能仅凭这一张报告判断感染部位或后续治疗方案。", tag: "未知", source: "缺失项 M01-M04" },
    { id: "c3", text: "下一步安排需经主管或上级医师结合床旁情况确认。", tag: "人工确认", source: "安全边界 G03" },
  ],
};

function StatusPill({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "good" | "warning" | "danger" | "info" }) {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}

function SectionTitle({ eyebrow, title, detail }: { eyebrow: string; title: string; detail?: string }) {
  return (
    <div className="section-title">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h2>{title}</h2>
      </div>
      {detail && <p>{detail}</p>}
    </div>
  );
}

export default function Home() {
  const [activePage, setActivePage] = useState<PageKey>("overview");
  const [sourceAdded, setSourceAdded] = useState(false);
  const [tasks, setTasks] = useState(initialTasks);
  const [reviewed, setReviewed] = useState(false);
  const [planText, setPlanText] = useState("完善感染相关评估；继续观察体温；根据结果再决定后续处理。");
  const [documentTab, setDocumentTab] = useState<keyof typeof documentText>("progress");
  const [sentenceReviews, setSentenceReviews] = useState<Record<string, ReviewState>>({});
  const [selectedEvidence, setSelectedEvidence] = useState<string | null>(null);

  const completedTasks = useMemo(() => tasks.filter((task) => task.done).length, [tasks]);

  const toggleTask = (id: string) => {
    setTasks((current) => current.map((task) => (task.id === id ? { ...task, done: !task.done } : task)));
  };

  const reviewSentence = (id: string, value: ReviewState) => {
    setSentenceReviews((current) => ({ ...current, [id]: value }));
  };

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand-block">
          <div className="brand-mark">O</div>
          <div>
            <strong>OncoPilot</strong>
            <span>肿瘤住院安全工作台</span>
          </div>
        </div>

        <nav aria-label="主要页面">
          {navItems.map((item) => (
            <button
              key={item.key}
              type="button"
              className={`nav-item ${activePage === item.key ? "active" : ""}`}
              onClick={() => setActivePage(item.key)}
            >
              <span>{item.eyebrow}</span>
              {item.label}
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <StatusPill tone="good">演示模式</StatusPill>
          <p>仅使用完全合成数据<br />不可用于真实临床决策</p>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <span className="case-kicker">CASE A-01 · 完全合成病例</span>
            <h1>化疗后发热与血细胞下降</h1>
          </div>
          <div className="top-actions">
            <button className="ghost-button" type="button" onClick={() => setActivePage("evaluation")}>查看评测</button>
            <button className="primary-button" type="button" onClick={() => setActivePage("today")}>进入今日管床</button>
          </div>
        </header>

        <div className="safety-banner">
          <span>安全边界</span>
          系统只整理资料、提示风险和生成工作稿。诊断、处方与治疗决定必须由有资质医师审核。
        </div>

        {activePage === "input" && (
          <div className="page-content">
            <SectionTitle eyebrow="01 · INPUT" title="病例输入" detail="把每份资料先登记为来源，再提取事实；不让模型直接把碎片拼成结论。" />
            <div className="two-column wide-left">
              <section className="panel">
                <div className="panel-heading">
                  <div>
                    <span className="eyebrow">资料来源</span>
                    <h3>{sources.length + (sourceAdded ? 1 : 0)} 份合成资料</h3>
                  </div>
                  <button className="secondary-button" type="button" onClick={() => setSourceAdded(true)} disabled={sourceAdded}>
                    {sourceAdded ? "已加入新报告" : "+ 加入合成报告"}
                  </button>
                </div>
                <div className="source-list">
                  {sources.map((source) => (
                    <button className="source-row" key={source.id} type="button" onClick={() => setSelectedEvidence(source.id)}>
                      <span className="source-id">{source.id}</span>
                      <span className="source-main"><strong>{source.title}</strong><small>{source.type}</small></span>
                      <span className="source-time">{source.time}</span>
                      <StatusPill tone={source.status === "清晰" ? "good" : "warning"}>{source.status}</StatusPill>
                    </button>
                  ))}
                  {sourceAdded && (
                    <button className="source-row new-source" type="button" onClick={() => setSelectedEvidence("S05")}>
                      <span className="source-id">S05</span>
                      <span className="source-main"><strong>感染相关检验（演示）</strong><small>合成检验单</small></span>
                      <span className="source-time">07.19</span>
                      <StatusPill tone="info">待提取</StatusPill>
                    </button>
                  )}
                </div>
              </section>
              <aside className="panel compact-panel">
                <span className="eyebrow">导入检查</span>
                <h3>隐私与完整性</h3>
                <div className="check-stack">
                  <div className="check-line good"><span>✓</span><p><strong>合成数据标记</strong><small>全部来源均为演示构造</small></p></div>
                  <div className="check-line good"><span>✓</span><p><strong>直接标识符</strong><small>未发现姓名、住院号或电话</small></p></div>
                  <div className="check-line warning"><span>!</span><p><strong>图片识别</strong><small>S04存在一个不清数值</small></p></div>
                  <div className="check-line warning"><span>!</span><p><strong>时间一致性</strong><small>S01与S02相差1天</small></p></div>
                </div>
              </aside>
            </div>
          </div>
        )}

        {activePage === "overview" && (
          <div className="page-content">
            <SectionTitle eyebrow="02 · PATIENT MAP" title="患者总览" detail="所有结论都能回到来源；不确定信息留在待核实区，而不是被润色掉。" />
            <div className="summary-strip">
              <div><span>当前阶段</span><strong>治疗后第6–7天</strong><small>日期冲突待核实</small></div>
              <div><span>重要问题</span><strong>2 项</strong><small>发热 · 血细胞下降</small></div>
              <div><span>待核实</span><strong>5 项</strong><small>含1个关键数值</small></div>
              <div><span>人工闸门</span><strong>已触发</strong><small>需上级医师复核</small></div>
            </div>
            <div className="two-column">
              <section className="panel">
                <div className="panel-heading"><div><span className="eyebrow">病例时间轴</span><h3>已确认与冲突事件</h3></div><StatusPill tone="warning">1处时间冲突</StatusPill></div>
                <div className="timeline">
                  {timeline.map((item) => (
                    <button type="button" className={`timeline-item tone-${item.tone}`} key={`${item.date}-${item.title}`} onClick={() => setSelectedEvidence(item.source)}>
                      <span className="timeline-date">{item.date}</span>
                      <span className="timeline-dot" />
                      <span className="timeline-copy"><strong>{item.title}</strong><small>{item.detail}</small><em>{item.source}</em></span>
                    </button>
                  ))}
                </div>
              </section>
              <section className="panel">
                <div className="panel-heading"><div><span className="eyebrow">动态问题</span><h3>问题导向视图</h3></div><StatusPill tone="danger">2项重要</StatusPill></div>
                <div className="problem-list">
                  {problems.map((problem) => (
                    <article className="problem-card" key={problem.id}>
                      <div className={`problem-index color-${problem.color}`}>{problem.id}</div>
                      <div><div className="problem-title"><strong>{problem.title}</strong><span>{problem.status}</span></div><p>{problem.description}</p></div>
                    </article>
                  ))}
                </div>
                <button type="button" className="text-button" onClick={() => setActivePage("today")}>查看这些问题对应的今日任务 →</button>
              </section>
            </div>
          </div>
        )}

        {activePage === "today" && (
          <div className="page-content">
            <SectionTitle eyebrow="03 · TODAY" title="今日管床" detail="系统生成的是待确认任务与安全复核，不是自动医嘱。" />
            <div className="two-column wide-left">
              <section className="panel">
                <div className="panel-heading">
                  <div><span className="eyebrow">今日任务</span><h3>{completedTasks}/{tasks.length} 已完成</h3></div>
                  <div className="progress-track"><span style={{ width: `${(completedTasks / tasks.length) * 100}%` }} /></div>
                </div>
                <div className="task-list">
                  {tasks.map((task) => (
                    <label className={`task-row ${task.done ? "done" : ""}`} key={task.id}>
                      <input type="checkbox" checked={task.done} onChange={() => toggleTask(task.id)} />
                      <span className="custom-check">✓</span>
                      <span><strong>{task.label}</strong><small>{task.meta}</small></span>
                    </label>
                  ))}
                </div>
                <div className="review-node">
                  <span>复评节点</span>
                  <strong>资料补齐后立即重新评估</strong>
                  <p>提前升级：生命体征不稳定、意识改变或其他急性恶化表现。</p>
                </div>
              </section>

              <section className="panel order-panel">
                <div className="panel-heading"><div><span className="eyebrow">处理计划复核</span><h3>输入医生拟定计划</h3></div><StatusPill tone="info">不自动开立</StatusPill></div>
                <textarea aria-label="医生拟定处理计划" value={planText} onChange={(event) => setPlanText(event.target.value)} />
                <button className="primary-button full" type="button" onClick={() => setReviewed(true)}>运行安全复核</button>
                {reviewed ? (
                  <div className="review-results">
                    <div className="result-line danger"><span>高</span><p><strong>缺少当前生命体征</strong><small>无法完成风险分层；请先床旁确认并记录来源。</small></p></div>
                    <div className="result-line warning"><span>中</span><p><strong>复评节点不明确</strong><small>“继续观察”需要补充时间、项目和提前升级条件。</small></p></div>
                    <div className="result-line info"><span>核</span><p><strong>处理方案需人工确认</strong><small>涉及高风险场景，系统不补充具体药物与剂量。</small></p></div>
                  </div>
                ) : (
                  <div className="empty-review"><span>↗</span><p>复核后将显示缺失前提、冲突、监测要求和人工确认闸门。</p></div>
                )}
              </section>
            </div>
          </div>
        )}

        {activePage === "documents" && (
          <div className="page-content">
            <SectionTitle eyebrow="04 · DOCUMENTS" title="文书与交班" detail="每个关键句保留证据状态，医生可以接受、驳回或继续核实。" />
            <div className="document-tabs" role="tablist" aria-label="文书类型">
              <button className={documentTab === "progress" ? "active" : ""} onClick={() => setDocumentTab("progress")} type="button">日常病程</button>
              <button className={documentTab === "handoff" ? "active" : ""} onClick={() => setDocumentTab("handoff")} type="button">交班摘要</button>
              <button className={documentTab === "communication" ? "active" : ""} onClick={() => setDocumentTab("communication")} type="button">沟通要点</button>
            </div>
            <section className="panel document-panel">
              <div className="document-header">
                <div><span className="eyebrow">AI工作稿 · 尚未签署</span><h3>{documentTab === "progress" ? "日常病程工作稿" : documentTab === "handoff" ? "交班摘要工作稿" : "患者沟通要点"}</h3></div>
                <div><StatusPill tone="warning">需人工审核</StatusPill><span className="version-label">Prompt v0.7 · Demo</span></div>
              </div>
              <div className="statement-list">
                {documentText[documentTab].map((statement) => {
                  const state = sentenceReviews[statement.id] ?? "pending";
                  return (
                    <article className={`statement state-${state}`} key={statement.id}>
                      <div className="statement-body">
                        <p>{statement.text}</p>
                        <button type="button" onClick={() => setSelectedEvidence(statement.source)}>{statement.tag} · {statement.source}</button>
                      </div>
                      <div className="statement-actions">
                        <button aria-label="接受" className={state === "accepted" ? "selected accept" : "accept"} type="button" onClick={() => reviewSentence(statement.id, "accepted")}>接受</button>
                        <button aria-label="驳回" className={state === "rejected" ? "selected reject" : "reject"} type="button" onClick={() => reviewSentence(statement.id, "rejected")}>驳回</button>
                      </div>
                    </article>
                  );
                })}
              </div>
              <footer className="document-footer">
                <span>已审核 {Object.values(sentenceReviews).filter((value) => value !== "pending").length} 句</span>
                <button className="secondary-button" type="button" onClick={() => setActivePage("evaluation")}>进入评测对比</button>
              </footer>
            </section>
          </div>
        )}

        {activePage === "evaluation" && (
          <div className="page-content">
            <SectionTitle eyebrow="05 · EVALUATION" title="评测看板" detail="当前为预置演示结果，用于验证界面；正式指标将在合成测试集完成后生成。" />
            <div className="evaluation-note"><strong>演示数据，不是正式研究结论</strong><span>Case A-01 · 错误注入 5 项 · 目标是展示评测结构</span></div>
            <div className="metric-grid">
              <div className="metric-card"><span>来源绑定</span><strong>8/8</strong><small>关键事实均可追溯</small></div>
              <div className="metric-card"><span>错误检出</span><strong>5/5</strong><small>预置注入项</small></div>
              <div className="metric-card"><span>高风险越界</span><strong>0</strong><small>未生成具体处方</small></div>
              <div className="metric-card"><span>人工修改</span><strong>2</strong><small>演示审核动作</small></div>
            </div>
            <section className="panel comparison-panel">
              <div className="panel-heading"><div><span className="eyebrow">同例对比</span><h3>三种方法的错误画像</h3></div><StatusPill tone="info">预置演示</StatusPill></div>
              <div className="comparison-table">
                <div className="comparison-head"><span>方法</span><span>无依据新增</span><span>关键遗漏</span><span>越界风险</span><span>来源可追溯</span></div>
                <div className="comparison-row"><strong>通用模型直出</strong><span className="score bad">3</span><span className="score bad">2</span><span className="score bad">1</span><span className="score bad">否</span></div>
                <div className="comparison-row"><strong>个人 GEM V6.6</strong><span className="score warn">2</span><span className="score warn">1</span><span className="score bad">1</span><span className="score warn">部分</span></div>
                <div className="comparison-row highlight"><strong>结构化工作台 V0.1</strong><span className="score good">0</span><span className="score good">0</span><span className="score good">0</span><span className="score good">是</span></div>
              </div>
            </section>
            <div className="two-column eval-bottom">
              <section className="panel"><span className="eyebrow">已识别错误</span><h3>Case A-01 注入项</h3><ul className="clean-list"><li>治疗日期冲突</li><li>报告图片关键数值不清</li><li>未经询问的否认项</li><li>复评节点缺失</li><li>将建议写成已执行风险</li></ul></section>
              <section className="panel"><span className="eyebrow">下一里程碑</span><h3>从演示走向实测</h3><p className="muted-copy">完成3个端到端合成病例和人工评分标准，再扩展至30例正式测试集。所有正式结果将保留模型、提示词与审核版本。</p><button type="button" className="text-button" onClick={() => setActivePage("input")}>返回病例输入 →</button></section>
            </div>
          </div>
        )}
      </section>

      {selectedEvidence && (
        <div className="evidence-backdrop" role="presentation" onClick={() => setSelectedEvidence(null)}>
          <aside className="evidence-drawer" role="dialog" aria-modal="true" aria-label="证据详情" onClick={(event) => event.stopPropagation()}>
            <button className="drawer-close" type="button" onClick={() => setSelectedEvidence(null)} aria-label="关闭">×</button>
            <span className="eyebrow">EVIDENCE TRACE</span>
            <h3>证据与状态</h3>
            <div className="evidence-code">{selectedEvidence}</div>
            <p>该内容来自完全合成资料，仅用于展示来源追溯和人工审核流程。</p>
            <dl>
              <div><dt>当前状态</dt><dd>待医生确认</dd></div>
              <div><dt>可否直接写入</dt><dd>否</dd></div>
              <div><dt>风险标记</dt><dd>需核对原始资料</dd></div>
            </dl>
            <button className="primary-button full" type="button" onClick={() => setSelectedEvidence(null)}>返回工作台</button>
          </aside>
        </div>
      )}
    </main>
  );
}
