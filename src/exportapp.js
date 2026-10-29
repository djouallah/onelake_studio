'use strict';
// =============================================================================
// exportapp.js — Export to Fabric: a model's Explore and Logs, as a Fabric app of its own
// =============================================================================
// Explore's button (app/explore/view.js) hands the host the model's text (to check it), where
// it lives in OneLake (for a model opened from its local copy, where the export writes it), and
// the shelves on screen. What is written to a folder of this machine
// — the local copy, an agent's to grow later — and what is published from its dist/
// (fabricapp.js) is:
//   site/            fabric_app/site: the page (index.html, app.js) and its data source
//                    (storage/: Fabric sign-in, the function's answer, DuckDB-WASM reading the
//                    tables in the browser as views v_<table>)
//   site/explore/    Studio's Explore and Logs (app/explore/), the same files the panel runs
//   site/semantic/   dax-sql (PINS.daxSql): SQL over the model, as SQL over the views
//   site/vendor/     every package the page runs (vendor/webapp: DuckDB-WASM and its
//                    extensions, Arrow, the Rayfin SDK, ECharts): nothing from a CDN
//   site/explore.json  the shelves the first view shows
//   rayfin/          fabric_app/rayfin: what the app is (rayfin.yml) and its function's source
//                    (built at package time, by scripts/function-bundle.mjs: nobody's machine
//                    builds it)
//   dist/            site/ stamped with the build, plus rayfin.config.json (the backend the
//                    browser talks to): byte for byte what was uploaded, but for vendor/,
//                    uploaded as site/ holds it and not written a second time
// The model is never copied: the app's function reads it from the lakehouse, in place, at
// run time (MODEL_URL), so the app shows the model as it is there. The lakehouse its Direct
// Lake expression holds is the catalog (CATALOG_URL). Nothing here is AI.
// No `vscode` import: the extension passes in what it owns.
// =============================================================================

const { join, dirname } = require('node:path');
const fsp = require('node:fs/promises');
const zlib = require('node:zlib');
const { createHash } = require('node:crypto');
const { TABLE_ORIGIN } = require('./catalog');
const { PINS, WEBAPP } = require('./vendored');

const MARKER = '.onelake-studio-export.json';
const DFS = 'https://onelake.dfs.fabric.microsoft.com';
// What a re-export writes again; anything else in the folder is left alone. `model` is an
// earlier export's copy of the model, which no export writes any more.
const OWNED = ['site', 'dist', 'rayfin', 'model', 'AGENTS.md', '.gitignore'];

// An app's name: lower case, letters, digits and dashes (as a Rayfin id), and -explore: its
// own, never the name of an app someone else deployed for the same model.
function appName(s) {
  const out = String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `${!out ? 'model' : /^[a-z]/.test(out) ? out : `m-${out}`}-explore`;
}

// The model's tables as the data source reads them (fabric_app/site/storage/data.js,
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

// A OneLake file's DFS URL, from the names the tree knows it by: the workspace, and the path
// from its item ("nem.Lakehouse/Files/semantic_model/ossie.yaml").
const trimPath = p => String(p).replace(/^\/+/, '');
const dfsUrl = (workspace, path) =>
  `${DFS}/${encodeURIComponent(workspace)}/${trimPath(path).split('/').map(encodeURIComponent).join('/')}`;

/**
 * What an export is, before anything is written: the app's name, its lakehouse and catalog,
 * the model's URL. Throws, saying why, when the model cannot make one.
 * `mods`: the agent's modules() — { compiler: { parseYaml, ossieToTmsl }, semantic };
 * `where`: the model file in OneLake, { workspace, path } (the path from its item).
 */
function planExport(text, fileName, name, { compiler, semantic }, where) {
  if (!where || !where.workspace || !where.path) throw new Error(`${fileName} is not a OneLake file: the app reads its model from the lakehouse`);
  if (!/^[^/]+\/Files\//.test(trimPath(where.path))) throw new Error(`${fileName} is not in a lakehouse's Files/`);
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
    warnings, title, name: appName(title), modelName: name, fileName,
    workspace: lake.workspace, lakehouse: lake.item,
    catalogUrl: `${TABLE_ORIGIN}/iceberg/${lake.workspace}/${lake.item}`,
    modelUrl: dfsUrl(where.workspace, where.path),
    modelPath: `${where.workspace}/${trimPath(where.path)}`,
    tables: [...sources],
  };
}

// fabric_app/rayfin/rayfin.yml, for this app: its own id and name, and its sign-in redirects.
function rayfinYml(text, name, redirects = []) {
  let out = String(text);
  const swap = (re, to, what) => {
    if (!re.test(out)) throw new Error(`fabric_app/rayfin/rayfin.yml has no ${what}`);
    out = out.replace(re, to);
  };
  swap(/^id: .*$/m, `id: ${name}`, 'id');
  swap(/^name: .*$/m, `name: ${name}`, 'name');
  if (redirects.length) {
    swap(/^([ \t]*)allowedRedirectUris:[ \t]*\r?\n/m,
      m => m + redirects.map(r => `${/^([ \t]*)/.exec(m)[1]}  - ${r}\n`).join(''), 'allowedRedirectUris');
  }
  return out;
}

const agentsMd = plan => `# ${plan.title} — Explore, as a Fabric app

Written by OneLake Studio's **Export to Fabric**, and deployed by it over the Fabric REST API (item
type \`AppBackend\`, named \`${plan.name}\`): no CLI. The site is **protected** — only people who may
open the app item can load it.

- Model: \`${plan.modelPath}\`, read **in place** by the app's function at run time (its \`MODEL_URL\`
  secret): the app holds no copy of it, so a change to the model is in the app on its next load.
- Lakehouse: workspace \`${plan.workspace}\`, item \`${plan.lakehouse}\` — its Iceberg catalog is the
  function's \`CATALOG_URL\`: ${plan.catalogUrl}

## Layers

| Layer | Path | |
|---|---|---|
| Page | \`site/index.html\`, \`site/app.js\` | Explore and Logs over the data source |
| Explore, Logs | \`site/explore/\` | OneLake Studio's, the same files the extension runs |
| Compiler | \`site/semantic/dax-sql/\`, \`site/semantic/formats/\` | dax-sql (\`${PINS.daxSql}\`): SQL over the model, as SQL over \`v_<table>\` |
| Packages | \`site/vendor/\` | DuckDB-WASM (\`${WEBAPP.duckdbWasm}\`, DuckDB ${WEBAPP.duckdb}) with its ${WEBAPP.extensions.join(' and ')} extensions, Arrow, the Rayfin SDK, ECharts: shipped with the site, nothing from a CDN |
| Data source | \`site/storage/\` | signs in (Rayfin Fabric SSO), asks the function, downloads the tables into the browser (OPFS), DuckDB-WASM |
| Function | \`rayfin/functions/src/function_app.ts\` | reads the model, the tables' metadata locations, a read-only SAS on \`Tables/\` |

Tables the app reads (\`v_<table>\` ← \`schema.table\`):

${plan.tables.map(([n, s]) => `- \`${n}\` ← \`${s}\``).join('\n')}

\`dist/\` is \`site/\` as uploaded (stamped with the build, plus \`rayfin.config.json\`), but for \`vendor/\`:
the packages are uploaded as \`site/vendor/\` holds them, and kept there only. Exporting again from
OneLake Studio rewrites \`site/\`, \`dist/\`, \`rayfin/\` and this file, and updates the same app.

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
  if (!marker) throw new Error(`${dir} is not empty and was not written by Export to Fabric: rename it, or open another folder`);
  return { exists: true, marker };
}

// The folder's marker: null when the folder is new or empty; throws when it holds anything
// Export to Fabric did not write.
const readMarker = async dir => (await isEmptyOrOurs(dir)).marker;

/**
 * Writes the app's folder (the local copy). Returns the marker kept in the folder (an earlier
 * export's item and redirects, when there was one).
 * `fabricAppDir`: the extension's fabric_app/; `appDir`: Studio's page modules (app/, or
 * webview/ installed); `daxSqlDir`: vendor/npm/<PINS.daxSql>; `webappDir`: vendor/webapp, the
 * page's packages.
 */
async function writeExport({ plan, state, outDir, fabricAppDir, appDir, daxSqlDir, webappDir }) {
  const { marker } = await isEmptyOrOurs(outDir);
  for (const p of OWNED) await fsp.rm(join(outDir, p), { recursive: true, force: true });
  const at = (root, p) => join(root, ...p.split('/'));
  await fsp.cp(join(fabricAppDir, 'site'), at(outDir, 'site'), { recursive: true });
  await fsp.cp(join(appDir, 'explore'), at(outDir, 'site/explore'), { recursive: true });
  await fsp.cp(join(appDir, 'paths.js'), at(outDir, 'site/paths.js'));
  await fsp.cp(join(daxSqlDir, 'src'), at(outDir, 'site/semantic/dax-sql'), { recursive: true });
  for (const f of ['tmsl.js', 'ossie.js']) await fsp.cp(join(daxSqlDir, 'formats', f), at(outDir, `site/semantic/formats/${f}`));
  await fsp.cp(webappDir, at(outDir, 'site/vendor'), { recursive: true });
  await fsp.cp(join(fabricAppDir, 'rayfin'), at(outDir, 'rayfin'), { recursive: true });
  const yml = at(outDir, 'rayfin/rayfin.yml');
  await fsp.writeFile(yml, rayfinYml(await fsp.readFile(yml, 'utf8'), plan.name, (marker && marker.redirects) || []));
  const files = {
    'site/explore.json': JSON.stringify(state || null),
    'AGENTS.md': agentsMd(plan),
    '.gitignore': GITIGNORE,
  };
  for (const [p, body] of Object.entries(files)) {
    await fsp.mkdir(dirname(at(outDir, p)), { recursive: true });
    await fsp.writeFile(at(outDir, p), body);
  }
  const next = { ...(marker || {}), name: plan.name, model: plan.modelPath,
                 workspaceId: plan.workspace, lakehouseId: plan.lakehouse };
  await writeMarker(outDir, next);
  return next;
}

const writeMarker = (dir, m) => fsp.writeFile(join(dir, MARKER), JSON.stringify(m, null, 2) + '\n');

// What site/vendor/ weighs: { total, parts: [[name, bytes]] }, a part per package
// (npm/<pkg>@<v>, npm/@<scope>/<pkg>@<v>) or extension, largest first.
async function vendorSize(outDir) {
  const root = join(outDir, 'site', 'vendor');
  const parts = new Map();
  let total = 0;
  for (const rel of (await fsp.readdir(root, { recursive: true }).catch(() => [])).map(f => f.split('\\').join('/'))) {
    const st = await fsp.stat(join(root, rel));
    if (!st.isFile()) continue;
    const seg = rel.split('/');
    const name = seg[0] === 'npm' ? seg.slice(1, seg[1].startsWith('@') ? 3 : 2).join('/')
      : seg[0] === 'duckdb-ext' ? `${seg[seg.length - 1].replace(/\.duckdb_extension\.wasm$/, '')} extension` : rel;
    parts.set(name, (parts.get(name) || 0) + st.size);
    total += st.size;
  }
  return { total, parts: [...parts].sort((a, b) => b[1] - a[1]) };
}

// --- What changed in the folder since it was published ---------------------------

// The folder's own files — what an export writes and an agent edits — as { 'a/b': sha256 }.
// node_modules and dist/ are build output, not edits.
const FINGERPRINTED = ['site', 'rayfin', 'AGENTS.md', '.gitignore'];
const SKIPPED = new Set(['node_modules', 'dist']);

async function fingerprint(outDir) {
  const out = {};
  async function walk(rel) {
    const abs = join(outDir, ...rel.split('/'));
    const st = await fsp.stat(abs).catch(() => null);
    if (!st) return;
    if (st.isDirectory()) {
      for (const e of (await fsp.readdir(abs)).sort()) if (!SKIPPED.has(e)) await walk(`${rel}/${e}`);
    } else {
      out[rel] = createHash('sha256').update(await fsp.readFile(abs)).digest('hex');
    }
  }
  for (const p of FINGERPRINTED) await walk(p);
  return out;
}

// The paths added, removed or changed since `marker.files` was taken; [] when nothing moved,
// or when the marker predates the record (an earlier export's).
async function localChanges(outDir, marker) {
  const was = marker && marker.files;
  if (!was) return [];
  const now = await fingerprint(outDir);
  return [...new Set([...Object.keys(was), ...Object.keys(now)])].filter(p => was[p] !== now[p]).sort();
}

// A build id, URL-safe (it is the ?v= cache-buster): yyyymmdd-hhmmss UTC.
const buildId = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

/**
 * dist/ from site/: every relative import gets ?v=<build> and __BUILD__ becomes the build, so
 * a browser never runs the files of two deploys together; then rayfin.config.json, which the
 * browser SDK fetches from the site's root. Returns the files, path -> bytes, as uploaded.
 * vendor/ is in the upload but not written to dist/: ~48 MB of packages, the same bytes as
 * site/vendor/, kept once.
 */
async function buildDist(outDir, config, build = buildId()) {
  const site = join(outDir, 'site'), dist = join(outDir, 'dist');
  await fsp.rm(dist, { recursive: true, force: true });
  const files = new Map();
  for (const rel of (await fsp.readdir(site, { recursive: true })).map(f => f.split('\\').join('/')).sort()) {
    const src = join(site, rel);
    if (!(await fsp.stat(src)).isFile()) continue;
    let bytes = await fsp.readFile(src);
    // site/vendor/ is pinned packages, already versioned by their path: left byte for byte.
    if (/\.(html|js)$/.test(rel) && !rel.startsWith('vendor/')) {
      bytes = Buffer.from(bytes.toString('utf8')
        .replaceAll('__BUILD__', build)
        .replace(/(\b(?:from|import)\s*["']\.{1,2}\/[\w./-]+\.js)(["'])/g, `$1?v=${build}$2`)
        .replace(/(<link rel="stylesheet" href="\.\/[\w./-]+\.css)(")/g, `$1?v=${build}$2`), 'utf8');
    }
    files.set(rel, bytes);
  }
  files.set('rayfin.config.json', Buffer.from(JSON.stringify(config, null, 2) + '\n', 'utf8'));
  for (const [rel, bytes] of files) {
    if (rel.startsWith('vendor/')) continue;
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

module.exports = { planExport, writeExport, buildDist, writeMarker, readMarker, fingerprint, localChanges,
                   vendorSize, zip, crc32, rayfinYml, appName, dfsUrl, MARKER };
