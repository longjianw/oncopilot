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
  verification_state: "model_only" | "local_checked" | "web_checked";
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
  if (!title || !trigger || !purpose || /(?:\d+(?:\.\d+)?\s*(?:mg|g|ml)|每日|每次|静滴|口服)/i.test(`${title}${trigger}${purpose}`)) return [];
  return [{ title, trigger, purpose }];
}).slice(0, limit) : [];

const explicitEvidenceText = (evidenceText: string) => {
  try {
    const parsed = JSON.parse(evidenceText) as { facts?: Array<{ value?: unknown; certainty?: unknown }> };
    if (Array.isArray(parsed.facts)) return parsed.facts
      .filter((fact) => fact?.certainty === "explicit" || fact?.certainty === "doctor_confirmed")
      .map((fact) => typeof fact.value === "string" ? fact.value : "")
      .join("\n");
  } catch { /* fall through to the original bounded evidence text */ }
  return evidenceText;
};

const normalizeStage = (value: string) => value.toUpperCase().replace(/\s+/g, "").replace(/Ⅳ/g, "IV").replace(/Ⅲ/g, "III").replace(/Ⅱ/g, "II").replace(/Ⅰ/g, "I");

const unsupportedDiagnosticCertainty = (diagnosticText: string, evidenceText: string) => {
  const explicitEvidence = explicitEvidenceText(evidenceText);
  const unsupportedTerms = ["转移", "化疗"];
  if (unsupportedTerms.some((term) => diagnosticText.includes(term) && !explicitEvidence.includes(term))) return true;
  const unsupportedTemporalTerms = ["未恢复", "持续性", "进行性", "反复", "逐渐加重", "较前恶化"];
  if (unsupportedTemporalTerms.some((term) => diagnosticText.includes(term) && !explicitEvidence.includes(term))) return true;
  const stages = diagnosticText.match(/(?:IV|III|II|I|Ⅳ|Ⅲ|Ⅱ|Ⅰ|[1-4])\s*期/gi) || [];
  return stages.some((stage) => !normalizeStage(explicitEvidence).includes(normalizeStage(stage)));
};

export function parseClinicalReference(raw: string, evidenceText = ""): ClinicalReferenceBundle {
  const value = parseModelJson(raw) as Partial<ClinicalReferenceBundle>;
  const preliminaryDiagnosis = typeof value.preliminary_diagnosis === "string" ? value.preliminary_diagnosis.trim() : "";
  const diagnosticBasis = strings(value.diagnostic_basis);
  const differentialDiagnosis = strings(value.differential_diagnosis, 5);
  const missingPrerequisites = strings(value.missing_prerequisites);
  const suggestedWorkup = pathItems(value.suggested_workup);
  const treatmentPathways = pathItems(value.treatment_pathways);
  if (!preliminaryDiagnosis || diagnosticBasis.length < 1 || missingPrerequisites.length < 1 || suggestedWorkup.length < 2 || treatmentPathways.length < 2) {
    throw new Error("模型没有生成足够完整的病例专属参考");
  }
  if (evidenceText && unsupportedDiagnosticCertainty([preliminaryDiagnosis, ...diagnosticBasis].join(" "), evidenceText.replace(/\s+/g, ""))) {
    throw new Error("模型在诊断区加入了资料未支持的分期、转移或治疗类型");
  }
  return {
    preliminary_diagnosis: preliminaryDiagnosis,
    diagnostic_basis: diagnosticBasis,
    differential_diagnosis: differentialDiagnosis,
    missing_prerequisites: missingPrerequisites,
    suggested_workup: suggestedWorkup,
    treatment_pathways: treatmentPathways,
    verification_state: "model_only",
    disclaimer: "AI参考候选，尚未进行指南或本院资料核验；不得直接作为医嘱、处方或最终诊疗决定。",
  };
}

export function localReferenceChecks(bundle: ClinicalReferenceBundle): ReferenceCheck[] {
  const text = JSON.stringify(bundle);
  if (!/黑色素瘤|melanoma/i.test(text)) {
    return [{
      topic: "疾病专属来源卡",
      status: "not_found",
      note: "当前本地只完成黑色素瘤来源卡；本病例暂无对应瘤种来源卡，不能把黑色素瘤规则用于交叉核验。",
      source: "本地来源库接入状态",
    }];
  }
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
