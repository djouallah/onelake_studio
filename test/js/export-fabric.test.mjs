// Export to Fabric for real (fabric_app/export/exportflow.js), as the CI identity, on fabriccat: a model
// file of the lakehouse's lakeci_plain table published as an app with its function, then made a
// Direct Lake semantic model. Nothing is faked but the dialogs, which answer yes. The app and the model
// stay in the workspace, and each run replaces them.
//
// Not here: a DAX query of the model. Fabric refuses a service principal one, on a model it made itself
// (PowerBINotAuthorizedException): it needs a person signed in.
//
// FABRIC_TOKEN, POWERBI_TOKEN and ONELAKE_TOKEN are the identity's tokens for the Fabric API, the Power BI
// API and storage; ONELAKE_CI_WORKSPACE and ONELAKE_CI_LAKEHOUSE name where. Needs vendor/, fabric-function/
// and fabric-site/ (scripts/vendor.mjs, scripts/function-bundle.mjs, scripts/site-bundle.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, copyFile, writeFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { FABRIC_TOKEN, POWERBI_TOKEN, ONELAKE_TOKEN, EXCHANGE_TOKEN, ONELAKE_CI_WORKSPACE: WS, ONELAKE_CI_LAKEHOUSE: LAKEHOUSE } = process.env;
const skip = !(FABRIC_TOKEN && POWERBI_TOKEN && ONELAKE_TOKEN && WS && LAKEHOUSE)
  && "FABRIC_TOKEN, POWERBI_TOKEN, ONELAKE_TOKEN, ONELAKE_CI_WORKSPACE and ONELAKE_CI_LAKEHOUSE are set only by the lake's workflow";
if (skip && process.env.NO_SKIP) throw new Error(skip);

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TABLE = "lakeci_plain";
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
      const app = appOf({ ...o, externalEntraExchange: !!EXCHANGE_TOKEN });
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
// the site answers nobody who isn't signed in, and what was uploaded is the page as Vite built it, with the app's own files.
async function published(s, said, zipName, since) {
  const { readApp, unzip } = require("../../fabric_app/export/exportapp.js");
  const { marker } = await readApp(join(s.dir, zipName));
  assert.match(marker.itemId, /^[0-9a-f-]{36}$/);
  assert.match(marker.hostingUrl, /^https:\/\/[\w.-]+\.fabricapps\.net/);
  assert.ok(said.includes(marker.hostingUrl), said);
  const live = await s.status.deployStatus(marker.workspaceId, marker.itemId);
  assert.equal(live.hostingUrl, marker.hostingUrl);
  assert.ok(Date.parse(live.lastSuccessfulDeploymentAt) >= since - 5 * 60_000, `deployed ${live.lastSuccessfulDeploymentAt}, not by this run`);
  assert.ok(new URL(marker.hostingUrl).origin && marker.redirects.includes(new URL(marker.hostingUrl).origin), "sign-in comes back to the site");

  const anonymous = await fetch(new URL("report.json", marker.hostingUrl));
  assert.equal(anonymous.status, 401, "the site is not public");
  const signed = await fetch(new URL("report.json", marker.hostingUrl), { headers: { authorization: `Bearer ${FABRIC_TOKEN}` } });
  console.log(`${new URL("report.json", marker.hostingUrl)} with the identity's Fabric token: HTTP ${signed.status}`);

  const site = unzip(s.sites.at(-1));
  for (const p of ["index.html", "model.json", "settings.json", "report.json", "rayfin.config.json", "world.json"]) assert.ok(site.has(p), `the site has ${p}`);
  // The page as Vite built it, never the project's own scripts.
  assert.ok(![...site.keys()].some(p => /^src\/|^storage\/|^explore\/|^vendor\/|vite\.config|package\.json$/.test(p)), `no script of the project: ${[...site.keys()].join(", ")}`);
  // DuckDB-WASM and its extensions.
  const wasm = [...site.keys()].filter(p => /\.wasm$/.test(p));
  assert.ok(wasm.some(p => /^assets\/duckdb-base-[^/]+\.wasm$/.test(p)), `DuckDB-WASM is in the site: ${wasm.join(", ")}`);
  assert.ok(wasm.some(p => /^duckdb-ext\/v[^/]+\/wasm_eh\/parquet\.duckdb_extension\.wasm$/.test(p)), `DuckDB's extensions are in the site: ${wasm.join(", ")}`);
  assert.equal(JSON.parse(site.get("rayfin.config.json").toString("utf8")).itemId, marker.itemId);
  // Every file its index.html names was uploaded, and it is stamped with this publish's build.
  const html = site.get("index.html").toString("utf8");
  assert.doesNotMatch(html, /__BUILD__/, "the build is stamped");
  let named = 0;
  for (const [, ref] of html.matchAll(/\b(?:src|href)="\.\/([^"?#]+)"/g)) {
    assert.ok(site.has(ref), `index.html names ${ref}, and the site has none`);
    named++;
  }
  assert.ok(named >= 2, `${named} files named by index.html: its script and its styles`);
  return marker;
}

test("on fabriccat: a model file's app is published, with its function", { skip, timeout: 20 * 60_000 }, async () => {
  const s = await setup();
  const text = JSON.stringify(bimOf(s.workspaceId, s.lakehouseId, "lakeci"), null, 2);
  await s.writer.writeFile(WS, PATH, Buffer.from(text, "utf8"));
  // The Report tab's tiles, as Add to report keeps them before the model has a zip: what the app opens on, and
  // what the Fabricator step (run-fabricator.mjs) checks the preview draws.
  await s.flow.reportSave({ workspace: WS, model: "lakeci", spec: { pages: [{ name: "Page 1", tiles: [
    { title: "All of it", kind: "pivot", pivot: { rows: [], values: ["Total amount"], mark: "table" } },
    { title: "By region", kind: "pivot", pivot: { rows: [`${TABLE}.region`], values: ["Total amount"], mark: "table" } },
  ] }] } });
  const since = Date.now();
  const said = await s.flow.exportExplore({ file: FILE, name: "lakeci", text, state: null, workspace: WS, path: PATH });
  assert.match(said, /^Published to Fabric: https:/);
  const marker = await published(s, said, "lakeci.fabricator", since);
  assert.equal(marker.model, `${WS}/${PATH}`);
  assert.equal(marker.lakehouseId, s.lakehouseId);
  await project(s, "lakeci.fabricator", marker);
  await signedIn(s);
});

// The file is a Rayfin project Fabricator imports: its packages, its package.json, and the app as `rayfin up`
// records it, the one just published. FABRICATOR_OUT: where to copy it, for CI's next step (run-fabricator-project.mjs),
// which installs it and serves it as Fabricator does.
async function project(s, zipName, marker) {
  const { readApp, SITE, DEPLOYMENTS, CONFIG } = require("../../fabric_app/export/exportapp.js");
  const { files } = await readApp(join(s.dir, zipName));
  const pkg = JSON.parse(files.get("package.json").toString("utf8"));
  assert.ok(pkg.devDependencies["@microsoft/rayfin-cli"], "the project's own Rayfin CLI");
  const page = JSON.parse(files.get("site/package.json").toString("utf8"));
  assert.ok(page.dependencies["@microsoft/rayfin-auth-provider-fabric"], "the Fabric sign-in package, which Fabricator's check asks for");
  assert.ok(page.dependencies["@duckdb/duckdb-wasm"], "DuckDB-WASM is the page's own package");
  assert.equal(page.scripts.build, "vite build");
  for (const p of ["site/index.html", "site/vite.config.mjs", "site/src/app.js", "site/src/storage/data.js"]) assert.ok(files.has(p), p);
  assert.ok(files.has("package-lock.json"), "its lock file");
  assert.ok(files.has(".agents/skills/rayfin/SKILL.md"), "Rayfin's agent files");
  assert.equal(JSON.parse(files.get("site/public/report.json").toString("utf8")).pages[0].tiles.length, 2, "the Report tab's tiles");
  assert.ok([...files.keys()].some(p => p.startsWith(`${SITE}duckdb-ext/`)), "DuckDB's extensions are in the file");
  assert.ok(![...files.keys()].some(p => p.startsWith(SITE) && /\.(m?js|html)$/.test(p)), "no script in site/public/");
  const reg = JSON.parse(files.get(DEPLOYMENTS).toString("utf8"));
  assert.equal(reg.deployments[reg.active].fabricItemId, marker.itemId, "rayfin up's record names the app just published");
  assert.equal(reg.deployments[reg.active].hostingUrl, marker.hostingUrl);
  assert.equal(JSON.parse(files.get(CONFIG).toString("utf8")).itemId, marker.itemId);
  if (process.env.FABRICATOR_OUT) {
    await copyFile(join(s.dir, zipName), process.env.FABRICATOR_OUT);
    console.log(`the project: ${process.env.FABRICATOR_OUT}`);
  }
}

// The published app, asked as a viewer's page asks it, with no browser: the site's own SDK signs in with an
// Entra token (the app is published with externalEntraExchange for this), then calls the deployed function.
// Only with EXCHANGE_TOKEN, a person's delegated Power BI token with the scope Item.Execute.All (the Rayfin CLI's
// sign-in gives one; the Azure CLI's cannot): Fabric turns down the CI identity's own tokens here (AUTH_FAILED,
// tried 2026-11-11), a service principal's not being delegated. So this runs where a person runs the test, and
// in CI the app is published as an export publishes it, with no exchange.
async function signedIn(s) {
  if (!EXCHANGE_TOKEN) return console.log("published app: not signed in to (no EXCHANGE_TOKEN: a person's token is needed)");
  const { unzip, sitePackages } = require("../../fabric_app/export/exportapp.js");
  const config = JSON.parse(unzip(s.sites.at(-1)).get("rayfin.config.json").toString("utf8"));
  // The Rayfin SDK the page imports, installed as the project installs it: a module beside it names the two packages.
  const sdk = await mkdtemp(join(tmpdir(), "rayfin-sdk-"));
  const deps = Object.fromEntries(Object.entries(sitePackages()).filter(([name]) => name.startsWith("@microsoft/rayfin-")));
  await writeFile(join(sdk, "package.json"), JSON.stringify({ private: true, type: "module", dependencies: deps }));
  await writeFile(join(sdk, "sdk.mjs"), 'export * as rayfin from "@microsoft/rayfin-client";\nexport * as provider from "@microsoft/rayfin-auth-provider-fabric";\n');
  execSync("npm install --no-audit --no-fund --loglevel=error", { cwd: sdk, stdio: ["ignore", "ignore", "inherit"] });
  const { rayfin, provider } = await import(pathToFileURL(join(sdk, "sdk.mjs")).href);
  const client = new rayfin.RayfinClient({ ...config, baseUrl: config.apiUrl, publishableKey: config.publishableKey, authStorage: false });
  await provider.signInWithEntraToken(client.auth, { entraToken: EXCHANGE_TOKEN });
  assert.ok(client.auth.getSession()?.isAuthenticated, "the published app gives a session for the token");
  // What the page asks of its function (storage/catalog.js), of the function Fabric runs.
  const r = await client.functions.openCatalog.invoke({ tables: "" }, { timeoutMs: 240000 });
  assert.equal(r?.error, undefined, `the deployed function: ${r?.error}`);
  const location = r.metadata?.[`test.${TABLE}`];
  assert.ok(location, `the deployed function names test.${TABLE}'s metadata: ${JSON.stringify(r.metadata)}`);
  assert.deepEqual(r.missing, []);
  const folder = Object.keys(r.sas).find(f => location.includes(`/Tables/${f}/`));
  assert.ok(folder, `a SAS for the table's folder: ${Object.keys(r.sas).join(", ")}`);
  assert.match(r.sas[folder], /(^|&)sp=r(&|$)/, "the SAS is read-only");
  // The SAS reads the table, as the page's downloads do.
  const read = await fetch(`${location.replace(/^abfss?:\/\/([^@/]+)@([^/]+)\//, "https://$2/$1/")}?${r.sas[folder]}`);
  assert.equal(read.status, 200, "the table's metadata.json, read with the deployed function's SAS");
  console.log(`published app: signed in with no browser; its function named test.${TABLE} and its read-only SAS read it`);
}

