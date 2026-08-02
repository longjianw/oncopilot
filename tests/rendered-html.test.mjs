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

test("renders the focused inpatient workbench", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /OncoPilot/);
  assert.match(html, /肿瘤住院管床助手/);
  assert.match(html, /在区患者/);
  assert.match(html, /我的分管患者/);
  assert.match(html, /今日管床摘要/);
  assert.match(html, /新增报告处理闭环/);
  assert.match(html, /固定规则演示 · 尚未接入真实模型/);
  assert.match(html, /完全合成数据/);
  assert.doesNotMatch(html, /codex-preview/);
  assert.doesNotMatch(html, /react-loading-skeleton/);
});
