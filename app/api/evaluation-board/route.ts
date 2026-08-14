import { calculateArmScore, evaluationDimensions, winnerLabel, type BoardDecision, type BoardRoleId, type BoardRoleReview, type EvaluationArm } from "../../../lib/evaluation-lab";
import { containsSensitiveIdentifier, parseModelJson, requestModel } from "../../../lib/model-api";

type IncomingArm = Partial<EvaluationArm>;
type IncomingBody = {
  case_label?: unknown;
  track?: unknown;
  arm_a?: IncomingArm;
  arm_b?: IncomingArm;
};

const roleDefinitions: Array<{ id: BoardRoleId; label: string; mandate: string }> = [
  {
    id: "product",
    label: "产品经理",
    mandate: "判断结果是否解决医生的真实工作问题；优先识别最影响首印象、继续使用意愿和编辑负担的一个产品问题。",
  },
  {
    id: "engineering",
    label: "技术负责人",
    mandate: "从模型调用拆分、提示词、门禁、超时、重试和可观测性分析根因；不要把所有质量问题笼统归因于模型。",
  },
  {
    id: "clinical_quality",
    label: "临床质量负责人",
    mandate: "只审查记录忠实度、时间线、本次与既往分离、无依据断言和安全风险；不替具体患者作诊疗决定。",
  },
  {
    id: "evaluation",
    label: "测评负责人",
    mandate: "审查盲法、金标准、评分一致性、样本量和可复现性；阻止把两个病例的试评得分宣传成临床准确率。",
  },
];

const numberInRange = (value: unknown, minimum = 0, maximum = 9999) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : minimum;
};

const boundedText = (value: unknown, maximum: number) => typeof value === "string" ? value.trim().slice(0, maximum) : "";

const cleanArm = (value: IncomingArm | undefined): EvaluationArm => {
  const rawScores = value?.scores && typeof value.scores === "object" ? value.scores : {};
  return {
    output: "",
    scores: Object.fromEntries(evaluationDimensions.map((item) => [item.id, numberInRange((rawScores as Record<string, unknown>)[item.id], 0, 4)])) as EvaluationArm["scores"],
    p0Count: numberInRange(value?.p0Count, 0, 99),
    p1Count: numberInRange(value?.p1Count, 0, 99),
    latencySeconds: numberInRange(value?.latencySeconds, 0, 3600),
    retryCount: numberInRange(value?.retryCount, 0, 20),
    reviewerNote: boundedText(value?.reviewerNote, 1200),
  };
};

const stringList = (value: unknown, maximumItems: number, maximumLength: number) => Array.isArray(value)
  ? value.map((item) => boundedText(item, maximumLength)).filter(Boolean).slice(0, maximumItems)
  : [];

const parseRoleReview = (value: unknown, role: { id: BoardRoleId; label: string }): BoardRoleReview => {
  if (!value || typeof value !== "object") throw new Error(`${role.label}没有返回结构化意见`);
  const candidate = value as Record<string, unknown>;
  const headline = boundedText(candidate.headline, 180);
  const evidence = stringList(candidate.evidence, 4, 260);
  const recommendation = boundedText(candidate.recommendation, 420);
  const concern = boundedText(candidate.concern, 300);
  if (!headline || evidence.length < 2 || !recommendation || !concern) throw new Error(`${role.label}意见不完整`);
  return { role: role.id, roleLabel: role.label, headline, evidence, recommendation, concern };
};

const parseExecutive = (value: unknown): BoardDecision => {
  if (!value || typeof value !== "object") throw new Error("负责人没有返回结构化决策");
  const candidate = value as Record<string, unknown>;
  const decision = boundedText(candidate.decision, 300);
  const rationale = stringList(candidate.rationale, 5, 320);
  const disagreements = stringList(candidate.disagreements, 5, 320);
  const nextSprint = stringList(candidate.next_sprint, 5, 320);
  const stopConditions = stringList(candidate.stop_conditions, 4, 320);
  if (!decision || rationale.length < 2 || nextSprint.length < 2 || stopConditions.length < 1) throw new Error("负责人决策不完整");
  return { decision, rationale, disagreements, nextSprint, stopConditions };
};

export async function POST(request: Request) {
  const startedAt = Date.now();
  try {
    const body = await request.json() as IncomingBody;
    const caseLabel = boundedText(body.case_label, 80) || "未命名试评";
    const track = body.track === "end_to_end" ? "端到端资料处理" : "统一事件账本后的生成质量";
    const armA = cleanArm(body.arm_a);
    const armB = cleanArm(body.arm_b);
    if (containsSensitiveIdentifier(JSON.stringify({ caseLabel, armA, armB }))) {
      return Response.json({ error: "评审摘要中检测到疑似身份号码，请只提交评分和去标识化问题摘要。" }, { status: 400 });
    }

    const apiKey = process.env.ARK_CODING_API_KEY;
    if (!apiKey) return Response.json({ error: "内部评审模型尚未配置。" }, { status: 503 });
    const baseUrl = (process.env.ARK_CODING_BASE_URL || "https://ark.cn-beijing.volces.com/api/coding/v3").replace(/\/$/, "");
    const model = process.env.ARK_REFERENCE_MODEL || process.env.ARK_CODING_MODEL || "deepseek-v4-pro";
    const scoreA = calculateArmScore(armA);
    const scoreB = calculateArmScore(armB);
    const summary = {
      case_label: caseLabel,
      track,
      blinded_winner: winnerLabel(scoreA, scoreB),
      arm_a: { score: scoreA.score, hard_fail: scoreA.hardFail, p0: armA.p0Count, p1: armA.p1Count, latency_seconds: armA.latencySeconds, retries: armA.retryCount, reviewer_note: armA.reviewerNote, dimensions: scoreA.dimensionScores.map(({ id, label, value, weight }) => ({ id, label, value, weight })) },
      arm_b: { score: scoreB.score, hard_fail: scoreB.hardFail, p0: armB.p0Count, p1: armB.p1Count, latency_seconds: armB.latencySeconds, retries: armB.retryCount, reviewer_note: armB.reviewerNote, dimensions: scoreB.dimensionScores.map(({ id, label, value, weight }) => ({ id, label, value, weight })) },
    };

    const reviews = await Promise.all(roleDefinitions.map(async (role) => {
      const prompt = [
        `你是OncoPilot内部产品评审会的${role.label}。`,
        role.mandate,
        "这是同一高能力模型在隔离上下文中的多视角审阅，不是真实多人专家共识。只能使用下面的盲评汇总；看不到病例原文，也不得猜测A/B对应哪个产品。",
        "给出一个主判断，引用至少两条具体数字或评分差异作为证据，只推荐一个本轮优先动作，并指出一个可能误导结论的风险。不要提出患者个体诊疗建议。",
        "只返回JSON：{\"headline\":\"\",\"evidence\":[\"\",\"\"],\"recommendation\":\"\",\"concern\":\"\"}",
        `盲评汇总：${JSON.stringify(summary)}`,
      ].join("\n\n");
      const raw = await requestModel(baseUrl, apiKey, model, prompt, { maxOutputTokens: 1800, timeoutMs: 120000, thinking: "disabled", jsonObject: true });
      return parseRoleReview(parseModelJson(raw), role);
    }));

    const executivePrompt = [
      "你是OncoPilot内部评审会的执行负责人。四个角色已经独立审阅同一份盲评汇总。",
      "你的任务不是追求表面共识，而是明确：这一轮是否足以支持产品迭代、最优先改什么、哪些分歧尚未解决、下一轮如何验证、出现什么情况必须停止发布或扩大试用。",
      "两个病例或单次试评只能称为小样本试评，不能称临床准确率。若角色意见冲突，必须原样保留冲突；若证据不足，决策应是继续测评而非强行选边。",
      "只返回JSON：{\"decision\":\"\",\"rationale\":[\"\",\"\"],\"disagreements\":[\"\"],\"next_sprint\":[\"\",\"\"],\"stop_conditions\":[\"\"]}",
      `盲评汇总：${JSON.stringify(summary)}`,
      `独立角色意见：${JSON.stringify(reviews)}`,
    ].join("\n\n");
    const executiveRaw = await requestModel(baseUrl, apiKey, model, executivePrompt, { maxOutputTokens: 2400, timeoutMs: 120000, thinking: "disabled", jsonObject: true });
    const executive = parseExecutive(parseModelJson(executiveRaw));

    return Response.json({
      result: {
        reviews,
        executive,
        model,
        elapsedSeconds: Math.round((Date.now() - startedAt) / 100) / 10,
        sameModelReview: true,
      },
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const timeout = error instanceof Error && error.name === "TimeoutError";
    const message = error instanceof Error ? error.message : "内部评审会暂时失败。";
    return Response.json({ error: timeout ? "内部评审模型在2分钟内未完成，请保留当前评分后重试。" : message.includes("上游") ? "内部评审模型暂时不可用，请稍后重试。" : message }, { status: timeout ? 504 : 502, headers: { "Cache-Control": "no-store" } });
  }
}
