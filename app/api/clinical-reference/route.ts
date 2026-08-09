import { containsSensitiveIdentifier, parseModelJson, requestModel } from "../../../lib/model-api";
import { ClinicalReferenceBundle, localReferenceChecks, parseClinicalReference, ReferenceCheck, starterClinicalReference } from "../../../lib/clinical-reference";

type Fact = { field?: unknown; value?: unknown; event_time?: unknown; event_type?: unknown; encounter_scope?: unknown; certainty?: unknown; source_ids?: unknown };

const validFacts = (value: unknown): Fact[] => Array.isArray(value) ? value.filter((fact) => fact && typeof fact === "object" && typeof (fact as Fact).value === "string").slice(0, 80) : [];
const stripHtml = (value: string) => value
  .replace(/<script[\s\S]*?<\/script>/gi, " ")
  .replace(/<style[\s\S]*?<\/style>/gi, " ")
  .replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;|&#160;/gi, " ")
  .replace(/&amp;/gi, "&")
  .replace(/\s+/g, " ");

const sourceWindow = (text: string, term: RegExp, radius = 6000) => {
  const index = text.search(term);
  return index < 0 ? text.slice(0, radius * 2) : text.slice(Math.max(0, index - radius), index + radius);
};

const parseChecks = (raw: string): ReferenceCheck[] => {
  const parsed = parseModelJson(raw) as { checks?: unknown };
  if (!Array.isArray(parsed.checks)) return [];
  return parsed.checks.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const check = item as Partial<ReferenceCheck>;
    if (typeof check.topic !== "string" || typeof check.note !== "string" || typeof check.source !== "string") return [];
    const status = check.status === "supported" || check.status === "conditional" || check.status === "not_found" ? check.status : "not_found";
    return [{ topic: check.topic.slice(0, 80), status, note: check.note.slice(0, 400), source: check.source.slice(0, 180), ...(typeof check.url === "string" ? { url: check.url.slice(0, 500) } : {}) }];
  }).slice(0, 8);
};

export async function POST(request: Request) {
  try {
    const body = await request.json() as { action?: unknown; facts?: unknown; current_purpose?: unknown; reference?: unknown };
    const action = body.action === "starter" || body.action === "local" || body.action === "web" ? body.action : "generate";
    const facts = validFacts(body.facts);
    const currentPurpose = typeof body.current_purpose === "string" ? body.current_purpose.slice(0, 240) : "";
    const factsText = facts.map((fact) => String(fact.value)).join("；");
    if (!facts.length) return Response.json({ error: "缺少可追溯事实，暂时不能生成诊疗参考。" }, { status: 400 });
    if (containsSensitiveIdentifier(JSON.stringify({ facts, currentPurpose }))) return Response.json({ error: "检测到疑似身份证号或手机号，请脱敏后再生成。" }, { status: 400 });
    const diagnosticFacts = facts.filter((fact) => /diagnosis|pathology/i.test(String(fact.field)) || /diagnosis|pathology|molecular/i.test(String(fact.event_type))).map((fact) => String(fact.value)).slice(0, 6);

    if (action === "starter") return Response.json({ result: starterClinicalReference(factsText, diagnosticFacts) });

    if (action === "local") {
      const reference = body.reference as ClinicalReferenceBundle;
      if (!reference || typeof reference !== "object") return Response.json({ error: "请先生成AI参考候选。" }, { status: 400 });
      return Response.json({ result: { ...reference, verification_state: "local_checked", checks: localReferenceChecks(reference), disclaimer: "已用本地来源卡交叉核对；支持仅代表候选方向可在来源中找到，仍需判断患者适用条件并由上级医师确认。" } });
    }

    const apiKey = process.env.ARK_CODING_API_KEY;
    if (!apiKey) return Response.json({ error: "模型服务尚未配置。" }, { status: 503 });
    const baseUrl = (process.env.ARK_CODING_BASE_URL || "https://ark.cn-beijing.volces.com/api/coding/v3").replace(/\/$/, "");

    if (action === "web") {
      const reference = body.reference as ClinicalReferenceBundle;
      if (!reference || typeof reference !== "object") return Response.json({ error: "请先生成AI参考候选。" }, { status: 400 });
      const nciUrl = "https://www.cancer.gov/types/skin/hp/melanoma-treatment-pdq";
      const nhcUrl = "https://www.nhc.gov.cn/yzygj/c100068/202204/0c1f7d3aca0545abbeb02030ce255930.shtml";
      const [nciResult, nhcResult] = await Promise.allSettled([
        fetch(nciUrl, { headers: { "User-Agent": "OncoPilot-reference-check/0.1" }, signal: AbortSignal.timeout(15000) }),
        fetch(nhcUrl, { headers: { "User-Agent": "OncoPilot-reference-check/0.1" }, signal: AbortSignal.timeout(15000) }),
      ]);
      const nci = nciResult.status === "fulfilled" && nciResult.value.ok ? nciResult.value : null;
      const nhc = nhcResult.status === "fulfilled" && nhcResult.value.ok ? nhcResult.value : null;
      if (!nci && !nhc) return Response.json({ error: "权威网页本次均未能读取，请稍后重试。" }, { status: 502 });
      const excerpts: string[] = [];
      const availableSources: string[] = [];
      if (nci) {
        const nciText = stripHtml(await nci.text());
        excerpts.push(`NCI专业版：${sourceWindow(nciText, /Diagnosis|Treatment Option Overview/i)}`);
        availableSources.push(`NCI Melanoma Treatment PDQ ${nciUrl}`);
      }
      if (nhc) {
        const nhcText = stripHtml(await nhc.text());
        excerpts.push(`国家卫健委发布页：${sourceWindow(nhcText, /黑色素瘤/, 1200)}`);
        availableSources.push(`国家卫健委黑色素瘤诊疗指南发布页 ${nhcUrl}`);
      }
      const prompt = [
        "你是肿瘤诊疗参考的来源核对器，只做交叉核对，不制定患者医嘱。",
        "根据本次实时读取的官方网页摘录，逐项检查AI参考候选。status只能是supported、conditional或not_found。conditional用于方向存在但患者适用前提不足。不要补充剂量、处方或新的患者事实。",
        "只返回JSON：{\"checks\":[{\"topic\":\"\",\"status\":\"conditional\",\"note\":\"\",\"source\":\"\",\"url\":\"\"}]}。",
        `已知事实：${JSON.stringify(facts)}`,
        `AI参考候选：${JSON.stringify(reference)}`,
        `官方网页摘录：${excerpts.join("\n").slice(0, 28000)}`,
        `本次实际成功读取的来源（只能引用这些）：${availableSources.join("；")}`,
      ].join("\n\n");
      const checks = parseChecks(await requestModel(baseUrl, apiKey, "deepseek-v4-pro", prompt, { maxOutputTokens: 1200, timeoutMs: 75000 }));
      return Response.json({ result: { ...reference, verification_state: "web_checked", checks, disclaimer: `本次已读取${availableSources.map((source) => source.split(" http")[0]).join("、")}进行交叉核对；未成功读取的来源不计入核验。网页支持不等于患者适用，最终诊断和医嘱仍由医生结合完整资料确认。` } });
    }

    const prompt = [
      "你是OncoPilot的肿瘤入院诊疗准备助手。医生明确要求获得一版有用的AI参考，而不是空白。你可以积极给出初步诊断表达、诊断依据、需要补齐的关键前提、候选检查及其目的，以及按分期/可切除性/分子状态分支的治疗讨论方向。",
      "这不是最终诊疗决定。只能使用已提供的结构化事实，不得编造原发部位、分期、转移、基因状态或治疗反应；不得给药物剂量、频次、直接可执行处方或出院去向。每个检查和治疗方向必须写trigger（什么条件下考虑）与purpose（为了解决什么问题）。",
      "低信息黑色素瘤也不能只说资料不足：应生成可操作的资料复核、病理参数、分期评估和分层治疗讨论框架。PET-CT、分子检测等只能作为有条件候选，不能写成人人必须。",
      "只返回JSON：{\"preliminary_diagnosis\":\"\",\"diagnostic_basis\":[\"\"],\"differential_diagnosis\":[\"\"],\"missing_prerequisites\":[\"\"],\"suggested_workup\":[{\"title\":\"\",\"trigger\":\"\",\"purpose\":\"\"}],\"treatment_pathways\":[{\"title\":\"\",\"trigger\":\"\",\"purpose\":\"\"}]}。",
      `本次来院目的：${currentPurpose || "未提供"}`,
      `结构化事实：${JSON.stringify(facts)}`,
    ].join("\n\n");
    const result = parseClinicalReference(await requestModel(baseUrl, apiKey, "deepseek-v4-flash", prompt, { maxOutputTokens: 1800, timeoutMs: 75000 }), factsText, diagnosticFacts);
    return Response.json({ result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "诊疗参考暂时生成失败。";
    return Response.json({ error: message.includes("上游") ? "诊疗参考模型暂时不可用，请稍后重试。" : message }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
