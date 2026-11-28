// Tests for core/models/fabric.js — a workspace's semantic models, apps and notebooks, and their
// definitions, read from the Fabric API. Its one write is a notebook's Publish, and the module
// takes no storage token at all.
//
// No network: `fetch` is replaced per test with a table of canned answers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const fabricModule = require("../../core/models/fabric.js");
const { createFabric, modelFileName, modelCopyPath, notebookCopyPath, notebookKind } = fabricModule;

const WS_ID = "11111111-2222-3333-4444-555555555555";

const res = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: k => headers[k.toLowerCase()] ?? null },
  json: async () => body,
  text: async () => JSON.stringify(body),
});

function fabricWith(answers, opts = {}) {
  const calls = [];
  const saved = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || "GET", body: init.body, auth: init.headers && init.headers.authorization });
    for (const [match, make] of answers) {
      if (typeof match === "function" ? match(url, init) : (typeof match === "string" ? url.includes(match) : match.test(url))) {
        return make(url, init);
      }
    }
    return res(404, {});
  };
  const fabric = createFabric({
    getFabricToken: async () => "fab",
    sleep: async () => {},
    ...opts,
  });
  return { fabric, calls, restore: () => { globalThis.fetch = saved; } };
}

test("itemOf: a Direct Lake expression's GUIDs, as the names the tree and OneLake use", async () => {
  const LH = "99999999-8888-7777-6666-555555555555";
  const { fabric, restore } = fabricWith([
    [/\/v1\/workspaces$/, () => res(200, { value: [{ id: WS_ID, displayName: "Power BI" }] })],
    [`/workspaces/${WS_ID}/items/${LH}`, () => res(200, { id: LH, displayName: "nem", type: "Lakehouse" })],
  ]);
  try {
    assert.deepEqual(await fabric.itemOf(WS_ID.toUpperCase(), LH), { workspace: "Power BI", item: "nem.Lakehouse" });
    await assert.rejects(fabric.itemOf("00000000-0000-0000-0000-000000000000", LH), /does not list the workspace/);
  } finally { restore(); }
});

test("itemOfSqlEndpoint: the item behind it, or null when Fabric doesn't show it", async () => {
  const END = "aaaaaaaa-0000-0000-0000-000000000001";
  const owner = id => ({ id: "owner", properties: { sqlEndpointProperties: { id } } });
  const run = async (answers, check) => {
    const { fabric, restore } = fabricWith(answers);
    try { await check(fabric); } finally { restore(); }
  };
  const endpoint = [`/items/${END}`, () => res(200, { id: END, type: "SQLEndpoint" })];

  await run([endpoint,
    [`/workspaces/${WS_ID}/lakehouses`, () => res(200, { value: [owner("other"), owner(END.toUpperCase())] })],
  ], async f => assert.deepEqual(await f.itemOfSqlEndpoint(WS_ID, END), { workspace: WS_ID, item: "owner" }));

  await run([endpoint,
    [`/workspaces/${WS_ID}/lakehouses`, () => res(200, { value: [] })],
    [`/workspaces/${WS_ID}/mirroredDatabases`, () => res(200, { value: [owner(END)] })],
  ], async f => assert.deepEqual(await f.itemOfSqlEndpoint(WS_ID, END), { workspace: WS_ID, item: "owner" }));

  await run([[`/items/${END}`, () => res(200, { id: END, type: "Warehouse" })]],
    async f => assert.deepEqual(await f.itemOfSqlEndpoint(WS_ID, END), { workspace: WS_ID, item: END }));

  await run([endpoint, [`/workspaces/${WS_ID}/lakehouses`, () => res(200, { value: [] })],
    [`/workspaces/${WS_ID}/mirroredDatabases`, () => res(200, { value: [] })],
  ], async f => assert.equal(await f.itemOfSqlEndpoint(WS_ID, END), null, "an endpoint nothing owns"));

  await run([], async f => assert.equal(await f.itemOfSqlEndpoint(WS_ID, END), null, "404"));
  await run([[`/items/${END}`, () => res(403, {})]],
    async f => assert.equal(await f.itemOfSqlEndpoint(WS_ID, END), null, "403"));
  await run([[`/items/${END}`, () => res(500, {})]],
    async f => assert.rejects(f.itemOfSqlEndpoint(WS_ID, END), /HTTP 500/, "any other failure says so"));
});

test("a workspace's items, with their ids", async () => {
  const { fabric, restore } = fabricWith([
    [/\/v1\/workspaces$/, () => res(200, { value: [{ id: WS_ID, displayName: "Sales" }] })],
    [`/workspaces/${WS_ID}/items`, () => res(200, { value: [{ id: "i", displayName: "nem", type: "Lakehouse", extra: 1 }] })],
  ]);
  try {
    assert.deepEqual(await fabric.listItems("Sales"), [{ id: "i", name: "nem", type: "Lakehouse" }]);
  } finally { restore(); }
});

test("a workspace name maps to its GUID through one paged listing, memoised", async () => {
  const { fabric, calls, restore } = fabricWith([
    [/continuationToken=c2/, () => res(200, { value: [{ id: WS_ID, displayName: "Sales" }] })],
    [/\/v1\/workspaces$/, () => res(200, { value: [{ id: "x", displayName: "Other" }], continuationToken: "c2" })],
  ]);
  try {
    assert.equal(await fabric.workspaceId("Sales"), WS_ID);
    assert.equal(await fabric.workspaceId("Other"), "x");
    assert.equal(calls.length, 2, "two pages, then the memo answers");
    assert.equal(calls[0].auth, "Bearer fab", "the Fabric token, not the storage one");
    await assert.rejects(fabric.workspaceId("Nope"), /does not list a workspace named "Nope"/);
    assert.equal(await fabric.workspaceId(WS_ID), WS_ID, "a GUID needs no lookup");
  } finally { restore(); }
});

test("semantic models are listed by name, with their ids", async () => {
  const { fabric, restore } = fabricWith([
    [/\/v1\/workspaces$/, () => res(200, { value: [{ id: WS_ID, displayName: "Sales" }] })],
    [`/workspaces/${WS_ID}/semanticModels`, () => res(200, { value: [
      { id: "m2", displayName: "zeta" }, { id: "m1", displayName: "Alpha", description: "d" },
    ] })],
  ]);
  try {
    assert.deepEqual(await fabric.listSemanticModels("Sales"), [
      { id: "m1", name: "Alpha", description: "d" },
      { id: "m2", name: "zeta", description: "" },
    ]);
  } finally { restore(); }
});

test("a workspace's apps are its AppBackend items, each with its URL and last deploy", async () => {
  const { fabric, calls, restore } = fabricWith([
    [/\/v1\/workspaces$/, () => res(200, { value: [{ id: WS_ID, displayName: "Sales" }] })],
    [`/workspaces/${WS_ID}/items?type=AppBackend`, () => res(200, { value: [
      { id: "a2", displayName: "zeta", type: "AppBackend" }, { id: "a1", displayName: "Alpha", type: "AppBackend", description: "d" },
    ] })],
    [`/appBackends/a1/__private/deploy/status`, (url, init) => init.headers["x-ms-workload-resource-moniker"] === "a1"
      ? res(200, { hostingUrl: "https://alpha.webapp.fabricapps.net", lastSuccessfulDeploymentAt: "2026-10-28T07:32:09Z" })
      : res(400, {})],
    [`/appBackends/a2/__private/deploy/status`, () => res(404, { message: "never deployed" })],
    [`/appBackends/a1/__private/projectRuntimeSettings`, () => res(200, { publishableKey: "pk-secret",
      serviceSettings: { staticHosting: { enabled: true, anonymousAccess: true } } })],
    [`/appBackends/a2/__private/projectRuntimeSettings`, () => res(403, {})],
  ]);
  try {
    const apps = await fabric.listApps("Sales");
    assert.deepEqual(apps, [
      { id: "a1", name: "Alpha", description: "d", url: "https://alpha.webapp.fabricapps.net", deployedAt: "2026-10-28T07:32:09Z", access: "public" },
      { id: "a2", name: "zeta", description: "", url: "", deployedAt: "", access: "" },
    ], "an app whose status or settings cannot be read is still listed");
    assert.ok(!JSON.stringify(apps).includes("pk-secret"), "the publishable key is never kept");
    assert.ok(calls.every(c => c.method === "GET"), "listing apps only reads");
  } finally { restore(); }
});

test("a Fabric error says what Fabric said", async () => {
  const { fabric, restore } = fabricWith([
    [/\/v1\/workspaces$/, () => res(403, { message: "The caller is not authorized" })],
  ]);
  try {
    await assert.rejects(fabric.listSemanticModels("Sales"), /HTTP 403\) — The caller is not authorized/);
  } finally { restore(); }
});

const BIM = JSON.stringify({ name: "m", model: { tables: [] } });
const definition = { definition: { parts: [
  { path: "definition.pbism", payload: Buffer.from("{}").toString("base64"), payloadType: "InlineBase64" },
  { path: "model.bim", payload: Buffer.from(BIM).toString("base64"), payloadType: "InlineBase64" },
] } };

test("getDefinition answered at once returns the decoded model.bim", async () => {
  const { fabric, calls, restore } = fabricWith([
    [/getDefinition\?format=TMSL/, () => res(200, definition)],
  ]);
  try {
    const bytes = await fabric.getBim(WS_ID, "m1");
    assert.equal(bytes.toString("utf8"), BIM);
    assert.equal(calls[0].method, "POST");
  } finally { restore(); }
});

test("getDefinition as a long-running operation is polled, then its /result read", async () => {
  const OP = "https://api.fabric.microsoft.com/v1/operations/op1";
  let polls = 0;
  const { fabric, calls, restore } = fabricWith([
    [/getDefinition/, () => res(202, {}, { location: OP, "retry-after": "1" })],
    [/operations\/op1\/result$/, () => res(200, definition)],
    [/operations\/op1$/, () => res(200, { status: ++polls < 2 ? "Running" : "Succeeded" })],
  ]);
  try {
    const bytes = await fabric.getBim(WS_ID, "m1");
    assert.equal(bytes.toString("utf8"), BIM);
    assert.equal(polls, 2, "polled until Succeeded");
    assert.ok(calls.at(-1).url.endsWith("/operations/op1/result"));
  } finally { restore(); }
});

test("a failed operation fails with its reason; a definition with no model.bim says so", async () => {
  const OP = "https://api.fabric.microsoft.com/v1/operations/op2";
  const a = fabricWith([
    [/getDefinition/, () => res(202, {}, { location: OP })],
    [/operations\/op2$/, () => res(200, { status: "Failed", error: { message: "Unsupported model" } })],
  ]);
  try { await assert.rejects(a.fabric.getBim(WS_ID, "m1"), /failed — Unsupported model/); }
  finally { a.restore(); }

  const b = fabricWith([
    [/getDefinition/, () => res(200, { definition: { parts: [{ path: "definition/model.tmdl", payload: "" }] } })],
  ]);
  try { await assert.rejects(b.fabric.getBim(WS_ID, "m1"), /no model\.bim part \(it has definition\/model\.tmdl\)/); }
  finally { b.restore(); }
});

test("a long-running operation that never finishes gives up", async () => {
  const OP = "https://api.fabric.microsoft.com/v1/operations/op3";
  let now = 0;
  const realNow = Date.now;
  Date.now = () => now;
  const { fabric, restore } = fabricWith([
    [/getDefinition/, () => res(202, {}, { location: OP })],
    [/operations\/op3$/, () => res(200, { status: "Running" })],
  ], { sleep: async ms => { now += ms; }, lroTimeoutMs: 10_000 });
  try { await assert.rejects(fabric.getBim(WS_ID, "m1"), /did not finish within 10 s/); }
  finally { restore(); Date.now = realNow; }
});

const ipynb = (group, kernel) => ({ nbformat: 4, metadata: { microsoft: { language_group: group }, kernel_info: { name: kernel } }, cells: [] });
const nbDefinition = nb => ({ definition: { parts: [
  { path: ".platform", payload: Buffer.from("{}").toString("base64") },
  { path: "notebook-content.ipynb", payload: Buffer.from("\uFEFF" + JSON.stringify(nb)).toString("base64") },
] } });

test("a notebook's kind is in its .ipynb: a Python notebook runs anywhere, a Spark one in Fabric only", () => {
  assert.equal(notebookKind(ipynb("jupyter_python", "jupyter")), "python");
  assert.equal(notebookKind({ metadata: { kernel_info: { name: "jupyter" } } }), "python");
  assert.equal(notebookKind(ipynb("synapse_pyspark", "synapse_pyspark")), "spark");
  assert.equal(notebookKind({ metadata: { kernel_info: { name: "synapse_spark" } } }), "spark");
  assert.equal(notebookKind({ metadata: { kernelspec: { name: "synapse_pyspark" } } }), "spark", "an older notebook names it in kernelspec only");
  assert.equal(notebookKind({ metadata: { microsoft: { language_group: "jupyter_python" }, kernelspec: { name: "jupyter" } } }), "python",
    "a kernelspec VS Code rewrote");
  assert.equal(notebookKind({ metadata: {} }), "");
  assert.equal(notebookKind(null), "");
});

test("a workspace's notebooks are listed in one request; what each runs on is read from its definition, on its own", async () => {
  const OP = "https://api.fabric.microsoft.com/v1/operations/nb2";
  const { fabric, calls, restore } = fabricWith([
    [/\/v1\/workspaces$/, () => res(200, { value: [{ id: WS_ID, displayName: "Sales" }] })],
    [`/workspaces/${WS_ID}/notebooks/n1/getDefinition?format=ipynb`, () => res(200, nbDefinition(ipynb("jupyter_python", "jupyter")))],
    [`/workspaces/${WS_ID}/notebooks/n2/getDefinition?format=ipynb`, () => res(202, {}, { location: OP })],
    [/operations\/nb2\/result$/, () => res(200, nbDefinition(ipynb("synapse_pyspark", "synapse_pyspark")))],
    [/operations\/nb2$/, () => res(200, { status: "Succeeded" })],
    [`/workspaces/${WS_ID}/notebooks/n3/getDefinition`, () => res(403, { message: "no" })],
    [`/workspaces/${WS_ID}/notebooks`, () => res(200, { value: [
      { id: "n2", displayName: "spark job" }, { id: "n1", displayName: "Ossie", description: "d" }, { id: "n3", displayName: "locked" },
    ] })],
  ]);
  try {
    assert.deepEqual(await fabric.listNotebooks("Sales"), [
      { id: "n3", name: "locked", description: "" },
      { id: "n1", name: "Ossie", description: "d" },
      { id: "n2", name: "spark job", description: "" },
    ]);
    assert.ok(!calls.some(c => c.method === "POST"), "listing reads no definition: it is one request");
    let given = null;
    assert.equal(await fabric.notebookKindOf(WS_ID, "n1", { onNotebook: nb => { given = nb; } }), "python");
    assert.equal(given.metadata.microsoft.language_group, "jupyter_python", "the definition read is handed on, to be kept");
    assert.equal(await fabric.notebookKindOf(WS_ID, "n2"), "spark", "a long-running definition is waited for");
    await assert.rejects(fabric.notebookKindOf(WS_ID, "n3"), /HTTP 403/);
  } finally { restore(); }
});

test("getNotebook answers the parsed .ipynb, and says so when there is none", async () => {
  const nb = ipynb("jupyter_python", "jupyter");
  const a = fabricWith([[/getDefinition\?format=ipynb/, () => res(200, nbDefinition(nb))]]);
  try { assert.deepEqual(await a.fabric.getNotebook(WS_ID, "n1"), nb, "its byte-order mark is no trouble"); }
  finally { a.restore(); }
  const b = fabricWith([[/getDefinition/, () => res(200, { definition: { parts: [{ path: "notebook-content.py", payload: "" }] } })]]);
  try { await assert.rejects(b.fabric.getNotebook(WS_ID, "n1"), /no notebook-content\.ipynb part \(it has notebook-content\.py\)/); }
  finally { b.restore(); }
  const c = fabricWith([[/getDefinition/, () => res(200, { definition: { parts: [{ path: "notebook-content.ipynb", payload: Buffer.from("{nope").toString("base64") }] } })]]);
  try { await assert.rejects(c.fabric.getNotebook(WS_ID, "n1"), /not an \.ipynb/); }
  finally { c.restore(); }
});

test("a notebook's local copy is under its account, beside its workspace's models", () => {
  assert.equal(notebookCopyPath("root", "me@contoso.com", "sales", "Ossie"), join("root", "me@contoso.com", "sales", "Ossie.ipynb"));
  const climbed = notebookCopyPath("root", "a", "../x", "../../y");
  assert.ok(climbed.startsWith(join("root", "a", "_x")) && !climbed.split(/[\\/]/).includes(".."), `nothing climbs out: ${climbed}`);
});

test("a model's name becomes a safe local file name", () => {
  assert.equal(modelFileName("Sales Model"), "Sales Model.ossie.yaml", "named as Ossie's own tools name a model");
  assert.match(modelFileName('a/b\\c:d*e?"f<g>h|i'), /^a_b_c_d_e__f_g_h_i~[0-9a-f]{6}\.ossie\.yaml$/);
  assert.match(modelFileName(".."), /^model~[0-9a-f]{6}\.ossie\.yaml$/, "nothing but dots is still a file");
  assert.match(modelFileName("../../x"), /^_\.\._x~[0-9a-f]{6}\.ossie\.yaml$/, "slashes cannot survive into a path");
});

test("two models whose names clean to one thing keep a file each", () => {
  for (const [a, b] of [["sales#1", "sales_1"], ["a/b", "a_b"], ["x.", "x"], ["a%b", "a#b"]]) {
    assert.notEqual(modelFileName(a), modelFileName(b), `${a} and ${b}`);
  }
});

test("a model's local copy is under its account: two tenants can each have sales/nem", () => {
  const a = modelCopyPath("root", "me@contoso.com", "sales", "nem");
  const b = modelCopyPath("root", "me@fabrikam.com", "sales", "nem");
  assert.notEqual(a, b);
  assert.equal(a, join("root", "me@contoso.com", "sales", "nem.ossie.yaml"));
  assert.equal(modelCopyPath("root", null, "sales", "nem"), join("root", "signed-out", "sales", "nem.ossie.yaml"));
  const climbed = modelCopyPath("root", "a", "../x", "../../y");
  assert.ok(climbed.startsWith(join("root", "a", "_x")) && !climbed.split(/[\\/]/).includes(".."), `nothing climbs out: ${climbed}`);
});

test("Publish replaces the notebook's definition with the .ipynb, and waits for Fabric to finish", async () => {
  const OP = "https://api.fabric.microsoft.com/v1/operations/up1";
  let polls = 0;
  const nb = { nbformat: 4, metadata: {}, cells: [{ cell_type: "code", source: ["x = 1"] }] };
  const { fabric, calls, restore } = fabricWith([
    [`/workspaces/${WS_ID}/notebooks/n1/updateDefinition`, () => res(202, {}, { location: OP })],
    [/operations\/up1$/, () => res(200, { status: ++polls < 2 ? "Running" : "Succeeded" })],
  ]);
  try {
    await fabric.updateNotebook(WS_ID, "n1", nb);
    const post = calls.find(c => c.method === "POST");
    const part = JSON.parse(post.body).definition.parts[0];
    assert.equal(JSON.parse(post.body).definition.format, "ipynb");
    assert.equal(part.path, "notebook-content.ipynb");
    assert.deepEqual(JSON.parse(Buffer.from(part.payload, "base64").toString("utf8")), nb);
    assert.equal(polls, 2, "polled until Succeeded");
  } finally { restore(); }
  const failed = fabricWith([[/updateDefinition/, () => res(403, { message: "not a contributor" })]]);
  try { await assert.rejects(failed.fabric.updateNotebook(WS_ID, "n1", nb), /Publishing the notebook failed \(HTTP 403\) — not a contributor/); }
  finally { failed.restore(); }
});

test("the module reads, and writes only a notebook's Publish: no existence check, no storage token", () => {
  assert.deepEqual(Object.keys(fabricModule).sort(), ["createFabric", "modelAccountDir", "modelCopyPath", "modelFileName", "notebookCopyPath", "notebookKind"]);
  const f = createFabric({ getFabricToken: async () => "fab" });
  assert.deepEqual(Object.keys(f).sort(), ["getBim", "getNotebook", "itemOf", "itemOfSqlEndpoint", "listApps", "listItems",
    "listNotebooks", "listSemanticModels", "notebookKindOf", "reset", "updateNotebook", "workspaceId"]);
});

test("a 401 is retried once with a fresh token", async () => {
  let n = 0;
  const { fabric, calls, restore } = fabricWith(
    [[/\/v1\/workspaces$/, () => (++n === 1 ? res(401, {}) : res(200, { value: [] }))]],
    { getFabricToken: async ({ fresh } = {}) => (fresh ? "new" : "old") });
  try {
    await assert.rejects(fabric.workspaceId("x"), /does not list/, "the retry's answer is the one used");
    assert.deepEqual(calls.map(c => c.auth), ["Bearer old", "Bearer new"]);
  } finally { restore(); }
});

test("a definition is asked about after 1 s, then 2, 4…, never past the Retry-After Fabric gave", async () => {
  const OP = "https://api.fabric.microsoft.com/v1/operations/slow";
  const waits = [];
  let polls = 0;
  const { fabric, restore } = fabricWith([
    [/getDefinition/, () => res(202, {}, { location: OP, "retry-after": "20" })],
    [/operations\/slow\/result$/, () => res(200, definition)],
    [/operations\/slow$/, () => res(200, { status: ++polls < 7 ? "Running" : "Succeeded" }, { "retry-after": "20" })],
  ], { sleep: async ms => { waits.push(ms); } });
  try {
    await fabric.getBim(WS_ID, "m1");
    assert.deepEqual(waits, [1000, 2000, 4000, 8000, 16000, 20000, 20000]);
  } finally { restore(); }
});
