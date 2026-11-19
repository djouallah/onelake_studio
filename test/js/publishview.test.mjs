// fabric_app/export/publishview.js: Fabric's Publish of a semantic view, and what Fabric said of it. No network:
// `fetch` answers as Fabric did when OneLake Studio's spike published studio_spike (2026-11-18).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createViewPublisher } = require("../../fabric_app/export/publishview.js");

const WS = "91588e42-0f1c-4e56-bcaa-cbf015b8f312", LH = "d77983f0-61d2-4d37-b143-f1841f07a3f2";
const res = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null },
                                 text: async () => JSON.stringify(body), json: async () => body });
const fabric = { workspaceId: async () => WS, listItems: async () => [{ id: "x", name: "data", type: "Warehouse" }, { id: LH, name: "data", type: "Lakehouse" }] };

async function publishWith(answer, lakehouse = "data") {
  const saved = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, init = {}) => { calls.push({ url, method: init.method }); return answer(); };
  try { return { r: await createViewPublisher({ fabric, getToken: async () => "t" }).publish("analytics_as_code", lakehouse, "studio spike"), calls }; }
  finally { globalThis.fetch = saved; }
}

test("Publish is one POST to the view of that lakehouse, and says the model Fabric made", async () => {
  const { r, calls } = await publishWith(() => res(200, {
    semanticModel: { workspaceId: WS, id: "b0af5496-096b-4d05-9540-7e5f45e8861d" }, summary: { errorCount: 0, warningCount: 0 }, warnings: [] }));
  assert.deepEqual(calls, [{ method: "POST",
    url: `https://api.fabric.microsoft.com/v1/workspaces/${WS}/lakehouses/${LH}/semanticViews/studio%20spike/publish?beta=true` }]);
  assert.deepEqual(r, { modelId: "b0af5496-096b-4d05-9540-7e5f45e8861d", warnings: [] });
});

test("what Fabric refused is said as Fabric said it, by file and line", async () => {
  const diagnostics = { summary: { errorCount: 1, warningCount: 0 }, diagnostics: [{
    code: "OSSIE_COMPILATION_COLUMN_NOT_FOUND", severity: "Error", stage: "SchemaResolution",
    message: "The relationship endpoint must match exactly one synchronized column.",
    messageArguments: { relationshipName: "summary_to_calendar", columnName: "date" },
    source: { path: "studio_spike_semantic_view.yaml", semanticPath: "/relationships/1/from_columns/0", start: { line: 26, column: 9 } } }] };
  await assert.rejects(publishWith(() => res(400, { errorCode: "SemanticViewCompilationFailed",
    moreDetails: [{ errorCode: "SemanticViewDiagnostics", message: JSON.stringify(diagnostics) }],
    message: "PowerBI service client received error HTTP response." })), e => {
    assert.equal(e.status, 400);
    assert.equal(e.diagnostics.length, 1);
    assert.match(e.message, /^Fabric did not publish studio spike \(HTTP 400\): Error OSSIE_COMPILATION_COLUMN_NOT_FOUND The relationship endpoint/);
    assert.match(e.message, /\(studio_spike_semantic_view\.yaml, line 26, \/relationships\/1\/from_columns\/0\)/);
    return true;
  });
  await assert.rejects(publishWith(() => res(403, { errorCode: "Forbidden", message: "Not allowed" })), /HTTP 403\): Not allowed/);
  await assert.rejects(publishWith(() => res(200, {}), "nope"), /does not list a lakehouse named nope/);
});

test("a Publish of a view while one of it is under way joins it: one POST, so Fabric makes one model", async () => {
  const saved = globalThis.fetch;
  let posts = 0, answer;
  globalThis.fetch = async () => { posts++; return new Promise(r => { answer = r; }); };
  try {
    const p = createViewPublisher({ fabric, getToken: async () => "t" });
    const first = p.publish("analytics_as_code", "data", "nem");
    const again = p.publish("Analytics_as_code", "Data", "NEM");
    await new Promise(r => setTimeout(r, 10));
    answer(res(200, { semanticModel: { id: "m" }, warnings: [] }));
    assert.deepEqual(await Promise.all([first, again]), [{ modelId: "m", warnings: [] }, { modelId: "m", warnings: [] }]);
    assert.equal(posts, 1);
    // Once it is done, the next Publish is one of its own.
    const next = p.publish("analytics_as_code", "data", "nem");
    await new Promise(r => setTimeout(r, 10));
    answer(res(200, { semanticModel: { id: "m" }, warnings: [] }));
    await next;
    assert.equal(posts, 2);
  } finally { globalThis.fetch = saved; }
});

test("Fabric refusing a view whose name two models have says what to do", async () => {
  await assert.rejects(publishWith(() => res(400, { errorCode: "DuplicateDatasetNamesInWorkspace",
    moreDetails: [{ errorCode: "ModelingServiceError_Reason", message: "Expected exactly one model named nem in the workspace." }],
    message: "PowerBI service client received error HTTP response." })),
  /analytics_as_code has more than one semantic model named studio spike, .*Delete all but one in Fabric/);
});
