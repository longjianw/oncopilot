import assert from "node:assert/strict";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

async function extractWithoutVisionService() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("image-test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const formData = new FormData();
  formData.append("image", new File(["synthetic image"], "synthetic.jpg", { type: "image/jpeg" }));
  return worker.fetch(
    new Request("http://localhost/api/extract-image", { method: "POST", body: formData }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("renders the simple medical-record workflow", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /OncoPilot/);
  assert.match(html, /肿瘤病史整理助手/);
  assert.match(html, /把一堆患者资料/);
  assert.match(html, /现病史和待补问清单/);
  assert.match(html, /拍照、上传图片，或粘贴文字/);
  assert.match(html, /上传图片/);
  assert.match(html, /支持单页报告、病理或检查单照片/);
  assert.match(html, /益阳市中心医院肿瘤内科入院记录结构/);
  assert.match(html, /不替代上级审核/);
  assert.match(html, /生成现病史，并告诉我还要问什么/);
  assert.match(html, /实体瘤、淋巴瘤和白血病/);
  assert.doesNotMatch(html, /进入管床/);
  assert.doesNotMatch(html, /合成患者 A02/);
  assert.doesNotMatch(html, /codex-preview/);
  assert.doesNotMatch(html, /react-loading-skeleton/);
});

test("rejects image extraction clearly when no vision service is configured", async () => {
  const response = await extractWithoutVisionService();
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.match(body.error, /图片识别服务尚未配置/);
});
