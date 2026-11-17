'use strict';
// =============================================================================
// exportapp.js — Export to Fabric: a model's Explore, as a Fabric app of its own
// =============================================================================
// Explore's button (page/explore/view.js) hands the host the model's text (to check it), where
// it lives in OneLake (for a model opened from its local copy, where the export writes it), and
// the shelves on screen. The local copy — the whole app, an agent's to grow later — is one zip on
// this machine, <model>.fabricator, and what is published is built from it (buildDist, fabricapp.js).
// It is a Rayfin project as the Rayfin CLI lays one out, so Fabricator imports it (a .fabricator is
// its own project file), installs its packages, previews it with its own Vite and publishes it with
// `rayfin up`, over the same app this export made:
//   package.json     the project (projectPackage): the Rayfin CLI, which Fabricator and rayfin-local run;
//                    site and rayfin/functions are its workspaces
//   package-lock.json  fabric_app/project/package-lock.json (projectLock): npm resolves nothing
//   .gitignore, .gitattributes  fabric_app/project
//   scripts/validate-report.mjs  `npm run validate`: the Report checked with the page's own code
//   site/            the page, a Vite project (PAGE):
//     package.json   the packages the page imports (sitePackage: the Rayfin SDK, ECharts, DuckDB-WASM and
//                    Arrow), Vite and Rayfin's local-dev plugin
//     vite.config.mjs  fabric_app/project: `npm run build` makes site/dist/, which is what is uploaded
//     index.html, src/app.js, src/storage/  fabric_app/site: the page and its data source (storage/: Fabric
//                    sign-in, the function's answer, DuckDB-WASM reading the tables in the browser as
//                    views v_<table>)
//     src/explore/   Studio's Explore (page/explore/), the same files the panel runs
//     src/semantic/  dax-sql (PINS.daxSql): SQL over the model, as SQL over the views
//     public/        the site's own files, which Vite copies as they are (SITE):
//       report.json  the Report the app opens on (page/explore/report.js draws it): Studio's Report
//                    tab's tiles (none at first), written once, then the zip's (Studio's Add to
//                    report writes it too), and kept by every export
//       explore.json the shelves the first view shows
//       settings.json  { maxRows }: the most rows a visual asks for, maxResultRows as it was at the export
//       model.json   the model the page runs on: the project's model file, as JSON
//       world.json, duckdb-ext/  what npm has not (staticFiles): the world's outline a map draws over, and
//                    DuckDB's signed extensions; the extension's own, written again by every export
//       rayfin.config.json  the backend the browser talks to, once published (`rayfin up` keeps one it finds)
//   rayfin/          fabric_app/rayfin: what the app is (rayfin.yml) and its function's source
//                    (built at package time too, by scripts/function-bundle.mjs, for the extension's publish)
//   rayfin/.deployments.json  once published: the app, as `rayfin up` records it, so its publishes update it
//   rayfin/.env.secrets, rayfin/functions/local.settings.json  the function's CATALOG_URL and
//                    TABLES (a URL and table names, no credential), for `rayfin up` and a local run
//   model.ossie.yaml the model the app runs on (model.bim for a .bim), the model as
//                    exported. Each publish makes model.json from it, so an edit here (an
//                    agent's) is published by opening the file and exporting it.
//   AGENTS.md        how the app is made, and how to grow its report
//   .agents/skills/, .mcp.json, rayfin/.lockfile.json  Rayfin's agent files, as `rayfin init ai-files install`
//                    writes them at the project's CLI version (fabric-function/agent-files.json)
//   .fabricator/export.json   what Fabricator's Import window shows: the project's name, who exported it, when
//   .onelake-studio/export.json  our record (MARKER): the app item, its redirects, the entries' hashes
// The upload is the page as Vite builds it and the project's site/public/ (buildDist). OneLake Studio runs
// no npm: its page is built when the extension is packaged (scripts/site-bundle.mjs, fabric-site/), from
// these same files with the lock's packages, so it publishes what `npm run build` makes of a project it
// wrote. A project whose page was changed (site/src/…) is Fabricator's or `rayfin up`'s to publish.
// An earlier export's project had its page in site/public/, served as it was with its packages in
// site/public/vendor/: the next export writes it as above (setPage).
// An earlier export's .fabricapp (site/ at the top, export.json at the root, no packages) still reads:
// readApp lays it out as above, and its next save writes it so (exportflow.js).
// The app runs on the model as exported, never the lakehouse's file as it is now: the
// page reads model.json, made from the file's model.yaml, and its function signs only the
// tables that model names (TABLES). The lakehouse its Direct Lake expression holds is the catalog
// (CATALOG_URL). Nothing here is AI.
// No `vscode` import: the extension passes in what it owns.
// =============================================================================

const { join, dirname } = require('node:path');
const fsp = require('node:fs/promises');
const zlib = require('node:zlib');
const deflateRaw = require('node:util').promisify(zlib.deflateRaw);
const { createHash, randomBytes } = require('node:crypto');
const { crc32 } = require('../../core/crc32');
const { TABLE_ORIGIN } = require('../../core/onelake/catalog');
const { dfsFileUrl, stripBom } = require('../../core/names');
const { PINS, WEBAPP } = require('../../core/vendored');

// The page in the project, a Vite project (staticHosting's path in fabric_app/rayfin/rayfin.yml): its
// build, site/dist/, is what `rayfin up` uploads.
const PAGE = 'site/';
// The site's own files, which Vite copies into the build as they are: what an export writes of an app.
const SITE = 'site/public/';
// The zip's record of what was published, in a folder of its own as Fabricator keeps its own, and
// the Report: written when the zip has none, and kept from then on by every export.
const MARKER = '.onelake-studio/export.json';
const REPORT = `${SITE}report.json`;
// What Fabricator's Import window reads (its Manifest): written by every export.
const FABRICATOR_RECORD = '.fabricator/export.json';
// Where `rayfin up` records the app it published, which its next publish updates.
const DEPLOYMENTS = 'rayfin/.deployments.json';
const CONFIG = `${SITE}rayfin.config.json`;
// What npm has not, the extension's own (staticFiles): written again by every export.
const STATIC = [`${SITE}world.json`, `${SITE}duckdb-ext/`];
const isStatic = p => STATIC.some(s => (s.endsWith('/') ? p.startsWith(s) : p === s));
// The record's format: a file of a later one is never read as this one, nor written over.
const FORMAT = 1;
// The local copy's own extension, Fabricator's project file: a zip inside. An earlier export's
// .fabricapp still opens (LEGACY_EXT), and its next save writes a .fabricator beside it.
const APP_EXT = '.fabricator';
const LEGACY_EXT = '.fabricapp';
const OLD_MARKER = 'export.json';
const OLD_SITE = 'site/';
// The model the app runs on, in its own format, at the file's root.
// model.ossie.yaml, as Ossie's own tools name a model; model.yaml from an earlier export still reads.
const MODEL_COPIES = ['model.ossie.yaml', 'model.yaml', 'model.bim'];
const modelCopyName = file => (/\.bim$/i.test(String(file)) ? 'model.bim' : 'model.ossie.yaml');
/** The model's copy in the app's entries: `text` as `file` names its format, the other format's gone. */
function setModelCopy(files, file, text) {
  for (const p of MODEL_COPIES) files.delete(p);
  files.set(modelCopyName(file), Buffer.from(String(text), 'utf8'));
}
/** The model copy an app's entries hold, { name, text }, or null. */
function modelCopyOf(files) {
  const name = MODEL_COPIES.find(p => files.has(p));
  return name ? { name, text: files.get(name).toString('utf8') } : null;
}

// An app's name: the model's, lower case, letters, digits and dashes (as a Rayfin id). An app of that name
// that no export made is asked about before it is replaced (exportflow.js).
function appName(s) {
  const out = String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return !out ? 'model' : /^[a-z]/.test(out) ? out : `m-${out}`;
}
// The name an earlier build gave the same app: one published under it keeps it (exportflow.js).
const appNameBefore = name => `${name}-explore`;

// An Ossie dataset's table as schema.table, or null when it reads none. `source` is required
// by the spec, so a model from Power BI has one even for a calculation group or a calculated
// table: its partition, kept in the POWER_BI extension, says it has no entity. A bare name is
// in dbo, as in a TMSL partition; item.schema.table is its last two parts. The page reads it the same way
// (fabric_app/site/src/storage/data.js).
function ossieSource(d) {
  // The extension as Ossie has it now (an object), or as a file of the spec before does (custom_extensions, a JSON string).
  const pbi = (d.nonportable_extensions ?? d.custom_extensions ?? []).find(e => String(e.vendor_name).toUpperCase() === 'POWER_BI');
  let partition;
  try { partition = (typeof pbi.data === 'string' ? JSON.parse(pbi.data) : pbi.data).partitions?.[0]; } catch { /* no extension: its source alone */ }
  if (!d.source || (partition && !partition.source?.entityName)) return null;
  const s = String(d.source);
  // A table named <item>.<schema>.<table>, in the lakehouse the app reads: its schema.table.
  const parts = (s.match(/"(?:[^"]|"")*"|[^.]+/g) ?? []).map(p => (p.startsWith('"') ? p.slice(1, -1).replace(/""/g, '"') : p));
  if (parts.length === 3) return `${parts[1]}.${parts[2]}`;
  return s.includes('.') ? s : `dbo.${s}`;
}

// The model's tables as the data source reads them (fabric_app/site/src/storage/data.js,
// modelTables): name -> schema.table. An Ossie dataset's table; a TMSL table's Direct Lake
// partition.
/** The tables a model names, schema.table, each once: what the app's function may sign (TABLES). */
const tablesOf = model => [...new Set(sourcesOf(model).values())];

function sourcesOf(model) {
  const out = new Map();
  for (const d of model.datasets ?? []) {
    const s = ossieSource(d);
    if (s) out.set(d.name, s);
  }
  for (const t of (model.model ?? model).tables ?? []) {
    const s = t.partitions?.[0]?.source;
    if (s?.entityName) out.set(t.name, `${s.schemaName ?? 'dbo'}.${s.entityName}`);
  }
  return out;
}

// A OneLake file's DFS URL, from the names the tree knows it by: the workspace, and the path
// from its item ("nem.Lakehouse/Files/semantic_model/ossie.yaml").
const trimPath = p => String(p).replace(/^\/+/, '');
const dfsUrl = (workspace, path) => dfsFileUrl(workspace, path);

// The model's file, read: { doc, bim }, the file as it is (an Ossie model, or TMSL) and as TMSL.
function modelDoc(text, fileName, { compiler, semantic }) {
  const body = stripBom(text);
  if (semantic.isOssiePath(fileName)) {
    if (!semantic.isOssie(body)) throw new Error(`${fileName} is not an Apache Ossie model: it has no top-level version and datasets`);
    let doc;
    try { doc = compiler.parseYaml(body); }
    catch (e) { throw new Error(`${fileName} is not YAML: ${e.message}`); }
    return { doc, bim: compiler.ossieToTmsl(doc) };
  }
  try { const bim = JSON.parse(body); return { doc: bim, bim }; }
  catch (e) { throw new Error(`${fileName} is not a TMSL model: ${e.message}`); }
}

/**
 * What an export is, before anything is written: the app's name, its lakehouse and catalog,
 * the model's URL. Throws, saying why, when the model cannot make one.
 * `mods`: the agent's modules() — { compiler: { parseYaml, ossieToTmsl }, semantic };
 * `where`: the model file in OneLake, { workspace, path } (the path from its item), or a file on
 * disk, { workspace, onDisk: true, path? }, in the workspace its tables are in: the app carries its own copy
 * of the model either way, so where the file is only names the app's model; `lakes`: the
 * model's lakehouses by GUIDs, when the caller has resolved those its tables name in full.
 */
function planExport(text, fileName, name, mods, where, lakes = null) {
  const { semantic } = mods;
  const onDisk = !!(where && where.onDisk && where.workspace);
  if (!onDisk) {
    if (!where || !where.workspace || !where.path) throw new Error(`${fileName} is not a OneLake file, nor a file from disk in a workspace`);
    if (!/^[^/]+\/Files\//.test(trimPath(where.path))) throw new Error(`${fileName} is not in a lakehouse's Files/`);
  }
  const { doc, bim } = modelDoc(text, fileName, mods);
  const found = lakes || semantic.lakehousesOf(bim);
  if (found.length !== 1) {
    throw new Error(found.length
      ? `${fileName} names ${found.length} lakehouses: the app reads one catalog`
      : `${fileName} names no lakehouse: its tables must be named <lakehouse>.<schema>.<table>, or its Direct Lake expression hold https://onelake.dfs.fabric.microsoft.com/<workspace id>/<lakehouse id>`);
  }
  const [lake] = found;
  if (!lake.workspace) throw new Error(`${fileName} names its lakehouse ${lake.itemName} by name, and the app needs its GUIDs: Export to Fabric looks them up`);
  // A table reading another expression, a Sql.Database say, isn't in that lakehouse under its name.
  const lakeExprs = semantic.lakeExpressions(bim);
  const elsewhere = ((bim.model ?? bim).tables ?? []).filter(t => {
    const s = t.partitions?.[0]?.source;
    return s?.entityName && s.expressionSource && !lakeExprs.has(s.expressionSource);
  });
  if (elsewhere.length) {
    throw new Error(`${fileName} has tables its lakehouse doesn't hold: ${elsewhere.map(t => t.name).join(', ')} read another expression, and the app reads one catalog`);
  }
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
    // A file from disk is named by its workspace and file name (`path`: the name its app's export.json
    // kept, exported again from the .fabricapp): no OneLake path is its own.
    modelPath: `${where.workspace}/${trimPath(onDisk ? where.path || String(fileName).replace(/^.*[\\/]/, '') : where.path)}`,
    tables: [...sources],
  };
}

// site/report.json is the zip owner's: written once, with the tiles Studio's Report tab kept for the
// model or none, and kept by every later export. Studio's Report tab draws the same file.
const EMPTY_REPORT = '{\n  "pages": [\n    { "name": "Page 1", "tiles": [] }\n  ]\n}\n';

// fabric_app/rayfin/rayfin.yml, for this app: its own id and name, and its sign-in redirects.
function rayfinYml(text, name, redirects = []) {
  let out = String(text);
  const swap = (re, to, what) => {
    if (!re.test(out)) throw new Error(`fabric_app/rayfin/rayfin.yml has no ${what}`);
    out = out.replace(re, to);
  };
  swap(/^id: .*$/m, `id: ${name}`, 'id');
  swap(/^name: .*$/m, `name: ${name}`, 'name');
  // An earlier export's (an as-is file's own): its site was site/public/ as it was, with no build.
  out = out.replace(/^([ \t]*)folder: public[ \t]*\r?\n(?![ \t]*buildCommand:)/m,
    (m, indent) => `${indent}folder: dist\n${indent}buildCommand: npm run build\n`);
  // Only the redirects not listed yet: an as-is folder's rayfin.yml already has the last
  // publish's, and every publish would list them once more.
  const block = /^[ \t]*allowedRedirectUris:[ \t]*\r?\n((?:[ \t]+- .*\r?\n)*)/m.exec(out);
  const listed = new Set(block ? block[1].split(/\r?\n/).map(l => l.replace(/^[ \t]+- /, '').trim()) : []);
  const fresh = [...new Set(redirects)].filter(r => !listed.has(r));
  if (fresh.length) {
    swap(/^([ \t]*)allowedRedirectUris:[ \t]*\r?\n/m,
      m => m + fresh.map(r => `${/^([ \t]*)/.exec(m)[1]}  - ${r}\n`).join(''), 'allowedRedirectUris');
  }
  return out;
}

const agentsMd = plan => `# ${plan.title} — its Report, as a Fabric app

Written by OneLake Studio's **Export to Fabric**, and deployed by it over the Fabric REST API (item
type \`AppBackend\`, named \`${plan.name}\`). The site is **protected** — only people who may
open the app item can load it.

This is a Rayfin project: the page is a Vite project in \`site/\`, and \`npm run build\` makes \`site/dist/\`,
which is what is published. Fabricator previews and publishes it. Once OneLake Studio has published it,
\`rayfin/.deployments.json\` names the app, so either one updates that same app.

OneLake Studio publishes its own build of the page, with this project's \`site/public/\`. So a change to the
Report or the model is published by either; a change to the page's code (\`site/src/\`, \`site/index.html\`)
only by a publish that builds the project.

- Model: \`model.ossie.yaml\` in this file (\`model.bim\` for a .bim), exported from \`${plan.modelPath}\`: the app
  runs on it, as \`site/public/model.json\`, made from it at each publish by OneLake Studio. An edit to it is published by opening the project's \`.fabricator\` in OneLake Studio and exporting it;
  a change to the lakehouse's file reaches the app when it is exported again.
- Lakehouse: workspace \`${plan.workspace}\`, item \`${plan.lakehouse}\` — its Iceberg catalog is the
  function's \`CATALOG_URL\`: ${plan.catalogUrl}
- Identity: the function reads the tables as the **app item's owner** (Fabric Apps' app identity), so anyone who
  may open the app reads them with the owner's rights, never their own. It signs a SAS only for the tables the
  model names (its \`TABLES\` setting), and never reads the model.

## The Report: yours to grow

The app is its Report, \`site/public/report.json\`, and nothing else. The first export wrote
it with the tiles built in OneLake Studio's Report tab (none, if it had none), and no export writes it
again: edit it freely, then export again to publish it. Delete it and the next export writes a new one. OneLake Studio's Report tab, after Model and Visual,
draws this same file from its \`.fabricator\`, and draws it again when that changes; its Visual's **Add to report**
and a tile's ✕ write it there.

\`model.ossie.yaml\` (\`model.bim\` for a .bim model), at the root, is the model the app runs on: read it for what
its columns and measures mean.

**The fields a tile can name**, exactly as a tile names them, by table: \`npm run validate -- --fields\`.

**After every change to the Report, run \`npm run validate\`** and fix what it says. It checks
\`site/public/report.json\` with the page's own code: every page and tile, every field each one names (with the
nearest names when one is wrong), every filter, mark and layout, the filter bar, and that each tile's
query compiles as the page compiles it. It reads no data, so a tile it passes can still show no rows: look at it in the preview.

\`\`\`json
{ "pages": [
  { "name": "Sales", "tiles": [
    { "title": "", "kind": "text", "text": "# Sales\\nRevenue is **net of returns**." },
    { "title": "Revenue by Region", "kind": "pivot",
      "pivot": { "rows": ["dim_region.Region"], "values": ["Revenue"], "filters": [], "mark": "bar", "sort": "desc", "top": 10,
                 "format": { "numbers": { "Revenue": "int" } } } }
  ] }
] }
\`\`\`

- A tile is a Visual (\`pivot\`) or \`text\`, nothing else: no tile holds SQL. A Visual's query is generated from its
  shelves, the same SELECT over the model as OneLake Studio's Visual writes. The page compiles it (dax-sql) to SQL
  over the tables, and DuckDB-WASM runs it.
- \`pages\` are shown by name over the tiles, one at a time, in this order; a click on one in a tile filters only
  the tiles of its page. An older report, \`{ "tiles": [...] }\`, is one page, Page 1.
- \`pivot\` is Explore's shelves, as **Add to report** saves them, drawn as Visual draws them:
  \`{ "rows": ["dim_region.Region"], "cols": [], "values": ["Revenue"], "filters": [], "mark": "bar" }\`.
  A column is \`table.column\`, a measure its name; a column summarised on Values is \`"\\u0000sum\\u0000table.column"\`
  (\`sum\`, \`avg\`, \`min\`, \`max\`, \`count\`, \`distinct\`). \`mark\` is \`auto\`, \`table\`, \`highlight\`, \`bar\`, \`stacked\`,
  \`line\`, \`area\`, \`heatmap\`, \`scatter\`, \`card\`, \`slicer\`, \`treemap\`, \`calendar\` or \`map\`. \`"totals": true\` adds
  the totals. \`"sort": "desc"\` orders by the first measure, largest first, and \`"top": n\` keeps its first n rows (ties
  kept). A click picks its first Rows field (else Columns), and filters the page's other tiles by it.
- \`filters\` (the shelf): each \`{ "field": "<column>", "op": ... }\`: \`"in"\` or \`"notIn"\` with \`"values": [...]\`,
  \`"range"\` with \`"min"\` and/or \`"max"\`, \`"last"\` with \`"n"\` (the last n days, to today), \`"blank"\` or \`"notBlank"\`.
  On a measure, \`{ "field": "<measure>", "op": "range", "min": ..., "max": ..., "measure": true }\` keeps the rows whose
  figure is in that range (a HAVING): \`{ "field": "Curtailed MWh", "op": "range", "min": 0.001, "measure": true }\`.
- A card is a \`pivot\` tile whose \`mark\` is \`card\`: each field on Values as one big figure, over every row its
  filters keep. A date column on Rows adds its trend under the figure, and a second measure on Values (the model's
  own change measure) is shown as its change, ▲ or ▼:
  \`{ "rows": [], "cols": [], "values": ["Revenue"], "filters": [], "mark": "card" }\`.
- A slicer is a \`pivot\` tile whose \`mark\` is \`slicer\`: it lists the values of its first Rows field (those with a
  figure, when a measure is on Values, which it shows beside each), and what is picked in it filters every other tile.
  \`"slicer"\` says how it is drawn: \`list\`, \`buttons\`, \`dropdown\`, or \`range\` (a date or a number):
  \`{ "rows": ["dim_date.Year"], "values": ["Revenue"], "filters": [], "mark": "slicer", "slicer": "buttons" }\`.
- \`treemap\`: Rows are its levels (one or two), the first measure its size. \`calendar\`: a date column on Rows, the
  first measure a day's colour, one strip per year. \`map\`: Rows are a latitude, a longitude and optionally a name; the
  first measure a point's size, and a column on Columns its colour.
- \`text\`'s \`text\` is a few lines of Markdown (\`#\` to \`###\` headings, \`**bold**\`, \`*italic*\`, \`[a link](https://…)\`,
  \`- \` lists), and nothing else of Markdown or HTML.
- The tiles are laid out on 12 columns and rows of 10 pixels: \`"layout": { "x": 0, "y": 0, "w": 4, "h": 30 }\` puts a
  tile at the first column and row, 4 columns wide and 300 pixels tall, as its grip and its ◢ in OneLake Studio set
  it. Every tile floats up as far as it can; one with no layout goes in the first place it fits. \`"wide": true\`
  gives a tile with no layout the whole row.
- \`pivot.format\`: how the Visual is drawn, as OneLake Studio's Visual's Format pane sets it, kept with its shelves:
  any of \`"colors": { "<series>": "#rrggbb" }\`, \`"labels": true\`, \`"legend"\` (\`top\`, \`bottom\`, \`right\`, \`off\`),
  \`"xTitle"\`, \`"yTitle"\`, \`"yMin"\`, \`"yMax"\`, \`"zoom": true\`, \`"maxLabel": true\`, \`"totalLine": true\` (the total of
  each measure as a line across, from the query's own totals), \`"measures": { "<measure>": { "as": "bar" | "line" |
  "area" | "dashed", "axis": "right" } }\` (several measures in one plot), \`"byValue": { "<measure>": "background" |
  "bar" }\`, \`"banded": true\`, \`"figureSize"\`, \`"figureColor"\`, \`"change": "<measure>"\` and \`"goodWhen": "down"\` (a
  card's change), and \`"numbers": { "<field>": "int" | "dec2" | "short" | "pct" | "usd" }\`.
- A tile's own, beside \`pivot\`: \`"subtitle"\` (a line under its title), \`"showTitle": false\`, \`"titleSize": "S"\` or
  \`"L"\`, and \`"ignore": ["<filter bar field>"]\`, the filter bar's filters it does not follow.
- \`title\`, beside \`pages\`: the report's title, over its pages.
- \`theme\`, beside \`pages\`: \`{ "style": "paper" | "midnight" | "slate", "background": "dark" | "light", "palette": "ocean" | "warm" |
  "mono", "textSize": "S" | "L", "colors": { "<value>": "#rrggbb" } }\` for every page. A \`style\` is the whole look at once (the
  page's, the tiles' and the text's colours, and its own palette), and \`background\` is for a report with none; \`colors\` gives a
  value of any column (a fuel, a region) the same colour in every tile.
- \`filters\`, beside \`pages\`: the filter bar over every page, each \`{ "field": "table.column", "style": "dropdown" |
  "list" | "dates" }\`. What a viewer picks in it filters every tile, but those whose \`ignore\` names it.

## Layers

| Layer | Path | |
|---|---|---|
| Report | \`site/public/report.json\` | the pages the app shows: yours, kept by every export |
| Checker | \`scripts/validate-report.mjs\` | \`npm run validate\`: the Report checked with the page's own code, no browser |
| Page | \`site/index.html\`, \`site/src/app.js\` | the Report over the data source |
| Explore | \`site/src/explore/\` | OneLake Studio's, the same files the extension runs; \`report.js\` draws the Report, with Visual's drawing for a pivot tile |
| Compiler | \`site/src/semantic/src/\`, \`site/src/semantic/formats/\` | dax-sql (\`${PINS.daxSql}\`): SQL over the model, as SQL over \`v_<table>\` |
| Packages | \`site/package.json\` | DuckDB-WASM (\`${WEBAPP.duckdbWasm}\`, DuckDB ${WEBAPP.duckdb}), Arrow, the Rayfin SDK, ECharts: npm's, bundled by Vite; nothing from a CDN |
| Site files | \`site/public/\` | copied into the build as they are: the Report, the model, the page's settings, DuckDB's ${WEBAPP.extensions.join(' and ')} extensions (\`duckdb-ext/\`), the world's outline (\`world.json\`) |
| Data source | \`site/src/storage/\` | signs in (Rayfin Fabric SSO), asks the function, downloads into the browser (OPFS) what the Report reads of the tables (of a large one, only the columns it reads: \`storage/ranges.js\`), DuckDB-WASM |
| Function | \`rayfin/functions/src/function_app.ts\` | reads the model, the tables' metadata locations, a read-only SAS on \`Tables/\` |

Tables the app reads (\`v_<table>\` ← \`schema.table\`):

${plan.tables.map(([n, s]) => `- \`${n}\` ← \`${s}\``).join('\n')}

Exporting again from OneLake Studio rewrites every file of its \`.fabricator\` but \`site/public/report.json\`, and updates the
same app; \`.onelake-studio/export.json\` is its record of what was published.

The workspace must allow **OneLake user-delegated SAS tokens** (workspace settings → OneLake): the
function signs one. The page needs a browser with OPFS shared access handles (Chrome or Edge 121+).
`;

// --- The local copy: one zip ------------------------------------------------------

// A zip's entries, path -> bytes: the ones zip() writes (deflated), and stored ones, as another tool
// re-zips the app. Folders are left out, a backslash is a slash, and one top folder holding every
// entry (a folder zipped whole) is taken off.
const MAX_ENTRY_BYTES = 256 * 1024 * 1024;
// All of them together, and how many: each entry's limit alone lets a directory of thousands, every one
// pointing at the same few packed bytes, unpack to more memory than there is. An app is a few MB in a few
// hundred files.
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_ENTRIES = 20000;
function unzip(buf, { maxTotal = MAX_TOTAL_BYTES, maxEntries = MAX_ENTRIES } = {}) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0 || end + 22 > buf.length) throw new Error('no zip directory');
  const count = buf.readUInt16LE(end + 10);
  if (count > maxEntries) throw new Error(`${count} entries is more than an app holds`);
  let at = buf.readUInt32LE(end + 16);
  const out = new Map();
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== 0x02014b50) throw new Error('a broken zip directory');
    const method = buf.readUInt16LE(at + 10), size = buf.readUInt32LE(at + 20), raw = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28), extra = buf.readUInt16LE(at + 30), note = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42), crc = buf.readUInt32LE(at + 16);
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString('utf8').split('\\').join('/');
    at += 46 + nameLen + extra + note;
    if (name.endsWith('/')) continue;
    if (method !== 0 && method !== 8) throw new Error(`${name} is compressed in a way this can't read (method ${method})`);
    if (local + 30 > buf.length) throw new Error(`${name} is damaged`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    if (start + size > buf.length) throw new Error(`${name} is damaged`);
    const packed = buf.subarray(start, start + size);
    // No more than the entry says it holds, and no entry that says more than an app's file could: a few
    // kilobytes can otherwise unpack to all the memory there is.
    if (raw > MAX_ENTRY_BYTES) throw new Error(`${name} is too big to be an app's file`);
    total += raw;
    if (total > maxTotal) throw new Error('its files are too big together to be an app');
    let data;
    try { data = method === 8 ? zlib.inflateRawSync(packed, { maxOutputLength: Math.max(1, raw) }) : Buffer.from(packed); }
    catch { throw new Error(`${name} is damaged`); }
    if (data.length !== raw || crc32(data) !== crc) throw new Error(`${name} is damaged`);
    out.set(name, data);
  }
  const tops = new Set([...out.keys()].map(p => (p.includes('/') ? p.slice(0, p.indexOf('/') + 1) : '')));
  let files = out;
  if (tops.size === 1 && ![...tops][0].match(/^(|site\/|rayfin\/|\.onelake-studio\/|\.fabricator\/)$/)) {
    const [top] = tops;
    files = new Map([...out].map(([p, b]) => [p.slice(top.length), b]));
  }
  // An entry is a file of the app. One that names a place outside it is nothing an export wrote: checked as it
  // is kept, with any top folder gone, so that no part is empty, a dot, two dots or a drive.
  for (const name of files.keys()) {
    if (/^[A-Za-z]:/.test(name) || name.split('/').some(part => part === '' || part === '.' || part === '..')) {
      throw new Error(`${name || '(no name)'} is not a path inside an app`);
    }
  }
  return files;
}

/**
 * The local copy, read: { files: Map(path -> bytes), marker }; null when there is no such file.
 * Throws for a file that is not an app Export to Fabric wrote, which is never written over, and for one a
 * later OneLake Studio wrote (its record's format). An earlier export's .fabricapp is answered laid out as
 * a .fabricator is (fromLegacy), so the next write writes it so.
 */
async function readApp(zipPath) {
  const bytes = await fsp.readFile(zipPath).catch(e => (e.code === 'ENOENT' ? null : Promise.reject(e)));
  if (!bytes) return null;
  let files;
  try { files = unzip(bytes); } catch (e) { throw new Error(`${zipPath} is not a zip Export to Fabric can read: ${e.message}`); }
  const legacy = !files.has(MARKER) && files.has(OLD_MARKER);
  let marker = null;
  try { marker = JSON.parse(files.get(legacy ? OLD_MARKER : MARKER).toString('utf8')); } catch { /* not ours */ }
  if (!marker || typeof marker !== 'object') throw new Error(`${zipPath} was not written by Export to Fabric: rename it, or choose another folder`);
  if (Number(marker.format) > FORMAT) {
    throw new Error(`${zipPath} was written by a later OneLake Studio (its format is ${marker.format}): update OneLake Studio to open it`);
  }
  files.delete(MARKER);
  files.delete(FABRICATOR_RECORD);
  if (legacy) return fromLegacy(files, marker);
  return { files, marker };
}

// An earlier export's .fabricapp, as a .fabricator lays it out: its site/ is site/public/, its record at the
// root is MARKER, and its record's hashes name the entries where they are now. It has no packages: the next
// export writes them, as it does for every file.
function fromLegacy(files, marker) {
  const move = p => (p.startsWith(OLD_SITE) ? SITE + p.slice(OLD_SITE.length) : p);
  const out = new Map([...files].filter(([p]) => p !== OLD_MARKER).map(([p, b]) => [move(p), b]));
  const was = marker.files && typeof marker.files === 'object' ? marker.files : null;
  return { files: out, marker: was ? { ...marker, files: Object.fromEntries(Object.entries(was).map(([p, h]) => [move(p), h])) } : marker };
}

// A zip's entries in path order, as every export writes, hashes and uploads them.
const byPath = files => [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

// What Fabricator's Import window shows of the project (its Manifest, format 1), from our record: its name, when
// it was exported, and the workspace its publishes go to, when it is published (rayfin/.deployments.json).
const fabricatorRecord = marker => ({
  format: 1, name: String(marker.name || ''),
  ...(marker.exportedAt ? { createdAt: marker.exportedAt } : {}),
  history: false, deployment: !!marker.itemId,
  ...(marker.itemId && marker.report && marker.report.workspace ? { workspace: String(marker.report.workspace) } : {}),
});

/**
 * Writes the local copy, its entries sorted, then Fabricator's record and ours last: beside it first, then
 * renamed into place.
 */
async function writeApp(zipPath, files, marker) {
  const all = byPath(files).filter(([p]) => p !== MARKER && p !== FABRICATOR_RECORD);
  const json = o => Buffer.from(JSON.stringify(o, null, 2) + '\n', 'utf8');
  all.push([FABRICATOR_RECORD, json(fabricatorRecord(marker))], [MARKER, json({ ...marker, format: FORMAT })]);
  await fsp.mkdir(dirname(zipPath), { recursive: true });
  // A name of this write's own: two writes of one file at once (a publish, and a tile added meanwhile)
  // would otherwise write into each other's.
  const tmp = `${zipPath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await fsp.writeFile(tmp, await zip(all));
    await fsp.rename(tmp, zipPath);
  } catch (e) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

// A folder's files, under `to`: path -> bytes, but for those `skip` says.
async function filesOf(root, to, skip = () => false) {
  const out = new Map();
  for (const rel of (await fsp.readdir(root, { recursive: true })).map(f => f.split('\\').join('/')).sort()) {
    if (skip(rel)) continue;
    const src = join(root, rel);
    if ((await fsp.stat(src)).isFile()) out.set(`${to}${rel}`, await fsp.readFile(src));
  }
  return out;
}

// The Rayfin version the page's SDK is pinned at (core/vendored.js), which fabricapp.js speaks to Fabric too.
const RAYFIN_VERSION = WEBAPP.rayfinClient.split('@').pop();
// Every @microsoft/rayfin-* of the project on its ~X.Y.0 line, as the Rayfin CLI's templates have them and
// Fabricator's checks ask: the lock file names the version each is.
const RAYFIN_RANGE = `~${RAYFIN_VERSION.split('.').slice(0, 2).join('.')}.0`;
// A pin (core/vendored.js), as package.json names it: [name, version].
const pinOf = p => { const at = p.lastIndexOf('@'); return [p.slice(0, at), p.slice(at + 1)]; };
const nameOf = p => pinOf(p)[0];
// What the project installs at its root, as the Rayfin CLI's templates do: Fabricator publishes a project
// with its own Rayfin CLI, and rayfin-local runs it with its own @microsoft/rayfin-core.
const PROJECT_PACKAGES = {
  '@microsoft/rayfin-cli': RAYFIN_RANGE,
  '@microsoft/rayfin-core': RAYFIN_RANGE,
  typescript: '5.7.3',
};
// What the page is built with (site/vite.config.mjs): Vite, and the local-dev plugin, which serves the page
// the local backend's rayfin.config.json.
const SITE_DEV_PACKAGES = {
  '@microsoft/rayfin-local-dev': RAYFIN_RANGE,
  vite: '8.3.6',
};
/** The packages the page imports: the Rayfin SDK, ECharts, DuckDB-WASM and Arrow. */
const sitePackages = () => Object.fromEntries([
  [nameOf(WEBAPP.rayfinClient), RAYFIN_RANGE],
  [nameOf(WEBAPP.rayfinFabric), RAYFIN_RANGE],
  pinOf(WEBAPP.duckdbWasm), pinOf(WEBAPP.arrow),
  pinOf(WEBAPP.echarts),
].sort(([a], [b]) => (a < b ? -1 : 1)));
// The project names Arrow too, at the page's version: a package the project itself names is the
// one npm puts at the top of node_modules, so DuckDB-WASM (which asks for ^17) and the page share that one copy.
// Left to npm, the top one is another package's Arrow 21 (the Rayfin CLI's), DuckDB-WASM and the page each get
// a 17 of their own, and a table DuckDB answers is not a Table to the page's
// Arrow: no result was kept in the browser (storage/results.js, tableToIPC).
const projectPackages = () => Object.fromEntries([pinOf(WEBAPP.arrow)]);
/** The project's package.json: `npm run dev` as the template's; the page and the function are its workspaces. */
const projectPackage = name => JSON.stringify({
  name, private: true, version: '0.0.0', type: 'module',
  workspaces: ['site', 'rayfin/functions'],
  scripts: { dev: 'rayfin dev', 'dev:frontend': 'npm run dev -w site', build: 'npm run build -w site', 'rayfin:up': 'rayfin up',
             // The Report checked with the page's own code (fabric_app/project/validate-report.mjs).
             validate: 'node scripts/validate-report.mjs' },
  dependencies: projectPackages(),
  devDependencies: PROJECT_PACKAGES,
}, null, 2) + '\n';
/**
 * The page's package.json (site/): what it imports and is built with. `build:fabric` as the template names its build.
 * Its name is every app's the same: a lock file names a workspace's package (its link, node_modules/<name>), and one
 * lock file serves every app.
 */
const sitePackage = () => JSON.stringify({
  name: 'fabric-app-site', private: true, version: '0.0.0', type: 'module',
  scripts: { dev: 'vite', build: 'vite build', 'build:fabric': 'vite build' },
  dependencies: sitePackages(),
  devDependencies: SITE_DEV_PACKAGES,
}, null, 2) + '\n';
/**
 * The project's package-lock.json: fabric_app/project/package-lock.json (scripts/fabric-lock.mjs makes
 * it from projectPackage, sitePackage and the function's package.json), named for this app. With it,
 * Fabricator's `npm ci` takes the packages it names; without it, npm asked the registry about each of some
 * 300 packages first, most of the minute and a half an import took.
 */
/**
 * The project's npm package name: the app's, unless the lock file holds a package of that name (a model named
 * vite, or echarts): npm refuses a project that installs a package of its own name, so that one takes `-app`.
 * The app keeps its name everywhere else.
 */
function packageName(name, lockText) {
  const held = JSON.parse(lockText).packages || {};
  let out = name;
  while (held[`node_modules/${out}`]) out += '-app';
  return out;
}
function projectLock(text, name) {
  const lock = JSON.parse(text);
  lock.name = name;
  if (lock.packages && lock.packages['']) lock.packages[''].name = name;
  return JSON.stringify(lock, null, 2) + '\n';
}

/** The site's files npm has not, in the app's entries: the extension's own, written again over what the file had. */
function setStatic(files, statics) {
  for (const p of [...files.keys()]) if (isStatic(p)) files.delete(p);
  for (const [p, bytes] of statics) files.set(SITE + p, bytes);
}

// The page's code and the project around it: what an export writes from the extension's own files, and
// Vite builds. Not site/public/ (the app's own files), nor rayfin/, the model, the agent files or AGENTS.md.
const PROJECT_FILES = new Set(['package.json', 'package-lock.json', '.gitignore', '.gitattributes', 'scripts/validate-report.mjs']);
const isPage = p => (p.startsWith(PAGE) && !p.startsWith(SITE)) || PROJECT_FILES.has(p);
// An earlier export's page: in site/public/, served as it was, its packages in vendor/.
const OLD_PAGE = /^site\/public\/(?:index\.html$|app\.js$|paths\.js$|(?:storage|explore|semantic|vendor)\/)/;
const OLD_VENDOR = `${SITE}vendor/`;
/** Whether the entries are an earlier export's, their page in site/public/. */
const oldLayout = files => [...files.keys()].some(p => OLD_PAGE.test(p));

/**
 * The page's entries a person changed since the file was written: those whose bytes are neither the ones
 * its record kept (marker.files) nor this build's (`fresh`: appFiles). [] for a record with no hashes.
 * An earlier export's packages (vendor/) were never recorded: not counted.
 */
function pageChanges(files, marker, fresh) {
  const was = marker && marker.files;
  if (!was || typeof was !== 'object') return [];
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  const out = [];
  for (const [p, bytes] of byPath(files)) {
    if (!(isPage(p) || OLD_PAGE.test(p)) || p.startsWith(OLD_VENDOR)) continue;
    // The lock and package.json name the app: written again by every export, whatever they held.
    if (p === 'package-lock.json') continue;
    const now = sha(bytes);
    if (was[p] !== now && !(fresh.has(p) && sha(fresh.get(p)) === now)) out.push(p);
  }
  for (const p of Object.keys(was)) if ((isPage(p) || OLD_PAGE.test(p)) && !files.has(p) && fresh.has(p)) out.push(p);
  return [...new Set(out)].sort();
}

/** This build's page in the app's entries (`fresh`: appFiles), over whatever page they held, an earlier layout's too. */
function setPage(files, fresh) {
  for (const p of [...files.keys()]) if (isPage(p) || OLD_PAGE.test(p)) files.delete(p);
  for (const [p, bytes] of fresh) if (isPage(p)) files.set(p, bytes);
}

/**
 * The function's two settings, where `rayfin up` (rayfin/.env.secrets) and a local run
 * (rayfin/functions/local.settings.json) read them. Neither is a credential: the catalog's URL and the
 * tables it may sign for.
 */
function setSecrets(files, { catalogUrl, tables }) {
  files.set('rayfin/.env.secrets', Buffer.from(`CATALOG_URL=${catalogUrl}\nTABLES=${tables}\n`, 'utf8'));
  files.set('rayfin/functions/local.settings.json', Buffer.from(JSON.stringify({
    IsEncrypted: false, Values: { FUNCTIONS_WORKER_RUNTIME: 'node', CATALOG_URL: catalogUrl, TABLES: tables },
  }, null, 2) + '\n', 'utf8'));
}

// The workspace's key in rayfin/.deployments.json, as the Rayfin CLI makes it (sanitizeWorkspaceName).
const workspaceKey = name => String(name).slice(0, 200).toLowerCase().replace(/[\s_]+/g, '-')
  .replace(/[^a-z0-9-]/g, '').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');

/**
 * Once published, the app as `rayfin up` records it (rayfin/.deployments.json) and its site's
 * rayfin.config.json, so Fabricator's and `rayfin up`'s publishes update this app, not a new one.
 * `config`: the site's (fabricapp.js publish); `workspace`: the workspace's name.
 */
function setDeployment(files, { config, name, workspace, hostingUrl, deployedAt }) {
  const key = workspaceKey(workspace) || config.workspaceId;
  const portal = String(config.portalUrl || '').replace(/\/+$/, '');
  const record = {
    fabricItemId: config.itemId, itemName: name, fabricApiUrl: config.apiUrl, fabricWorkspaceId: config.workspaceId,
    ...(config.tenantId ? { fabricTenantId: config.tenantId } : {}),
    publishableKey: config.publishableKey, ...(hostingUrl ? { hostingUrl } : {}),
    fabricDeepLink: `${portal}/groups/${config.workspaceId}/appbackends/${config.itemId}${config.tenantId ? `?ctid=${config.tenantId}` : ''}`,
    deployedAt,
  };
  let was = {};
  try { was = JSON.parse(files.get(DEPLOYMENTS).toString('utf8')); } catch { /* none yet */ }
  const deployments = was && typeof was.deployments === 'object' && was.deployments ? was.deployments : {};
  files.set(DEPLOYMENTS, Buffer.from(JSON.stringify({ active: key, deployments: { ...deployments, [key]: record } }, null, 2) + '\n', 'utf8'));
  files.set(CONFIG, Buffer.from(JSON.stringify(config, null, 2) + '\n', 'utf8'));
}

/**
 * The app's entries, path -> bytes, as the local copy holds them, but the site's files npm has not
 * (setStatic) and, once published, its deployment (setDeployment).
 * `kept`: the zip's own report.json, which no export writes over, or the one Studio kept
 * before the first export (else a Report with no tiles);
 * `redirects`: the app's sign-in redirects so far.
 * `model`: the model the page runs on, read (modelDoc's doc): model.json.
 * `modelText`, `modelFile`: the model's text and its file's name, kept as model.ossie.yaml (setModelCopy).
 * `fabricAppDir`: the extension's fabric_app/; `appDir`: Studio's page modules (page/, or
 * webview/ installed); `daxSqlDir`: vendor/npm/<PINS.daxSql>; `agentFiles`: fabric-function/agent-files.json.
 */
async function appFiles({ plan, state, model, modelText = null, modelFile = 'model.yaml', kept = null, redirects = [], fabricAppDir, appDir, daxSqlDir, agentFiles, maxRows = null }) {
  if (!model) throw new Error('an app needs the model it runs on');
  // Rayfin's agent files, as `rayfin init ai-files install` writes them (scripts/function-bundle.mjs).
  const agents = JSON.parse(await fsp.readFile(agentFiles, 'utf8'));
  if (!agents['.agents/skills/rayfin/SKILL.md']) throw new Error(`${agentFiles} has no .agents/skills/rayfin/SKILL.md`);
  const text = s => Buffer.from(s, 'utf8');
  const SRC = `${PAGE}src/`;
  const lockText = await fsp.readFile(join(fabricAppDir, 'project', 'package-lock.json'), 'utf8');
  const files = new Map([
    // The page, a Vite project: index.html and src/.
    ...await filesOf(join(fabricAppDir, 'site'), PAGE),
    ...await filesOf(join(appDir, 'explore'), `${SRC}explore/`),
    [`${SRC}paths.js`, await fsp.readFile(join(appDir, 'paths.js'))],
    // As the package lays them out: formats/ imports ../src/.
    ...await filesOf(join(daxSqlDir, 'src'), `${SRC}semantic/src/`),
    ...await filesOf(join(daxSqlDir, 'formats'), `${SRC}semantic/formats/`),
    [`${PAGE}package.json`, text(sitePackage())],
    [`${PAGE}vite.config.mjs`, await fsp.readFile(join(fabricAppDir, 'project', 'vite.config.mjs'))],
    ...await filesOf(join(fabricAppDir, 'rayfin'), 'rayfin/', rel => rel.split('/').includes('node_modules')),
    // The project around it, as the Rayfin CLI's template has one: what Fabricator and rayfin-local run.
    ['package.json', text(projectPackage(packageName(plan.name, lockText)))],
    ['package-lock.json', text(projectLock(lockText, packageName(plan.name, lockText)))],
    ['.gitignore', await fsp.readFile(join(fabricAppDir, 'project', 'gitignore'))],
    ['.gitattributes', await fsp.readFile(join(fabricAppDir, 'project', 'gitattributes'))],
    ['scripts/validate-report.mjs', await fsp.readFile(join(fabricAppDir, 'project', 'validate-report.mjs'))],
    ...Object.entries(agents).map(([p, t]) => [p, text(t)]),
  ]);
  // The function's metadata as rayfin-local writes it on every build, with no newline at its end: as the repo has
  // it, every Fabricator session changed it, and each chat turn's commit carried it.
  const META = 'rayfin/functions/runtimemetadata.json';
  if (files.has(META)) files.set(META, text(files.get(META).toString('utf8').replace(/\s+$/, '')));
  files.set('rayfin/rayfin.yml', text(rayfinYml(files.get('rayfin/rayfin.yml').toString('utf8'), plan.name, redirects)));
  files.set(REPORT, kept ?? text(EMPTY_REPORT));
  files.set(`${SITE}explore.json`, text(JSON.stringify(state || null)));
  setModel(files, model);
  if (modelText != null) setModelCopy(files, modelFile, modelText);
  // The most rows a visual asks for: maxResultRows as it was at the export. Always written: the hosting
  // answers a file a site lacks with its index.html.
  files.set(`${SITE}settings.json`, text(JSON.stringify(Number.isInteger(maxRows) && maxRows > 0 ? { maxRows } : {})));
  files.set('AGENTS.md', text(agentsMd(plan)));
  return files;
}

// site/model.json, the model the page runs on: the project's model file, read. Written at each export, As Is too.
const setModel = (files, model) => files.set(`${SITE}model.json`, Buffer.from(JSON.stringify(model), 'utf8'));

/**
 * The site's files npm has not, as site/public/ holds them, path -> bytes: `webappDir` (vendor/webapp), the
 * world's outline and DuckDB's signed extensions.
 */
const staticFiles = webappDir => filesOf(webappDir, '');

/**
 * The page as Vite builds it, path -> bytes: `siteDir` (fabric-site/, which scripts/site-bundle.mjs makes
 * when the extension is packaged, with its own pins.json beside the page).
 */
async function siteBuild(siteDir) {
  const files = await filesOf(siteDir, '', rel => rel === 'pins.json').catch(() => new Map());
  if (!files.has('index.html')) throw new Error(`this build has no page for the app (${siteDir}): run node scripts/site-bundle.mjs`);
  return files;
}

// What files weigh together: { total, parts: [[name, bytes]] }, a part per top folder or file, largest first.
function sizeOf(files) {
  const parts = new Map();
  let total = 0;
  for (const [path, bytes] of files) {
    const name = path.includes('/') ? `${path.slice(0, path.indexOf('/'))}/` : path;
    parts.set(name, (parts.get(name) || 0) + bytes.length);
    total += bytes.length;
  }
  return { total, parts: [...parts].sort((a, b) => b[1] - a[1]) };
}

// --- What changed in the zip since it was published -------------------------------

// The zip's entries — what an export writes and an agent edits — as { 'a/b': sha256 }. The
// Report isn't counted: no export rewrites it, so an edit to it is never at risk and never asked about.
// Nor what every export writes again whatever the file held: the records, the site's files npm has not, the
// deployment and the function's settings.
const UNCOUNTED = new Set([REPORT, MARKER, FABRICATOR_RECORD, DEPLOYMENTS, CONFIG, 'rayfin/.env.secrets', 'rayfin/functions/local.settings.json']);
function fingerprint(files) {
  const out = {};
  for (const [p, bytes] of byPath(files)) {
    if (!UNCOUNTED.has(p) && !isStatic(p) && !p.startsWith(OLD_VENDOR)) out[p] = createHash('sha256').update(bytes).digest('hex');
  }
  return out;
}

// The paths added, removed or changed since `marker.files` was taken; [] when nothing moved.
// A publish that failed part way has an item and no record, and says so rather than nothing.
function localChanges(files, marker) {
  const was = marker && marker.files;
  if (!was) return marker && marker.itemId && !marker.exportedAt ? ['(the last publish did not finish, so any file may have changed)'] : [];
  const now = fingerprint(files);
  return [...new Set([...Object.keys(was), ...Object.keys(now)])].filter(p => was[p] !== now[p]).sort();
}

// A build id, URL-safe (it is the ?v= cache-buster): yyyymmdd-hhmmss UTC.
const buildId = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

/**
 * What is uploaded, path -> bytes, as `npm run build` makes it of the project: `page` (siteBuild), the page as
 * Vite built it, its index.html stamped with the build; then the zip's site/public/, copied as it is, as Vite
 * copies it; then rayfin.config.json, which the browser SDK fetches from the site's root: this publish's
 * backend, whatever the zip's is.
 */
function buildDist(files, config, page, build = buildId()) {
  if (!page || !page.has('index.html')) throw new Error('an app is published with its page built (siteBuild)');
  const out = new Map();
  for (const [rel, bytes] of page) {
    out.set(rel, rel === 'index.html' ? Buffer.from(Buffer.from(bytes).toString('utf8').replaceAll('__BUILD__', build), 'utf8') : bytes);
  }
  for (const [path, bytes] of files) {
    // An earlier export's page, in site/public/ (the next write lays the file out again): never uploaded.
    if (!path.startsWith(SITE) || path === CONFIG || OLD_PAGE.test(path)) continue;
    out.set(path.slice(SITE.length), bytes);
  }
  out.set('rayfin.config.json', Buffer.from(JSON.stringify(config, null, 2) + '\n', 'utf8'));
  return new Map(byPath(out));
}

// --- A zip, with no dependency -----------------------------------------------
// Deflate (zlib's raw deflate, level 9) per entry, UTF-8 names, the entries at the root.

/** files: Map or [[path, bytes]] -> a zip's bytes. Deflated off the thread every other extension shares. */
async function zip(files) {
  const local = [], central = [];
  let offset = 0;
  const DOS_TIME = 0, DOS_DATE = (2026 - 1980) << 9 | 1 << 5 | 1;   // a fixed date: the same files zip the same
  for (const [path, data] of files) {
    const name = Buffer.from(path, 'utf8');
    const raw = Buffer.from(data);
    const packed = await deflateRaw(raw, { level: 9 });
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

module.exports = { planExport, modelDoc, appFiles, setModel, readApp, writeApp, unzip, staticFiles,
                   siteBuild, sizeOf, buildDist, fingerprint, localChanges, zip, crc32, rayfinYml, appName, appNameBefore, dfsUrl, MARKER, REPORT,
                   APP_EXT, LEGACY_EXT, PAGE, SITE, CONFIG, DEPLOYMENTS, FABRICATOR_RECORD, FORMAT, MODEL_COPIES, setModelCopy, modelCopyOf,
                   tablesOf, setStatic, setPage, pageChanges, oldLayout, setSecrets, setDeployment, projectPackage, sitePackage,
                   sitePackages, projectPackages, projectLock, packageName,workspaceKey, PROJECT_PACKAGES, SITE_DEV_PACKAGES, RAYFIN_RANGE,
                   MAX_TOTAL_BYTES, MAX_ENTRIES };
