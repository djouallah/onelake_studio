// Export to Fabric, where a file is someone else's: an app's file names
// the app it is published over, so one from elsewhere is asked about before it replaces anything.
// And a tile added while an export publishes stays in the file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile, rm, cp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { createExport } = require("../../fabric_app/export/exportflow.js");
const { writeApp, readApp, unzip, SITE } = require("../../fabric_app/export/exportapp.js");
const { PINS } = require("../../core/vendored.js");
const semantic = await import("../../page/semantic.js");

const URL_ = "https://onelake.dfs.fabric.microsoft.com/0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0/11111111-2222-3333-4444-555555555555";
const OSSIE = "version: 0.3.0.dev0\nname: Sales Model\ndatasets:\n  - name: fct_sales\n";
const doc = { version: "0.3.0.dev0", name: "Sales Model", datasets: [{ name: "fct_sales", source: "mart.fct_sales", fields: [{ name: "amount" }] }] };
const bim = { model: {
  expressions: [{ name: "DirectLake", expression: [`    Source = AzureStorage.DataLake("${URL_}", [HierarchicalNavigation=true])`] }],
  tables: [{ name: "fct_sales" }],
} };
const REQUEST = { file: "model.yaml", name: "sales", text: OSSIE, state: {}, workspace: "power bi", path: "nem.Lakehouse/Files/semantic_model/sales.yaml" };
const RAYFIN = "id: x\nname: x\nauth:\n  allowedRedirectUris:\n    - http://localhost:5173\n";
const EVIL = "https://evil.example/callback";

// An export that goes all the way, against a Fabric that only records what it was asked to publish.
async function setup({ answers = [], onPublish = async () => {} } = {}) {
  const ext = await mkdtemp(join(tmpdir(), "provenance-"));
  await mkdir(join(ext, "fabric-function"));
  await writeFile(join(ext, "fabric-function", "source.zip"), "zip");
  await writeFile(join(ext, "fabric-function", "deploymetadata.json"), "{}");
  await writeFile(join(ext, "fabric-function", "agent-files.json"), JSON.stringify({ ".agents/skills/rayfin/SKILL.md": "# rayfin\n" }));
  await mkdir(join(ext, "vendor", "webapp"), { recursive: true });
  // The page as Vite built it (scripts/site-bundle.mjs makes it, with npm): what a publish uploads.
  await mkdir(join(ext, "fabric-site"), { recursive: true });
  await writeFile(join(ext, "fabric-site", "index.html"), "<!doctype html>built\n");
  // What a file's page is written from, an as-is file's too: this build's.
  await buildable(ext);
  const asked = [], published = [], sites = [];
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
    },
    memento: { get: k => kept.get(k), update: async (k, v) => { kept.set(k, v); } },
    fabricAppOf: () => ({
      takenName: async () => null,
      deployStatus: async () => null,
      publish: async o => {
        published.push({ itemId: o.itemId, redirects: o.redirects });
        // What it would upload, as fabricapp.js asks for it once it knows the backend.
        sites.push(unzip(await o.site({ apiUrl: "https://backend" })));
        const id = o.itemId || "new-item";
        await o.onItem(id);
        await onPublish();
        // As fabricapp.js answers: the site's backend too, which the file keeps for rayfin up.
        return { itemId: id, hostingUrl: "https://app.example", redirects: o.redirects,
                 config: { apiUrl: "https://backend", publishableKey: "pk", workspaceId: o.workspaceId, itemId: id, portalUrl: "https://app.fabric.microsoft.com/" } };
      },
    }),
    extensionDir: ext, reportDir: join(ext, "reports"), pageDir: async () => ext,
    ui, onRefresh() {}, log() {},
  });
  return { flow, asked, published, sites, kept, ext, done: () => rm(ext, { recursive: true, force: true }) };
}

// An app's file as someone else's export wrote it: it names an item, and a redirect of its own.
async function appFile(dir, marker = {}) {
  const file = join(dir, "sales.fabricator");
  await writeApp(file, new Map([["model.yaml", Buffer.from(OSSIE)], [`${SITE}app.js`, Buffer.from("// theirs")],
                                ["rayfin/rayfin.yml", Buffer.from(RAYFIN)], [`${SITE}report.json`, Buffer.from('{"tiles":[]}')]]),
    { name: "sales-model-explore", model: "power bi/nem.Lakehouse/Files/semantic_model/sales.yaml", ...marker });
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
  assert.match(asked[0].message, /has not published sales\.fabricator from this computer before\. Publish it over the app /);
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
  assert.deepEqual(kept.get("exportedItems"), { "victim-item": file }, "with the file it was published from");
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
  assert.deepEqual(kept.get("exportedItems"), { "new-item": file });
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

// What a new file is written from (appFiles): this checkout's fabric_app/ and page/, in the extension's folder as
// a build lays them out, and a stand-in for dax-sql, which the suite runs without (vendor/ is fetched).
async function buildable(ext) {
  const root = new URL("../../", import.meta.url);
  for (const d of ["site", "project", "rayfin"]) {
    await cp(new URL(`fabric_app/${d}/`, root), join(ext, "fabric_app", d), { recursive: true, filter: s => !/node_modules/.test(s) });
  }
  // Studio's Explore, where pageDir() says (the extension's folder, in setup).
  await cp(new URL("page/explore/", root), join(ext, "explore"), { recursive: true });
  await cp(new URL("page/paths.js", root), join(ext, "paths.js"));
  const dax = join(ext, "vendor", "npm", PINS.daxSql);
  await mkdir(join(dax, "src"), { recursive: true });
  await mkdir(join(dax, "formats"), { recursive: true });
  await writeFile(join(dax, "src", "index.js"), "// dax-sql\n");
  await writeFile(join(dax, "formats", "tmsl.js"), "// tmsl\n");
}

// A Save As to another file: the Report tab drew the model's Report from the file it was exported to before (or
// from Studio's own file, before any export), and draws the new file's from now on. The new file starts from
// those tiles. It started empty, and the Report tab then drew no tiles at all (the user's nem, 2026-11-17).
test("an export saved to another file keeps the Report the Report tab drew", async () => {
  const dir = await mkdtemp(join(tmpdir(), "provenance-saveas-"));
  const TILES = { pages: [{ name: "Page 1", tiles: [{ title: "Generation MW by year", kind: "pivot", pivot: { rows: [], values: ["MW"] } }] }] };
  const MODEL = { workspace: "power bi", model: "sales" };
  // The earlier file, which the Report tab draws, with its tiles.
  const earlier = await appFile(dir, { itemId: "the-item" });
  const a = await setup({ answers: [join(dir, "sales-client-side.fabricator")] });
  await buildable(a.ext);
  a.kept.set("exportReport:power bi/sales", earlier);
  a.kept.set("exportedItems", { "the-item": earlier });
  const { stamp } = await a.flow.reportOf(MODEL);
  await a.flow.reportSave({ ...MODEL, spec: TILES, stamp });
  await a.flow.exportExplore({ ...REQUEST, file: "sales.yaml" });
  const saved = await readApp(join(dir, "sales-client-side.fabricator"));
  assert.deepEqual(JSON.parse(saved.files.get(`${SITE}report.json`).toString("utf8")), TILES, "the new file has the tiles");
  const drawn = await a.flow.reportOf(MODEL);
  assert.equal(drawn.from, join(dir, "sales-client-side.fabricator"), "the Report tab draws the new file");
  assert.deepEqual(drawn.spec, TILES, "with the same tiles");
  assert.deepEqual(JSON.parse((await readApp(earlier)).files.get(`${SITE}report.json`).toString("utf8")), TILES, "the earlier file keeps its own");
  await a.done();

  // Before any export: the tiles are in Studio's own file, and the first file starts from them.
  const b = await setup({ answers: [join(dir, "first.fabricator")] });
  await buildable(b.ext);
  await b.flow.reportSave({ ...MODEL, spec: TILES, stamp: 0 });
  const studio = (await b.flow.reportOf(MODEL)).from;
  await b.flow.exportExplore({ ...REQUEST, file: "sales.yaml" });
  assert.deepEqual(JSON.parse((await readApp(join(dir, "first.fabricator"))).files.get(`${SITE}report.json`).toString("utf8")), TILES);
  assert.deepEqual((await b.flow.reportOf(MODEL)).spec, TILES);
  assert.equal(existsSync(studio), false, "Studio's own file goes: the zip holds the Report now");
  await b.done();
  await rm(dir, { recursive: true, force: true });
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
  assert.deepEqual(JSON.parse(after.files.get(`${SITE}report.json`).toString("utf8")), TILES, "the publish's last write kept it");
  assert.equal(after.marker.itemId, "new-item", "and the publish's own record is there too");
  // The app as rayfin up records it, so Fabricator's publish updates this app; and the site's backend.
  const reg = JSON.parse(after.files.get("rayfin/.deployments.json").toString("utf8"));
  assert.equal(reg.active, "power-bi");
  assert.equal(reg.deployments["power-bi"].fabricItemId, "new-item");
  assert.equal(reg.deployments["power-bi"].hostingUrl, "https://app.example");
  assert.equal(JSON.parse(after.files.get(`${SITE}rayfin.config.json`).toString("utf8")).itemId, "new-item");
  assert.match(after.files.get("rayfin/.env.secrets").toString("utf8"), /^CATALOG_URL=https:\/\/onelake\.table\.fabric\.microsoft\.com\/iceberg\/.*\nTABLES=mart\.fct_sales\n$/);
  await rm(dir, { recursive: true, force: true });
  await a.done();
});

test("a file that names an app this computer did publish, but is another file, is asked about too", async () => {
  const dir = await mkdtemp(join(tmpdir(), "provenance-app-"));
  const mine = await appFile(dir, { itemId: "my-item" });
  const { flow, asked, published, kept, done } = await setup({ answers: [undefined] });
  kept.set("exportedItems", { "my-item": mine });
  await flow.exportExplore({ ...REQUEST, appFile: mine });
  assert.equal(asked.filter(a => /has not published/.test(a.message)).length, 0, "its own file asks nothing");
  // The same app named by a file that came from somewhere else: its pages are not this computer's.
  const theirs = join(dir, "from-a-colleague", "sales.fabricator");
  await mkdir(join(dir, "from-a-colleague"));
  await writeApp(theirs, new Map([["model.yaml", Buffer.from(OSSIE)], [`${SITE}app.js`, Buffer.from("// theirs")], ["rayfin/rayfin.yml", Buffer.from(RAYFIN)]]),
    { name: "sales-model-explore", model: "power bi/nem.Lakehouse/Files/semantic_model/sales.yaml", itemId: "my-item" });
  const e = await flow.exportExplore({ ...REQUEST, appFile: theirs }).then(() => null, x => x);
  assert.equal(e && e.declined, true);
  assert.equal(published.length, 1, "only the first reached Fabric");
  assert.match(asked.at(-1).message, /Publish it over the app it names \(sales-model-explore\)\?/);
  // A record from a build that kept the ids alone still counts, for any file: it had no path to hold a file to.
  kept.set("exportedItems", ["my-item"]);
  await flow.exportExplore({ ...REQUEST, appFile: mine });
  assert.equal(published.length, 2);
  await rm(dir, { recursive: true, force: true });
  await done();
});

test("a file that names no app yet but carries sign-in redirects is asked about: the app it makes would keep them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "provenance-app-"));
  const file = await appFile(dir, { redirects: [EVIL] });
  const { flow, asked, published, done } = await setup({ answers: [undefined] });
  const e = await flow.exportExplore({ ...REQUEST, appFile: file }).then(() => null, x => x);
  assert.equal(e && e.declined, true);
  assert.equal(published.length, 0);
  assert.match(asked[0].message, /from this computer before\. Publish it\?$/);
  assert.ok(asked[0].rest[0].detail.includes(EVIL));
  assert.match(asked[0].rest[0].detail, /^A new app is made in power bi\./);
  await rm(dir, { recursive: true, force: true });
  await done();
});

test("a tile saved and an export's own record written at the same moment: both are in the file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "provenance-app-"));
  const file = await appFile(dir);
  const TILES = { tiles: [{ title: "at the same moment", kind: "text", text: "hi" }] };
  let a, saving;
  // Not waited for: the save is under way while the publish goes on to write its record.
  const onPublish = async () => {
    const { stamp } = await a.flow.reportOf({ workspace: "power bi", model: "sales" });
    saving = a.flow.reportSave({ workspace: "power bi", model: "sales", spec: TILES, stamp }).then(() => null, e => e);
  };
  a = await setup({ onPublish });
  await a.flow.exportExplore({ ...REQUEST, appFile: file });
  const refused = await saving;
  // A save that found the file changed since it was drawn is refused, by design, and the page saves again.
  if (refused) {
    assert.match(refused.message, /changed since it was drawn/);
    const { stamp } = await a.flow.reportOf({ workspace: "power bi", model: "sales" });
    await a.flow.reportSave({ workspace: "power bi", model: "sales", spec: TILES, stamp });
  }
  const after = await readApp(file);
  assert.deepEqual(JSON.parse(after.files.get(`${SITE}report.json`).toString("utf8")), TILES);
  assert.equal(after.marker.itemId, "new-item", "the save did not write an older record back over the export's");
  assert.ok(after.marker.exportedAt, "nor lose that it was published");
  await rm(dir, { recursive: true, force: true });
  await a.done();
});

// The page is a Vite project, and OneLake Studio runs no npm: it uploads its own build of the page with the file's
// Report and model. So a file whose page someone changed is asked about, and keeps its page for a publish that builds it.
test("a file whose page was changed is asked about: OneLake Studio publishes its own page, and the file keeps the change", async () => {
  const dir = await mkdtemp(join(tmpdir(), "provenance-page-"));
  const file = join(dir, "sales.fabricator");
  const answers = [file];
  const a = await setup({ answers });
  await a.flow.exportExplore({ ...REQUEST, file: "sales.yaml" });
  assert.equal(a.published.length, 1);
  // What was uploaded: the built page, and the file's site/public/ beside it; no script of the project.
  const site = a.sites[0];
  assert.equal(site.get("index.html").toString(), "<!doctype html>built\n");
  for (const p of ["report.json", "model.json", "settings.json", "rayfin.config.json"]) assert.ok(site.has(p), p);
  assert.ok(![...site.keys()].some(p => /^src\/|vite\.config|package\.json/.test(p)), [...site.keys()].join(", "));
  const first = await readApp(file);
  assert.ok(first.files.has("site/src/app.js") && first.files.has("site/index.html") && first.files.has("site/package.json"));
  assert.ok(![...first.files.keys()].some(p => /^site\/public\/.*\.(js|html)$/.test(p)), "no script in site/public/");
  assert.match(first.files.get("rayfin/rayfin.yml").toString(), /folder: dist\n    buildCommand: npm run build/);

  // Published again as it is, untouched: nothing asked.
  await a.flow.exportExplore({ ...REQUEST, appFile: file });
  assert.equal(a.published.length, 2);
  assert.equal(a.asked.filter(q => /was changed/.test(q.message)).length, 0);

  // Its page changed: asked, and a No publishes nothing.
  const edited = await readApp(file);
  edited.files.set("site/src/app.js", Buffer.from("// a person's own page\n"));
  await writeApp(file, edited.files, edited.marker);
  answers.push(undefined);
  const e = await a.flow.exportExplore({ ...REQUEST, appFile: file }).then(() => null, x => x);
  assert.equal(e && e.declined, true);
  assert.equal(a.published.length, 2, "nothing reached Fabric");
  const q = a.asked.at(-1);
  assert.match(q.message, /The page in sales\.fabricator was changed, and OneLake Studio publishes its own page/);
  assert.match(q.rest[0].detail, /Changed: site\/src\/app\.js\n/);
  assert.match(q.rest[0].detail, /Fabricator, or npm run rayfin:up in the project, publishes a changed page\./);
  assert.deepEqual(q.rest.slice(1), ["Publish It"]);

  // A Yes: OneLake Studio's page is uploaded, and the file keeps the person's.
  answers.push("Publish It");
  await a.flow.exportExplore({ ...REQUEST, appFile: file });
  assert.equal(a.published.length, 3);
  assert.equal(a.sites[2].get("index.html").toString(), "<!doctype html>built\n");
  const kept = await readApp(file);
  assert.equal(kept.files.get("site/src/app.js").toString(), "// a person's own page\n");
  assert.equal(kept.marker.page, "own");
  // And is asked again at the next publish: its page is still not the one uploaded.
  const questions = () => a.asked.filter(x => (x.rest ?? []).includes("Publish It")).length;
  const before = questions();
  answers.push("Publish It");
  await a.flow.exportExplore({ ...REQUEST, appFile: file });
  assert.equal(questions(), before + 1);
  assert.equal((await readApp(file)).files.get("site/src/app.js").toString(), "// a person's own page\n");

  // An earlier export's file, its page in site/public/: published as it is, it takes this build's page, unasked.
  await mkdir(join(dir, "earlier"));
  const old = await appFile(join(dir, "earlier"), { itemId: "new-item" });
  a.kept.set("exportedItems", { ...a.kept.get("exportedItems"), "new-item": old });
  const asked = questions();
  await a.flow.exportExplore({ ...REQUEST, appFile: old });
  assert.equal(questions(), asked, "nothing asked");
  const now = await readApp(old);
  assert.ok(!now.files.has(`${SITE}app.js`) && now.files.has("site/src/app.js") && now.files.has("site/index.html"), "laid out as a Vite project");
  assert.ok(!a.sites.at(-1).has("app.js"), "its old script is not uploaded");
  await rm(dir, { recursive: true, force: true });
  await a.done();
});
