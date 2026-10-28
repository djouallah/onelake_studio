'use strict';
// =============================================================================
// exportapp.js — Export to Fabric: a model's Explore, as a Fabric app of its own
// =============================================================================
// Explore's button (app/explore/explore.js) hands the host the model's text and the shelves
// on screen. What is written to a folder of this machine — the local copy, an agent's to grow
// later — and what is published from its dist/ (fabricapp.js) is:
//   site/explore/    Studio's Explore, as it runs in the panel: explore.js, query.js (the
//                    query as DAX, the DAX as SQL), draw.js, model.js, theme.js, explore.css
//   site/semantic/   dax-sql (PINS.daxSql) and the model, as ossie.json
//   site/storage/    analytics-as-code's Iceberg data source (PINS.exportTemplate): the page
//                    signs in (Rayfin's Fabric SSO), the app's function answers where each
//                    table is and a read-only SAS, the page downloads the files into the
//                    browser and DuckDB-WASM reads them as views v_<table>
//   site/app.js      generated: Explore over that data source
//   rayfin/          the template's Rayfin project — rayfin.yml says what the app is, and its
//                    function's source is what is deployed (built at package time, by
//                    scripts/function-bundle.mjs: nobody's machine builds it)
//   model/           the model file, as it was
//   dist/            site/ stamped with the build, plus rayfin.config.json (the backend the
//                    browser talks to): byte for byte what was uploaded
// The template is generic: the model names the tables (a dataset's `source`, schema.table),
// the lakehouse its Direct Lake expression holds is the catalog. Nothing here is AI.
// No `vscode` import: the extension passes in what it owns.
// =============================================================================

const { join, dirname } = require('node:path');
const fsp = require('node:fs/promises');
const zlib = require('node:zlib');
const { TABLE_ORIGIN } = require('./catalog');
const { PINS } = require('./vendored');

const MARKER = '.onelake-studio-export.json';
// What a re-export writes again; anything else in the folder is left alone.
const OWNED = ['site', 'dist', 'rayfin', 'model', 'AGENTS.md', '.gitignore'];

// The template's files (from its root, vendor/gh/<PINS.exportTemplate>) and where each goes.
const TEMPLATE = [
  ['front_end/fabric_app/iceberg/site/storage', 'site/storage'],
  ['front_end/fabric_app/common/site/storage/auth.js', 'site/storage/auth.js'],
  ['front_end/page/storage/queue.js', 'site/storage/queue.js'],
  ['front_end/page/storage/results.js', 'site/storage/results.js'],
  ['front_end/page/frontend/perflog.js', 'site/frontend/perflog.js'],
  ['front_end/fabric_app/iceberg/rayfin', 'rayfin'],
];
// Studio's own modules (app/, or webview/ installed), as the panel runs them.
const STUDIO = ['explore/explore.js', 'explore/query.js', 'explore/draw.js', 'explore/model.js',
  'explore/theme.js', 'explore/explore.css', 'paths.js'];

// An app's name: lower case, letters, digits and dashes (as a Rayfin id).
function slug(s) {
  const out = String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return !out ? 'explore' : /^[a-z]/.test(out) ? out : `m-${out}`;
}

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// The model's tables as the data source reads them (the template's storage/data.js,
// modelTables): name -> schema.table. An Ossie dataset's `source`; a TMSL table's Direct Lake
// partition.
function sourcesOf(model) {
  const out = new Map();
  for (const d of model.datasets ?? []) if (d.source) out.set(d.name, String(d.source));
  for (const t of (model.model ?? model).tables ?? []) {
    const s = t.partitions?.[0]?.source;
    if (s?.entityName) out.set(t.name, `${s.schemaName ?? 'dbo'}.${s.entityName}`);
  }
  return out;
}

/**
 * What an export is, before anything is written: the app's name, its lakehouse and catalog,
 * and the model as the page reads it. Throws, saying why, when the model cannot make one.
 * `mods`: the agent's modules() — { compiler: { parseYaml, ossieToTmsl }, semantic }.
 */
function planExport(text, fileName, name, { compiler, semantic }) {
  const body = String(text).replace(/^﻿/, '');
  let doc, bim;
  if (semantic.isOssiePath(fileName)) {
    if (!semantic.isOssie(body)) throw new Error(`${fileName} is not an Apache Ossie model: it has no top-level version and datasets`);
    try { doc = compiler.parseYaml(body); }
    catch (e) { throw new Error(`${fileName} is not YAML: ${e.message}`); }
    bim = compiler.ossieToTmsl(doc);
  } else {
    try { bim = JSON.parse(body); }
    catch (e) { throw new Error(`${fileName} is not a TMSL model: ${e.message}`); }
    doc = bim;
  }
  const lakes = semantic.lakehousesOf(bim);
  if (lakes.length !== 1) {
    throw new Error(lakes.length
      ? `${fileName} names ${lakes.length} lakehouses: the app reads one catalog`
      : `${fileName} names no lakehouse: its Direct Lake expression must hold https://onelake.dfs.fabric.microsoft.com/<workspace id>/<lakehouse id>`);
  }
  const [lake] = lakes;
  const sources = sourcesOf(doc);
  if (!sources.size) throw new Error(`${fileName} has no table the app can read: none names its source as schema.table`);
  // The page names a table's view v_<table> and finds it again with \w+; the function opens
  // schema.table only, and refuses a whole request with one name it does not take.
  const badNames = [...sources.keys()].filter(n => !/^\w+$/.test(n));
  if (badNames.length) throw new Error(`the app reads tables named with letters, digits and _ only: ${badNames.join(', ')}`);
  const badSources = [...sources].filter(([, s]) => !/^[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/.test(s));
  if (badSources.length) throw new Error(`the app opens schema.table sources only: ${badSources.map(([n, s]) => `${n} (${s})`).join(', ')}`);
  const modelTables = ((bim.model ?? bim).tables ?? []).map(t => t.name);
  const warnings = modelTables.filter(t => !sources.has(t))
    .map(t => `table ${t}: the model names no source for it, so the app cannot read it`);
  const title = String((doc && doc.name) || name);
  return {
    doc, warnings, title, name: slug(title), modelName: name, fileName,
    workspace: lake.workspace, lakehouse: lake.item,
    catalogUrl: `${TABLE_ORIGIN}/iceberg/${lake.workspace}/${lake.item}`,
    tables: [...sources],
  };
}

// The template's rayfin.yml, for this app: its own id and name, its site PROTECTED, no build
// command (the extension builds dist/), none of the template's own deployments' redirects.
function rayfinYml(text, name, redirects = []) {
  let out = String(text);
  const swap = (re, to, what) => {
    if (!re.test(out)) throw new Error(`the template's rayfin.yml has no ${what} — is PINS.exportTemplate a different layout?`);
    out = out.replace(re, to);
  };
  swap(/^id: .*$/m, `id: ${name}`, 'id');
  swap(/^name: .*$/m, `name: ${name}`, 'name');
  swap(/^(\s*)assetAccess: .*$/m, '$1assetAccess: protected', 'assetAccess');
  out = out.replace(/^[ \t]*buildCommand: node \S*build\.mjs[ \t]*\r?\n/m, '');
  out = out.replace(/^[ \t]*- https:\/\/\S+\.fabricapps\.net[ \t]*\r?\n/gm, '');
  if (redirects.length) {
    swap(/^([ \t]*)allowedRedirectUris:[ \t]*\r?\n/m,
      m => m + redirects.map(r => `${/^([ \t]*)/.exec(m)[1]}  - ${r}\n`).join(''), 'allowedRedirectUris');
  }
  return `# Written by OneLake Studio's Export to Fabric, which deploys this app over the Fabric REST\n` +
         `# API from ../dist/. A record of what the app is: nothing reads this file to deploy.\n` + out;
}

const indexHtml = plan => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(plan.title)} · Explore</title>
<link rel="stylesheet" href="./explore/explore.css">
<style>
  /* explore.css's tokens, and the sign-in gate's (storage/auth.js: --bg, --muted, --accent,
     --on-accent). Dark first, as the panel's palette is drawn; light when the browser asks. */
  :root {
    color-scheme: dark;
    --bg: #0d1117; --panel: #161b22; --panel2: #1c2330; --border: #30363d; --text: #e6edf3;
    --muted: #8d96a0; --accent: #2f81f7; --accent2: #58a6ff; --err: #f85149; --hover: rgba(255,255,255,0.07);
  }
  @media (prefers-color-scheme: light) {
    :root {
      color-scheme: light;
      --bg: #f6f8fa; --panel: #ffffff; --panel2: #eef1f4; --border: #d0d7de; --text: #1f2328;
      --muted: #59636e; --accent: #0969da; --accent2: #0969da; --err: #cf222e;
      --raised: #ffffff; --row-line: #e6e9ed; --faint: #8c959f; --disabled: #afb8c1;
      --hairline: rgba(0,0,0,0.08); --hover: rgba(0,0,0,0.05); --hover-soft: rgba(0,0,0,0.025);
      --shadow: 0 8px 24px rgba(140,149,159,0.3); --measure: #9a6700;
    }
  }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  html, body { margin: 0; min-height: 100%; }
  body { background: var(--bg); color: var(--text); font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  button, input, select { font: inherit; color: inherit; }
  input, select { background: var(--input-bg); border: 1px solid var(--border); border-radius: 6px; padding: 0.2rem 0.4rem; }
  header { display: flex; align-items: baseline; gap: 0.8rem; flex-wrap: wrap; padding: 0.8rem var(--gutter) 0; }
  header h1 { font-size: 1.1rem; margin: 0; }
  header .about, #status, footer { color: var(--muted); font-size: 0.8rem; }
  #status { margin-left: auto; }
  footer { padding: 0 var(--gutter) 1rem; }
</style>
<script src="https://cdn.jsdelivr.net/npm/${PINS.echarts}/dist/echarts.min.js"></script>
</head>
<body>
<header>
  <h1>${esc(plan.title)}</h1>
  <span class="about">Explore · semantic model ${esc(plan.modelName)}</span>
  <span id="status" role="status" aria-live="polite">Starting…</span>
</header>
<main id="explore" class="explore-page"></main>
<footer>build __BUILD__ · exported from OneLake Studio</footer>
<script type="module">import { start } from "./app.js"; start();</script>
</body>
</html>
`;

const appJs = (plan, state) => `// app.js — Explore over the model, the page of this Fabric app (OneLake Studio's Export to
// Fabric). Studio's own Explore (explore/explore.js) drives it: a query of the shelves is DAX
// (explore/query.js), the DAX is SQL over the views v_<table> (dax-sql), and storage/data.js
// runs it in DuckDB-WASM over the lakehouse's tables, downloaded into this browser.
import { createDataSource } from "./storage/data.js";
import { createExplorer } from "./explore/explore.js";
import { createModelQuery, EXPLORE_CASTS } from "./explore/query.js";
import { tmslOf } from "./explore/model.js";
import { PALETTE, registerChartTheme } from "./explore/theme.js";
import { createCompiler } from "./semantic/dax-sql/index.js";
import { tmslToModel } from "./semantic/formats/tmsl.js";
import { ossieToTmsl } from "./semantic/formats/ossie.js";

const NAME = ${JSON.stringify(plan.modelName)};
// The shelves Explore showed when the app was exported: the first view of a new visitor.
const FIRST = ${JSON.stringify(state || null)};
const KEY = \`explore.\${NAME}\`;
const MODEL = new URL("./semantic/ossie.json" + new URL(import.meta.url).search, import.meta.url);

const status = s => { document.getElementById("status").textContent = s || ""; };
const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
// An Arrow result as the rows Explore reads: plain objects keyed by the select's names.
const rowsOf = table => table.toArray().map(r => r.toJSON());

function saveCsv(table, filename) {
  const fields = table.schema.fields.map(f => f.name);
  const cell = v => v == null ? "" : /[",\\n\\r]/.test(String(v)) ? \`"\${String(v).replace(/"/g, '""')}"\` : String(v);
  const text = [fields.map(cell).join(","), ...rowsOf(table).map(r => fields.map(f => cell(r[f])).join(","))].join("\\n") + "\\n";
  const a = Object.assign(document.createElement("a"),
    { href: URL.createObjectURL(new Blob([text], { type: "text/csv" })), download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

export async function start() {
  try {
    const doc = await (await fetch(MODEL)).json();
    const bim = Array.isArray(doc.datasets) ? ossieToTmsl(doc) : doc;
    const tmsl = tmslOf(bim);
    const mq = createModelQuery(tmsl, createCompiler(tmslToModel(bim), { tableSource: t => \`v_\${t.name}\`, castOutput: EXPLORE_CASTS }));
    const data = createDataSource({ onStatus: status, onProgress: p => status(p ? (p.detail || p.label) : "") });
    const ready = data.init().then(() => status(""));
    ready.catch(e => { console.error(e); status(\`Error: \${e?.message || e}\`); });
    const query = async q => { await ready; const dax = mq.toDax(q); return data.query(mq.toSQL(dax), dax); };
    registerChartTheme(echarts, css);
    const charts = new Map();
    const resized = new ResizeObserver(es => { for (const e of es) charts.get(e.target)?.resize(); });
    createExplorer(document.getElementById("explore"), {
      model: async () => { await ready; return tmsl; },
      toDax: q => mq.toDax(q),
      run: async q => rowsOf(await query(q)),
      csv: async q => saveCsv(await query(q), \`\${NAME}-explore.csv\`),
      chart: box => {
        if (!charts.has(box)) { charts.set(box, echarts.init(box, "studio")); resized.observe(box); }
        return charts.get(box);
      },
      palette: () => PALETTE,
      css,
      loadState: () => { try { return JSON.parse(localStorage.getItem(KEY)) ?? FIRST; } catch { return FIRST; } },
      saveState: s => { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {} },
    });
  } catch (e) {
    console.error(e);
    status(\`Error: \${e?.message || e}\`);
  }
}
`;

const agentsMd = plan => `# ${plan.title} — Explore, as a Fabric app

Written by OneLake Studio's **Export to Fabric** from \`model/${plan.fileName}\`, and deployed by it over
the Fabric REST API (item type \`AppBackend\`): no CLI. The site is **protected** — only people who may
open the app item can load it.

- Lakehouse: workspace \`${plan.workspace}\`, item \`${plan.lakehouse}\`
- Iceberg catalog (the function's \`CATALOG_URL\` secret): ${plan.catalogUrl}
- Runtime: \`${PINS.exportTemplate}\` (\`front_end/fabric_app/iceberg\`), compiler \`${PINS.daxSql}\`

## Layers

| Layer | Path | |
|---|---|---|
| Page | \`site/index.html\`, \`site/app.js\` | generated: Explore over the data source |
| Explore | \`site/explore/\` | OneLake Studio's Explore, as the extension runs it |
| Compiler | \`site/semantic/dax-sql/\`, \`site/semantic/formats/\` | dax-sql: the query as DAX, the DAX as SQL over \`v_<table>\` |
| Model | \`site/semantic/ossie.json\` | the model, as the page reads it |
| Data source | \`site/storage/\` | signs in (Rayfin Fabric SSO), asks the function, downloads the tables into the browser (OPFS), DuckDB-WASM |
| Function | \`rayfin/functions/src/function_app.ts\` | the catalog's metadata locations and a read-only SAS on \`Tables/\` |

Tables the app reads (\`v_<table>\` ← \`schema.table\`):

${plan.tables.map(([n, s]) => `- \`${n}\` ← \`${s}\``).join('\n')}

\`dist/\` is \`site/\` as uploaded (stamped with the build, plus \`rayfin.config.json\`). Exporting again from
OneLake Studio rewrites \`site/\`, \`dist/\`, \`rayfin/\`, \`model/\` and this file, and updates the same app.

The workspace must allow **OneLake user-delegated SAS tokens** (workspace settings → OneLake): the
function signs one. The page needs a browser with OPFS shared access handles (Chrome or Edge 121+).
`;

const GITIGNORE = `node_modules
rayfin/.env*
rayfin/.deployments.json
`;

// --- Writing the folder -------------------------------------------------------

async function isEmptyOrOurs(dir) {
  const entries = await fsp.readdir(dir).catch(e => (e.code === 'ENOENT' ? null : Promise.reject(e)));
  if (entries == null || !entries.length) return { exists: entries != null, marker: null };
  const marker = await fsp.readFile(join(dir, MARKER), 'utf8').then(JSON.parse, () => null);
  if (!marker) throw new Error(`${dir} is not empty and was not written by Export to Fabric`);
  return { exists: true, marker };
}

/**
 * Writes the app's folder (the local copy), then builds its dist/. Returns the marker kept in
 * the folder (an earlier export's item and redirects, when there was one).
 * `templateDir`: vendor/gh/<PINS.exportTemplate>; `daxSqlDir`: vendor/gh/<PINS.daxSql>;
 * `appDir`: Studio's page modules (app/, or webview/ installed).
 */
async function writeExport({ plan, text, state, outDir, templateDir, daxSqlDir, appDir }) {
  const { marker } = await isEmptyOrOurs(outDir);
  for (const p of OWNED) await fsp.rm(join(outDir, p), { recursive: true, force: true });
  const at = (root, p) => join(root, ...p.split('/'));
  for (const [from, to] of TEMPLATE) await fsp.cp(at(templateDir, from), at(outDir, to), { recursive: true });
  for (const p of STUDIO) await fsp.cp(at(appDir, p), at(outDir, `site/${p}`));
  await fsp.cp(join(daxSqlDir, 'src'), at(outDir, 'site/semantic/dax-sql'), { recursive: true });
  for (const f of ['tmsl.js', 'ossie.js']) await fsp.cp(join(daxSqlDir, 'formats', f), at(outDir, `site/semantic/formats/${f}`));
  const yml = at(outDir, 'rayfin/rayfin.yml');
  await fsp.writeFile(yml, rayfinYml(await fsp.readFile(yml, 'utf8'), plan.name, (marker && marker.redirects) || []));
  const files = {
    'site/index.html': indexHtml(plan),
    'site/app.js': appJs(plan, state),
    'site/semantic/ossie.json': JSON.stringify(plan.doc),
    [`model/${plan.fileName}`]: String(text),
    'AGENTS.md': agentsMd(plan),
    '.gitignore': GITIGNORE,
  };
  for (const [p, body] of Object.entries(files)) {
    await fsp.mkdir(dirname(at(outDir, p)), { recursive: true });
    await fsp.writeFile(at(outDir, p), body);
  }
  const next = { ...(marker || {}), name: plan.name, model: plan.modelName,
                 workspaceId: plan.workspace, lakehouseId: plan.lakehouse };
  await writeMarker(outDir, next);
  return next;
}

const writeMarker = (dir, m) => fsp.writeFile(join(dir, MARKER), JSON.stringify(m, null, 2) + '\n');

// A build id, URL-safe (it is the ?v= cache-buster): yyyymmdd-hhmmss UTC.
const buildId = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

/**
 * dist/ from site/: every relative import gets ?v=<build> and __BUILD__ becomes the build, so
 * a browser never runs the files of two deploys together; then rayfin.config.json, which the
 * browser SDK fetches from the site's root. Returns the files, path -> bytes, as uploaded.
 */
async function buildDist(outDir, config, build = buildId()) {
  const site = join(outDir, 'site'), dist = join(outDir, 'dist');
  await fsp.rm(dist, { recursive: true, force: true });
  const files = new Map();
  for (const rel of (await fsp.readdir(site, { recursive: true })).map(f => f.split('\\').join('/')).sort()) {
    const src = join(site, rel);
    if (!(await fsp.stat(src)).isFile()) continue;
    let bytes = await fsp.readFile(src);
    if (/\.(html|js)$/.test(rel)) {
      bytes = Buffer.from(bytes.toString('utf8')
        .replaceAll('__BUILD__', build)
        .replace(/(\b(?:from|import)\s*["']\.{1,2}\/[\w./-]+\.js)(["'])/g, `$1?v=${build}$2`)
        .replace(/(<link rel="stylesheet" href="\.\/[\w./-]+\.css)(")/g, `$1?v=${build}$2`), 'utf8');
    }
    files.set(rel, bytes);
  }
  files.set('rayfin.config.json', Buffer.from(JSON.stringify(config, null, 2) + '\n', 'utf8'));
  for (const [rel, bytes] of files) {
    await fsp.mkdir(dirname(join(dist, rel)), { recursive: true });
    await fsp.writeFile(join(dist, rel), bytes);
  }
  return files;
}

// --- A zip, with no dependency -----------------------------------------------
// Deflate (zlib's raw deflate, level 9) per entry, UTF-8 names, the entries at the root.

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** files: Map or [[path, bytes]] -> a zip's bytes. */
function zip(files) {
  const local = [], central = [];
  let offset = 0;
  const DOS_TIME = 0, DOS_DATE = (2026 - 1980) << 9 | 1 << 5 | 1;   // a fixed date: the same files zip the same
  for (const [path, data] of files) {
    const name = Buffer.from(path, 'utf8');
    const raw = Buffer.from(data);
    const packed = zlib.deflateRawSync(raw, { level: 9 });
    const crc = crc32(raw);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6);
    head.writeUInt16LE(8, 8); head.writeUInt16LE(DOS_TIME, 10); head.writeUInt16LE(DOS_DATE, 12);
    head.writeUInt32LE(crc, 14); head.writeUInt32LE(packed.length, 18); head.writeUInt32LE(raw.length, 22);
    head.writeUInt16LE(name.length, 26); head.writeUInt16LE(0, 28);
    local.push(head, name, packed);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(8, 10); dir.writeUInt16LE(DOS_TIME, 12); dir.writeUInt16LE(DOS_DATE, 14);
    dir.writeUInt32LE(crc, 16); dir.writeUInt32LE(packed.length, 20); dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(name.length, 28); dir.writeUInt32LE(offset, 42);
    central.push(dir, name);
    offset += head.length + name.length + packed.length;
  }
  const size = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(size, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

module.exports = { planExport, writeExport, buildDist, writeMarker, zip, crc32, rayfinYml, slug, MARKER };
