import { containsSensitiveIdentifier, requestModel } from "../../../lib/model-api";
import { ClinicalReferenceBundle, localReferenceChecks, parseClinicalReference, webReferenceChecks } from "../../../lib/clinical-reference";

type Fact = { field?: unknown; value?: unknown; event_time?: unknown; event_type?: unknown; encounter_scope?: unknown; certainty?: unknown; source_ids?: unknown };

const validFacts = (value: unknown): Fact[] => {
  if (!Array.isArray(value)) return [];
  const facts: Fact[] = [];
  let totalCharacters = 0;
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const fact = item as Fact;
    const field = typeof fact.field === "string" ? fact.field.slice(0, 80) : "";
    const factValue = typeof fact.value === "string" ? fact.value.trim() : "";
    if (!factValue || factValue.length > 800 || field === "unparsed_source_segment") continue;
    if (facts.length >= 60 || totalCharacters + factValue.length > 24_000) break;
    totalCharacters += factValue.length;
    facts.push({
      field,
      value: factValue,
      event_time: typeof fact.event_time === "string" ? fact.event_time.slice(0, 80) : "",
      event_type: typeof fact.event_type === "string" ? fact.event_type.slice(0, 80) : "other",
      encounter_scope: typeof fact.encounter_scope === "string" ? fact.encounter_scope.slice(0, 20) : "unclear",
      certainty: typeof fact.certainty === "string" ? fact.certainty.slice(0, 24) : "pending",
      source_ids: Array.isArray(fact.source_ids) ? fact.source_ids.filter((source): source is string => typeof source === "string").slice(0, 8) : [],
    });
  }
  return facts;
};
const stripHtml = (value: string) => value
  .replace(/<script[\s\S]*?<\/script>/gi, " ")
  .replace(/<style[\s\S]*?<\/style>/gi, " ")
  .replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;|&#160;/gi, " ")
  .replace(/&amp;/gi, "&")
  .replace(/\s+/g, " ");

export async function POST(request: Request) {
  try {
    const body = await request.json() as { action?: unknown; facts?: unknown; current_purpose?: unknown; reference?: unknown };
    const action = body.action === "local" || body.action === "web" ? body.action : "generate";
    const facts = validFacts(body.facts);
    const currentPurpose = typeof body.current_purpose === "string" ? body.current_purpose.slice(0, 240) : "";
    if (!facts.length) return Response.json({ error: "缺少可追溯事实，暂时不能生成诊疗参考。" }, { status: 400 });
    if (containsSensitiveIdentifier(JSON.stringify({ facts, currentPurpose }))) return Response.json({ error: "检测到疑似身份证号或手机号，请脱敏后再生成。" }, { status: 400 });

    if (action === "local") {
      const reference = body.reference as ClinicalReferenceBundle;
      if (!reference || typeof reference !== "object") return Response.json({ error: "请先生成AI参考候选。" }, { status: 400 });
      return Response.json({ result: { ...reference, verification_state: "local_checked", checks: localReferenceChecks(reference), disclaimer: "已用本地来源卡交叉核对；支持仅代表候选方向可在来源中找到，仍需判断患者适用条件并由上级医师确认。" } });
    }

    if (action === "web") {
      const reference = body.reference as ClinicalReferenceBundle;
      if (!reference || typeof reference !== "object") return Response.json({ error: "请先生成AI参考候选。" }, { status: 400 });
      if (!/黑色素瘤|melanoma/i.test(JSON.stringify(reference))) {
        return Response.json({ error: "当前联网权威来源只完成黑色素瘤接入；本病例不使用不匹配的病种页面进行伪核验。" }, { status: 400 });
      }
      const nciUrl = "https://www.cancer.gov/types/skin/hp/melanoma-treatment-pdq";
      const nhcUrl = "https://www.nhc.gov.cn/yzygj/c100068/202204/0c1f7d3aca0545abbeb02030ce255930.shtml";
      const [nciResult, nhcResult] = await Promise.allSettled([
        fetch(nciUrl, { headers: { "User-Agent": "OncoPilot-reference-check/0.1" }, signal: AbortSignal.timeout(10000) }),
        fetch(nhcUrl, { headers: { "User-Agent": "OncoPilot-reference-check/0.1" }, signal: AbortSignal.timeout(6000) }),
      ]);
      const nci = nciResult.status === "fulfilled" && nciResult.value.ok ? nciResult.value : null;
      const nhc = nhcResult.status === "fulfilled" && nhcResult.value.ok ? nhcResult.value : null;
      if (!nci && !nhc) return Response.json({ error: "权威网页本次均未能读取，请稍后重试。" }, { status: 502 });
      const availableSources: string[] = [];
      let nciText = "";
      let nhcText = "";
      if (nci) {
        nciText = stripHtml(await nci.text());
        availableSources.push(`NCI Melanoma Treatment PDQ ${nciUrl}`);
      }
      if (nhc) {
        nhcText = stripHtml(await nhc.text());
        availableSources.push(`国家卫健委黑色素瘤诊疗指南发布页 ${nhcUrl}`);
      }
      const checks = webReferenceChecks(reference, { nciText, nhcText, nciUrl, nhcUrl });
      return Response.json({ result: { ...reference, verification_state: "web_checked", checks, disclaimer: `本次已读取${availableSources.map((source) => source.split(" http")[0]).join("、")}进行交叉核对；未成功读取的来源不计入核验。网页支持不等于患者适用，最终诊断和医嘱仍由医生结合完整资料确认。` } });
    }

    const apiKey = process.env.ARK_CODING_API_KEY;
    if (!apiKey) return Response.json({ error: "模型服务尚未配置。" }, { status: 503 });
    const baseUrl = (process.env.ARK_CODING_BASE_URL || "https://ark.cn-beijing.volces.com/api/coding/v3").replace(/\/$/, "");
    const model = process.env.ARK_REFERENCE_MODEL || process.env.ARK_CODING_MODEL || "deepseek-v4-pro";

    const prompt = [
      "你是OncoPilot的肿瘤入院诊疗准备助手。请根据本病例结构化事实生成病例专属的初步诊断表达、诊断依据、需要补齐的关键前提、候选检查及其目的，以及分层诊疗讨论方向。不能输出跨病种通用套话来冒充病例分析。",
      "当前是入院记录场景，不是出院记录。输出只使用‘初步诊断’，不得生成‘出院诊断’；既往出院记录中的诊断只能作为既往证据。初步诊断需区分明确诊断、待排诊断、分期和并发症；鉴别诊断只围绕当前确有疑问的问题，不机械罗列。",
      "这不是最终诊疗决定。只能使用已提供的结构化事实，不得编造原发部位、分期、转移、基因状态或治疗反应；不得给药物剂量、频次、直接可执行处方或出院去向。每个检查和治疗方向必须写trigger（什么条件下考虑）与purpose（为了解决什么问题）。",
      "诊断及诊断依据必须沿用资料原词：资料只写‘全身治疗’时不得改写为‘化疗’，只写结节或复发时不得自行升级为转移或某一具体分期。缺少当前数值或原始报告时，相关并发问题使用‘考虑/待排/待明确’，不能写成已经达到某诊断标准。",
      "单次检验或单个时间点只能写该次结果，不能扩写成‘持续、进行性、反复、未恢复或较前恶化’；只有结构化事实明确提供纵向变化时才能使用这些表述。",
      "资料较少时也不能只说资料不足：应结合已经明确的肿瘤类型、既往治疗和当前突出问题，生成有病例针对性的补充前提和条件性讨论；不能把某一瘤种的固定字段套到其他病种。PET-CT、分子检测等只能作为有条件候选，不能写成人人必须。",
      "控制篇幅：诊断依据2至4条、鉴别诊断0至3条、关键前提3至6条、候选检查3至5项、诊疗方向2至4项；每项只保留一个明确问题，不重复展开。",
      "只返回完整JSON：{\"preliminary_diagnosis\":\"\",\"diagnostic_basis\":[\"\"],\"differential_diagnosis\":[\"\"],\"missing_prerequisites\":[\"\"],\"suggested_workup\":[{\"title\":\"\",\"trigger\":\"\",\"purpose\":\"\"}],\"treatment_pathways\":[{\"title\":\"\",\"trigger\":\"\",\"purpose\":\"\"}]}。不得在JSON结束前截断。",
      `本次来院目的：${currentPurpose || "未提供"}`,
      `结构化事实：${JSON.stringify(facts)}`,
    ].join("\n\n");
    try {
      const result = parseClinicalReference(
        await requestModel(baseUrl, apiKey, model, prompt, { maxOutputTokens: 5200, timeoutMs: 120000, thinking: "disabled", jsonObject: true }),
        JSON.stringify({ facts, currentPurpose }),
      );
      return Response.json({ result, model }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      const timeout = error instanceof Error && error.name === "TimeoutError";
      return Response.json({
        error: timeout
          ? "V4 Pro在2分钟内没有完成病例专属参考；未用通用内置候选替代，请保留当前资料后重试。"
          : "V4 Pro本次没有生成通过质量校验的病例专属参考；未展示通用套话，请重试。",
      }, { status: timeout ? 504 : 502, headers: { "Cache-Control": "no-store" } });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "诊疗参考暂时生成失败。";
    return Response.json({ error: message.includes("上游") ? "诊疗参考模型暂时不可用，请稍后重试。" : message }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
