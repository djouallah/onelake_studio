// Tests for extension/src/fabric.js — a workspace's semantic models, and the one write the
// extension makes: a model's .bim into <lakehouse>/Files/semantic_models/.
//
// The write path is the part that matters most. It is the only code in the extension that
// changes anything in OneLake, so what it refuses is tested as hard as what it does.
//
// No network: `fetch` is replaced per test with a table of canned answers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createFabric, exportPath, bimFileName, assertExportPath } = require("../extension/src/fabric.js");

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
    getStorageToken: async () => "sto",
    sleep: async () => {},
    ...opts,
  });
  return { fabric, calls, restore: () => { globalThis.fetch = saved; } };
}

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

test("the export path is <lakehouse>/Files/semantic_models/<safe name>.bim", () => {
  assert.equal(exportPath("Sales.Lakehouse", "Sales Model"), "Sales.Lakehouse/Files/semantic_models/Sales Model.bim");
  assert.equal(bimFileName('a/b\\c:d*e?"f<g>h|i'), "a_b_c_d_e__f_g_h_i.bim");
  assert.equal(bimFileName(".."), "model.bim", "nothing but dots is still a file");
  assert.equal(bimFileName("../../x"), "_.._x.bim", "slashes cannot survive into a path");
});

test("every path but an export's is refused before anything is sent", async () => {
  for (const bad of [
    "Sales.Lakehouse/Tables/semantic_models/m.bim",
    "Sales.Warehouse/Files/semantic_models/m.bim",
    "Sales.Lakehouse/Files/other/m.bim",
    "Sales.Lakehouse/Files/semantic_models/sub/m.bim",
    "Sales.Lakehouse/Files/semantic_models/m.parquet",
    "Sales.Lakehouse/Files/semantic_models/..",
    "../Sales.Lakehouse/Files/semantic_models/m.bim",
    "Sales.Lakehouse/Files/semantic_models/",
  ]) assert.throws(() => assertExportPath(bad), /Refusing to write/, bad);
  assert.doesNotThrow(() => assertExportPath("Sales.Lakehouse/Files/semantic_models/m.bim"));

  const { fabric, calls, restore } = fabricWith([]);
  try {
    await assert.rejects(fabric.writeExport("ws", "Sales.Lakehouse/Tables/x.bim", Buffer.from("x")), /Refusing/);
    await assert.rejects(fabric.exists("ws", "Sales.Lakehouse/Files/x.bim"), /Refusing/);
    assert.equal(calls.length, 0, "no request went out");
  } finally { restore(); }
});

test("the write is create, append, flush — on the storage token, at the right positions", async () => {
  const REL = "Sales.Lakehouse/Files/semantic_models/My Model.bim";
  const { fabric, calls, restore } = fabricWith([[() => true, () => res(201, {})]]);
  try {
    await fabric.writeExport("My WS", REL, Buffer.from("hello"));
    const base = "https://onelake.dfs.fabric.microsoft.com/My%20WS/Sales.Lakehouse/Files/semantic_models/My%20Model.bim";
    assert.deepEqual(calls.map(c => `${c.method} ${c.url}`), [
      `PUT ${base}?resource=file`,
      `PATCH ${base}?action=append&position=0`,
      `PATCH ${base}?action=flush&position=5`,
    ]);
    assert.ok(calls.every(c => c.auth === "Bearer sto"), "OneLake is written on the storage token");
    assert.equal(Buffer.from(calls[1].body).toString(), "hello");
  } finally { restore(); }
});

test("exists is a HEAD: 200 is there, 404 is not, anything else is an error", async () => {
  const REL = "Sales.Lakehouse/Files/semantic_models/m.bim";
  let status = 200;
  const { fabric, calls, restore } = fabricWith([[() => true, () => res(status, {})]]);
  try {
    assert.equal(await fabric.exists("ws", REL), true);
    status = 404; assert.equal(await fabric.exists("ws", REL), false);
    status = 403; await assert.rejects(fabric.exists("ws", REL), /HTTP 403/);
    assert.ok(calls.every(c => c.method === "HEAD"));
  } finally { restore(); }
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
