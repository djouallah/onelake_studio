// =============================================================================
// vendor.mjs — the webview's third-party code, inside the extension
// =============================================================================
// Downloads what src/vendored.js pins — the markdown renderer, ECharts and the dax-sql
// compiler — into vendor/, which panel.js serves to the page as webview
// resources. Nothing the page runs comes from a CDN at run time. Generate Report's template
// (src/report.js) is vendored the same way, and copied from here into the folder it writes.
//
// Layout, relative to vendor/:
//   npm/<pkg>@<v>/+esm.js       a jsDelivr ESM bundle, saved with a .js extension: VS Code
//                               serves webview resources by extension, and a module script
//                               refuses anything that is not JavaScript.
//   npm/<pkg>@<v>/<path>        a plain file of a package (ECharts' own build).
//   gh/<owner>/<repo>@<sha>/…   a pinned repository's modules.
// Every absolute `/npm/…` import inside a bundle is rewritten to a RELATIVE path, so the
// tree works under whatever base URI the webview gives it.
//
// Run by vscode:prepublish for every package, and once for a checkout before F5.
// vendor/ is gitignored: pinned, reproducible artifacts, not source.
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join, dirname, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const { VENDOR } = createRequire(import.meta.url)("../src/vendored.js");

const here = join(dirname(fileURLToPath(import.meta.url)), "..");   // the extension root
const OUT = join(here, "vendor");
const JSDELIVR = "https://cdn.jsdelivr.net";

let files = 0, bytes = 0;

async function get(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) {
      if (attempt >= 3) throw e;
      await new Promise(res => setTimeout(res, 1000 * attempt));
    }
  }
}

async function save(rel, buf) {
  const file = join(OUT, ...rel.split("/"));
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, buf);
  files++; bytes += buf.length;
}

// "/npm/x@1/+esm" -> "npm/x@1/+esm.js"; "/npm/x@1/dist/a.mjs/+esm" -> "npm/x@1/dist/a.mjs/+esm.js"
const localOf = npmPath => npmPath.replace(/^\//, "").replace(/\/\+esm$/, "/+esm.js");

const seen = new Set();
async function esmClosure(npmPath) {
  if (seen.has(npmPath)) return;
  seen.add(npmPath);
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
  await save(localOf(npmPath), Buffer.from(out, "utf8"));
  for (const dep of deps) await esmClosure(dep);
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

for (const pkg of VENDOR.esm) await esmClosure(`/npm/${pkg}/+esm`);
for (const f of VENDOR.files) await save(`npm/${f}`, await get(`${JSDELIVR}/npm/${f}`));
for (const { repo, include } of VENDOR.gh) {
  const listing = JSON.parse((await get(`https://data.jsdelivr.com/v1/packages/gh/${repo}?structure=flat`)).toString("utf8"));
  const names = (listing.files || []).map(f => f.name).filter(n => include.test(n));
  if (!names.length) throw new Error(`gh/${repo}: the listing has none of the files to vendor`);
  for (const n of names) await save(`gh/${repo}${n}`, await get(`${JSDELIVR}/gh/${repo}${n}`));
}

await writeFile(STAMP, want);
console.log(`vendored ${files} file(s), ${(bytes / 1e6).toFixed(1)}MB`);
