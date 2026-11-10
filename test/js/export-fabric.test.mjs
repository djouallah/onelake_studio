// Export to Fabric for real (fabric_app/export/exportflow.js), as the CI identity, on fabriccat: a model
// file of the lakehouse's lakeci_plain table published as a client-side app with its function, then made a
// Direct Lake semantic model, and that model's app. Nothing is faked but the dialogs, which answer yes.
// Both apps and the model stay in the workspace, and each run replaces them.
//
// FABRIC_TOKEN, POWERBI_TOKEN and ONELAKE_TOKEN are the identity's tokens for the Fabric API, the Power BI
// API and storage; ONELAKE_CI_WORKSPACE and ONELAKE_CI_LAKEHOUSE name where. Needs vendor/ and
// fabric-function/ (scripts/vendor.mjs, scripts/function-bundle.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { FABRIC_TOKEN, POWERBI_TOKEN, ONELAKE_TOKEN, ONELAKE_CI_WORKSPACE: WS, ONELAKE_CI_LAKEHOUSE: LAKEHOUSE } = process.env;
const skip = !(FABRIC_TOKEN && POWERBI_TOKEN && ONELAKE_TOKEN && WS && LAKEHOUSE)
  && "FABRIC_TOKEN, POWERBI_TOKEN, ONELAKE_TOKEN, ONELAKE_CI_WORKSPACE and ONELAKE_CI_LAKEHOUSE are set only by the lake's workflow";
if (skip && process.env.NO_SKIP) throw new Error(skip);

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TABLE = "lakeci_plain", ROWS = 5000;
const MODEL = "lakeci_model";
const FILE = "lakeci.bim";
const PATH = `${LAKEHOUSE}.Lakehouse/Files/lakeci/${FILE}`;

// The model file: one Direct Lake table, Tables/test/lakeci_plain as make_tables.py writes it.
const bimOf = (workspaceId, lakehouseId, name) => ({
  name, compatibilityLevel: 1604,
  model: {
    culture: "en-US",
    expressions: [{ name: "DirectLake", kind: "m", expression: [
      "let",
      `    Source = AzureStorage.DataLake("https://onelake.dfs.fabric.microsoft.com/${workspaceId}/${lakehouseId}", [HierarchicalNavigation=true])`,
      "in",
      "    Source",
    ] }],
    tables: [{
      name: TABLE,
      columns: [
        { name: "id", dataType: "int64", sourceColumn: "id" },
        { name: "region", dataType: "string", sourceColumn: "region" },
        { name: "amount", dataType: "double", sourceColumn: "amount" },
      ],
      measures: [{ name: "Total amount", expression: `SUM(${TABLE}[amount])` }],
      partitions: [{ name: TABLE, mode: "directLake",
                     source: { type: "entity", entityName: TABLE, schemaName: "test", expressionSource: "DirectLake" } }],
    }],
  },
});

// Export to Fabric as core.js builds it, on this checkout's files, with the identity's tokens.
async function setup() {
  const { createExport } = require("../../fabric_app/export/exportflow.js");
  const { createFabricApp } = require("../../fabric_app/export/fabricapp.js");
  const { createOneLakeWriter } = require("../../fabric_app/export/onelakewrite.js");
  const { createFabric } = require("../../core/models/fabric.js");
  const { PINS } = require("../../core/vendored.js");
  const load = (...p) => import(pathToFileURL(join(ROOT, ...p)).href);
  const [semantic, c, t, o, y] = await Promise.all([
    load("page", "semantic.js"),
    load("vendor", "npm", PINS.daxSql, "src", "index.js"), load("vendor", "npm", PINS.daxSql, "formats", "tmsl.js"),
    load("vendor", "npm", PINS.daxSql, "formats", "ossie.js"), load("vendor", "npm", PINS.yaml, "+esm.js"),
  ]);
  const mods = { semantic, compiler: { createCompiler: c.createCompiler, createViews: c.createViews, tmslToModel: t.tmslToModel,
                                       ossieToTmsl: o.ossieToTmsl, tmslToOssie: o.tmslToOssie, parseYaml: y.parse, stringifyYaml: y.stringify } };
  const dir = await mkdtemp(join(tmpdir(), "export-fabric-"));
  const asked = [], sites = [], kept = new Map();
  const log = line => console.log(line);
  // The dialogs: saved where the Save dialog opens, in a folder of the test's; every question answered
  // by its own button, as each run replaces what the last one made.
  const ui = {
    openFolder: () => null,
    saveFile: async o => join(dir, basename(o.defaultPath)),
    info: async () => undefined,
    warn: async (message, _opts, ...buttons) => { asked.push(message); log(`asked: ${message} -> ${buttons[0]}`); return buttons[0]; },
    withProgress: (_title, work) => work({ report() {} }),
    openExternal() {}, reveal() {},
  };
  const fabric = createFabric({ getFabricToken: async () => FABRIC_TOKEN });
  const appOf = o => createFabricApp(o);
  const flow = createExport({
    connectivity: { offline: () => false, noInternet: () => false },
    modules: async () => mods,
    appToken: async () => FABRIC_TOKEN, powerBiToken: async () => POWERBI_TOKEN, fabric,
    memento: { get: k => kept.get(k), update: async (k, v) => { kept.set(k, v); } },
    extensionDir: ROOT, reportDir: join(dir, "reports"), pageDir: async () => join(ROOT, "page"),
    ui, onRefresh() {}, log,
    // The site as it is uploaded, kept to be looked at.
    fabricAppOf: o => {
      const app = appOf(o);
      return { ...app, publish: p => app.publish({ ...p, site: async config => { const z = await p.site(config); sites.push(z); return z; } }) };
    },
  });
  const workspaceId = String(await fabric.workspaceId(WS)).toLowerCase();
  const lake = (await fabric.listItems(WS)).find(i => i.type === "Lakehouse" && i.name.toLowerCase() === LAKEHOUSE.toLowerCase());
  assert.ok(lake, `${WS} has a lakehouse ${LAKEHOUSE}`);
  return { flow, dir, asked, sites, workspaceId, lakehouseId: String(lake.id).toLowerCase(),
           writer: createOneLakeWriter({ getToken: async () => ONELAKE_TOKEN }),
           status: createFabricApp({ getToken: async () => FABRIC_TOKEN }) };
}

// What was published: the zip's record names the item and its site, Fabric says it deployed it just now,
// the site answers nobody who isn't signed in, and every module the uploaded files import was uploaded.
async function published(s, said, zipName, engine, since) {
  const { readApp, unzip } = require("../../fabric_app/export/exportapp.js");
  const { marker } = await readApp(join(s.dir, zipName));
  assert.equal(marker.engine, engine);
  assert.match(marker.itemId, /^[0-9a-f-]{36}$/);
  assert.match(marker.hostingUrl, /^https:\/\/[\w.-]+\.fabricapps\.net/);
  assert.ok(said.includes(marker.hostingUrl), said);
  const live = await s.status.deployStatus(marker.workspaceId, marker.itemId);
  assert.equal(live.hostingUrl, marker.hostingUrl);
  assert.ok(Date.parse(live.lastSuccessfulDeploymentAt) >= since - 5 * 60_000, `deployed ${live.lastSuccessfulDeploymentAt}, not by this run`);
  assert.ok(new URL(marker.hostingUrl).origin && marker.redirects.includes(new URL(marker.hostingUrl).origin), "sign-in comes back to the site");

  const anonymous = await fetch(new URL("app.js", marker.hostingUrl));
  assert.equal(anonymous.status, 401, "the site is not public");
  const signed = await fetch(new URL("app.js", marker.hostingUrl), { headers: { authorization: `Bearer ${FABRIC_TOKEN}` } });
  console.log(`${marker.hostingUrl}app.js with the identity's Fabric token: HTTP ${signed.status}`);

  const site = unzip(s.sites.at(-1));
  for (const p of ["index.html", "app.js", "model.json", "engine.json", "report.json", "rayfin.config.json"]) assert.ok(site.has(p), `the site has ${p}`);
  assert.equal(JSON.parse(site.get("engine.json").toString("utf8")).engine, engine);
  assert.equal(JSON.parse(site.get("rayfin.config.json").toString("utf8")).itemId, marker.itemId);
  let imports = 0;
  for (const [path, bytes] of site) {
    if (!/\.(html|js)$/.test(path) || path.startsWith("vendor/")) continue;
    for (const [, spec] of bytes.toString("utf8").matchAll(/\b(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"'?]+\.js)(?:\?v=[\w-]+)?["']/g)) {
      const to = new URL(spec, new URL(path, "http://site/")).pathname.slice(1);
      assert.ok(site.has(to), `${path} imports ${spec}, and the site has no ${to}`);
      imports++;
    }
  }
  assert.ok(imports > 10, `${imports} imports found`);
  return marker;
}

test("on fabriccat: a model file's app is published, client side, with its function", { skip, timeout: 20 * 60_000 }, async () => {
  const s = await setup();
  const text = JSON.stringify(bimOf(s.workspaceId, s.lakehouseId, "lakeci"), null, 2);
  await s.writer.writeFile(WS, PATH, Buffer.from(text, "utf8"));
  const since = Date.now();
  const said = await s.flow.exportExplore({ file: FILE, name: "lakeci", text, state: null, workspace: WS, path: PATH });
  assert.match(said, /^Published to Fabric: https:/);
  const marker = await published(s, said, "lakeci-explore.fabricapp", "duckdb", since);
  assert.equal(marker.model, `${WS}/${PATH}`);
  assert.equal(marker.lakehouseId, s.lakehouseId);
});

test("on fabriccat: the model file made a Direct Lake semantic model, which answers, and its app is published", { skip, timeout: 20 * 60_000 }, async () => {
  const s = await setup();
  const text = JSON.stringify(bimOf(s.workspaceId, s.lakehouseId, "lakeci model"), null, 2);
  const made = await s.flow.createSemanticModel({ file: FILE, name: MODEL, text, workspace: WS, path: PATH, mode: "directlake" });
  assert.match(made, new RegExp(`^Semantic model ${MODEL} (created|updated) in ${WS} \\(`));

  const since = Date.now();
  const said = await s.flow.exportExplore({ file: `${MODEL}.bim`, name: MODEL, text, state: null, model: { workspace: WS, name: MODEL } });
  assert.match(said, new RegExp(`^Published to Fabric, on the semantic model ${MODEL}: https:`));
  const marker = await published(s, said, "lakeci-model-explore.fabricapp", "semanticModel", since);
  assert.equal(marker.semanticModel.name, MODEL);
  assert.equal(marker.semanticModel.workspace, s.workspaceId);

  // The model the app queries reads the table: its rows, counted in DAX.
  const r = await fetch(`https://api.powerbi.com/v1.0/myorg/groups/${s.workspaceId}/datasets/${marker.semanticModel.id}/executeQueries`, {
    method: "POST", headers: { authorization: `Bearer ${POWERBI_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ queries: [{ query: `EVALUATE ROW("n", COUNTROWS(${TABLE}), "total", [Total amount])` }] }),
  });
  const body = await r.text();
  assert.equal(r.status, 200, body);
  const [row] = JSON.parse(body).results[0].tables[0].rows;
  assert.equal(row["[n]"], ROWS);
  assert.ok(row["[total]"] > 0);
});
