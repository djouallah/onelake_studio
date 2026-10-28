// fabricapp.js: a Fabric app (AppBackend) created and deployed over the Fabric REST API, in
// the order and with the bodies `rayfin up` sends. No network: `fetch` is a script of canned
// answers, and every request is kept to be checked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createFabricApp, tenantOf, MONIKER } = require("../src/fabricapp.js");

const WS = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
const ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const API = "https://api.fabric.microsoft.com/v1";
const E = `${API}/workspaces/${WS}/appBackends/${ID}`;
const HOST = "https://sales-model-eastus.webapp.fabricapps.net";

const res = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: k => headers[k.toLowerCase()] ?? null },
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});

// answers: [[method, url-part, (init, n) => response]], the first that matches answers.
function appWith(answers, opts = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const method = init.method || "GET";
    calls.push({ url, method, headers: init.headers || {}, body: init.body });
    for (const a of answers) {
      const [m, part, make] = a;
      if (m === method && url.includes(part)) { a.n = (a.n || 0) + 1; return make(init, a.n); }
    }
    return res(404, { message: `no answer for ${method} ${url}` });
  };
  const app = createFabricApp({ getToken: async () => "tok", sleep: async () => {}, fetchImpl, ...opts });
  return { app, calls };
}

const happy = (over = []) => [
  ...over,
  ["GET", `/workspaces/${WS}/items?type=AppBackend`, () => res(200, { value: [] })],
  ["POST", `/workspaces/${WS}/items`, () => res(201, { id: ID, displayName: "sales-model", type: "AppBackend" })],
  ["GET", "/__private/extended-properties", (_, n) => res(200, { extendedProperties: n < 2 ? {} : { BaaSEndpoint: "https://baas.example" } })],
  ["GET", "/__private/publishable-key", () => res(200, '"pk-abc"')],
  ["POST", "/__private/projectRuntimeSettings", () => res(200, {})],
  ["POST", "/__private/secrets", () => res(200, { name: "CATALOG_URL" })],
  ["POST", "/__private/webapp/deploy", () => res(200, { success: true, hostingUrl: HOST, deploymentId: "d1" })],
  ["POST", "/__private/functions/deploy", () => res(202, { udfArtifactId: "udf-1" })],
  ["GET", "/userDataFunctions/udf-1/__private/functions/metadata", (_, n) => res(200, { deploy: { status: n < 2 ? "InProgress" : "Complete" } })],
];

const publish = (app, over = {}) => app.publish({
  workspaceId: WS, name: "sales-model", tenantId: "tid-1",
  catalogUrl: `https://onelake.table.fabric.microsoft.com/iceberg/${WS}/lh`,
  modelUrl: "https://onelake.dfs.fabric.microsoft.com/ws/nem.Lakehouse/Files/semantic_model/ossie.yaml",
  site: async config => { publish.config = config; return Buffer.from("PK-site"); },
  fn: { sourceZip: Buffer.from("PK-fn"), deployMetaData: '{"runtime":"TypeScript"}' },
  ...over,
});

test("publish: item, backend, key, settings, secrets, site, function, redirect — in the CLI's order", async () => {
  const { app, calls } = appWith(happy());
  const r = await publish(app);
  assert.deepEqual(r, { itemId: ID, hostingUrl: HOST, created: true, redirects: [HOST] });
  const seq = calls.map(c => `${c.method} ${c.url.replace(API, "").replace(`/workspaces/${WS}`, "")}`);
  assert.deepEqual(seq, [
    "GET /items?type=AppBackend",
    "POST /items",
    `GET /appBackends/${ID}/__private/extended-properties`,
    `GET /appBackends/${ID}/__private/extended-properties`,
    `GET /appBackends/${ID}/__private/publishable-key`,
    `POST /appBackends/${ID}/__private/projectRuntimeSettings`,
    `POST /appBackends/${ID}/__private/secrets`,
    `POST /appBackends/${ID}/__private/secrets`,
    `POST /appBackends/${ID}/__private/webapp/deploy`,
    `POST /appBackends/${ID}/__private/functions/deploy`,
    "GET /userDataFunctions/udf-1/__private/functions/metadata",
    "GET /userDataFunctions/udf-1/__private/functions/metadata",
    `POST /appBackends/${ID}/__private/projectRuntimeSettings`,
  ]);
  for (const c of calls) assert.equal(c.headers.authorization, "Bearer tok");
  for (const c of calls.filter(c => c.url.startsWith(E))) assert.equal(c.headers[MONIKER], ID, `${c.url} names the item`);

  assert.deepEqual(JSON.parse(calls[1].body), { type: "AppBackend", displayName: "sales-model" });
  const first = JSON.parse(calls[5].body);
  assert.equal(first.staticHosting.anonymousAccess, false, "the site is protected");
  assert.deepEqual(first.staticHosting, { enabled: true, folder: "dist", indexDocument: "index.html", anonymousAccess: false });
  assert.deepEqual(first.functions, { enabled: true, auth: { type: "application" } });
  assert.deepEqual(first.auth, { enabled: true, fabric: { enabled: true }, allowedRedirectUris: [] });
  assert.equal(first.packageVersions["@microsoft/rayfin-cli"], "1.36.2");
  assert.deepEqual(JSON.parse(calls[6].body), { name: "CATALOG_URL", value: `https://onelake.table.fabric.microsoft.com/iceberg/${WS}/lh` });
  assert.deepEqual(JSON.parse(calls[7].body), { name: "MODEL_URL", value: "https://onelake.dfs.fabric.microsoft.com/ws/nem.Lakehouse/Files/semantic_model/ossie.yaml" });
  assert.equal(calls[8].headers["content-type"], "application/zip");
  assert.equal(String(calls[8].body), "PK-site");
  const form = calls[9].body;
  assert.ok(form instanceof FormData);
  assert.equal(form.get("DeployMetaData"), '{"runtime":"TypeScript"}');
  assert.equal(form.get("isCompiledZip"), "true");
  assert.equal(form.get("SourceZipFile").name, "source.zip");
  assert.equal(calls[9].headers["content-type"], undefined, "fetch writes the multipart boundary");
  assert.deepEqual(JSON.parse(calls[12].body).auth.allowedRedirectUris, [HOST]);
  assert.deepEqual(publish.config, { apiUrl: "https://baas.example", publishableKey: "pk-abc", workspaceId: WS,
    itemId: ID, portalUrl: "https://app.fabric.microsoft.com/", tenantId: "tid-1" });
});

test("publish again: the item an earlier export created, by its id, its redirect already known — no create, no second settings", async () => {
  const { app, calls } = appWith(happy([
    ["GET", `/workspaces/${WS}/items?type=AppBackend`, () => res(200, { value: [{ id: ID, displayName: "Sales-Model" }] })],
  ]));
  const r = await publish(app, { redirects: [HOST], itemId: ID });
  assert.equal(r.created, false);
  assert.ok(!calls.some(c => c.method === "POST" && c.url.endsWith("/items")));
  assert.equal(calls.filter(c => c.url.endsWith("/projectRuntimeSettings")).length, 1);
  assert.deepEqual(JSON.parse(calls.find(c => c.url.endsWith("/projectRuntimeSettings")).body).auth.allowedRedirectUris, [HOST]);
});

test("a 202 create is followed; a 5xx create is looked for by name, never sent twice", async () => {
  const lro = appWith(happy([
    ["GET", "/operations/op-1", () => res(200, { status: "Succeeded" })],
    ["GET", `/workspaces/${WS}/items?type=AppBackend`, (_, n) => res(200, { value: n < 2 ? [] : [{ id: ID, displayName: "sales-model" }] })],
    ["POST", `/workspaces/${WS}/items`, () => res(202, {}, { location: `${API}/operations/op-1`, "retry-after": "1" })],
  ]));
  assert.equal((await publish(lro.app)).itemId, ID);

  const flaky = appWith(happy([
    ["GET", `/workspaces/${WS}/items?type=AppBackend`, (_, n) => res(200, { value: n < 2 ? [] : [{ id: ID, displayName: "sales-model" }] })],
    ["POST", `/workspaces/${WS}/items`, () => res(500, { message: "boom" })],
  ]));
  assert.equal((await publish(flaky.app)).itemId, ID);
  assert.equal(flaky.calls.filter(c => c.method === "POST" && c.url.endsWith("/items")).length, 1);
});

test("Fabric's own message is the error: a capacity refusal, a failed site, a failed function", async () => {
  const cap = appWith(happy([["POST", `/workspaces/${WS}/items`, () => res(400, { errorCode: "CapacityLimitExceeded", message: "no capacity" })]]));
  await assert.rejects(publish(cap.app), /Creating the app sales-model failed \(HTTP 400\) — no capacity/);
  const site = appWith(happy([["POST", "/__private/webapp/deploy", () => res(200, { success: false, errorMessage: "posture" })]]));
  await assert.rejects(publish(site.app), /Uploading the site failed: posture/);
  const fn = appWith(happy([["GET", "/__private/functions/metadata", () => res(200, { deploy: { status: "Fail", error: "bad bundle" } })]]));
  await assert.rejects(publish(fn.app), /Deploying the function failed — bad bundle/);
  await assert.rejects(publish(appWith(happy()).app, { site: async () => Buffer.alloc(101 * 1024 * 1024) }), /100 MB at most/);
});

test("a 401 is retried once with a fresh token; a not-ready deploy endpoint is retried", async () => {
  let fresh = 0;
  const { app, calls } = appWith(happy([
    ["GET", `/workspaces/${WS}/items?type=AppBackend`, (init, n) => res(n === 1 ? 401 : 200, { value: [{ id: ID, displayName: "sales-model" }] })],
    ["POST", "/__private/webapp/deploy", (_, n) => n < 3 ? res(503, {}) : res(200, { success: true, hostingUrl: HOST })],
  ]), { getToken: async o => (o && o.fresh ? (fresh++, "tok2") : "tok") });
  await publish(app, { itemId: ID });
  assert.equal(fresh, 1);
  assert.equal(calls[1].headers.authorization, "Bearer tok2");
  assert.equal(calls.filter(c => c.url.endsWith("/webapp/deploy")).length, 3);
});

test("deployStatus: the app's last deploy, named in the header; null when there is no such app", async () => {
  const { app, calls } = appWith([
    ["GET", `/appBackends/${ID}/__private/deploy/status`, () => res(200, { hostingUrl: HOST, lastSuccessfulDeploymentAt: "2026-10-28T07:32:09.0000000Z" })],
    ["GET", "/appBackends/gone/__private/deploy/status", () => res(404, { message: "not found" })],
  ]);
  assert.deepEqual(await app.deployStatus(WS, ID), { hostingUrl: HOST, lastSuccessfulDeploymentAt: "2026-10-28T07:32:09.0000000Z" });
  assert.equal(calls[0].headers[MONIKER], ID);
  assert.equal(await app.deployStatus(WS, "gone"), null);
  const denied = appWith([["GET", "/__private/deploy/status", () => res(403, { message: "no" })]]);
  await assert.rejects(denied.app.deployStatus(WS, ID), /HTTP 403/);
});

test("tenantOf: a token's tid", () => {
  const payload = Buffer.from(JSON.stringify({ tid: "t-1", aud: "x" })).toString("base64url");
  assert.equal(tenantOf(`h.${payload}.s`), "t-1");
  assert.equal(tenantOf("nope"), null);
});

test("an app of that name that no export created is never taken over unasked", async () => {
  const theirs = [["GET", `/workspaces/${WS}/items?type=AppBackend`, () => res(200, { value: [{ id: "theirs", displayName: "sales-model" }] })]];
  const refused = appWith(happy(theirs));
  await assert.rejects(publish(refused.app), e => e.code === "NAME_TAKEN" && e.item.id === "theirs");
  assert.equal(refused.calls.length, 1, "nothing but the listing: no settings, no upload");
  // An id kept from an earlier export that the workspace no longer has is no licence either.
  await assert.rejects(publish(appWith(happy(theirs)).app, { itemId: "gone" }), e => e.code === "NAME_TAKEN");
  // Asked, and told yes.
  const taken = appWith(happy(theirs));
  const r = await publish(taken.app, { takeOver: true });
  assert.equal(r.itemId, "theirs");
  assert.ok(!taken.calls.some(c => c.method === "POST" && c.url.endsWith("/items")));
});
