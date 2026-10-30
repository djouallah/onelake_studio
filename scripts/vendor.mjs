// =============================================================================
// vendor.mjs — the webview's third-party code, inside the extension
// =============================================================================
// Downloads what src/vendored.js pins — the markdown renderer, ECharts and the dax-sql
// compiler — into vendor/, which panel.js serves to the page as webview
// resources. Nothing the page runs comes from a CDN at run time. Export to Fabric copies
// dax-sql from here into the app it writes, and vendor/webapp/ — the web app's own packages
// (DuckDB-WASM and its extensions, Arrow, the Rayfin SDK, ECharts) — into its site/vendor/.
//
// Layout, relative to vendor/:
//   npm/<pkg>@<v>/+esm.js       a jsDelivr ESM bundle, saved with a .js extension: VS Code
//                               serves webview resources by extension, and a module script
//                               refuses anything that is not JavaScript.
//   npm/<pkg>@<v>/<path>        a plain file of a package (ECharts' own build, dax-sql's
//                               modules).
//   webapp/npm/…                the web app's packages, the same two forms.
//   webapp/duckdb-ext/<v>/wasm_eh/<name>.duckdb_extension.wasm
//                               DuckDB's signed extensions, at the path DuckDB-WASM asks for.
// Every absolute `/npm/…` import inside a bundle is rewritten to a RELATIVE path, so the
// tree works under whatever base URI the webview gives it.
//
// Run by vscode:prepublish for every package, and once for a checkout before F5.
// vendor/ is gitignored: pinned, reproducible artifacts, not source.
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join, dirname, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { fetchRetry } from "./fetch-retry.mjs";

// Every download goes through here: at most PARALLEL at once, so a cold vendor/ takes the
// slowest file's time, not the sum of a few hundred.
const PARALLEL = 8;
let active = 0;
const waiting = [];
async function get(url) {
  if (active >= PARALLEL) await new Promise(r => waiting.push(r));
  active++;
  try { return await fetchRetry(url); }
  finally { active--; const next = waiting.shift(); if (next) next(); }
}

const { VENDOR } = createRequire(import.meta.url)("../src/vendored.js");

const here = join(dirname(fileURLToPath(import.meta.url)), "..");   // the extension root
const OUT = join(here, "vendor");
const JSDELIVR = "https://cdn.jsdelivr.net";

let files = 0, bytes = 0;

async function save(rel, buf, root = OUT) {
  const file = join(root, ...rel.split("/"));
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, buf);
  files++; bytes += buf.length;
}

// "/npm/x@1/+esm" -> "npm/x@1/+esm.js"; "/npm/x@1/dist/a.mjs/+esm" -> "npm/x@1/dist/a.mjs/+esm.js"
const localOf = npmPath => npmPath.replace(/^\//, "").replace(/\/\+esm$/, "/+esm.js");

// `root`: vendor/ or vendor/webapp/, each tree whole on its own.
const seen = new Set();
async function esmClosure(npmPath, root = OUT) {
  if (seen.has(`${root}|${npmPath}`)) return;
  seen.add(`${root}|${npmPath}`);
  const text = (await get(JSDELIVR + npmPath)).toString("utf8");
  const deps = new Set();
  for (const m of text.matchAll(/["'](\/npm\/[^"'\s]+?)["']/g)) deps.add(m[1]);
  const at = posix.dirname(localOf(npmPath));
  let out = text;
  for (const dep of deps) {
    let rel = posix.relative(at, localOf(dep));
    if (!rel.startsWith(".")) rel = "./" + rel;
    out = out.split(`"${dep}"`).join(`"${rel}"`).split(`'${dep}'`).join(`'${rel}'`);
  }
  await save(localOf(npmPath), Buffer.from(out, "utf8"), root);
  await Promise.all([...deps].map(dep => esmClosure(dep, root)));
}

// A tree built from these exact pins is reused as it is — a restored CI cache costs no
// network. Anything else is rebuilt from scratch: a stale file from an older pin or an
// older layout must never be what the page loads.
const STAMP = join(OUT, ".pins.json");
const want = JSON.stringify(VENDOR, (k, v) => (v instanceof RegExp ? String(v) : v));
if (await readFile(STAMP, "utf8").catch(() => "") === want) {
  console.log(`vendor/ already holds these pins — nothing to fetch`);
  process.exit(0);
}
console.log(`vendoring webview libraries into ${OUT} ...`);
await rm(OUT, { recursive: true, force: true });

// The panel's tree first, then the web app's: the counts below are each's own.
await Promise.all([
  ...VENDOR.esm.map(pkg => esmClosure(`/npm/${pkg}/+esm`)),
  ...VENDOR.files.map(async f => save(`npm/${f}`, await get(`${JSDELIVR}/npm/${f}`))),
  ...VENDOR.packages.map(async ({ pkg, include }) => {
    const listing = JSON.parse((await get(`https://data.jsdelivr.com/v1/packages/npm/${pkg}?structure=flat`)).toString("utf8"));
    const names = (listing.files || []).map(f => f.name).filter(n => include.test(n));
    if (!names.length) throw new Error(`npm/${pkg}: the listing has none of the files to vendor`);
    await Promise.all(names.map(async n => save(`npm/${pkg}${n}`, await get(`${JSDELIVR}/npm/${pkg}${n}`))));
  }),
]);


const WEB = join(OUT, "webapp");
const panelFiles = files, panelBytes = bytes;
const { duckdb, platform, names } = VENDOR.webapp.extensions;
await Promise.all([
  ...VENDOR.webapp.esm.map(pkg => esmClosure(`/npm/${pkg}/+esm`, WEB)),
  ...VENDOR.webapp.files.map(async f => save(`npm/${f}`, await get(`${JSDELIVR}/npm/${f}`), WEB)),
  ...names.map(async n => {
    const rel = `duckdb-ext/${duckdb}/${platform}/${n}.duckdb_extension.wasm`;
    await save(rel, await get(`https://extensions.duckdb.org/${duckdb}/${platform}/${n}.duckdb_extension.wasm`), WEB);
  }),
]);

await writeFile(STAMP, want);
console.log(`vendored ${panelFiles} file(s), ${(panelBytes / 1e6).toFixed(1)}MB for the panel; ` +
  `${files - panelFiles} file(s), ${((bytes - panelBytes) / 1e6).toFixed(1)}MB for the web app (vendor/webapp)`);
