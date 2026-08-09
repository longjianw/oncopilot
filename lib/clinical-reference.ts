import { parseModelJson } from "./model-api";

export type ReferencePathItem = { title: string; trigger: string; purpose: string };
export type ReferenceCheck = { topic: string; status: "supported" | "conditional" | "not_found"; note: string; source: string; url?: string };
export type ClinicalReferenceBundle = {
  preliminary_diagnosis: string;
  diagnostic_basis: string[];
  differential_diagnosis: string[];
  missing_prerequisites: string[];
  suggested_workup: ReferencePathItem[];
  treatment_pathways: ReferencePathItem[];
  verification_state: "starter" | "model_only" | "local_checked" | "web_checked";
  disclaimer: string;
  checks?: ReferenceCheck[];
};

const strings = (value: unknown, limit = 8) => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean).slice(0, limit)
  : [];

const pathItems = (value: unknown, limit = 8): ReferencePathItem[] => Array.isArray(value) ? value.flatMap((item) => {
  if (!item || typeof item !== "object") return [];
  const candidate = item as Partial<ReferencePathItem>;
  const title = typeof candidate.title === "string" ? candidate.title.trim() : "";
  const trigger = typeof candidate.trigger === "string" ? candidate.trigger.trim() : "";
  const purpose = typeof candidate.purpose === "string" ? candidate.purpose.trim() : "";
  if (!title || !trigger || !purpose || /(?:\d+(?:\.\d+)?\s*(?:mg|g|ml)|每日|每次|静滴|口服)/i.test(`${title}${purpose}`)) return [];
  return [{ title, trigger, purpose }];
}).slice(0, limit) : [];

const diagnosisItems = (diagnosticFacts: string[]) => [...new Set(diagnosticFacts.flatMap((fact) => fact
  .replace(/既往住院记录明确诊断\s*[:：]?/g, "")
  .replace(/(?:入院|出院|初步|目前|当前)诊断\s*[:：]?/g, "")
  .split(/[；;\n]|(?=\d+[.、])/)
  .map((item) => item.replace(/^\s*\d+[.、]\s*/, "").trim())
  .filter((item) => item.length >= 2 && item.length <= 100 && /癌|瘤|白血病|淋巴瘤|感染|缺乏|减少|贫血|转移|复发|综合征|疾病|病变/.test(item))))].slice(0, 6);

export const defaultReferenceDiagnosis = (factsText: string, diagnosticFacts: string[] = []) => {
  if (/黑色素瘤|melanoma/i.test(factsText)) return "黑色素瘤（现有资料已提示；原发部位、病理亚型及临床分期待补）";
  const candidates = diagnosisItems(diagnosticFacts);
  return candidates.length
    ? `${candidates.join("；")}（依据现有资料整理，需结合本次入院情况及原始报告核对）`
    : "肿瘤相关诊断（具体病种、部位、病理及分期待结合原始资料补充）";
};

export function starterClinicalReference(factsText: string, diagnosticFacts: string[]): ClinicalReferenceBundle {
  const melanoma = /黑色素瘤|melanoma/i.test(factsText);
  const generalMissing = ["本次主要问题、来院目的及当前症状", "原发肿瘤病理、分期和目前疾病状态", "既往治疗、疗效及最近一次治疗时间", "ECOG PS、重要合并症和器官功能"];
  const generalWorkup: ReferencePathItem[] = [
    { title: "复核当前诊断列表及原始依据", trigger: "现有资料主要来自既往记录，或诊断名称、病理、分期未形成同一条证据链", purpose: "区分原发肿瘤、治疗相关问题、并发症和仍待排除的问题" },
    { title: "补齐本次症状、查体和关键检验/影像", trigger: "本次主要问题或最新客观状态尚未完整提供", purpose: "判断既往诊断中哪些仍是当前需要处理的问题，并形成入院基线" },
    { title: "核对既往治疗时间线与疗效", trigger: "既往手术、放疗或系统治疗资料分散，最近疗效评价不清", purpose: "明确当前治疗阶段、既往获益及限制后续讨论的因素" },
    { title: "补充体能、合并症与器官功能评估", trigger: "ECOG PS、感染/血液学问题或肝肾功能等资料不足", purpose: "为检查优先级和后续治疗可行性讨论提供基础" },
  ];
  const generalPathways: ReferencePathItem[] = [
    { title: "先处理当前突出问题", trigger: "本次存在感染、血细胞异常、疼痛或其他影响安全与治疗实施的问题时", purpose: "先明确严重度、病因线索和复评节点，再讨论抗肿瘤治疗衔接" },
    { title: "原发肿瘤状态复核路径", trigger: "既往肿瘤诊断明确，但当前分期、复发/进展状态或既往疗效不完整时", purpose: "补齐病理和影像证据后，判断当前处于随访、局部处理还是系统治疗讨论阶段" },
    { title: "多问题分层讨论路径", trigger: "原发肿瘤、治疗相关不良反应和合并症同时存在时", purpose: "按当前危险性、可逆性和对后续治疗的影响排序，形成上级讨论清单" },
  ];
  return {
    preliminary_diagnosis: defaultReferenceDiagnosis(factsText, diagnosticFacts),
    diagnostic_basis: diagnosticFacts.length ? diagnosticFacts.map((fact) => `现有资料记载：${fact}`) : ["现有结构化事实尚不足以形成诊断依据摘要"],
    differential_diagnosis: melanoma
      ? ["若病理原文、取材代表性或诊断一致性存在疑问，先由病理科复核是否需要鉴别其他色素性病变或不同原发类型"]
      : ["围绕本次突出问题判断是否需要鉴别感染、治疗相关不良反应、肿瘤进展或其他合并疾病；没有新发疑点时不机械罗列"],
    missing_prerequisites: melanoma ? ["原发部位、发现及取材方式", "完整病理报告及关键参数", "区域淋巴结和远处转移分期资料", "既往处理、体能状态及合并症"] : generalMissing,
    suggested_workup: melanoma ? [
      { title: "复核完整病理与免疫组化原文", trigger: "当前只有确诊摘要或报告内容不全", purpose: "补齐病理类型、Breslow厚度、溃疡、切缘及其他影响分期和讨论路径的参数" },
      { title: "补充原发灶、全身皮肤及区域淋巴结评估", trigger: "原发部位或实际查体尚未明确", purpose: "明确原发灶、卫星/移行相关皮损及区域淋巴结情况" },
      { title: "按分期线索选择影像评估", trigger: "当前区域淋巴结或远处转移资料不足，或症状/查体提示需要评估", purpose: "结合已有检查，在区域淋巴结超声、胸部CT、腹盆部增强CT/MRI、骨或中枢评估等候选中选择" },
      { title: "评估BRAF、c-KIT、NRAS等分子资料", trigger: "进入需要依据分子状态讨论系统治疗的临床情境，且既往结果未提供", purpose: "为后续靶向或系统治疗分层讨论提供依据" },
    ] : generalWorkup,
    treatment_pathways: melanoma ? [
      { title: "局限且可切除路径", trigger: "完整病理和分期支持局限、可切除时", purpose: "进入原发灶手术范围及区域淋巴结管理的多学科评估" },
      { title: "高风险术后路径", trigger: "已完成切除且病理/分期提示较高复发风险时", purpose: "结合分期、分子状态和患者情况讨论辅助治疗与随访方向" },
      { title: "不可切除或转移性路径", trigger: "经影像、病理和上级医师确认不可切除或远处转移时", purpose: "结合分子状态、既往治疗、体能和器官功能讨论系统治疗及局部处理方向" },
    ] : generalPathways,
    verification_state: "starter",
    disclaimer: "已根据现有事实生成可编辑的快速候选；资料缺失处已保留条件，需结合原始报告和本次实际情况核对。",
  };
}

export function parseClinicalReference(raw: string, factsText: string, diagnosticFacts: string[]): ClinicalReferenceBundle {
  const value = parseModelJson(raw) as Partial<ClinicalReferenceBundle>;
  const suggestedWorkup = pathItems(value.suggested_workup);
  const treatmentPathways = pathItems(value.treatment_pathways);
  if (suggestedWorkup.length < 2 || treatmentPathways.length < 2) throw new Error("模型没有生成足够完整的条件性参考路径");
  return {
    preliminary_diagnosis: defaultReferenceDiagnosis(factsText, diagnosticFacts),
    diagnostic_basis: diagnosticFacts.length ? diagnosticFacts.map((fact) => `现有资料记载：${fact}`) : strings(value.diagnostic_basis),
    differential_diagnosis: strings(value.differential_diagnosis, 5),
    missing_prerequisites: strings(value.missing_prerequisites),
    suggested_workup: suggestedWorkup,
    treatment_pathways: treatmentPathways,
    verification_state: "model_only",
    disclaimer: "AI参考候选，尚未进行指南或本院资料核验；不得直接作为医嘱、处方或最终诊疗决定。",
  };
}

export function localReferenceChecks(bundle: ClinicalReferenceBundle): ReferenceCheck[] {
  const text = JSON.stringify(bundle);
  return [
    {
      topic: "病理关键参数",
      status: /Breslow|溃疡|切缘|有丝分裂|病理/.test(text) ? "supported" : "not_found",
      note: "CSCO来源卡支持复核Breslow厚度、溃疡、切缘及其他关键病理参数；缺项不等于阴性。",
      source: "2025 CSCO黑色素瘤诊疗指南，第7页",
    },
    {
      topic: "分子检测候选",
      status: /BRAF|c-KIT|NRAS|分子/.test(text) ? "conditional" : "not_found",
      note: "BRAF、c-KIT、NRAS属于指南列出的分子分型候选；是否检测取决于临床情境、已有标本和后续治疗讨论。",
      source: "2025 CSCO黑色素瘤诊疗指南，第7页",
    },
    {
      topic: "影像分期候选",
      status: /淋巴结|CT|MRI|PET|影像|分期/.test(text) ? "conditional" : "not_found",
      note: "区域淋巴结超声、胸部CT、腹盆部增强CT/MRI、骨扫描、头颅增强检查等属于分期候选；PET/CT为较低级别推荐，不能写成人人必做。",
      source: "2025 CSCO黑色素瘤诊疗指南，第12页",
    },
    {
      topic: "治疗方向",
      status: "conditional",
      note: "本地V0.1来源卡尚未完成治疗章节提炼；当前只能保留按分期、可切除性和分子状态分支的讨论框架，不能显示为本地指南已核验。",
      source: "本地知识库接入状态",
    },
  ];
}

export function webReferenceChecks(
  bundle: ClinicalReferenceBundle,
  sources: { nciText?: string; nhcText?: string; nciUrl: string; nhcUrl: string },
): ReferenceCheck[] {
  const candidate = JSON.stringify(bundle);
  const checks: ReferenceCheck[] = [];
  if (sources.nciText) {
    const nciHasStaging = /Stage I|Stage II|Stage III|Stage IV|staging/i.test(sources.nciText);
    const nciHasTreatment = /Treatment Option Overview|surgery|immunotherapy|targeted therapy/i.test(sources.nciText);
    const nciHasMolecular = /BRAF|KIT|NRAS/i.test(sources.nciText);
    checks.push(
      {
        topic: "分期后选择路径",
        status: nciHasStaging && /分期|局限|转移|可切除/.test(candidate) ? "conditional" : "not_found",
        note: "NCI专业版按疾病分期组织治疗信息；当前患者分期未明，因此只能支持“先分期、再分支讨论”的方向，不能支持某一具体方案。",
        source: "NCI Melanoma Treatment PDQ",
        url: sources.nciUrl,
      },
      {
        topic: "治疗方式候选",
        status: nciHasTreatment && /手术|免疫|靶向|系统治疗|局部处理/.test(candidate) ? "conditional" : "not_found",
        note: "官方页面包含手术、免疫治疗、靶向治疗等按情境展开的治疗信息；仅说明候选方向存在，不代表适用于本患者。",
        source: "NCI Melanoma Treatment PDQ",
        url: sources.nciUrl,
      },
      {
        topic: "分子状态与治疗讨论",
        status: nciHasMolecular && /BRAF|c-KIT|NRAS|分子/.test(candidate) ? "conditional" : "not_found",
        note: "官方页面包含分子靶点相关内容；是否检测及如何使用结果仍取决于病理类型、分期、标本和治疗情境。",
        source: "NCI Melanoma Treatment PDQ",
        url: sources.nciUrl,
      },
    );
  }
  if (sources.nhcText) {
    checks.push({
      topic: "中国官方指南入口",
      status: /黑色素瘤/.test(sources.nhcText) && /指南|诊疗/.test(sources.nhcText) ? "supported" : "not_found",
      note: "本次已读取国家卫生健康委黑色素瘤诊疗指南发布页；发布页可作为权威入口，但患者适用性仍需结合指南正文和完整资料逐项判断。",
      source: "国家卫生健康委黑色素瘤诊疗指南发布页",
      url: sources.nhcUrl,
    });
  }
  return checks;
}
