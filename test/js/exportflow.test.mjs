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
const { createExport } = require("../../fabric_app/export/exportflow.js");
const { writeApp, readApp, zip, SITE, FORMAT } = require("../../fabric_app/export/exportapp.js");
const semantic = await import("../../page/semantic.js");

const URL_ = "https://onelake.dfs.fabric.microsoft.com/0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0/11111111-2222-3333-4444-555555555555";
const OSSIE = "version: 0.2.0.dev0\nname: Sales Model\ndatasets:\n  - name: fct_sales\n";
const doc = { version: "0.2.0.dev0", name: "Sales Model", datasets: [{ name: "fct_sales", source: "mart.fct_sales", fields: [{ name: "amount" }] }] };
const bim = { model: {
  expressions: [{ name: "DirectLake", expression: [`    Source = AzureStorage.DataLake("${URL_}", [HierarchicalNavigation=true])`] }],
  tables: [{ name: "fct_sales" }],
} };
const REQUEST = { file: "sales.yaml", name: "sales", text: OSSIE, state: {}, workspace: "power bi", path: "nem.Lakehouse/Files/semantic_model/sales.yaml" };

// `models`: the workspace's semantic models by name.
async function setup({ offline = false, noInternet = false, answers = [], folder = null, token = "t", functionPackage = true,
                       models = {} } = {}) {
  const ext = await mkdtemp(join(tmpdir(), "exportflow-"));
  if (functionPackage) {
    await mkdir(join(ext, "fabric-function"));
    await writeFile(join(ext, "fabric-function", "source.zip"), "zip");
    await writeFile(join(ext, "fabric-function", "deploymetadata.json"), "{}");
    await writeFile(join(ext, "fabric-function", "agent-files.json"), JSON.stringify({ ".agents/skills/rayfin/SKILL.md": "# rayfin\n" }));
  }
  const asked = [];
  const looked = [];
  const kept = new Map();
  const ui = {
    openFolder: () => folder,
    saveFile: async o => { asked.push({ saveFile: o }); return answers.shift() ?? null; },
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
    },
    onelake: {}, catalog: {},
    fabricModel: {
      find: async (ws, name) => { looked.push({ ws, name }); return models[name] || null; },
      write: async () => { throw new Error("nothing is written in these tests"); },
    },
    memento: { get: k => kept.get(k), update: async (k, v) => { kept.set(k, v); } },
    // Fabric is never asked: the first call stops the export here.
    fabricAppOf: () => ({ takenName: async () => { throw new Error("stop: Fabric is not asked in these tests"); },
                          deployStatus: async () => null }),
    extensionDir: ext,
    reportDir: join(ext, "reports"),
    pageDir: async () => ext,
    ui,
    onRefresh() {},
    log() {},
  });
  const exportExplore = x => flow.exportExplore(x);
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
  await assert.rejects(exportExplore({ ...REQUEST, path: undefined, workspace: undefined }), /needs a model file: one in OneLake, or one from disk in a workspace/);
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

test("the Save dialog is the one question: named for the model file, in Documents the first time; Cancel writes and remembers nothing", async () => {
  const { exportExplore, asked, kept, done } = await setup({ answers: [null] });
  const e = await exportExplore(REQUEST).then(() => null, x => x);
  assert.equal(e.declined, true);
  assert.equal(e.message, "Export cancelled.");
  assert.equal(asked.length, 1);
  const o = asked[0].saveFile;
  assert.match(o.defaultPath, /[\\/]sales\.fabricator$/, "the file's own name, its extension Fabricator's project file's");
  assert.equal(o.title, "Export sales.fabricator to Fabric");
  assert.equal(o.saveLabel, "Export");
  assert.deepEqual(o.filters, { "Fabricator project": ["fabricator"] });
  assert.equal(kept.size, 0);
  await done();
});

test("an app saved before: the Save dialog opens on that file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "exportflow-saved-"));
  const { exportExplore, asked, kept, done } = await setup({ answers: [null] });
  const there = join(dir, "sales-model-explore.fabricator");
  kept.set("exportZip:0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0/11111111-2222-3333-4444-555555555555/sales-model-explore", there);
  await exportExplore(REQUEST).catch(() => {});
  assert.equal(asked[0].saveFile.defaultPath, there);
  // One saved as an earlier .fabricapp is offered by its .fabricator name.
  const b = await setup({ answers: [null] });
  b.kept.set("exportZip:0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0/11111111-2222-3333-4444-555555555555/sales-model-explore", join(dir, "sales-model-explore.fabricapp"));
  await b.exportExplore(REQUEST).catch(() => {});
  assert.equal(b.asked[0].saveFile.defaultPath, there);
  await b.done();
  await rm(dir, { recursive: true, force: true });
  await done();
});

for (const ext of [".zip", ".fabricapp"]) test(`an app an earlier export saved as ${ext}: offered as .fabricator, and renamed when saved there`, async () => {
  const dir = await mkdtemp(join(tmpdir(), "exportflow-old-"));
  const old = join(dir, `sales-model-explore${ext}`);
  await writeApp(old, new Map([["site/app.js", Buffer.from("// app")]]),
    { model: "power bi/nem.Lakehouse/Files/semantic_model/sales.yaml", files: { "site/app.js": "edited since" } });
  const now = join(dir, "sales-model-explore.fabricator");
  const { exportExplore, asked, kept, done } = await setup({ answers: [now, undefined] });
  kept.set("exportZip:0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0/11111111-2222-3333-4444-555555555555/sales-model-explore", old);
  const e = await exportExplore(REQUEST).then(() => null, x => x);
  assert.equal(asked[0].saveFile.defaultPath, now);
  assert.match(e.message, /stop: Fabric is not asked/, "on to Fabric");
  assert.equal(existsSync(old), false);
  assert.ok(await readApp(now), "the same app, by its new name");
  await rm(dir, { recursive: true, force: true });
  await done();
});

test("a model file's app: the Save dialog alone, and no semantic model looked up", async () => {
  const { exportExplore, asked, looked, done } = await setup({ answers: [null] });
  await exportExplore(REQUEST).catch(() => {});
  assert.equal(looked.length, 0);
  assert.equal(asked.length, 1, "the Save dialog alone");
  await done();
});

test("saving over an app's file rewrites it, with no question about what changed in it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "exportflow-over-"));
  const file = join(dir, "sales-model-explore.fabricator");
  await writeApp(file, new Map([["site/app.js", Buffer.from("// app")]]),
    { model: "power bi/nem.Lakehouse/Files/semantic_model/sales.yaml", files: { "site/app.js": "edited since" } });
  const { exportExplore, asked, done } = await setup({ answers: [file] });
  const e = await exportExplore(REQUEST).then(() => null, x => x);
  assert.match(e.message, /stop: Fabric is not asked/, "on to Fabric");
  assert.deepEqual(asked.map(a => (a.saveFile ? "save" : a.message)), ["save"], "the Save dialog alone");
  await rm(dir, { recursive: true, force: true });
  await done();
});

test("opening an app's file: its report is this file from now on, and its own model comes back", async () => {
  const dir = await mkdtemp(join(tmpdir(), "exportflow-open-app-"));
  const file = join(dir, "sales-model-explore.fabricator");
  await writeApp(file, new Map([["model.yaml", Buffer.from(OSSIE)], ["site/report.json", Buffer.from('{"tiles":[]}')]]),
    { name: "sales-model-explore", model: "power bi/nem.Lakehouse/Files/semantic_model/sales.yaml",
      workspaceId: "ws-id", lakehouseId: "lh-id", report: { workspace: "power bi", model: "sales" } });
  const { flow, kept, done } = await setup();
  const app = await flow.openApp(file);
  assert.deepEqual(app.report, { workspace: "power bi", model: "sales" });
  assert.deepEqual(app.copy, { name: "model.yaml", text: OSSIE });
  assert.equal(app.modelPath, "power bi/nem.Lakehouse/Files/semantic_model/sales.yaml");
  assert.equal(kept.get("exportReport:power bi/sales"), file, "the Report tab draws this file");
  assert.equal(kept.get("exportZip:ws-id/lh-id/sales-model-explore"), file, "the next export saves here");
  await assert.rejects(flow.openApp(join(dir, "gone.fabricapp")), /is gone/);
  await rm(dir, { recursive: true, force: true });
  await done();
});

test("an app's file opened from disk is exported as it is: no Save dialog, and no question about its changes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "exportflow-app-"));
  const file = join(dir, "sales-model-explore.fabricator");
  await writeApp(file, new Map([["model.yaml", Buffer.from(OSSIE)], ["site/app.js", Buffer.from("// app")]]),
    { model: "power bi/nem.Lakehouse/Files/semantic_model/sales.yaml", files: { "site/app.js": "edited since" } });
  const { exportExplore, asked, done } = await setup();
  const e = await exportExplore({ ...REQUEST, file: "model.yaml", appFile: file }).then(() => null, x => x);
  assert.match(e.message, /stop: Fabric is not asked/, "it went on to Fabric");
  assert.equal(asked.filter(a => a.saveFile).length, 0, "no Save dialog");
  assert.equal(asked.filter(a => /has changed since/.test(a.message || "")).length, 0, "its changes are what is published");
  await rm(dir, { recursive: true, force: true });
  await done();
});

test("an earlier .fabricapp opened from disk is published from its .fabricator: renamed, laid out as one, nothing asked", async () => {
  const dir = await mkdtemp(join(tmpdir(), "exportflow-legacy-"));
  const old = join(dir, "sales.fabricapp");
  await writeFile(old, await zip([["model.yaml", Buffer.from(OSSIE)], ["site/app.js", Buffer.from("// app")],
    ["export.json", Buffer.from(JSON.stringify({ model: "power bi/nem.Lakehouse/Files/semantic_model/sales.yaml" }))]]));
  const { exportExplore, asked, done } = await setup();
  const e = await exportExplore({ ...REQUEST, file: "model.yaml", appFile: old }).then(() => null, x => x);
  assert.match(e.message, /stop: Fabric is not asked/, "it went on to Fabric");
  assert.equal(asked.length, 0, "no Save dialog, no question");
  assert.equal(existsSync(old), false);
  const app = await readApp(join(dir, "sales.fabricator"));
  assert.equal(app.files.get(`${SITE}app.js`).toString(), "// app", "its site where a .fabricator has it");
  await rm(dir, { recursive: true, force: true });
  await done();
});

// Create Semantic Model: only replacing one is asked.
const CREATE = { file: "sales.yaml", text: OSSIE, workspace: "power bi", path: "nem.Lakehouse/Files/semantic_model/sales.yaml" };

test("Create Semantic Model: a new one is not asked about, one there is", async () => {
  const a = await setup({ models: { sales: { id: "m1", displayName: "sales" } }, answers: [undefined] });
  const e = await a.flow.createSemanticModel(CREATE).then(() => null, x => x);
  assert.equal(e.declined, true);
  assert.equal(a.asked.length, 1, "one question");
  assert.equal(a.asked[0].message, "Update the semantic model sales?");
  assert.deepEqual(a.asked[0].rest.slice(1), ["Update"]);
  assert.match(a.asked[0].rest[0].detail, /^Workspace: power bi\nFrom: nem\.Lakehouse\/Files\/semantic_model\/sales\.yaml\n\npower bi already has a semantic model of this name: its definition is replaced\.$/);
  await a.done();
  const b = await setup();
  await assert.rejects(b.flow.createSemanticModel(CREATE), /nothing is written in these tests/, "on to writing it");
  assert.equal(b.asked.length, 0);
  await b.done();
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
  await assert.rejects(flow.reportSave({ ...MODEL, spec: { pages: [{ name: "Sales" }] }, stamp }), /a report is/, "a page with no tiles list");
  // Pages, as the Report saves them now.
  const PAGES = { pages: [{ name: "Sales", tiles: TILES.tiles }, { name: "Notes", tiles: [{ title: "", kind: "text", text: "# Hi" }] }] };
  const paged = await flow.reportSave({ ...MODEL, spec: PAGES, stamp });
  assert.deepEqual((await flow.reportOf(OPENED)).spec, PAGES);
  assert.ok(paged.stamp != null);
  await done();
});

test("with an export's zip, the Report is the zip's site/public/report.json: saved into it, its other entries and marker kept", async () => {
  const open = await mkdtemp(join(tmpdir(), "exportflow-open-"));
  const zipPath = join(open, "sales-model-explore.fabricator");
  const marker = { model: "power bi/nem.Lakehouse/Files/semantic_model/sales.yaml", files: { [`${SITE}app.js`]: "h" } };
  await writeApp(zipPath, new Map([[`${SITE}app.js`, Buffer.from("// app")], [`${SITE}report.json`, Buffer.from('{ "tiles": [] }')]]), marker);
  const { flow, kept, done } = await setup();
  // A file from before the export is not read once there is a zip.
  await flow.reportSave({ ...MODEL, spec: { tiles: [{ title: "old", kind: "kpi", sql: "SELECT 1 FROM model" }] }, stamp: 0 });
  kept.set("exportReport:power bi/sales", zipPath);
  const before = await flow.reportOf(OPENED);
  assert.deepEqual([before.spec, before.from], [{ tiles: [] }, zipPath]);
  await flow.reportSave({ ...MODEL, spec: TILES, stamp: before.stamp });
  const app = await readApp(zipPath);
  assert.deepEqual(JSON.parse(app.files.get(`${SITE}report.json`).toString("utf8")), TILES);
  assert.equal(app.files.get(`${SITE}app.js`).toString("utf8"), "// app");
  assert.deepEqual(app.marker, { ...marker, format: FORMAT });
  assert.deepEqual((await flow.reportOf(OPENED)).spec, TILES);
  await rm(open, { recursive: true, force: true });
  await done();
});
