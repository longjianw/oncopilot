"use client";

import { useMemo, useState } from "react";

type ListMode = "ward" | "mine";
type Tone = "red" | "amber" | "blue" | "green";

type Patient = {
  id: string; bed: string; label: string; sex: "男" | "女"; ageBand: string;
  diagnosis: string; admitted: string; days: number; doctor: string; mine: boolean;
  risk: string; tone: Tone; change: string; task: string; evidence: string;
};

const patients: Patient[] = [
  { id: "SYN-A01", bed: "A-03", label: "合成患者 A01", sex: "女", ageBand: "50–59岁", diagnosis: "淋巴系统恶性肿瘤", admitted: "08-01", days: 2, doctor: "我", mine: true, risk: "需优先查看", tone: "red", change: "治疗后出现发热描述，新增血常规结果。", task: "核对当前生命体征与关键检验原值。", evidence: "2份新资料 · 1项待核实" },
  { id: "SYN-A02", bed: "A-12", label: "合成患者 A02", sex: "男", ageBand: "60–69岁", diagnosis: "肺部恶性肿瘤", admitted: "07-29", days: 5, doctor: "我", mine: true, risk: "结果待确认", tone: "amber", change: "新影像报告出现与既往不同的描述。", task: "回看报告原文，确认是否更新问题清单。", evidence: "1份新报告 · 2处来源绑定" },
  { id: "SYN-A03", bed: "B-06", label: "合成患者 A03", sex: "女", ageBand: "40–49岁", diagnosis: "乳腺恶性肿瘤", admitted: "07-27", days: 7, doctor: "我", mine: true, risk: "常规随访", tone: "green", change: "今日暂无新的高风险变化。", task: "完成日常病程与下一周期安排确认。", evidence: "资料完整度 92%" },
  { id: "SYN-A04", bed: "A-18", label: "合成患者 A04", sex: "男", ageBand: "50–59岁", diagnosis: "结直肠恶性肿瘤", admitted: "08-02", days: 1, doctor: "上级组 A", mine: false, risk: "新入院", tone: "blue", change: "入院资料已整理，病理分期信息待补齐。", task: "等待主管组完成首次评估。", evidence: "3份资料 · 2项待补" },
  { id: "SYN-A05", bed: "B-11", label: "合成患者 A05", sex: "女", ageBand: "60–69岁", diagnosis: "宫颈恶性肿瘤", admitted: "07-31", days: 3, doctor: "上级组 B", mine: false, risk: "检查回报", tone: "amber", change: "新增生化检查，存在一项趋势变化。", task: "由主管组结合床旁情况复核。", evidence: "1份新检验" },
  { id: "SYN-A06", bed: "B-17", label: "合成患者 A06", sex: "男", ageBand: "70–79岁", diagnosis: "食管恶性肿瘤", admitted: "07-25", days: 9, doctor: "上级组 B", mine: false, risk: "常规随访", tone: "green", change: "无新增关键资料。", task: "按既定计划随访。", evidence: "资料完整度 88%" },
  { id: "SYN-A07", bed: "C-05", label: "合成患者 A07", sex: "女", ageBand: "50–59岁", diagnosis: "卵巢恶性肿瘤", admitted: "07-30", days: 4, doctor: "上级组 C", mine: false, risk: "沟通待办", tone: "blue", change: "治疗周期说明尚未形成结构化记录。", task: "补充沟通要点并由主管医师确认。", evidence: "1项文书待办" },
  { id: "SYN-A08", bed: "C-09", label: "合成患者 A08", sex: "男", ageBand: "40–49岁", diagnosis: "鼻咽部恶性肿瘤", admitted: "07-28", days: 6, doctor: "上级组 C", mine: false, risk: "常规随访", tone: "green", change: "今日暂无新的高风险变化。", task: "继续既定观察。", evidence: "无新增资料" },
];

const taskTemplates = ["核对当前生命体征与症状起始时间", "回看新报告原值并确认来源", "请主管或上级医师确认下一步安排"];

export default function Home() {
  const [mode, setMode] = useState<ListMode>("mine");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState("SYN-A01");
  const [doneTasks, setDoneTasks] = useState<Record<string, boolean>>({});
  const [confirmed, setConfirmed] = useState(false);
  const [workflowStage, setWorkflowStage] = useState(0);
  const [evaluationOpen, setEvaluationOpen] = useState(false);

  const visiblePatients = useMemo(() => {
    const source = mode === "mine" ? patients.filter((patient) => patient.mine) : patients;
    const keyword = query.trim().toLowerCase();
    if (!keyword) return source;
    return source.filter((patient) => [patient.bed, patient.label, patient.diagnosis, patient.risk].some((value) => value.toLowerCase().includes(keyword)));
  }, [mode, query]);

  const selectedPatient = visiblePatients.find((patient) => patient.id === selectedId) ?? visiblePatients[0] ?? patients[0];
  const isWorkflowCase = selectedPatient.id === "SYN-A01";
  const currentChange = isWorkflowCase
    ? workflowStage >= 2
      ? "新增血常规较上一份合成报告出现白细胞、中性粒细胞及血小板下降。"
      : workflowStage >= 1
        ? "已收到一份新报告，尚未完成结构化解析。"
        : "今日尚无新增资料，等待检验或检查回报。"
    : selectedPatient.change;
  const currentTask = isWorkflowCase
    ? workflowStage >= 3
      ? "先核对当前生命体征与症状，再由主管医师复核风险。"
      : "尚未生成新的今日待办。"
    : selectedPatient.task;
  const currentEvidence = isWorkflowCase && workflowStage >= 1 ? "LAB-SYN-082 · 完全合成报告" : selectedPatient.evidence;

  const switchMode = (next: ListMode) => {
    setMode(next); setQuery(""); setConfirmed(false);
    const first = next === "mine" ? patients.find((patient) => patient.mine) : patients[0];
    if (first) setSelectedId(first.id);
  };

  const selectPatient = (id: string) => { setSelectedId(id); setConfirmed(false); setEvaluationOpen(false); };

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">OP</span><div><strong>OncoPilot</strong><small>肿瘤住院管床助手</small></div></div>
        <div className="ward-label"><span>当前病区</span><strong>肿瘤三区 · 演示病区</strong></div>
        <nav aria-label="患者范围">
          <button className={mode === "ward" ? "active" : ""} type="button" onClick={() => switchMode("ward")}><span className="nav-icon">区</span><span><strong>在区患者</strong><small>全病区患者视图</small></span><b>30</b></button>
          <button className={mode === "mine" ? "active" : ""} type="button" onClick={() => switchMode("mine")}><span className="nav-icon">我</span><span><strong>我的分管患者</strong><small>仅显示当前分管</small></span><b>3</b></button>
        </nav>
        <div className="privacy-note"><strong>完全合成数据</strong><p>不连接医院 HIS，不包含真实患者资料，不用于临床决策。</p></div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div><span className="eyebrow">AI PORTFOLIO · V0.4</span><h1>{mode === "ward" ? "在区患者" : "我的分管患者"}</h1><p>{mode === "ward" ? "先看全病区，再进入需要关注的患者。" : "把我负责的患者、今日变化和待办放在同一个页面。"}</p></div>
          <div className="scope-switch" aria-label="切换患者范围"><button type="button" className={mode === "ward" ? "active" : ""} onClick={() => switchMode("ward")}>在区 30</button><button type="button" className={mode === "mine" ? "active" : ""} onClick={() => switchMode("mine")}>我分管 3</button></div>
        </header>

        <div className="safety-line"><span>演示边界</span>AI只整理新增资料、提示待办与风险；诊疗决定仍由有资质医师审核。</div>

        <div className="content-grid">
          <section className="patient-panel">
            <div className="list-toolbar">
              <div><span>患者列表</span><strong>{mode === "ward" ? "30例在区患者" : "3例分管患者"}</strong><small>当前展示 {visiblePatients.length} 条完全合成样例</small></div>
              <label className="search-box"><span>检索</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="床位、诊断或状态" aria-label="检索患者" /></label>
            </div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>床位</th><th>患者标识</th><th>主要诊断</th><th>住院</th><th>当前状态</th></tr></thead>
                <tbody>{visiblePatients.map((patient) => (
                  <tr key={patient.id} className={selectedPatient.id === patient.id ? "selected" : ""} onClick={() => selectPatient(patient.id)}>
                    <td><span className="bed-number">{patient.bed}</span></td>
                    <td><button type="button" onClick={() => selectPatient(patient.id)}><strong>{patient.label}</strong><small>{patient.sex} · {patient.ageBand} · {patient.id}</small></button></td>
                    <td><span className="diagnosis">{patient.diagnosis}</span></td>
                    <td><strong>{patient.days}天</strong><small>{patient.admitted} 入区</small></td>
                    <td><span className={`risk risk-${patient.tone}`}><i />{patient.risk}</span></td>
                  </tr>
                ))}</tbody>
              </table>
              {visiblePatients.length === 0 && <div className="empty">没有找到匹配的合成患者。</div>}
            </div>
          </section>

          <aside className="patient-card">
            <div className="patient-card-head"><div><span>{selectedPatient.bed}床 · {selectedPatient.id}</span><h2>{selectedPatient.label}</h2><p>{selectedPatient.sex} · {selectedPatient.ageBand} · 住院第{selectedPatient.days}天</p></div><span className={`risk risk-${selectedPatient.tone}`}><i />{selectedPatient.risk}</span></div>
            <dl className="patient-facts"><div><dt>主要诊断</dt><dd>{selectedPatient.diagnosis}</dd></div><div><dt>分管范围</dt><dd>{selectedPatient.mine ? "我的分管患者" : selectedPatient.doctor}</dd></div></dl>

            {isWorkflowCase && (
              <section className="workflow-box">
                <div className="workflow-heading"><div><span>可交互演示</span><strong>新增报告处理闭环</strong></div><small>前台为固定规则演示 · 后台已完成真实模型初测</small></div>
                <div className="workflow-steps" aria-label="处理进度">
                  {["新增报告", "AI识别", "生成待办", "医生核实"].map((label, index) => {
                    const step = index + 1;
                    const reached = step <= workflowStage || (step === 4 && confirmed);
                    const current = step === workflowStage + 1 && !confirmed;
                    return <span key={label} className={`${reached ? "done" : ""} ${current ? "current" : ""}`}><i>{reached ? "✓" : step}</i>{label}</span>;
                  })}
                </div>

                {workflowStage === 0 && <div className="workflow-empty"><p>模拟收到一份完全合成的血常规报告，体验AI如何把新资料转成管床待办。</p><button type="button" onClick={() => setWorkflowStage(1)}>+ 模拟新增检验报告</button></div>}

                {workflowStage >= 1 && (
                  <div className="synthetic-report">
                    <div><span>新资料 · LAB-SYN-082</span><strong>血常规（完全合成）</strong><small>采集时间 08-03 08:10 · 不对应任何真实患者</small></div>
                    <dl>
                      <div><dt>白细胞</dt><dd>1.8 ×10⁹/L <b>低</b></dd></div>
                      <div><dt>中性粒细胞绝对值</dt><dd>0.8 ×10⁹/L <b>低</b></dd></div>
                      <div><dt>血红蛋白</dt><dd>108 g/L <b>低</b></dd></div>
                      <div><dt>血小板</dt><dd>92 ×10⁹/L <b>低</b></dd></div>
                    </dl>
                    {workflowStage === 1 && <button type="button" className="workflow-action" onClick={() => setWorkflowStage(2)}>运行演示解析</button>}
                  </div>
                )}

                {workflowStage >= 2 && (
                  <div className="analysis-result">
                    <span>演示解析结果</span>
                    <p><strong>已识别：</strong>3项血细胞指标较上一份合成报告下降。</p>
                    <p><strong>仍缺少：</strong>当前生命体征、症状变化和床旁评估。</p>
                    <p><strong>安全边界：</strong>不自动判断病因，不生成处方或剂量。</p>
                    {workflowStage === 2 && <button type="button" className="workflow-action" onClick={() => setWorkflowStage(3)}>生成今日待办</button>}
                    {workflowStage >= 3 && <div className="generated-note">已生成3项待确认任务，请医生逐项核实。</div>}
                  </div>
                )}
              </section>
            )}

            <section className="ai-summary">
              <div className="section-label"><span>AI</span><strong>今日管床摘要</strong><small>基于合成资料</small></div>
              <div className="summary-block"><span>今日变化</span><p>{currentChange}</p></div>
              <div className="summary-block"><span>建议先做</span><p>{currentTask}</p></div>
              <button type="button" className="evidence-button">查看来源 · {currentEvidence}</button>
            </section>
            <section className="todo-section">
              <div className="section-label"><strong>今日待办</strong><small>由医生确认完成</small></div>
              {(!isWorkflowCase || workflowStage >= 3) ? taskTemplates.map((task, index) => { const key = `${selectedPatient.id}-${index}`; return <label className={doneTasks[key] ? "todo done" : "todo"} key={key}><input type="checkbox" checked={Boolean(doneTasks[key])} onChange={() => setDoneTasks((current) => ({ ...current, [key]: !current[key] }))} /><span>✓</span><p>{task}</p></label>; }) : <div className="todo-empty">完成演示解析后，系统才会生成待确认任务。</div>}
            </section>
            <section className="review-box"><div><span>安全提醒</span><strong>{confirmed ? "已标记人工核实" : "关键结论尚未人工确认"}</strong><p>系统不自动修改诊断、开立医嘱或给出可直接执行的治疗方案。</p></div><button type="button" disabled={isWorkflowCase && workflowStage < 3} className={confirmed ? "confirmed" : ""} onClick={() => setConfirmed((value) => !value)}>{confirmed ? "已核实" : "标记核实"}</button></section>
            {isWorkflowCase && confirmed && (
              <section className="evaluation-proof">
                <button type="button" className="evaluation-toggle" onClick={() => setEvaluationOpen((value) => !value)}><span><strong>评测证据</strong><small>查看这条流水线怎样被检验</small></span><b>{evaluationOpen ? "收起" : "展开"}</b></button>
                {evaluationOpen && (
                  <div className="evaluation-body">
                    <div className="evaluation-disclaimer"><strong>A01 单病例初测，不代表最终排名</strong><p>2026-08-03 使用完全合成输入、同一提示词和同一评分器；原始输出已保存并人工核对。</p></div>
                    <div className="evaluation-scores">
                      <article><span>DeepSeek V4 Pro</span><strong>100<small>/100</small></strong><p>35.9秒 · 全部关键项命中</p></article>
                      <article><span>DeepSeek V4 Flash</span><strong>100<small>/100</small></strong><p>27.4秒 · 同分且更快</p></article>
                      <article className="warning"><span>MiniMax M3</span><strong>95<small>/100</small></strong><p>22.0秒 · 多报1项“无变化”</p></article>
                      <article className="failure"><span>豆包 / GLM</span><strong>超时</strong><p>均超过120秒，未获得可评分输出</p></article>
                    </div>
                    <div className="error-tags positive"><span>无自动诊断</span><span>无具体治疗越权</span><span>来源完整</span><span>保留人工复核</span></div>
                    <p className="evaluation-next">阶段结论：Pro 与 Flash 质量并列，Flash 更快；当前仍保留 Pro 为默认模型，待扩展到约30例合成病例后再确定最终方案。</p>
                  </div>
                )}
              </section>
            )}
          </aside>
        </div>
      </section>
    </main>
  );
}
