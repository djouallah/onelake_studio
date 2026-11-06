// fabricmodel.js: Export to Fabric's semantic model, created or updated over the Fabric REST API,
// framed (Direct Lake) or put on SSO (DirectQuery) over the Power BI API. No network: `fetch` is a
// script of canned answers, and every request is kept to be checked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createFabricModel } = require("../../src/fabricmodel.js");

const WS = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
const API = "https://api.fabric.microsoft.com/v1";
const PBI = "https://api.powerbi.com/v1.0/myorg";
const DEF = { parts: [{ path: "model.bim", payload: "e30=", payloadType: "InlineBase64" }] };

const res = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: k => headers[k.toLowerCase()] ?? null },
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});

function modelWith(answers) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const method = init.method || "GET";
    calls.push({ url, method, auth: (init.headers || {}).authorization, body: init.body });
    for (const a of answers) {
      const [m, part, make] = a;
      if (m === method && url.includes(part)) { a.n = (a.n || 0) + 1; return make(init, a.n); }
    }
    return res(404, { message: `no answer for ${method} ${url}` });
  };
  const model = createFabricModel({ getToken: async () => "fab", powerBiToken: async () => "pbi", sqlToken: async () => "sql",
                                    sleep: async () => {}, fetchImpl });
  return { model, calls };
}

test("find: the workspace's model of that name, whatever its case, or null", async () => {
  const { model } = modelWith([["GET", `/workspaces/${WS}/semanticModels`, () => res(200, { value: [{ id: "m1", displayName: "Sales" }] })]]);
  assert.deepEqual(await model.find(WS, "sales"), { id: "m1", displayName: "Sales" });
  assert.equal(await model.find(WS, "other"), null);
});

test("write: a new model is created, its operation waited for, then found by name", async () => {
  const { model, calls } = modelWith([
    ["POST", `/workspaces/${WS}/semanticModels`, () => res(202, "", { location: `${API}/operations/op1`, "retry-after": "1" })],
    ["GET", "/operations/op1", (_, n) => res(200, { status: n < 2 ? "Running" : "Succeeded" })],
    ["GET", `/workspaces/${WS}/semanticModels`, () => res(200, { value: [{ id: "m9", displayName: "sales" }] })],
  ]);
  assert.deepEqual(await model.write(WS, "sales", DEF), { id: "m9", created: true });
  assert.deepEqual(JSON.parse(calls[0].body), { displayName: "sales", definition: DEF });
  assert.equal(calls[0].auth, "Bearer fab");
});

test("write: the model of that name has its definition replaced, the same item", async () => {
  const { model, calls } = modelWith([
    ["POST", `/semanticModels/m1/updateDefinition`, () => res(200, {})],
  ]);
  assert.deepEqual(await model.write(WS, "sales", DEF, "m1"), { id: "m1", created: false });
  assert.deepEqual(calls.map(c => c.method + " " + c.url), [`POST ${API}/workspaces/${WS}/semanticModels/m1/updateDefinition`]);
  assert.deepEqual(JSON.parse(calls[0].body), { definition: DEF });
});

test("write: a failed operation says why", async () => {
  const { model } = modelWith([
    ["POST", `/semanticModels/m1/updateDefinition`, () => res(202, "", { location: `${API}/operations/op2` })],
    ["GET", "/operations/op2", () => res(200, { status: "Failed", error: { message: "bad TMSL" } })],
  ]);
  await assert.rejects(model.write(WS, "sales", DEF, "m1"), /Updating the semantic model sales failed — bad TMSL/);
});

test("frame: a Direct Lake refresh with Power BI's token, waited for until it completes", async () => {
  const { model, calls } = modelWith([
    ["POST", `/groups/${WS}/datasets/m1/refreshes`, () => res(202, "", { location: `${PBI}/groups/${WS}/datasets/m1/refreshes/r1` })],
    ["GET", "/refreshes/r1", (_, n) => res(200, { status: n < 2 ? "Unknown" : "Completed" })],
  ]);
  await model.frame(WS, "m1");
  assert.equal(calls[0].auth, "Bearer pbi");
  assert.equal(JSON.parse(calls[0].body).type, "full");
  assert.equal(calls.length, 3);
  const failed = modelWith([
    ["POST", "/refreshes", () => res(202, "", { location: `${PBI}/r2` })],
    ["GET", "/r2", () => res(200, { status: "Failed", messages: [{ message: "table missing" }] })],
  ]);
  await assert.rejects(failed.model.frame(WS, "m1"), /Refreshing the semantic model failed — table missing/);
});

test("bindSso: every data source on OAuth2 with the caller's identity; taken over when it is someone else's", async () => {
  const { model, calls } = modelWith([
    ["GET", `/groups/${WS}/datasets/m1/datasources`, () => res(200, { value: [{ gatewayId: "g1", datasourceId: "d1" }] })],
    ["PATCH", "/gateways/g1/datasources/d1", (_, n) => res(n < 2 ? 403 : 200, n < 2 ? { error: { code: "NotOwner" } } : {})],
    ["POST", `/groups/${WS}/datasets/m1/Default.TakeOver`, () => res(200, {})],
  ]);
  await model.bindSso(WS, "m1");
  assert.deepEqual(calls.map(c => c.method), ["GET", "PATCH", "POST", "GET", "PATCH"]);
  const { credentialDetails: c } = JSON.parse(calls[4].body);
  assert.equal(c.credentialType, "OAuth2");
  assert.equal(c.useEndUserOAuth2Credentials, true);
  assert.deepEqual(JSON.parse(c.credentials), { credentialData: [{ name: "accessToken", value: "sql" }] });
});
