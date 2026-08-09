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
  if (!title || !trigger || !purpose || /(?:\d+(?:\.\d+)?\s*(?:mg|g|ml)|每日|每次|静滴|口服)/i.test(`${title}${purpose}`)) return [];
  return [{ title, trigger, purpose }];
}).slice(0, limit) : [];

export const defaultReferenceDiagnosis = (factsText: string) => /黑色素瘤|melanoma/i.test(factsText)
  ? "黑色素瘤（现有资料已提示；原发部位、病理亚型及临床分期待补）"
  : "肿瘤相关诊断（具体病种、部位、病理及分期待医生结合原始资料确认）";

export function parseClinicalReference(raw: string, factsText: string): ClinicalReferenceBundle {
  const value = parseModelJson(raw) as Partial<ClinicalReferenceBundle>;
  let preliminary = typeof value.preliminary_diagnosis === "string" ? value.preliminary_diagnosis.trim() : "";
  const stageMention = preliminary.match(/(?:[ⅠⅡⅢⅣIVX]{1,4}|[0-4]期|转移)/g)?.join(" ") || "";
  if (!preliminary || (stageMention && !factsText.includes(stageMention))) preliminary = defaultReferenceDiagnosis(factsText);
  const suggestedWorkup = pathItems(value.suggested_workup);
  const treatmentPathways = pathItems(value.treatment_pathways);
  if (suggestedWorkup.length < 2 || treatmentPathways.length < 2) throw new Error("模型没有生成足够完整的条件性参考路径");
  return {
    preliminary_diagnosis: preliminary,
    diagnostic_basis: strings(value.diagnostic_basis),
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
