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

test("renders the simple medical-record workflow", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /OncoPilot/);
  assert.match(html, /肿瘤病例整理助手/);
  assert.match(html, /把零散资料/);
  assert.match(html, /可核实的现病史/);
  assert.match(html, /粘贴患者资料/);
  assert.match(html, /AI整理病史/);
  assert.match(html, /DeepSeek V4 Flash · 已接入/);
  assert.match(html, /仅使用合成或严格脱敏资料/);
  assert.doesNotMatch(html, /codex-preview/);
  assert.doesNotMatch(html, /react-loading-skeleton/);
});
