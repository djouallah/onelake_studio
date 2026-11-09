// exportflow.js: Export to Fabric's questions, through a fake `ui`. All of them come before anything is
// written, and a No is a refusal rather than a failure. What it publishes is exportapp's and
// fabricapp's, tested beside them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { createExport } = require("../../src/exportflow.js");
const { writeApp, readApp } = require("../../src/exportapp.js");
const semantic = await import("../../app/semantic.js");

const URL_ = "https://onelake.dfs.fabric.microsoft.com/0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0/11111111-2222-3333-4444-555555555555";
const OSSIE = "version: 0.2.0.dev0\nname: Sales Model\ndatasets:\n  - name: fct_sales\n";
const doc = { version: "0.2.0.dev0", name: "Sales Model", datasets: [{ name: "fct_sales", source: "mart.fct_sales", fields: [{ name: "amount" }] }] };
const bim = { model: {
  expressions: [{ name: "DirectLake", expression: [`    Source = AzureStorage.DataLake("${URL_}", [HierarchicalNavigation=true])`] }],
  tables: [{ name: "fct_sales" }],
} };
const REQUEST = { file: "sales.yaml", name: "sales", text: OSSIE, state: {}, workspace: "power bi", path: "nem.Lakehouse/Files/semantic_model/sales.yaml" };

// `mode`: what Explore's Export window sends (null: none, as the command line without --mode). `models`: the workspace's semantic models by name.
async function setup({ offline = false, noInternet = false, answers = [], folder = null, token = "t", functionPackage = true,
                       mode = "client", models = {} } = {}) {
  const ext = await mkdtemp(join(tmpdir(), "exportflow-"));
  if (functionPackage) {
    await mkdir(join(ext, "fabric-function"));
    await writeFile(join(ext, "fabric-function", "source.zip"), "zip");
    await writeFile(join(ext, "fabric-function", "deploymetadata.json"), "{}");
  }
  const asked = [];
  const looked = [];
  const kept = new Map();
  const ui = {
    openFolder: () => folder,
    pickFolder: async o => { asked.push({ pickFolder: o }); return answers.shift() ?? null; },
    info: async (message, ...rest) => { asked.push({ message, rest }); return answers.shift(); },
    warn: async (message, ...rest) => { asked.push({ message, rest }); return answers.shift(); },
    withProgress: () => { throw new Error("nothing is written in these tests"); },
    openExternal() {}, reveal() {},
  };
  const flow = createExport({
    connectivity: { offline: () => offline, noInternet: () => noInternet },
    modules: async () => ({ semantic, compiler: { parseYaml: () => doc, ossieToTmsl: () => bim } }),
    hostToken: async () => token,
    appToken: async () => token,
    fabric: {
      workspaceId: async name => `id-of-${name}`,
      itemOf: async () => ({ workspace: "power bi", item: "nem.Lakehouse" }),
      sqlEndpoints: async () => [{ type: "Lakehouse", name: "nem", host: "x.datawarehouse.fabric.microsoft.com,1433" }],
    },
    onelake: {}, catalog: {},
    fabricModel: {
      find: async (ws, name) => { looked.push({ ws, name }); return models[name] || null; },
      write: async () => { throw new Error("nothing is written in these tests"); },
    },
    memento: { get: k => kept.get(k), update: async (k, v) => { kept.set(k, v); } },
    extensionDir: ext,
    reportDir: join(ext, "reports"),
    pageDir: async () => ext,
    ui,
    onRefresh() {},
    log() {},
  });
  const exportExplore = x => flow.exportExplore(mode == null || x.mode ? x : { ...x, mode });
  return { exportExplore, flow, asked, looked, kept, ext, done: () => rm(ext, { recursive: true, force: true }) };
}

test("offline says why, before anything is asked", async () => {
  const a = await setup({ offline: true, noInternet: true });
  await assert.rejects(a.exportExplore(REQUEST), /needs a connection, and there is no internet/);
  assert.equal(a.asked.length, 0);
  await a.done();
  const b = await setup({ offline: true });
  await assert.rejects(b.exportExplore(REQUEST), /needs a connection, and you are not signed in/);
  await b.done();
});

test("a local model with nowhere known to go is refused, not asked about", async () => {
  const { exportExplore, asked, done } = await setup();
  await assert.rejects(exportExplore({ ...REQUEST, path: undefined, workspace: undefined, model: null }), /needs a model that is a OneLake file/);
  assert.equal(asked.length, 0);
  await done();
});

test("a build with no function package says so", async () => {
  const { exportExplore, done } = await setup({ functionPackage: false });
  await assert.rejects(exportExplore(REQUEST), /no function package/);
  await done();
});

test("no token for the Fabric API stops it before a question", async () => {
  const { exportExplore, asked, done } = await setup({ token: null });
  await assert.rejects(exportExplore(REQUEST), /not signed in to the Fabric API/);
  assert.equal(asked.length, 0);
  await done();
});

test("with no folder open it asks for one, and dismissing that is a refusal", async () => {
  const { exportExplore, asked, done } = await setup({ answers: [null] });
  const e = await exportExplore(REQUEST).then(() => null, x => x);
  assert.equal(e.declined, true);
  assert.equal(e.message, "Export cancelled.");
  assert.ok(asked[0].pickFolder);
  await done();
});

test("where it goes is shown first: a No leaves nothing written and nothing remembered", async () => {
  const dir = await mkdtemp(join(tmpdir(), "exportflow-open-"));
  const { exportExplore, asked, kept, done } = await setup({ folder: dir, answers: [undefined] });
  const e = await exportExplore(REQUEST).then(() => null, x => x);
  assert.equal(e.declined, true);
  assert.match(asked[0].message, /^Export .* to Fabric\?$/);
  assert.equal(asked[0].rest[0].modal, true);
  assert.match(asked[0].rest[0].detail, /^Local copy: .*sales-model-explore\.zip \(new\)\n/, "the app is one file");
  assert.doesNotMatch(asked[0].rest[0].detail, /no longer used/);
  assert.equal(kept.size, 0);
  assert.equal(existsSync(join(dir, "sales-model-explore.zip")), false);
  await rm(dir, { recursive: true, force: true });
  await done();
});

test("Choose Another Folder asks again, starting where the last one was", async () => {
  const open = await mkdtemp(join(tmpdir(), "exportflow-open-"));
  const { exportExplore, asked, done } = await setup({ folder: open, answers: ["Choose Another Folder…", null] });
  const e = await exportExplore(REQUEST).then(() => null, x => x);
  assert.equal(e.declined, true);
  assert.equal(asked[1].pickFolder.startAt, open);
  await rm(open, { recursive: true, force: true });
  await done();
});

test("no mode given is Direct Lake; an unknown one is refused", async () => {
  const dir = await mkdtemp(join(tmpdir(), "exportflow-open-"));
  const a = await setup({ mode: null, folder: dir, answers: [undefined] });
  await a.exportExplore(REQUEST).catch(() => {});
  assert.match(a.asked[0].rest[0].detail, /\nSemantic model: sales, Direct Lake \(new\)$/);
  await rm(dir, { recursive: true, force: true });
  await a.done();
  const b = await setup();
  await assert.rejects(b.exportExplore({ ...REQUEST, mode: "import" }), /no mode import: client, directquery or directlake/);
  await b.done();
});

test("client side makes no semantic model", async () => {
  const dir = await mkdtemp(join(tmpdir(), "exportflow-open-"));
  const { exportExplore, asked, looked, done } = await setup({ folder: dir, answers: [undefined] });
  await exportExplore(REQUEST).catch(() => {});
  assert.equal(looked.length, 0);
  assert.doesNotMatch(asked[0].rest[0].detail, /Semantic model/);
  await rm(dir, { recursive: true, force: true });
  await done();
});

test("Direct Lake: the model's semantic model is looked up by name first, the dialog says it is updated, and a No writes nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "exportflow-open-"));
  const { exportExplore, asked, looked, done } = await setup({ folder: dir, answers: [undefined], mode: "directLake",
                                                              models: { sales: { id: "m1", displayName: "sales" } } });
  const e = await exportExplore(REQUEST).then(() => null, x => x);
  assert.equal(e.declined, true);
  assert.deepEqual(looked, [{ ws: "id-of-power bi", name: "sales" }]);
  assert.match(asked[0].rest[0].detail, /\nSemantic model: sales, Direct Lake \(updated\)$/);
  await rm(dir, { recursive: true, force: true });
  await done();
});

test("DirectQuery: a new semantic model, on the lakehouse's SQL endpoint", async () => {
  const dir = await mkdtemp(join(tmpdir(), "exportflow-open-"));
  const { exportExplore, asked, done } = await setup({ folder: dir, answers: [undefined], mode: "directQuery" });
  await exportExplore(REQUEST).catch(() => {});
  assert.match(asked[0].rest[0].detail, /\nSemantic model: sales, DirectQuery \(new\)$/);
  await rm(dir, { recursive: true, force: true });
  await done();
});

// A semantic model opened from the tree: its local copy, with no file in OneLake.
const { workspace: _w, path: _p, ...ON_MODEL } = REQUEST;

test("a semantic model opened from the tree is exported as it is: found by its workspace and name, nothing asked of a lakehouse", async () => {
  const dir = await mkdtemp(join(tmpdir(), "exportflow-open-"));
  const { exportExplore, asked, looked, done } = await setup({ folder: dir, answers: [undefined], mode: null,
                                                              models: { "NEM Sales": { id: "m1", displayName: "NEM Sales" } } });
  const e = await exportExplore({ ...ON_MODEL, model: { workspace: "aemo", name: "NEM Sales" } }).then(() => null, x => x);
  assert.equal(e.declined, true);
  assert.deepEqual(looked, [{ ws: "id-of-aemo", name: "NEM Sales" }]);
  const { detail } = asked[0].rest[0];
  assert.match(detail, /\nWorkspace: aemo\nSemantic model: NEM Sales, as it is \(not changed\)$/);
  assert.doesNotMatch(detail, /Model: |\.yaml|Direct Lake|DirectQuery/, "no model file, and no mode");
  await rm(dir, { recursive: true, force: true });
  await done();
});

test("a semantic model takes no mode, and one gone from its workspace is said", async () => {
  const a = await setup({ mode: "directLake" });
  await assert.rejects(a.exportExplore({ ...ON_MODEL, model: { workspace: "aemo", name: "NEM Sales" } }), /NEM Sales is a semantic model: its app runs on it as it is, with no mode/);
  await a.done();
  const b = await setup({ mode: null });
  await assert.rejects(b.exportExplore({ ...ON_MODEL, model: { workspace: "aemo", name: "NEM Sales" } }), /aemo has no semantic model NEM Sales any more/);
  assert.equal(b.asked.length, 0);
  await b.done();
});

test("an earlier export's folder is no longer used, and the dialog says it can be deleted", async () => {
  const open = await mkdtemp(join(tmpdir(), "exportflow-open-"));
  await mkdir(join(open, "sales-model-explore"));
  await writeFile(join(open, "sales-model-explore", ".onelake-studio-export.json"), JSON.stringify({ itemId: "item" }));
  const { exportExplore, asked, done } = await setup({ folder: open, answers: [undefined] });
  await exportExplore(REQUEST).catch(() => {});
  assert.match(asked[0].rest[0].detail, /The app is one file now: the folder .*sales-model-explore is no longer used, and can be deleted\./);
  await rm(open, { recursive: true, force: true });
  await done();
});

test("Publish As Is only for a zip made for the same kind of site: DuckDB in the browser, or a semantic model", async () => {
  const cases = [
    // [what the zip was made for, the site it has, this export, As Is offered, why not]
    ["duckdb", {}, "directLake", false, /the zip was made for Client side, and this export is Direct Lake, so only Overwrite changes what the app runs on\./],
    [undefined, { "site/engine.json": '{"engine":"semanticModel"}' }, "client", false, /the zip was made for a semantic model, and this export is Client side/],
    ["directQuery", { "site/engine.json": '{"engine":"semanticModel"}' }, "directLake", true, null],
  ];
  for (const [engine, site, mode, offered, why] of cases) {
    const open = await mkdtemp(join(tmpdir(), "exportflow-open-"));
    const files = new Map([["site/app.js", Buffer.from("// app")], ...Object.entries(site).map(([p, body]) => [p, Buffer.from(body)])]);
    await writeApp(join(open, "sales-model-explore.zip"), files, {
      model: "power bi/nem.Lakehouse/Files/semantic_model/sales.yaml", engine, files: { "site/app.js": "edited since" } });
    const { exportExplore, asked, done } = await setup({ folder: open, answers: ["Export", undefined], mode });
    const e = await exportExplore(REQUEST).then(() => null, x => x);
    assert.equal(e.declined, true);
    assert.equal(e.message, "Not exported: the local copy has changes.");
    const [o, ...buttons] = asked[1].rest;
    assert.match(asked[1].message, /has changed since it was last published/);
    assert.deepEqual(buttons, offered ? ["Overwrite Local Changes", "Publish As Is"] : ["Overwrite Local Changes"], `${engine} -> ${mode}`);
    if (why) assert.match(o.detail, why);
    else assert.match(o.detail, /Publish As Is: publish the zip's site/);
    await rm(open, { recursive: true, force: true });
    await done();
  }
});

// The Report tab's tiles, as Add to report and a tile's ✕ save them (reportSave).
const MODEL = { workspace: "power bi", model: "sales" };
const OPENED = MODEL;
const TILES = { tiles: [{ title: "Total Fare by Borough", kind: "pivot", pivot: { rows: ["dim_zone.Borough"], values: ["Total Fare"] } }] };

test("before an export, the Report is kept in Studio's file, and a save over a newer edit is refused", async () => {
  const { flow, done } = await setup();
  const first = await flow.reportOf(OPENED);
  assert.deepEqual([first.spec, first.from, first.stamp], [{ tiles: [] }, null, 0], "no tiles, nothing written");
  const { stamp } = await flow.reportSave({ ...MODEL, spec: TILES, stamp: first.stamp });
  const back = await flow.reportOf(OPENED);
  assert.deepEqual(back.spec, TILES);
  assert.equal(back.stamp, stamp);
  assert.match(back.from, /reports[\\/][0-9a-f]{40}\.json$/);
  assert.deepEqual((await flow.reportOf({ ...OPENED, workspace: "POWER BI", model: "Sales" })).spec, TILES, "by its names, case aside");
  assert.equal(await flow.reportStamp(MODEL), stamp);
  // Drawn before the file was written, saved after: refused, the file as it was.
  await assert.rejects(flow.reportSave({ ...MODEL, spec: { tiles: [] }, stamp: first.stamp }), /changed since it was drawn/);
  assert.deepEqual((await flow.reportOf(OPENED)).spec, TILES);
  await assert.rejects(flow.reportSave({ ...MODEL, spec: { title: "no tiles" }, stamp }), /a report is/);
  await done();
});

test("with an export's zip, the Report is the zip's site/report.json: saved into it, its other entries and marker kept", async () => {
  const open = await mkdtemp(join(tmpdir(), "exportflow-open-"));
  const zipPath = join(open, "sales-model-explore.zip");
  const marker = { model: "power bi/nem.Lakehouse/Files/semantic_model/sales.yaml", files: { "site/app.js": "h" } };
  await writeApp(zipPath, new Map([["site/app.js", Buffer.from("// app")], ["site/report.json", Buffer.from('{ "tiles": [] }')]]), marker);
  const { flow, kept, done } = await setup();
  // A file from before the export is not read once there is a zip.
  await flow.reportSave({ ...MODEL, spec: { tiles: [{ title: "old", kind: "kpi", sql: "SELECT 1 FROM model" }] }, stamp: 0 });
  kept.set("exportReport:power bi/sales", zipPath);
  const before = await flow.reportOf(OPENED);
  assert.deepEqual([before.spec, before.from], [{ tiles: [] }, zipPath]);
  await flow.reportSave({ ...MODEL, spec: TILES, stamp: before.stamp });
  const app = await readApp(zipPath);
  assert.deepEqual(JSON.parse(app.files.get("site/report.json").toString("utf8")), TILES);
  assert.equal(app.files.get("site/app.js").toString("utf8"), "// app");
  assert.deepEqual(app.marker, marker);
  assert.deepEqual((await flow.reportOf(OPENED)).spec, TILES);
  await rm(open, { recursive: true, force: true });
  await done();
});
