// =============================================================================
// vendor.mjs — put the engine INSIDE the extension
// =============================================================================
// Downloads what the WEBVIEW still fetches — sql.js (the .db/.sqlite reader) and the
// markdown renderer — into extension/vendor/<host>/<path>, mirroring the CDN's own
// layout. The proxy's /cdn route serves these files first and only falls back to the
// network for anything missing, so an installed extension boots with no CDN at all.
//
// DuckDB is NOT here any more. It runs natively in the extension host (see
// src/engine-host.js), installed as a real dependency, so the 39MB of wasm this used to
// download — the module closure, the worker, the 35MB binary and four extension
// binaries — no longer exists in the vsix or on the boot path. That took the package
// from 22.5MB to under 10MB and removed 'unsafe-eval' from the panel's CSP.
//
// Run once for a checkout (F5 falls back to the network until you do) and by
// vscode:prepublish for every package. vendor/ is gitignored: these are pinned,
// reproducible artifacts, not source.
//
// The jsDelivr +esm closure is discovered, not hardcoded: +esm bundles import their
// dependencies by absolute /npm/ path, so each downloaded file is scanned for more.
import { mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const VENDOR = join(here, "vendor");

const fetched = new Set();
let bytes = 0;

async function save(host, path, buf) {
  const file = join(VENDOR, host, ...path.split("/").filter(Boolean));
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, buf);
  bytes += buf.length;
}

async function have(host, path) {
  try { return (await stat(join(VENDOR, host, ...path.split("/").filter(Boolean)))).isFile(); }
  catch (_) { return false; }
}

async function grab(host, path, { optional = false } = {}) {
  const key = `${host}${path}`;
  if (fetched.has(key)) return null;
  fetched.add(key);
  if (await have(host, path)) {
    console.log(`  have  ${key}`);
    return readFile(join(VENDOR, host, ...path.split("/").filter(Boolean)));
  }
  const r = await fetch(`https://${host}${path}`);
  if (!r.ok) {
    if (optional) { console.log(`  skip  ${key} (${r.status})`); return null; }
    throw new Error(`${key}: ${r.status}`);
  }
  const buf = Buffer.from(await r.arrayBuffer());
  await save(host, path, buf);
  console.log(`  got   ${key} (${(buf.length / 1e6).toFixed(1)}MB)`);
  return buf;
}

// A jsDelivr ESM file plus, recursively, every absolute /npm/ path it references.
async function grabEsmClosure(path) {
  const buf = await grab("cdn.jsdelivr.net", path);
  if (!buf) return;
  const text = buf.toString("utf8");
  const deps = new Set();
  for (const m of text.matchAll(/["'](\/npm\/[^"']+?)["']/g)) deps.add(m[1]);
  for (const dep of deps) await grabEsmClosure(dep);
}

console.log(`vendoring webview assets into ${VENDOR} ...`);

// sql.js (the .db/.sqlite reader) and the markdown renderer — small, and the difference
// between "works offline" and "mostly works offline". These genuinely run IN the page:
// sql.js because duckdb-wasm's sqlite VFS could never open an app-supplied file, and
// marked/dompurify because rendering a document is the webview's own job.
const SQLJS = "1.13.0";
await grabEsmClosure(`/npm/sql.js@${SQLJS}/+esm`);
await grab("cdn.jsdelivr.net", `/npm/sql.js@${SQLJS}/dist/sql-wasm.wasm`, { optional: true });
await grabEsmClosure("/npm/marked@18.0.7/+esm");
await grabEsmClosure("/npm/dompurify@3.4.12/+esm");

console.log(`vendored ${fetched.size} URL(s), ${(bytes / 1e6).toFixed(1)}MB new`);
