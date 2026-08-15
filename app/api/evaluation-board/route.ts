import { calculateArmScore, evaluationDimensions, winnerLabel, type BoardDecision, type BoardRoleId, type BoardRoleReview, type EvaluationArm } from "../../../lib/evaluation-lab";
import { containsSensitiveIdentifier, parseModelJson, requestModel } from "../../../lib/model-api";

type IncomingArm = Partial<EvaluationArm>;
type IncomingBody = {
  mode?: unknown;
  role_id?: unknown;
  reviews?: unknown;
  case_label?: unknown;
  track?: unknown;
  arm_a?: IncomingArm;
  arm_b?: IncomingArm;
};

const roleDefinitions: Array<{ id: BoardRoleId; label: string; mandate: string }> = [
  {
    id: "product",
    label: "产品经理小龙虾",
    mandate: "判断结果是否解决医生的真实工作问题；优先识别最影响首印象、继续使用意愿和编辑负担的一个产品问题。",
  },
  {
    id: "user_research",
    label: "市场与用户研究小龙虾",
    mandate: "从真实使用意愿、替代方案、信任建立和试用阻力判断医生为什么会继续用或放弃；不要用主观想象代替现有评分证据。",
  },
  {
    id: "engineering",
    label: "技术负责人小龙虾",
    mandate: "从模型调用拆分、提示词、门禁、超时、重试和可观测性分析根因；不要把所有质量问题笼统归因于模型。",
  },
  {
    id: "clinical_quality",
    label: "临床质量小龙虾",
    mandate: "只审查记录忠实度、时间线、本次与既往分离、无依据断言和安全风险；不替具体患者作诊疗决定。",
  },
  {
    id: "evaluation",
    label: "测评师小龙虾",
    mandate: "审查盲法、金标准、评分一致性、样本量和可复现性；阻止把少量病例的试评得分宣传成临床准确率。",
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
  return { role: role.id, roleLabel: role.label, headline, evidence, recommendation, concern, model: boundedText(candidate.model, 80) };
};

const parseExecutive = (value: unknown): BoardDecision => {
  if (!value || typeof value !== "object") throw new Error("CEO没有返回结构化决策");
  const candidate = value as Record<string, unknown>;
  const decision = boundedText(candidate.decision, 300);
  const rationale = stringList(candidate.rationale, 5, 320);
  const disagreements = stringList(candidate.disagreements, 5, 320);
  const nextSprint = stringList(candidate.next_sprint, 5, 320);
  const stopConditions = stringList(candidate.stop_conditions, 4, 320);
  if (!decision || rationale.length < 2 || nextSprint.length < 2 || stopConditions.length < 1) throw new Error("CEO决策不完整");
  return { decision, rationale, disagreements, nextSprint, stopConditions };
};

type MeetingSummary = {
  arm_a: { score: number; latency_seconds: number; p0: number };
  arm_b: { score: number; latency_seconds: number; p0: number };
};

type ModelRuntime = {
  apiKey: string;
  baseUrl: string;
  model: string;
  provider: "openai" | "ark";
};

const metricPattern = (arm: "A" | "B", value: number, unit: "分" | "秒") => {
  const escaped = String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:回答)?${arm}(?:组|臂|方案|版本)?[^。；，,\\n]{0,20}${escaped}\\s*${unit}`, "i");
};

const claimsPositiveP0 = (text: string) => {
  const withoutZeroStatements = text
    .replace(/(?:两组|两臂|A\s*\/\s*B)?\s*P0(?:错误)?(?:计数)?\s*(?:均|都)?\s*(?:为|是|=)\s*0/gi, "")
    .replace(/(?:无|没有|未见|未出现|未触发)\s*P0/gi, "");
  return /(?:P0|硬失败|致命错误|致命缺陷|触发.{0,6}P0)/i.test(withoutZeroStatements);
};

const validateRoleMetrics = (review: BoardRoleReview, summary: MeetingSummary) => {
  const text = `${review.headline}\n${review.evidence.join("\n")}\n${review.recommendation}\n${review.concern}`;
  const swappedScore = summary.arm_a.score !== summary.arm_b.score && (
    metricPattern("A", summary.arm_b.score, "分").test(text) || metricPattern("B", summary.arm_a.score, "分").test(text)
  );
  const swappedLatency = summary.arm_a.latency_seconds !== summary.arm_b.latency_seconds && (
    metricPattern("A", summary.arm_b.latency_seconds, "秒").test(text) || metricPattern("B", summary.arm_a.latency_seconds, "秒").test(text)
  );
  if (swappedScore || swappedLatency) throw new Error("角色意见把A/B的总分或耗时归属写反");
  if (summary.arm_a.p0 === 0 && summary.arm_b.p0 === 0 && claimsPositiveP0(text)) {
    throw new Error("本轮P0计数均为0，角色意见不得编造P0");
  }
};

const modelOptions = (runtime: ModelRuntime, maximum: number) => runtime.provider === "openai"
  ? { maxOutputTokens: maximum, timeoutMs: 120000, reasoningEffort: "medium" as const, store: false, jsonObject: true }
  : { maxOutputTokens: maximum, timeoutMs: 120000, thinking: "disabled" as const, jsonObject: true };

const buildMeetingContext = (body: IncomingBody) => {
  const caseLabel = boundedText(body.case_label, 80) || "未命名试评";
  const track = body.track === "end_to_end" ? "端到端资料处理" : "统一事件账本后的生成质量";
  const armA = cleanArm(body.arm_a);
  const armB = cleanArm(body.arm_b);
  if (containsSensitiveIdentifier(JSON.stringify({ caseLabel, armA, armB }))) {
    throw new Error("评审摘要中检测到疑似身份号码，请只提交评分和去标识化问题摘要。");
  }
  const scoreA = calculateArmScore(armA);
  const scoreB = calculateArmScore(armB);
  const summary = {
    case_label: caseLabel,
    track,
    blinded_winner: winnerLabel(scoreA, scoreB),
    arm_a: { score: scoreA.score, hard_fail: scoreA.hardFail, p0: armA.p0Count, p1: armA.p1Count, latency_seconds: armA.latencySeconds, retries: armA.retryCount, reviewer_note: armA.reviewerNote, dimensions: scoreA.dimensionScores.map(({ id, label, value, weight }) => ({ id, label, value, weight })) },
    arm_b: { score: scoreB.score, hard_fail: scoreB.hardFail, p0: armB.p0Count, p1: armB.p1Count, latency_seconds: armB.latencySeconds, retries: armB.retryCount, reviewer_note: armB.reviewerNote, dimensions: scoreB.dimensionScores.map(({ id, label, value, weight }) => ({ id, label, value, weight })) },
  };
  return { armA, armB, summary };
};

const generateRoleReview = async (runtime: ModelRuntime, summary: MeetingSummary, role: typeof roleDefinitions[number]) => {
  const prompt = [
    `你是OncoPilot内部产品评审会的${role.label}。`,
    role.mandate,
    "你只能使用下面的盲评汇总；看不到病例原文，也不得猜测A/B对应哪个产品。人工填写的P0计数是唯一P0依据，不得根据低分或评语自行升级为P0。",
    "给出一个主判断，引用至少两条具体数字或评分差异作为证据，只推荐一个本轮优先动作，并指出一个可能误导结论的风险。recommendation直接写动作内容，不要重复‘本轮优先动作’标签。不要提出患者个体诊疗建议。",
    "只返回JSON：{\"headline\":\"\",\"evidence\":[\"\",\"\"],\"recommendation\":\"\",\"concern\":\"\"}",
    `盲评汇总：${JSON.stringify(summary)}`,
  ].join("\n\n");
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const retry = attempt === 0 ? "" : `\n\n上一版把A/B数字归属写反或结构不完整，未通过门禁。权威数据为：A总分${summary.arm_a.score}分、耗时${summary.arm_a.latency_seconds}秒；B总分${summary.arm_b.score}分、耗时${summary.arm_b.latency_seconds}秒。请完整重写并逐项核对。`;
      const raw = await requestModel(runtime.baseUrl, runtime.apiKey, runtime.model, prompt + retry, modelOptions(runtime, 1800));
      const review = parseRoleReview(parseModelJson(raw), role);
      review.model = runtime.model;
      validateRoleMetrics(review, summary);
      return review;
    } catch (error) { lastError = error; }
  }
  throw lastError instanceof Error ? lastError : new Error(`${role.label}意见未通过数字归属门禁`);
};

const generateExecutive = async (runtime: ModelRuntime, summary: unknown, reviews: BoardRoleReview[], hasP0: boolean) => {
  const prompt = [
    "你是OncoPilot内部评审会的CEO。五个角色已经独立审阅同一份盲评汇总。",
    "你的任务不是追求表面共识，而是明确：这一轮是否足以支持产品迭代、最优先改什么、哪些分歧尚未解决、下一轮如何验证、出现什么情况必须停止发布或扩大试用。",
    "少量病例或单次试评只能称为小样本试评，不能称临床准确率。若角色意见冲突，必须原样保留冲突；若证据不足，决策应是继续测评而非强行选边。只要任一臂出现P0，第一优先级必须是停止扩大试用、复现并修复P0，不能把增加样本排在P0修复之前。",
    "所有字段必须使用简体中文自然语言，decision必须是一句医生和产品团队能直接读懂的中文结论，不得返回HOLD、GO、NO_GO等英文枚举码。只返回JSON：{\"decision\":\"\",\"rationale\":[\"\",\"\"],\"disagreements\":[\"\"],\"next_sprint\":[\"\",\"\"],\"stop_conditions\":[\"\"]}",
    `盲评汇总：${JSON.stringify(summary)}`,
    `独立角色意见：${JSON.stringify(reviews)}`,
  ].join("\n\n");
  let executive: BoardDecision | null = null;
  let executiveError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const retry = attempt === 0 ? "" : [
        "上一版未通过CEO质量门禁。请重新返回完整JSON，decision必须是简体中文自然语言，不能使用英文枚举码。",
        hasP0 ? "本轮存在P0，请在decision和next_sprint第一项中明确：停止扩大试用，先复现并修复P0；修复后才增加样本。" : "请按现有证据明确本轮优先级，不要编造P0。",
      ].join("\n");
      const raw = await requestModel(runtime.baseUrl, runtime.apiKey, runtime.model, prompt + retry, modelOptions(runtime, 2400));
      const candidate = parseExecutive(parseModelJson(raw));
      if (/^[A-Z0-9_ -]{3,}$/.test(candidate.decision)) throw new Error("CEO返回了机器枚举码而非中文结论");
      const priorityText = `${candidate.decision} ${candidate.nextSprint[0] || ""}`;
      if (hasP0 && !/(?:P0|硬失败|致命|停止.{0,12}(?:试用|发布|扩大)|修复.{0,12}P0)/i.test(priorityText)) throw new Error("CEO未把P0修复置于首位");
      if (!hasP0 && claimsPositiveP0([candidate.decision, ...candidate.rationale, ...candidate.disagreements, ...candidate.nextSprint, ...candidate.stopConditions].join(" "))) {
        throw new Error("本轮P0计数均为0，CEO不得编造P0");
      }
      executive = candidate;
      break;
    } catch (error) { executiveError = error; }
  }
  if (!executive) throw executiveError instanceof Error ? executiveError : new Error("CEO结论未通过质量门禁");
  return executive;
};

export async function POST(request: Request) {
  const startedAt = Date.now();
  try {
    const body = await request.json() as IncomingBody;
    const { armA, armB, summary } = buildMeetingContext(body);
    const arkKey = process.env.ARK_CODING_API_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;
    if (!arkKey || !openaiKey) return Response.json({ error: "多模型评审尚未完成配置。" }, { status: 503 });
    const arkRuntime: ModelRuntime = {
      apiKey: arkKey,
      baseUrl: (process.env.ARK_CODING_BASE_URL || "https://ark.cn-beijing.volces.com/api/coding/v3").replace(/\/$/, ""),
      model: process.env.ARK_REFERENCE_MODEL || process.env.ARK_CODING_MODEL || "deepseek-v4-pro",
      provider: "ark",
    };
    const openaiBoardRuntime: ModelRuntime = {
      apiKey: openaiKey,
      baseUrl: (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, ""),
      model: process.env.OPENAI_BOARD_MODEL || "gpt-5.4",
      provider: "openai",
    };
    const ceoRuntime: ModelRuntime = {
      ...openaiBoardRuntime,
      model: process.env.OPENAI_CEO_MODEL || process.env.OPENAI_EVAL_MODEL || "gpt-5.6-sol",
    };
    const runtimeForRole = (role: BoardRoleId) => role === "user_research" || role === "engineering" ? arkRuntime : openaiBoardRuntime;

    if (body.mode === "role") {
      const role = roleDefinitions.find((item) => item.id === body.role_id);
      if (!role) return Response.json({ error: "未知的公司会议角色。" }, { status: 400 });
      const runtime = runtimeForRole(role.id);
      const review = await generateRoleReview(runtime, summary, role);
      return Response.json({ result: { review, model: runtime.model, elapsedSeconds: Math.round((Date.now() - startedAt) / 100) / 10 } }, { headers: { "Cache-Control": "no-store" } });
    }

    if (body.mode === "executive") {
      const submitted = Array.isArray(body.reviews) ? body.reviews : [];
      const reviews = roleDefinitions.map((role) => {
        const candidate = submitted.find((item) => item && typeof item === "object" && (item as Record<string, unknown>).role === role.id);
        return parseRoleReview(candidate, role);
      });
      const executive = await generateExecutive(ceoRuntime, summary, reviews, armA.p0Count + armB.p0Count > 0);
      return Response.json({ result: { executive, model: ceoRuntime.model, elapsedSeconds: Math.round((Date.now() - startedAt) / 100) / 10 } }, { headers: { "Cache-Control": "no-store" } });
    }

    const reviews = await Promise.all(roleDefinitions.map((role) => generateRoleReview(runtimeForRole(role.id), summary, role)));
    const executive = await generateExecutive(ceoRuntime, summary, reviews, armA.p0Count + armB.p0Count > 0);
    return Response.json({ result: { reviews, executive, ceoModel: ceoRuntime.model, models: [...new Set(reviews.map((review) => review.model))], elapsedSeconds: Math.round((Date.now() - startedAt) / 100) / 10, mixedModelReview: true } }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const timeout = error instanceof Error && error.name === "TimeoutError";
    const message = error instanceof Error ? error.message : "内部评审会暂时失败。";
    const invalidInput = /身份号码|未知的公司会议角色/.test(message);
    return Response.json({ error: timeout ? "内部评审模型在2分钟内未完成，请保留当前评分后重试。" : message.includes("上游") ? "内部评审模型暂时不可用，请稍后重试。" : message }, { status: invalidInput ? 400 : timeout ? 504 : 502, headers: { "Cache-Control": "no-store" } });
  }
}
