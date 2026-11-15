// An export's .fabricator, as Fabricator takes one (CI, after export-fabric.test.mjs published it): the
// project unpacked, its packages installed from its own package.json, every script of its site parsed as
// `rayfin up` checks it before it uploads, its function built as `rayfin up` builds it (rayfin.yml's
// buildCommand), and its page served by its own Vite from the folder rayfin.yml's staticHosting names, as
// Fabricator's preview runs it: the page, its packages and the published app's rayfin.config.json answered.
// Fabricator itself and `rayfin up` (which signs in as a person) are not run here.
//
// FABRICATOR_OUT: the file. Run: FABRICATOR_OUT=lakeci.fabricator node test/js/run-fabricator-project.mjs
import { spawn, execSync, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { unzip, SITE, DEPLOYMENTS, CONFIG, FABRICATOR_RECORD, MARKER } = require("../../fabric_app/export/exportapp.js");
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
execSync("npm install --no-audit --no-fund --loglevel=error", { cwd: project, stdio: ["ignore", "inherit", "inherit"] });
ok("npm install, from the project's own package.json");

// Every script of the site, as `rayfin up` checks it: as a module, else as a classic script.
const site = join(project, ...SITE.split("/").filter(Boolean));
let checked = 0;
for (const rel of await readdir(site, { recursive: true })) {
  if (!/\.(m?js)$/.test(rel)) continue;
  const path = join(site, rel);
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
ok(`${checked} scripts of the site parse`);

// The function, as rayfin up builds it: rayfin.yml's buildCommand, in rayfin/functions.
execSync("npm run build", { cwd: join(project, "rayfin", "functions"), stdio: ["ignore", "inherit", "inherit"] });
ok("the function builds (npm run build in rayfin/functions)");

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
    if (r.status !== 200) fail(`${what}: HTTP ${r.status} for ${path}`);
    return r;
  };
  const html = await (await get("/", "the page")).text();
  // Vite adds its client and serves the inline module script from the page itself: the page's own footer is the mark.
  if (!/<span id="build">build __BUILD__ · <\/span>Explore, exported from/.test(html)) fail(`the page is not the app's: ${html.slice(0, 1500)}`);
  await get("/app.js", "the app's script");
  await get("/report.json", "the Report");
  await get(`/vendor/npm/${WEBAPP.duckdbWasm}/dist/duckdb-base.wasm`, "DuckDB-WASM, from the file");
  await get(`/vendor/npm/${WEBAPP.rayfinClient}/+esm.js`, "the Rayfin SDK, from the file");
  const config = await (await get("/rayfin.config.json", "the backend's config")).json();
  const reg = JSON.parse(entries.get(DEPLOYMENTS).toString("utf8"));
  const deployed = reg.deployments[reg.active];
  if (config.itemId !== deployed.fabricItemId || config.apiUrl !== deployed.fabricApiUrl) {
    fail(`rayfin.config.json names ${config.itemId}, rayfin up's record ${deployed.fabricItemId}`);
  }
  if (JSON.parse(entries.get(CONFIG).toString("utf8")).itemId !== config.itemId) fail("Vite answered another rayfin.config.json than the file's");
  ok(`Vite serves the page, its packages and the published app's backend (item ${config.itemId})`);
} finally {
  vite.kill();
}
await rm(project, { recursive: true, force: true }).catch(() => {});
console.log("the .fabricator is a project Fabricator can install, preview and publish");
