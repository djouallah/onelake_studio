// Tests for src/fabric.js — a workspace's semantic models and apps, and a model's .bim,
// read from the Fabric API. Read only: there is no write path to test, and the module
// takes no storage token at all.
//
// No network: `fetch` is replaced per test with a table of canned answers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const fabricModule = require("../src/fabric.js");
const { createFabric, bimFileName } = fabricModule;

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

test("a model's name becomes a safe local file name", () => {
  assert.equal(bimFileName("Sales Model"), "Sales Model.bim");
  assert.equal(bimFileName('a/b\\c:d*e?"f<g>h|i'), "a_b_c_d_e__f_g_h_i.bim");
  assert.equal(bimFileName(".."), "model.bim", "nothing but dots is still a file");
  assert.equal(bimFileName("../../x"), "_.._x.bim", "slashes cannot survive into a path");
});

test("the module can only read: no write, no existence check, no storage token", () => {
  assert.deepEqual(Object.keys(fabricModule).sort(), ["bimFileName", "createFabric"]);
  const f = createFabric({ getFabricToken: async () => "fab" });
  assert.deepEqual(Object.keys(f).sort(), ["getBim", "listApps", "listSemanticModels", "reset", "workspaceId"]);
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
