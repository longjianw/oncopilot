import type { AdmissionDraft, FactExtraction } from "./admission-record-contract";

export type ReviewSection = "present_illness" | "past_history" | "personal_history" | "family_history" | "allergy_history" | "specialist_exam";
export type ReviewOption = {
  option_id: string;
  label: string;
  text: string;
  tone: "positive" | "negative" | "neutral";
  detail_prompt?: string;
};
export type GuidedReviewItem = {
  choice_id: string;
  group: "发病与确诊" | "症状核对" | "其他病史" | "专科查体";
  section: ReviewSection;
  prompt: string;
  help: string;
  options: ReviewOption[];
};

const option = (option_id: string, label: string, text: string, tone: ReviewOption["tone"] = "neutral", detail_prompt?: string): ReviewOption => ({ option_id, label, text, tone, ...(detail_prompt ? { detail_prompt } : {}) });

const melanomaItems: GuidedReviewItem[] = [
  {
    choice_id: "melanoma_discovery", group: "发病与确诊", section: "present_illness", prompt: "最初如何发现异常？", help: "选择后仍可补充时间、部位和病灶表现。",
    options: [
      option("self", "自行发现", "患者最初自行发现【原发部位待补充】异常病灶。", "neutral", "如：发现时间、具体部位、当时的大小/颜色/形态"),
      option("exam", "体检或他人发现", "患者于体检或由他人发现【原发部位待补充】异常病灶。", "neutral", "如：发现时间、发现者、具体部位及当时表现"),
      option("symptom", "因局部症状就诊", "患者因【破溃/出血/疼痛/瘙痒等具体症状待补充】就诊后发现异常病灶。", "positive", "如：具体症状、开始时间、变化经过及原发部位"),
      option("unknown", "原发灶不清", "黑色素瘤原发部位及最初发现经过尚不明确。"),
      option("unasked", "暂不选择", ""),
    ],
  },
  {
    choice_id: "melanoma_sampling", group: "发病与确诊", section: "present_illness", prompt: "通过什么方式取得病理？", help: "不能仅凭“做过免疫组化”猜取材方式。",
    options: [
      option("excision", "病灶切除", "后行原发病灶切除取材，病理结合免疫组化提示黑色素瘤，具体报告待补充。", "neutral", "如：取材日期、医院、原发部位及手术名称"),
      option("biopsy", "局部活检", "后行局部病灶活检，病理结合免疫组化提示黑色素瘤，具体报告待补充。", "neutral", "如：活检日期、医院、具体取材部位及方式"),
      option("node", "淋巴结/其他部位取材", "后行【淋巴结或其他取材部位待补充】取材，病理结合免疫组化提示黑色素瘤，具体报告待补充。", "neutral", "如：取材日期、具体淋巴结区域/其他部位及取材方式"),
      option("unknown", "方式不清", "病理取材部位及方式尚待核对。"),
      option("unasked", "暂不选择", ""),
    ],
  },
  {
    choice_id: "melanoma_pathology_detail", group: "发病与确诊", section: "present_illness", prompt: "病理关键结果是否齐全？", help: "皮肤型还需核对厚度、溃疡等；其他亚型按原报告。",
    options: [
      option("complete", "已有完整报告", "病理类型及免疫组化关键结果已核对，具体内容见原报告。", "neutral", "可摘录：病理类型、厚度/溃疡/切缘及免疫组化关键结果"),
      option("partial", "只有部分结果", "目前仅掌握部分病理或免疫组化结果，完整报告尚待核对。", "neutral", "请写明：目前已有结果，以及仍缺少的报告或关键项目"),
      option("none", "报告未带来", "本次未提供完整病理及免疫组化报告。"),
      option("unasked", "暂不选择", ""),
    ],
  },
  {
    choice_id: "melanoma_staging", group: "发病与确诊", section: "present_illness", prompt: "确诊后是否做过区域或全身评估？", help: "只记录是否做过及报告内容，不自动判断分期。",
    options: [
      option("systemic", "已做全身影像", "确诊后已完善全身影像评估，检查日期、项目及结果待按原报告补充。", "neutral", "如：检查日期、检查名称、范围及报告原文结论"),
      option("regional", "仅做局部/区域评估", "确诊后已完成局部或区域淋巴结相关评估，具体项目及结果待补充。", "neutral", "如：检查日期、区域/部位、检查名称及报告原文结论"),
      option("not_done", "尚未完成", "确诊后尚未完成区域淋巴结及全身评估。"),
      option("unknown", "不清楚", "确诊后是否完成区域淋巴结及全身评估尚待核对。"),
      option("unasked", "暂不选择", ""),
    ],
  },
  {
    choice_id: "melanoma_prior_treatment", group: "发病与确诊", section: "present_illness", prompt: "确诊后是否已经处理过？", help: "这里只整理已经发生的处理，不生成治疗建议。",
    options: [
      option("surgery", "已手术", "确诊后已接受手术处理，手术日期、方式及术后病理待补充。", "neutral", "如：手术日期、医院、手术名称及术后病理"),
      option("other", "已接受其他治疗", "确诊后已接受抗肿瘤治疗，具体方案、日期及疗效待补充。", "neutral", "如：治疗名称、起止日期、疗程及已明确疗效"),
      option("none", "尚未治疗", "确诊后尚未接受抗肿瘤治疗。"),
      option("unknown", "不清楚", "确诊后的既往处理经过尚待核对。"),
      option("unasked", "暂不选择", ""),
    ],
  },
  {
    choice_id: "melanoma_local_symptoms", group: "症状核对", section: "present_illness", prompt: "原发灶或周围皮肤近期有变化吗？", help: "增大、颜色或形态变化、瘙痒、破溃、出血、疼痛。",
    options: [
      option("yes", "有变化", "近期原发灶或周围皮肤存在【增大/颜色或形态变化/瘙痒/破溃/出血/疼痛，具体待补充】。", "positive", "如：哪种变化、开始时间、部位、范围及变化趋势"),
      option("no", "均无", "近期原发灶及周围皮肤无明显增大、颜色或形态变化，无瘙痒、破溃、出血及疼痛。", "negative"),
      option("removed", "病灶已切除", "原发病灶已切除，近期术区变化待结合实际情况补充。", "neutral", "如：术区部位、愈合情况及近期新出现的变化"),
      option("unasked", "未问", ""),
    ],
  },
  {
    choice_id: "melanoma_nodes", group: "症状核对", section: "present_illness", prompt: "区域淋巴结有肿大或不适吗？", help: "根据原发部位核对相应引流区。",
    options: [
      option("yes", "有", "近期发现区域淋巴结肿大或不适，具体部位、大小及变化待补充。", "positive", "如：具体区域和侧别、发现时间、大小、疼痛及变化趋势"),
      option("no", "无", "近期未发现明显区域淋巴结肿大或不适。", "negative"),
      option("unasked", "未问", ""),
    ],
  },
  {
    choice_id: "melanoma_neurologic", group: "症状核对", section: "present_illness", prompt: "有头晕、头痛或其他神经系统症状吗？", help: "阳性时需在草稿中补充具体表现和时间。",
    options: [
      option("yes", "有", "近期有头晕、头痛或其他神经系统相关症状，具体表现、持续时间及伴随症状待补充。", "positive", "如：具体症状、起始时间、频率/持续时间、程度及伴随表现"),
      option("no", "无", "近期无头晕、头痛、肢体无力、感觉异常及抽搐。", "negative"),
      option("unasked", "未问", ""),
    ],
  },
  {
    choice_id: "melanoma_respiratory", group: "症状核对", section: "present_illness", prompt: "有持续咳嗽、胸痛或气促吗？", help: "候选症状不等同于存在肺部转移。",
    options: [
      option("yes", "有", "近期有持续咳嗽、胸痛或气促等呼吸系统症状，具体待补充。", "positive", "如：具体症状、起始时间、诱因、程度及变化趋势"),
      option("no", "无", "近期无持续咳嗽、胸痛及气促。", "negative"),
      option("unasked", "未问", ""),
    ],
  },
  {
    choice_id: "melanoma_general_gi", group: "症状核对", section: "present_illness", prompt: "食欲、体重或消化道症状有变化吗？", help: "包括恶心、呕吐、腹部不适等。",
    options: [
      option("yes", "有", "近期有食欲或体重变化，或伴恶心、呕吐、腹部不适等症状，具体待补充。", "positive", "如：具体症状、起始时间、体重变化数值、频率及程度"),
      option("no", "无", "近期食欲尚可，体重无明显下降，无恶心、呕吐及明显腹部不适。", "negative"),
      option("unasked", "未问", ""),
    ],
  },
  {
    choice_id: "melanoma_bone", group: "症状核对", section: "present_illness", prompt: "有持续骨痛或活动受限吗？", help: "阳性症状仍需结合检查，不能据此判断骨转移。",
    options: [
      option("yes", "有", "近期有持续骨痛或活动受限，具体部位、程度及时间待补充。", "positive", "如：疼痛部位、起始时间、NRS评分、诱因及活动影响"),
      option("no", "无", "近期无持续骨痛及明显活动受限。", "negative"),
      option("unasked", "未问", ""),
    ],
  },
  {
    choice_id: "past_conditions", group: "其他病史", section: "past_history", prompt: "有重要慢性病或传染病史吗？", help: "点击“均否认”前应完成实际询问。",
    options: [
      option("yes", "有", "既往有【疾病名称、确诊时间、当前用药及控制情况待补充】。", "positive", "如：高血压/糖尿病/冠心病等，确诊时间、控制情况、药名及剂量"),
      option("no", "均否认", "否认高血压、糖尿病、冠心病、病毒性肝炎、结核病等重要既往病史。", "negative"),
      option("unasked", "未问", ""),
    ],
  },
  {
    choice_id: "past_surgery_transfusion", group: "其他病史", section: "past_history", prompt: "既往手术或输血情况？", help: "本次肿瘤相关手术应同时保留在现病史时间线。",
    options: [
      option("yes", "有", "既往有【手术/外伤/输血经过待补充】。", "positive", "如：类型、日期、原因、医院及输血反应"),
      option("no", "均无", "否认其他重大手术、外伤及输血史。", "negative"),
      option("unasked", "未问", ""),
    ],
  },
  {
    choice_id: "personal_tobacco_alcohol", group: "其他病史", section: "personal_history", prompt: "吸烟、饮酒及长期暴露情况？", help: "按本院模板补充数量和年限。",
    options: [
      option("yes", "有", "有【吸烟/饮酒/职业或长期暴露情况待补充】。", "positive", "如：种类、每日量、持续年限、戒除时间或暴露类型"),
      option("no", "均无", "无吸烟及饮酒史，否认明确职业或长期有害暴露。", "negative"),
      option("unasked", "未问", ""),
    ],
  },
  {
    choice_id: "family_tumor", group: "其他病史", section: "family_history", prompt: "有肿瘤或遗传相关疾病家族史吗？", help: "阳性时补充亲属关系和疾病名称。",
    options: [
      option("yes", "有", "家族中有【亲属关系及肿瘤或遗传相关疾病待补充】。", "positive", "如：亲属关系、疾病名称及确诊年龄"),
      option("no", "无", "否认肿瘤及遗传相关疾病家族史。", "negative"),
      option("unasked", "未问", ""),
    ],
  },
  {
    choice_id: "allergy_status", group: "其他病史", section: "allergy_history", prompt: "药物、食物或其他过敏史？", help: "阳性时补充过敏原和反应。",
    options: [
      option("yes", "有", "有【过敏原及具体反应待补充】。", "positive", "如：药物/食物名称、具体反应、发生时间及严重程度"),
      option("no", "无", "否认明确药物、食物及其他过敏史。", "negative"),
      option("unasked", "未问", ""),
    ],
  },
  {
    choice_id: "melanoma_exam_primary", group: "专科查体", section: "specialist_exam", prompt: "原发灶、术区和周围皮肤实际查体？", help: "必须完成查体后选择；异常项需编辑具体部位和大小。",
    options: [
      option("abnormal", "有异常", "原发灶或术区可见【部位、大小、颜色、形态、边界、破溃/出血等所见待补充】。", "positive", "实际查体：部位、大小、颜色、形态、边界及有无破溃/出血"),
      option("normal", "未见明显异常", "原发灶或术区及周围皮肤未见明显新发异常病灶、破溃或出血。", "negative"),
      option("not_examined", "未查", ""),
    ],
  },
  {
    choice_id: "melanoma_exam_nodes", group: "专科查体", section: "specialist_exam", prompt: "区域淋巴结实际查体？", help: "根据原发部位选择相应引流区。",
    options: [
      option("abnormal", "触及异常", "区域淋巴结查体触及异常，具体部位、数量、大小、质地、活动度及压痛待补充。", "positive", "实际触诊：区域和侧别、数量、大小、质地、活动度及压痛"),
      option("normal", "未触及肿大", "相关区域淋巴结未触及明显肿大。", "negative"),
      option("not_examined", "未查", ""),
    ],
  },
  {
    choice_id: "oncology_performance_status", group: "专科查体", section: "specialist_exam", prompt: "ECOG PS体能状态是否实际评估？", help: "按实际活动能力评分；未评估不能填写分值。",
    options: [
      option("assessed", "已评估", "ECOG PS评分【具体分值待补充】分。", "neutral", "填写实际评估分值0至4，并简要记录活动能力依据"),
      option("not_assessed", "未评估", ""),
    ],
  },
  {
    choice_id: "oncology_pain_score", group: "专科查体", section: "specialist_exam", prompt: "存在疼痛时是否完成NRS评分？", help: "仅在患者存在疼痛且已实际评估时填写。",
    options: [
      option("assessed", "已评估", "疼痛NRS评分【具体分值待补充】分。", "neutral", "填写实际NRS分值0至10，并补充疼痛部位和评估时间"),
      option("no_pain", "已确认无疼痛", "患者目前无疼痛主诉。", "negative"),
      option("not_assessed", "未评估", ""),
    ],
  },
];

const genericItems: GuidedReviewItem[] = melanomaItems.filter((item) => [
  "past_conditions", "past_surgery_transfusion", "personal_tobacco_alcohol", "family_tumor", "allergy_status", "oncology_performance_status", "oncology_pain_score",
].includes(item.choice_id));

const addScaffold = (value: string, scaffold: string) => value.includes(scaffold) ? value : [value.trim(), scaffold].filter(Boolean).join(" ");

export function buildGuidedDraft(extraction: FactExtraction, evidenceDraft: AdmissionDraft) {
  const evidenceText = [extraction.current_purpose, ...extraction.facts.map((fact) => fact.value)].filter(Boolean).join(" ");
  const melanoma = /黑色素瘤|melanoma/i.test(evidenceText);
  const hasType = (type: string) => extraction.facts.some((fact) => fact.event_type === type);
  const hasCurrentType = (type: string) => extraction.facts.some((fact) => fact.event_type === type && fact.encounter_scope === "current");
  const lowInformation = extraction.facts.length <= 8 && evidenceDraft.present_illness.trim().length < 120;
  let presentIllness = evidenceDraft.present_illness;

  if (lowInformation && melanoma) {
    presentIllness = addScaffold(presentIllness, "患者于【首次发现时间】因【发现方式】发现【原发部位及病灶表现】，后于【检查日期及机构】行【取材方式】，病理及免疫组化具体结果、区域淋巴结与全身评估、既往处理经过待通过下方选项补全。近期局部及全身症状待逐项选择。");
  } else if (lowInformation) {
    presentIllness = addScaffold(presentIllness, "患者于【首次发病或发现时间】因【症状或发现方式】就诊，于【日期及机构】经【检查或取材方式】明确相关诊断；关键检查、既往治疗、本次情况及近期症状待通过下方选项补全。");
  }

  const nonExamNodeEvidence = extraction.facts.some((fact) => fact.event_type !== "specialist_exam" && /淋巴结.{0,8}(肿大|异常)|肿大.{0,8}淋巴结/.test(fact.value));
  const reviewItems = melanoma ? melanomaItems.map((item) => item.choice_id === "melanoma_exam_nodes" && nonExamNodeEvidence
    ? { ...item, help: "资料中的影像/病史提示淋巴结异常；此处仍须记录实际触诊，不能把影像写成查体。" }
    : item) : genericItems;

  const draft: AdmissionDraft = {
    ...evidenceDraft,
    present_illness: presentIllness,
    past_history: hasType("past_history") ? evidenceDraft.past_history : "【待选择：既往疾病、手术史及输血史】",
    personal_history: hasType("personal_history") ? evidenceDraft.personal_history : "【待选择：吸烟、饮酒、职业或长期暴露】",
    family_history: hasType("family_history") ? evidenceDraft.family_history : "【待选择：肿瘤及遗传相关疾病家族史】",
    allergy_history: hasType("allergy_history") ? evidenceDraft.allergy_history : "【待选择：药物、食物及其他过敏史】",
    specialist_exam: hasCurrentType("specialist_exam") ? evidenceDraft.specialist_exam : melanoma
      ? "【待查体，以下按实际所见填写】\nECOG PS评分【】分；存在疼痛时NRS评分【】分。\n【原发灶/术区具体部位】可见【色泽及形态】病灶/瘢痕，大小约【】cm×【】cm，边界【清晰/欠清】，表面【有/无】破溃、渗液或出血，与周围组织【有/无】粘连，周围皮肤【实际所见】。\n双侧颈部、腋窝及腹股沟浅表淋巴结【未触及明显肿大/于具体区域触及】；如有异常，记录侧别、数量、大小、质地、活动度及压痛。"
      : "【待查体：与当前肿瘤相关的原发部位、术区及区域淋巴结、ECOG PS；存在疼痛时评估NRS】",
  };

  return {
    draft,
    review_items: reviewItems,
    template_mode: lowInformation || [draft.past_history, draft.personal_history, draft.family_history, draft.allergy_history, draft.specialist_exam].some((value) => value.includes("【")),
    template_name: melanoma ? "黑色素瘤入院病史候选模板" : "肿瘤入院病史通用候选模板",
  };
}
