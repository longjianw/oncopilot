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

  const visiblePatients = useMemo(() => {
    const source = mode === "mine" ? patients.filter((patient) => patient.mine) : patients;
    const keyword = query.trim().toLowerCase();
    if (!keyword) return source;
    return source.filter((patient) => [patient.bed, patient.label, patient.diagnosis, patient.risk].some((value) => value.toLowerCase().includes(keyword)));
  }, [mode, query]);

  const selectedPatient = visiblePatients.find((patient) => patient.id === selectedId) ?? visiblePatients[0] ?? patients[0];

  const switchMode = (next: ListMode) => {
    setMode(next); setQuery(""); setConfirmed(false);
    const first = next === "mine" ? patients.find((patient) => patient.mine) : patients[0];
    if (first) setSelectedId(first.id);
  };

  const selectPatient = (id: string) => { setSelectedId(id); setConfirmed(false); };

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
          <div><span className="eyebrow">AI PORTFOLIO · V0.2</span><h1>{mode === "ward" ? "在区患者" : "我的分管患者"}</h1><p>{mode === "ward" ? "先看全病区，再进入需要关注的患者。" : "把我负责的患者、今日变化和待办放在同一个页面。"}</p></div>
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
            <section className="ai-summary">
              <div className="section-label"><span>AI</span><strong>今日管床摘要</strong><small>基于合成资料</small></div>
              <div className="summary-block"><span>今日变化</span><p>{selectedPatient.change}</p></div>
              <div className="summary-block"><span>建议先做</span><p>{selectedPatient.task}</p></div>
              <button type="button" className="evidence-button">查看来源 · {selectedPatient.evidence}</button>
            </section>
            <section className="todo-section">
              <div className="section-label"><strong>今日待办</strong><small>由医生确认完成</small></div>
              {taskTemplates.map((task, index) => { const key = `${selectedPatient.id}-${index}`; return <label className={doneTasks[key] ? "todo done" : "todo"} key={key}><input type="checkbox" checked={Boolean(doneTasks[key])} onChange={() => setDoneTasks((current) => ({ ...current, [key]: !current[key] }))} /><span>✓</span><p>{task}</p></label>; })}
            </section>
            <section className="review-box"><div><span>安全提醒</span><strong>{confirmed ? "已标记人工核实" : "关键结论尚未人工确认"}</strong><p>系统不自动修改诊断、开立医嘱或给出可直接执行的治疗方案。</p></div><button type="button" className={confirmed ? "confirmed" : ""} onClick={() => setConfirmed((value) => !value)}>{confirmed ? "已核实" : "标记核实"}</button></section>
          </aside>
        </div>
      </section>
    </main>
  );
}
