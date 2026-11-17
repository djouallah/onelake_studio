// An export's .fabricator, as Fabricator takes one (CI, after export-fabric.test.mjs published it): the
// project unpacked, its packages installed from its own package.json and lock file, every script of its page
// parsed, its function and its page built as `rayfin up` builds them (rayfin.yml's buildCommands), and its page
// served by its own Vite from the folder rayfin.yml's staticHosting names, as Fabricator's preview runs it: the
// page, its scripts with their packages resolved, and the published app's rayfin.config.json answered.
// The page it builds is the one OneLake Studio uploads (fabric-site/, scripts/site-bundle.mjs), file for file.
// Fabricator itself and `rayfin up` (which signs in as a person) are not run here.
//
// FABRICATOR_OUT: the file. Run: FABRICATOR_OUT=lakeci.fabricator node test/js/run-fabricator-project.mjs
import { spawn, execSync, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { unzip, siteBuild, SITE, DEPLOYMENTS, CONFIG, FABRICATOR_RECORD, MARKER } = require("../../fabric_app/export/exportapp.js");
const { WEBAPP } = require("../../core/vendored.js");

const fail = m => { console.log(`FAIL ${m}`); process.exit(1); };
const ok = m => console.log(`ok   ${m}`);
const file = process.env.FABRICATOR_OUT;
if (!file) fail("FABRICATOR_OUT is not set");

const entries = unzip(await readFile(file));
// What Fabricator looks for: the project at the top of the file, and its record of it.
if (!entries.has("rayfin/rayfin.yml")) fail("no rayfin/rayfin.yml at the file's top: Fabricator would not take it for a project");
const record = JSON.parse(entries.get(FABRICATOR_RECORD).toString("utf8"));
if (record.format !== 1 || !record.name || record.deployment !== true || !record.workspace) fail(`Fabricator's record: ${JSON.stringify(record)}`);
ok(`Fabricator's record: ${record.name}, published, in ${record.workspace}`);
if (!entries.has(MARKER)) fail("no record of ours");

const project = await mkdtemp(join(tmpdir(), "fabricator-"));
for (const [path, bytes] of entries) {
  const to = join(project, path);
  await mkdir(dirname(to), { recursive: true });
  await writeFile(to, bytes);
}
console.log(`the project: ${project}`);
// npm ci: from its lock file, which must agree with package.json, or npm refuses.
execSync("npm ci --no-audit --no-fund --loglevel=error", { cwd: project, stdio: ["ignore", "inherit", "inherit"] });
ok("npm ci, from the project's own package.json and lock file");
// One Arrow for DuckDB-WASM and the page: installed apart, a table DuckDB answers is not a Table to the page's.
for (const p of ["node_modules/@duckdb/duckdb-wasm/node_modules/apache-arrow", "site/node_modules/apache-arrow"]) {
  if (existsSync(join(project, ...p.split("/")))) fail(`a second copy of Arrow is installed: ${p}`);
}
if (existsSync(join(project, "node_modules", "@duckdb", "duckdb-wasm"))) {
  const arrow = JSON.parse(await readFile(join(project, "node_modules", "apache-arrow", "package.json"), "utf8")).version;
  if (arrow !== WEBAPP.arrow.split("@").pop()) fail(`the project's Arrow is ${arrow}, not ${WEBAPP.arrow}`);
  ok(`one Arrow, ${arrow}, for DuckDB-WASM and the page`);
}

// The site's own files (site/public/), and the page's code (site/src/). No script is in the first: Vite
// copies it as it is, and an earlier export's page lived there.
const site = join(project, ...SITE.split("/").filter(Boolean));
const stray = [...entries.keys()].filter(p => p.startsWith(SITE) && /\.(m?js|html)$/.test(p));
if (stray.length) fail(`site/public/ holds scripts of the page: ${stray.slice(0, 5).join(", ")}`);
// Every script of the page: as a module, else as a classic script (the store's worker script).
const src = join(project, "site", "src");
let checked = 0;
for (const rel of await readdir(src, { recursive: true })) {
  if (!/\.(m?js)$/.test(rel)) continue;
  const path = join(src, rel);
  try { execFileSync(process.execPath, ["--check", path], { stdio: "pipe" }); }
  catch {
    const copy = join(project, "check.cjs");
    await writeFile(copy, await readFile(path));
    try { execFileSync(process.execPath, ["--check", copy], { stdio: "pipe" }); }
    catch (e) { fail(`${rel} parses neither as a module nor as a script: ${String(e.stderr).slice(0, 400)}`); }
    finally { await rm(copy, { force: true }); }
  }
  checked++;
}
ok(`${checked} scripts of the page parse`);

// The Report's checker, as an agent runs it after an edit (npm run validate): the export's own Report passes, and
// one with a field the model has not, a mark the page does not draw and a filter-bar field it has not fails, each named.
const validate = () => { try { return { code: 0, out: execSync("npm run validate --silent", { cwd: project, encoding: "utf8" }) }; }
                         catch (e) { return { code: e.status, out: `${e.stdout}${e.stderr}` }; } };
const fine = validate();
if (fine.code !== 0) fail(`npm run validate on the export's own Report: ${fine.out.slice(0, 1500)}`);
ok(`npm run validate: ${fine.out.trim().split("\n").pop()}`);
const fields = execSync("npm run validate --silent -- --fields", { cwd: project, encoding: "utf8" });
if (!/\bTotal amount\b/.test(fields) || !/lakeci_plain\.region/.test(fields)) fail(`npm run validate -- --fields lists no model fields: ${fields.slice(0, 800)}`);
ok("npm run validate -- --fields lists the model's columns and measures");
const reportPath = join(site, "report.json");
const report = await readFile(reportPath, "utf8");
const broken = JSON.parse(report);
const firstTile = (broken.pages ?? [broken])[0].tiles[0];
firstTile.pivot.values = [...firstTile.pivot.values, "Totl amount"];
firstTile.pivot.mark = "lines";
broken.filters = [{ field: "lakeci_plain.regin", style: "dropdown" }];
await writeFile(reportPath, JSON.stringify(broken));
const bad = validate();
await writeFile(reportPath, report);
if (bad.code !== 1) fail(`npm run validate passed a broken Report: ${bad.out.slice(0, 800)}`);
for (const said of ['"Totl amount"', '"lines"', '"lakeci_plain.regin"', "near: Total amount"]) {
  if (!bad.out.includes(said)) fail(`npm run validate did not name ${said}: ${bad.out.slice(0, 1500)}`);
}
ok("npm run validate names a misspelt measure (with the near one), a mark the page has not and a filter-bar field the model has not");

// The function, as rayfin up builds it: rayfin.yml's buildCommand, in rayfin/functions.
execSync("npm run build", { cwd: join(project, "rayfin", "functions"), stdio: ["ignore", "inherit", "inherit"] });
ok("the function builds (npm run build in rayfin/functions)");

// The page, as rayfin up builds it: rayfin.yml's buildCommand, in site/, into site/dist/ with site/public/ copied in.
const yml = entries.get("rayfin/rayfin.yml").toString("utf8");
if (!/^    path: site\n    folder: dist\n    buildCommand: npm run build\n/m.test(yml)) fail(`rayfin.yml's staticHosting does not build site/ into dist: ${yml.slice(0, 1200)}`);
execSync("npm run build", { cwd: join(project, "site"), stdio: ["ignore", "inherit", "inherit"] });
const dist = join(project, "site", "dist");
const listed = async dir => (await readdir(dir, { recursive: true, withFileTypes: true })).filter(e => e.isFile())
  .map(e => join(e.parentPath, e.name).slice(dir.length + 1).split("\\").join("/")).sort();
const built = await listed(dist);
const copied = [...entries.keys()].filter(p => p.startsWith(SITE)).map(p => p.slice(SITE.length)).sort();
for (const p of copied) if (!built.includes(p)) fail(`the build lacks ${p}, a file of site/public/`);
if (!built.some(p => /^assets\/duckdb-base-[^/]+\.wasm$/.test(p))) fail(`the build has no DuckDB-WASM: ${built.join(", ")}`);
if (!built.some(p => /^assets\/duckdb-browser-base\.worker-[^/]+\.js$/.test(p))) fail(`the build has no DuckDB worker: ${built.join(", ")}`);
if (!built.some(p => /^assets\/blockcache-[^/]+\.js$/.test(p))) fail(`the build has no store script (blockcache.js): ${built.join(", ")}`);
for (const x of WEBAPP.extensions) {
  if (!built.includes(`duckdb-ext/${WEBAPP.duckdb}/wasm_eh/${x}.duckdb_extension.wasm`)) fail(`the build has no ${x} extension`);
}
// The store's script is a worker's, loaded with importScripts: built as it is, never as a module.
const blockcache = built.find(p => /^assets\/blockcache-[^/]+\.js$/.test(p));
if (blockcache && /^\s*(import|export)\b/m.test(await readFile(join(dist, blockcache), "utf8"))) fail("the build made a module of blockcache.js: a worker loads it with importScripts");
ok(`the page builds (npm run build in site/): ${built.length} files, ${copied.length} of them site/public/'s`);
// What OneLake Studio uploads is that same build, made when the extension was packaged.
const ours = [...(await siteBuild(fileURLToPath(new URL("../../fabric-site", import.meta.url)))).keys()].sort();
const theirs = built.filter(p => !copied.includes(p));
if (JSON.stringify(ours) !== JSON.stringify(theirs)) {
  fail(`OneLake Studio's page is not the project's build.\n  only in fabric-site: ${ours.filter(p => !theirs.includes(p)).join(", ") || "none"}` +
       `\n  only in the project's build: ${theirs.filter(p => !ours.includes(p)).join(", ") || "none"}`);
}
ok(`OneLake Studio's page (fabric-site/) is the project's build, file for file: ${ours.length} files`);

// The page, as Fabricator previews it: the project's Vite, started in staticHosting's folder (site/).
const PORT = 5179;
const vite = spawn(process.execPath, [join(project, "node_modules", "vite", "bin", "vite.js"), "--port", String(PORT), "--strictPort"],
  { cwd: join(project, "site"), stdio: ["ignore", "pipe", "pipe"] });
const said = [];
vite.stdout.on("data", d => said.push(String(d)));
vite.stderr.on("data", d => said.push(String(d)));
const base = `http://localhost:${PORT}`;
try {
  const started = Date.now();
  for (;;) {
    const r = await fetch(`${base}/`).catch(() => null);
    if (r) break;
    if (vite.exitCode != null || Date.now() - started > 60_000) fail(`Vite did not start: ${said.join("").slice(-2000)}`);
    await new Promise(r => setTimeout(r, 500));
  }
  const get = async (path, what) => {
    const r = await fetch(base + path);
    if (r.status !== 200) fail(`${what}: HTTP ${r.status} for ${path}: ${(await r.text().catch(() => "")).slice(0, 1500)}`);
    return r;
  };
  const html = await (await get("/", "the page")).text();
  // Vite adds its client and serves the inline module script from the page itself: the page's own footer is the mark.
  if (!/<span id="build">build __BUILD__ · <\/span>Explore, exported from/.test(html)) fail(`the page is not the app's: ${html.slice(0, 1500)}`);
  if (!/<script type="module" src="[^"]*\/src\/main\.js[^"]*"><\/script>/.test(html)) fail(`the page does not start src/main.js: ${html.slice(0, 1500)}`);
  // Each script as Vite serves it: a package it cannot resolve is an error here, not a 200.
  for (const p of ["/src/main.js", "/src/app.js", "/src/storage/auth.js", "/src/storage/data.js"]) {
    const text = await (await get(p, `the page's ${p}`)).text();
    if (/\[plugin:vite:|Failed to resolve import/.test(text)) fail(`Vite could not serve ${p}: ${text.slice(0, 1500)}`);
  }
  // DuckDB's worker script, as an engine's worker asks for it (importScripts): data.js imports where it is
  // (?url), and the script is then asked for itself. It names a source map its package does not hold, and Vite
  // warned for it each time, in Fabricator's backend log: served without that line (site/vite.config.mjs).
  const data = await (await get("/src/storage/data.js", "data.js")).text();
  const asked = /["']([^"']*duckdb-browser-base\.worker\.js\?[^"']*)["']/.exec(data)?.[1];
  if (!asked) fail(`data.js, as Vite serves it, does not import DuckDB's worker: ${data.slice(0, 1500)}`);
  const where = /export default ["']([^"']+)["']/.exec(await (await get(asked, "where DuckDB's worker is")).text())?.[1];
  if (!where) fail(`Vite did not say where DuckDB's worker is, asked ${asked}`);
  const worker = await (await get(where, "DuckDB's worker")).text();
  if (worker.length < 100_000) fail(`DuckDB's worker is ${worker.length} characters: ${worker.slice(0, 300)}`);
  if (/sourceMappingURL=/.test(worker.slice(-500))) fail("DuckDB's worker is served with its source map's name, which Vite warns it cannot read");
  await get("/report.json", "the Report");
  await get("/world.json", "the world's outline");
  const config = await (await get("/rayfin.config.json", "the backend's config")).json();
  const reg = JSON.parse(entries.get(DEPLOYMENTS).toString("utf8"));
  const deployed = reg.deployments[reg.active];
  if (config.itemId !== deployed.fabricItemId || config.apiUrl !== deployed.fabricApiUrl) {
    fail(`rayfin.config.json names ${config.itemId}, rayfin up's record ${deployed.fabricItemId}`);
  }
  if (JSON.parse(entries.get(CONFIG).toString("utf8")).itemId !== config.itemId) fail("Vite answered another rayfin.config.json than the file's");
  const warned = said.join("").split(/\r?\n/).filter(l => /warn|error/i.test(l));
  if (warned.length) fail(`Vite's dev server warned: ${warned.slice(0, 10).join(" | ")}`);
  ok(`Vite serves the page, its scripts and the published app's backend (item ${config.itemId}), with no warning`);
} finally {
  vite.kill();
}
await rm(project, { recursive: true, force: true }).catch(() => {});
console.log("the .fabricator is a project Fabricator can install, preview and publish");
