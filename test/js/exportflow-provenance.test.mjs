// Export to Fabric and Create Semantic Model, where a file or a model is someone else's: an app's file names
// the app it is published over, so one from elsewhere is asked about before it replaces anything, and a
// semantic model is taken over only on a yes. And a tile added while an export publishes stays in the file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { createExport } = require("../../fabric_app/export/exportflow.js");
const { writeApp, readApp } = require("../../fabric_app/export/exportapp.js");
const { createFabricModel } = require("../../fabric_app/export/fabricmodel.js");
const semantic = await import("../../page/semantic.js");

const URL_ = "https://onelake.dfs.fabric.microsoft.com/0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0/11111111-2222-3333-4444-555555555555";
const OSSIE = "version: 0.2.0.dev0\nname: Sales Model\ndatasets:\n  - name: fct_sales\n";
const doc = { version: "0.2.0.dev0", name: "Sales Model", datasets: [{ name: "fct_sales", source: "mart.fct_sales", fields: [{ name: "amount" }] }] };
const bim = { model: {
  expressions: [{ name: "DirectLake", expression: [`    Source = AzureStorage.DataLake("${URL_}", [HierarchicalNavigation=true])`] }],
  tables: [{ name: "fct_sales" }],
} };
const REQUEST = { file: "model.yaml", name: "sales", text: OSSIE, state: {}, workspace: "power bi", path: "nem.Lakehouse/Files/semantic_model/sales.yaml" };
const RAYFIN = "id: x\nname: x\nauth:\n  allowedRedirectUris:\n    - http://localhost:5173\n";
const EVIL = "https://evil.example/callback";

// An export that goes all the way, against a Fabric that only records what it was asked to publish.
async function setup({ answers = [], onPublish = async () => {}, fabricModel } = {}) {
  const ext = await mkdtemp(join(tmpdir(), "provenance-"));
  await mkdir(join(ext, "fabric-function"));
  await writeFile(join(ext, "fabric-function", "source.zip"), "zip");
  await writeFile(join(ext, "fabric-function", "deploymetadata.json"), "{}");
  await mkdir(join(ext, "vendor", "webapp"), { recursive: true });
  const asked = [], published = [];
  const kept = new Map();
  const ui = {
    openFolder: () => null,
    saveFile: async () => answers.shift() ?? null,
    info: async (message, ...rest) => { asked.push({ message, rest }); return undefined; },
    warn: async (message, ...rest) => { asked.push({ message, rest }); return answers.shift(); },
    withProgress: (_title, run) => run({ report() {} }),
    openExternal() {}, reveal() {},
  };
  const flow = createExport({
    connectivity: { offline: () => false, noInternet: () => false },
    modules: async () => ({ semantic, compiler: { parseYaml: () => doc, ossieToTmsl: () => bim } }),
    appToken: async () => "t",
    fabric: {
      workspaceId: async name => `id-of-${name}`,
      itemOf: async () => ({ workspace: "power bi", item: "nem.Lakehouse" }),
      sqlEndpoints: async () => [{ type: "Lakehouse", name: "nem", host: "x.datawarehouse.fabric.microsoft.com,1433" }],
    },
    ...(fabricModel ? { fabricModel } : {}),
    memento: { get: k => kept.get(k), update: async (k, v) => { kept.set(k, v); } },
    fabricAppOf: () => ({
      takenName: async () => null,
      deployStatus: async () => null,
      publish: async o => {
        published.push({ itemId: o.itemId, redirects: o.redirects });
        const id = o.itemId || "new-item";
        await o.onItem(id);
        await onPublish();
        return { itemId: id, hostingUrl: "https://app.example", redirects: o.redirects };
      },
    }),
    extensionDir: ext, reportDir: join(ext, "reports"), pageDir: async () => ext,
    ui, onRefresh() {}, log() {},
  });
  return { flow, asked, published, kept, ext, done: () => rm(ext, { recursive: true, force: true }) };
}

// An app's file as someone else's export wrote it: it names an item, and a redirect of its own.
async function appFile(dir, marker = {}) {
  const file = join(dir, "sales.fabricapp");
  await writeApp(file, new Map([["model.yaml", Buffer.from(OSSIE)], ["site/app.js", Buffer.from("// theirs")],
                                ["rayfin/rayfin.yml", Buffer.from(RAYFIN)], ["site/report.json", Buffer.from('{"tiles":[]}')]]),
    { name: "sales-model-explore", model: "power bi/nem.Lakehouse/Files/semantic_model/sales.yaml", engine: "duckdb", ...marker });
  return file;
}

test("an app's file from elsewhere is asked about before it is published over the app it names, and No publishes nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "provenance-app-"));
  const file = await appFile(dir, { itemId: "victim-item", redirects: [EVIL] });
  const { flow, asked, published, kept, done } = await setup({ answers: [undefined] });
  const e = await flow.exportExplore({ ...REQUEST, appFile: file }).then(() => null, x => x);
  assert.equal(e && e.declined, true, "a No is a refusal");
  assert.equal(published.length, 0, "nothing reached Fabric");
  assert.equal(asked.length, 1);
  assert.match(asked[0].message, /has not published sales\.fabricapp from this computer before\. Publish it over the app /);
  assert.match(asked[0].rest[0].detail, /is replaced by the pages in this file/);
  assert.ok(asked[0].rest[0].detail.includes(EVIL), "the redirects the file would add are shown");
  assert.deepEqual(asked[0].rest.slice(1), ["Publish It"]);
  assert.equal(kept.get("exportedItems"), undefined, "and it is not this computer's for having been asked about");
  await rm(dir, { recursive: true, force: true });
  await done();
});

test("on a yes it is published, and is this computer's from then on: the next export asks nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "provenance-app-"));
  const file = await appFile(dir, { itemId: "victim-item", redirects: [EVIL] });
  const { flow, asked, published, kept, done } = await setup({ answers: ["Publish It"] });
  await flow.exportExplore({ ...REQUEST, appFile: file });
  assert.deepEqual(published, [{ itemId: "victim-item", redirects: [EVIL] }]);
  assert.deepEqual(kept.get("exportedItems"), ["victim-item"]);
  const questions = () => asked.filter(a => /has not published/.test(a.message)).length;
  assert.equal(questions(), 1);
  await flow.exportExplore({ ...REQUEST, appFile: file });
  assert.equal(questions(), 1, "asked once");
  assert.equal(published.length, 2);
  await rm(dir, { recursive: true, force: true });
  await done();
});

test("a file that names no app yet is not asked about: its app is made here, and is this computer's", async () => {
  const dir = await mkdtemp(join(tmpdir(), "provenance-app-"));
  const file = await appFile(dir);
  const { flow, asked, published, kept, done } = await setup();
  await flow.exportExplore({ ...REQUEST, appFile: file });
  assert.equal(asked.filter(a => /has not published/.test(a.message)).length, 0);
  assert.deepEqual(published, [{ itemId: null, redirects: [] }]);
  assert.deepEqual(kept.get("exportedItems"), ["new-item"]);
  assert.equal((await readApp(file)).marker.itemId, "new-item");
  await rm(dir, { recursive: true, force: true });
  await done();
});

test("saving over a file from elsewhere asks too: it would publish over the app that file names", async () => {
  const dir = await mkdtemp(join(tmpdir(), "provenance-app-"));
  const file = await appFile(dir, { itemId: "victim-item" });
  const { flow, asked, published, done } = await setup({ answers: [file, undefined] });
  const e = await flow.exportExplore({ ...REQUEST, file: "sales.yaml" }).then(() => null, x => x);
  assert.equal(e && e.declined, true);
  assert.equal(published.length, 0);
  assert.match(asked[0].rest[0].detail, /is replaced by this Explore/);
  await rm(dir, { recursive: true, force: true });
  await done();
});

test("a tile added while the export publishes is still in the file when it is done", async () => {
  const dir = await mkdtemp(join(tmpdir(), "provenance-app-"));
  const file = await appFile(dir);
  const TILES = { tiles: [{ title: "added meanwhile", kind: "text", text: "hi" }] };
  let a;
  // Add to report, in the middle of the publish: into the same file (reportSave).
  const onPublish = async () => {
    const { stamp } = await a.flow.reportOf({ workspace: "power bi", model: "sales" });
    await a.flow.reportSave({ workspace: "power bi", model: "sales", spec: TILES, stamp });
  };
  a = await setup({ onPublish });
  await a.flow.exportExplore({ ...REQUEST, appFile: file });
  const after = await readApp(file);
  assert.deepEqual(JSON.parse(after.files.get("site/report.json").toString("utf8")), TILES, "the publish's last write kept it");
  assert.equal(after.marker.itemId, "new-item", "and the publish's own record is there too");
  await rm(dir, { recursive: true, force: true });
  await a.done();
});

// --- Create Semantic Model: someone else's model ---

const res = (status, body) => new Response(body == null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
// A Power BI whose data source refuses its credentials until the model is taken over.
function powerBi() {
  const calls = [];
  let taken = false;
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname.replace(/^\/v1(\.0\/myorg)?/, "");
    const method = init.method || "GET";
    calls.push(`${method} ${path}`);
    if (method === "GET" && /\/datasources$/.test(path)) return res(200, { value: [{ gatewayId: "g1", datasourceId: "d1" }] });
    if (method === "PATCH") return taken ? res(200, {}) : res(403, { error: { code: "NotOwner" } });
    if (/Default\.TakeOver$/.test(path)) { taken = true; return res(200, {}); }
    return res(404, { error: { code: "NotFound" } });
  };
  const model = createFabricModel({ getToken: async () => "t", powerBiToken: async () => "p", sqlToken: async () => "s",
                                    fetchImpl, sleep: async () => {}, log() {} });
  return { model, calls, taken: () => taken };
}

test("bindSso takes someone else's model over only after onTakeOver, and not at all when that throws", async () => {
  const no = powerBi();
  await assert.rejects(no.model.bindSso("ws", "m1", { onTakeOver: async () => { throw new Error("no"); } }), /^Error: no$/);
  assert.equal(no.taken(), false);
  assert.equal(no.calls.some(c => /TakeOver/.test(c)), false, "Power BI was never asked to");
  const yes = powerBi();
  let asked = 0;
  await yes.model.bindSso("ws", "m1", { onTakeOver: async () => { asked++; } });
  assert.equal(asked, 1);
  assert.equal(yes.taken(), true);
  // The owner's own model: no question at all.
  const own = powerBi();
  await own.model.bindSso("ws", "m1", { onTakeOver: async () => {} });
  let again = 0;
  await own.model.bindSso("ws", "m1", { onTakeOver: async () => { again++; } });
  assert.equal(again, 0, "its owner sets its sign-in with nothing asked");
});

test("Create Semantic Model asks before it takes a model over, and a No leaves it with its owner", async () => {
  const CREATE = { file: "sales.yaml", text: OSSIE, workspace: "power bi", path: "nem.Lakehouse/Files/semantic_model/sales.yaml", mode: "directquery" };
  const pbi = powerBi();
  const fabricModel = { find: async () => null, write: async () => ({ id: "m1" }), frame: async () => {}, bindSso: pbi.model.bindSso };
  const { flow, asked, done } = await setup({ answers: [undefined], fabricModel });
  const e = await flow.createSemanticModel(CREATE).then(() => null, x => x);
  assert.equal(e && e.declined, true);
  assert.match(e.message, /its sign-in to the SQL endpoint is not set: it is someone else's, and was not taken over/);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].message, "The semantic model sales is owned by someone else. Take it over?");
  assert.deepEqual(asked[0].rest.slice(1), ["Take It Over"]);
  assert.equal(pbi.taken(), false);
  await done();
  const yes = powerBi();
  const b = await setup({ answers: ["Take It Over"], fabricModel: { ...fabricModel, bindSso: yes.model.bindSso } });
  await b.flow.createSemanticModel(CREATE);
  assert.equal(yes.taken(), true);
  await b.done();
});
