import { containsSensitiveIdentifier, requestModel } from "../../../lib/model-api";
import { ClinicalReferenceBundle, localReferenceChecks, parseClinicalReference, starterClinicalReference, webReferenceChecks } from "../../../lib/clinical-reference";

type Fact = { field?: unknown; value?: unknown; event_time?: unknown; event_type?: unknown; encounter_scope?: unknown; certainty?: unknown; source_ids?: unknown };

const validFacts = (value: unknown): Fact[] => Array.isArray(value) ? value.filter((fact) => fact && typeof fact === "object" && typeof (fact as Fact).value === "string").slice(0, 80) : [];
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

    if (action === "web") {
      const reference = body.reference as ClinicalReferenceBundle;
      if (!reference || typeof reference !== "object") return Response.json({ error: "请先生成AI参考候选。" }, { status: 400 });
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

    const prompt = [
      "你是OncoPilot的肿瘤入院诊疗准备助手。医生明确要求获得一版有用的AI参考，而不是空白。你可以积极给出初步诊断表达、诊断依据、需要补齐的关键前提、候选检查及其目的，以及按分期/可切除性/分子状态分支的治疗讨论方向。",
      "当前是入院记录场景，不是出院记录。输出只使用‘初步诊断’，不得生成‘出院诊断’；既往出院记录中的诊断只能作为既往证据。初步诊断需区分明确诊断、待排诊断、分期和并发症；鉴别诊断只围绕当前确有疑问的问题，不机械罗列。",
      "这不是最终诊疗决定。只能使用已提供的结构化事实，不得编造原发部位、分期、转移、基因状态或治疗反应；不得给药物剂量、频次、直接可执行处方或出院去向。每个检查和治疗方向必须写trigger（什么条件下考虑）与purpose（为了解决什么问题）。",
      "低信息黑色素瘤也不能只说资料不足：应生成可操作的资料复核、病理参数、分期评估和分层治疗讨论框架。PET-CT、分子检测等只能作为有条件候选，不能写成人人必须。",
      "只返回JSON：{\"preliminary_diagnosis\":\"\",\"diagnostic_basis\":[\"\"],\"differential_diagnosis\":[\"\"],\"missing_prerequisites\":[\"\"],\"suggested_workup\":[{\"title\":\"\",\"trigger\":\"\",\"purpose\":\"\"}],\"treatment_pathways\":[{\"title\":\"\",\"trigger\":\"\",\"purpose\":\"\"}]}。",
      `本次来院目的：${currentPurpose || "未提供"}`,
      `结构化事实：${JSON.stringify(facts)}`,
    ].join("\n\n");
    try {
      const result = parseClinicalReference(await requestModel(baseUrl, apiKey, "deepseek-v4-flash", prompt, { maxOutputTokens: 1800, timeoutMs: 25000 }), factsText, diagnosticFacts);
      return Response.json({ result, degraded: false }, { headers: { "Cache-Control": "no-store" } });
    } catch {
      const starter = starterClinicalReference(factsText, diagnosticFacts);
      return Response.json({
        result: { ...starter, disclaimer: "AI深化本次未在25秒内返回，已保留根据现有事实生成的快速候选；可直接核对使用，也可稍后重新深化。" },
        degraded: true,
        warning: "AI深化暂未返回，已保留快速候选。",
      }, { headers: { "Cache-Control": "no-store" } });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "诊疗参考暂时生成失败。";
    return Response.json({ error: message.includes("上游") ? "诊疗参考模型暂时不可用，请稍后重试。" : message }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
