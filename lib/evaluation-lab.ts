export type EvaluationDimensionId =
  | "event_coverage"
  | "chronology"
  | "encounter_separation"
  | "unsupported_claims"
  | "uncertainty_preservation"
  | "section_placement"
  | "diagnosis_evidence"
  | "priority_quality"
  | "actionability"
  | "edit_cost";

export type EvaluationDimension = {
  id: EvaluationDimensionId;
  label: string;
  shortLabel: string;
  weight: number;
  guide: string;
};
export type EvaluationArm = {
  output: string;
  scores: Record<EvaluationDimensionId, number>;
  p0Count: number;
  p1Count: number;
  latencySeconds: number;
  retryCount: number;
  reviewerNote: string;
};

export type EvaluationSession = {
  caseLabel: string;
  track: "end_to_end" | "generation_only";
  evaluator: string;
  goldSummary: string;
  armA: EvaluationArm;
  armB: EvaluationArm;
};

export type ArmScore = {
  score: number;
  hardFail: boolean;
  weightedPoints: number;
  maximumPoints: number;
  dimensionScores: Array<EvaluationDimension & { value: number; weightedValue: number }>;
};

export const evaluationDimensions: EvaluationDimension[] = [
  { id: "event_coverage", label: "核心事件覆盖", shortLabel: "完整度", weight: 15, guide: "初诊、每线治疗、进展、近期变化和本次入院是否遗漏。" },
  { id: "chronology", label: "时间顺序与衔接", shortLabel: "时间线", weight: 10, guide: "事件先后、时间表达和因果衔接是否正确。" },
  { id: "encounter_separation", label: "本次与既往分离", shortLabel: "就诊归属", weight: 10, guide: "外院经过、既往记录和本次到院是否被错误合并。" },
  { id: "unsupported_claims", label: "无依据断言控制", shortLabel: "忠实度", weight: 15, guide: "是否新增原发部位、分期、转移、疗效、诊断或阴性史。" },
  { id: "uncertainty_preservation", label: "不确定性保留", shortLabel: "证据强度", weight: 10, guide: "待核对、考虑、可能和医生明确判断是否保持原强度。" },
  { id: "section_placement", label: "病历模块归位", shortLabel: "模块", weight: 10, guide: "现病史、既往史、查体、诊断与计划是否各归其位。" },
  { id: "diagnosis_evidence", label: "诊断与证据一致", shortLabel: "诊断", weight: 10, guide: "初步诊断顺序和依据是否服务本次问题且可追溯。" },
  { id: "priority_quality", label: "当前优先问题质量", shortLabel: "优先级", weight: 10, guide: "是否给出一个病例专属优先方向、理由和条件性分支。" },
  { id: "actionability", label: "临床可行动性", shortLabel: "可用性", weight: 5, guide: "是否指出真正改变下一步的缺口，而非堆砌常规项目。" },
  { id: "edit_cost", label: "修改后可用成本", shortLabel: "编辑成本", weight: 5, guide: "医生改到可用需要的删除、补写和重排工作量。" },
];

export const emptyScores = () => Object.fromEntries(evaluationDimensions.map((item) => [item.id, 2])) as Record<EvaluationDimensionId, number>;

export const emptyArm = (): EvaluationArm => ({
  output: "",
  scores: emptyScores(),
  p0Count: 0,
  p1Count: 0,
  latencySeconds: 0,
  retryCount: 0,
  reviewerNote: "",
});

export const emptyEvaluationSession = (): EvaluationSession => ({
  caseLabel: "合成试评病例 01",
  track: "generation_only",
  evaluator: "",
  goldSummary: "",
  armA: emptyArm(),
  armB: emptyArm(),
});

const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : minimum));

export const calculateArmScore = (arm: EvaluationArm): ArmScore => {
  const maximumPoints = evaluationDimensions.reduce((total, item) => total + item.weight * 4, 0);
  const dimensionScores = evaluationDimensions.map((item) => {
    const value = clamp(Number(arm.scores[item.id]), 0, 4);
    return { ...item, value, weightedValue: value * item.weight };
  });
  const weightedPoints = dimensionScores.reduce((total, item) => total + item.weightedValue, 0);
  const hardFail = clamp(Number(arm.p0Count), 0, 99) > 0;
  return {
    score: Math.round((weightedPoints / maximumPoints) * 1000) / 10,
    hardFail,
    weightedPoints,
    maximumPoints,
    dimensionScores,
  };
};

export const winnerLabel = (armA: ArmScore, armB: ArmScore) => {
  if (armA.hardFail !== armB.hardFail) return armA.hardFail ? "B" : "A";
  if (Math.abs(armA.score - armB.score) < 1) return "接近";
  return armA.score > armB.score ? "A" : "B";
};

export const scoreGuide = [
  "0 = 缺失或严重错误",
  "1 = 大量修改后勉强可用",
  "2 = 部分可用但有明显缺口",
  "3 = 基本可用，需少量修改",
  "4 = 证据充分且可直接进入医生复核",
];

export type BoardRoleId = "product" | "engineering" | "clinical_quality" | "evaluation";

export type BoardRoleReview = {
  role: BoardRoleId;
  roleLabel: string;
  headline: string;
  evidence: string[];
  recommendation: string;
  concern: string;
};

export type BoardDecision = {
  decision: string;
  rationale: string[];
  disagreements: string[];
  nextSprint: string[];
  stopConditions: string[];
};

export type EvaluationBoardResult = {
  reviews: BoardRoleReview[];
  executive: BoardDecision;
  model: string;
  elapsedSeconds: number;
  sameModelReview: true;
};
