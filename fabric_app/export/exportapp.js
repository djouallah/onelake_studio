'use strict';
// =============================================================================
// exportapp.js — Export to Fabric: a model's Explore, as a Fabric app of its own
// =============================================================================
// Explore's button (page/explore/view.js) hands the host the model's text (to check it), where
// it lives in OneLake (for a model opened from its local copy, where the export writes it), and
// the shelves on screen. The local copy — the whole app, an agent's to grow later — is one zip on
// this machine, <app>.zip, and what is published is built from it (buildDist, fabricapp.js):
//   site/            fabric_app/site: the page (index.html, app.js) and its data source
//                    (storage/: Fabric sign-in, the function's answer, DuckDB-WASM reading the
//                    tables in the browser as views v_<table>)
//   site/explore/    Studio's Explore (page/explore/), the same files the panel runs
//   site/semantic/   dax-sql (PINS.daxSql): SQL over the model, as SQL over the views
//   site/report.json the Report the app opens on (page/explore/report.js draws it): Studio's Report
//                    tab's tiles (none at first), written once, then the zip's (Studio's Add to
//                    report writes it too), and kept by every export
//   site/explore.json  the shelves the first view shows
//   site/engine.json   what the page runs on, { engine: 'duckdb' } or { engine: 'semanticModel', name }:
//                    on a semantic model the page runs no DuckDB (storage/modeldata.js: it queries the
//                    semantic model), and site/ holds neither DuckDB, its extensions, Arrow nor the data
//                    source that reads the tables in the browser. Always written: the hosting answers a
//                    file a site lacks with its index.html
//   site/model.json    the model the page runs on: client side, model.yaml as JSON; on a semantic model,
//                    its local copy, which the page writes its DAX from
//   rayfin/          fabric_app/rayfin: what the app is (rayfin.yml) and its function's source
//                    (built at package time, by scripts/function-bundle.mjs: nobody's machine
//                    builds it)
//   model.ossie.yaml client side only: the model the app runs on (model.bim for a .bim), the model as
//                    exported. Each publish makes site/model.json from it, so an edit here (an
//                    agent's) is published by opening the file and exporting it. A semantic model's app has none:
//                    its record names the semantic model.
//   AGENTS.md        how the app is made, and how to grow its report
//   export.json      what was published: the app item, its redirects, the entries' hashes
// Not in the zip: vendor/, every package the page runs (vendor/webapp: DuckDB-WASM and its
// extensions, Arrow, the Rayfin SDK, ECharts; nothing from a CDN), the extension's own, added
// as site/vendor/ when publishing; and the upload itself, site/ stamped with the build plus
// rayfin.config.json (the backend the browser talks to), built in memory.
// The app runs on the model as exported, never the lakehouse's file as it is now: client side the
// page reads site/model.json, made from the file's model.yaml, and its function signs only the
// tables that model names (TABLES); on a semantic model the page writes its DAX from site/model.json
// and queries the model. The lakehouse its Direct Lake expression holds is the catalog
// (CATALOG_URL). Nothing here is AI.
// No `vscode` import: the extension passes in what it owns.
// =============================================================================

const { join, dirname } = require('node:path');
const fsp = require('node:fs/promises');
const zlib = require('node:zlib');
const deflateRaw = require('node:util').promisify(zlib.deflateRaw);
const { createHash } = require('node:crypto');
const { crc32 } = require('../../core/crc32');
const { TABLE_ORIGIN } = require('../../core/onelake/catalog');
const { dfsFileUrl, stripBom } = require('../../core/names');
const { PINS, WEBAPP } = require('../../core/vendored');
const { modelConnector, MODEL_CONNECTOR } = require('./fabricapp');

// The zip's record of what was published, and the Report: written when the zip has none, and
// kept from then on by every export.
const MARKER = 'export.json';
const REPORT = 'site/report.json';
// The local copy's own extension: a zip inside, as a .vsix is, so a double-click opens OneLake Studio.
const APP_EXT = '.fabricapp';
// Client side, the model the app runs on, in its own format, at the file's root.
// model.ossie.yaml, as Ossie's own tools name a model; model.yaml from an earlier export still reads.
const MODEL_COPIES = ['model.ossie.yaml', 'model.yaml', 'model.bim'];
const modelCopyName = file => (/\.bim$/i.test(String(file)) ? 'model.bim' : 'model.ossie.yaml');
/** The model's copy in the app's entries: `text` as `file` names its format, the other format's gone. */
function setModelCopy(files, file, text) {
  for (const p of MODEL_COPIES) files.delete(p);
  files.set(modelCopyName(file), Buffer.from(String(text), 'utf8'));
}
/** The model copy an app's entries hold, { name, text }, or null (an app on a semantic model has none). */
function modelCopyOf(files) {
  const name = MODEL_COPIES.find(p => files.has(p));
  return name ? { name, text: files.get(name).toString('utf8') } : null;
}

// An app's name: lower case, letters, digits and dashes (as a Rayfin id), and -explore: its
// own, never the name of an app someone else deployed for the same model.
function appName(s) {
  const out = String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `${!out ? 'model' : /^[a-z]/.test(out) ? out : `m-${out}`}-explore`;
}

// An Ossie dataset's table as schema.table, or null when it reads none. `source` is required
// by the spec, so a model from Power BI has one even for a calculation group or a calculated
// table: its partition, kept in the POWER_BI extension, says it has no entity. A bare name is
// in dbo, as in a TMSL partition; item.schema.table is its last two parts. The page reads it the same way
// (fabric_app/site/storage/data.js).
function ossieSource(d) {
  const pbi = (d.custom_extensions ?? []).find(e => String(e.vendor_name).toUpperCase() === 'POWER_BI');
  let partition;
  try { partition = JSON.parse(pbi.data).partitions?.[0]; } catch { /* no extension: its source alone */ }
  if (!d.source || (partition && !partition.source?.entityName)) return null;
  const s = String(d.source);
  // A table named <item>.<schema>.<table>, in the lakehouse the app reads: its schema.table.
  const parts = (s.match(/"(?:[^"]|"")*"|[^.]+/g) ?? []).map(p => (p.startsWith('"') ? p.slice(1, -1).replace(/""/g, '"') : p));
  if (parts.length === 3) return `${parts[1]}.${parts[2]}`;
  return s.includes('.') ? s : `dbo.${s}`;
}

// The model's tables as the data source reads them (fabric_app/site/storage/data.js,
// modelTables): name -> schema.table. An Ossie dataset's table; a TMSL table's Direct Lake
// partition.
/** The tables a model names, schema.table, each once: what a client-side app's function may sign (TABLES). */
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
 * `where`: the model file in OneLake, { workspace, path } (the path from its item); `lakes`: the
 * model's lakehouses by GUIDs, when the caller has resolved those its tables name in full.
 */
function planExport(text, fileName, name, mods, where, lakes = null) {
  const { semantic } = mods;
  if (!where || !where.workspace || !where.path) throw new Error(`${fileName} is not a OneLake file: the app reads its model from the lakehouse`);
  if (!/^[^/]+\/Files\//.test(trimPath(where.path))) throw new Error(`${fileName} is not in a lakehouse's Files/`);
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
    modelPath: `${where.workspace}/${trimPath(where.path)}`,
    tables: [...sources],
  };
}

/**
 * An export of a Power BI semantic model as it is (exportflow.js): the app goes in the model's
 * workspace and queries it, so it has no lakehouse, catalog or model file, and the model need
 * name no lakehouse. `doc`: its local copy, read (modelDoc's doc); `model`: { workspace (its name),
 * workspaceId, id, name }.
 */
function planOnModel(doc, name, model) {
  const title = String((doc && doc.name) || name);
  return {
    warnings: [], title, name: appName(title), modelName: name,
    workspace: model.workspaceId, lakehouse: null, catalogUrl: null,
    modelPath: `${model.workspace}/${model.name}`,
    tables: [], engine: 'semanticModel',
    semanticModel: { workspace: model.workspaceId, id: model.id, name: model.name },
  };
}

// site/report.json is the zip owner's: written once, with the tiles Studio's Report tab kept for the
// model or none, and kept by every later export. Studio's Report tab draws the same file.
const EMPTY_REPORT = '{\n  "pages": [\n    { "name": "Page 1", "tiles": [] }\n  ]\n}\n';

// fabric_app/rayfin/rayfin.yml, for this app: its own id and name, its sign-in redirects, and on a
// semantic model ({ workspace, id }) its connector, as fabricapp.js declares it to Fabric.
function rayfinYml(text, name, redirects = [], semanticModel = null) {
  let out = String(text);
  const swap = (re, to, what) => {
    if (!re.test(out)) throw new Error(`fabric_app/rayfin/rayfin.yml has no ${what}`);
    out = out.replace(re, to);
  };
  swap(/^id: .*$/m, `id: ${name}`, 'id');
  swap(/^name: .*$/m, `name: ${name}`, 'name');
  // Only the redirects not listed yet: an as-is folder's rayfin.yml already has the last
  // publish's, and every publish would list them once more.
  const block = /^[ \t]*allowedRedirectUris:[ \t]*\r?\n((?:[ \t]+- .*\r?\n)*)/m.exec(out);
  const listed = new Set(block ? block[1].split(/\r?\n/).map(l => l.replace(/^[ \t]+- /, '').trim()) : []);
  const fresh = [...new Set(redirects)].filter(r => !listed.has(r));
  if (fresh.length) {
    swap(/^([ \t]*)allowedRedirectUris:[ \t]*\r?\n/m,
      m => m + fresh.map(r => `${/^([ \t]*)/.exec(m)[1]}  - ${r}\n`).join(''), 'allowedRedirectUris');
  }
  // The connector block, top level as the CLI keeps it: an as-is folder's is replaced, never doubled.
  out = out.replace(/^connectors:[^\n]*\n(?:(?:[ \t]+[^\n]*)?\n)*/m, '');
  if (semanticModel) {
    const c = modelConnector(semanticModel);
    out = out.replace(/\n*$/, '\n') + [
      'connectors:', `  - name: ${c.name}`, `    type: ${c.type}`, `    version: "${c.version}"`,
      '    config:', `      workspaceId: ${c.config.workspaceId}`, `      itemId: ${c.config.itemId}`,
      '    operations:', ...c.operations.map(o => `      - name: ${o.name}`),
      '    auth:', `      type: ${c.auth.type}`, '',
    ].join('\n');
  }
  return out;
}

const agentsMd = plan => `# ${plan.title} — its Report, as a Fabric app

Written by OneLake Studio's **Export to Fabric**, and deployed by it over the Fabric REST API (item
type \`AppBackend\`, named \`${plan.name}\`): no CLI. The site is **protected** — only people who may
open the app item can load it.

${onModel(plan) ? `- Semantic model: \`${plan.semanticModel.name}\`, as it is in Fabric: the export changed nothing in it. The page
  reads its definition as it was when exported, \`site/model.json\`; a change to the semantic model reaches the app
  when it is exported again. It is the app's \`${MODEL_CONNECTOR}\` connector (\`connectors:\` in \`rayfin/rayfin.yml\`).
- Engine: **the semantic model, as the viewer.** The page turns each of Explore's queries over the model into DAX
  (dax-sql) and runs it through that connector, which is delegated: as the person signed in, so each viewer needs
  Build on the semantic model (https://learn.microsoft.com/en-us/fabric/apps/connectors). The tenant must have the
  Semantic Model Execute Queries REST API setting on. The page runs no DuckDB and reads no table (\`site/engine.json\`,
  \`site/storage/modeldata.js\`). The tables below and the layers' DuckDB parts are the client-side export's.
` : `- Model: \`model.ossie.yaml\` in this file (\`model.bim\` for a .bim), exported from \`${plan.modelPath}\`: the app
  runs on it, as \`site/model.json\`, made from it at each publish. An edit to it is published by opening this file in OneLake Studio and exporting it;
  a change to the lakehouse's file reaches the app when it is exported again.
- Lakehouse: workspace \`${plan.workspace}\`, item \`${plan.lakehouse}\` — its Iceberg catalog is the
  function's \`CATALOG_URL\`: ${plan.catalogUrl}
- Identity: the function reads the tables as the **app item's owner** (Fabric Apps' app identity), so anyone who
  may open the app reads them with the owner's rights, never their own. It signs a SAS only for the tables the
  model names (its \`TABLES\` setting), and never reads the model.
`}
## The Report: yours to grow

The app is its Report, \`site/report.json\`, and nothing else. The first export wrote
it with the tiles built in OneLake Studio's Report tab (none, if it had none), and no export writes it
again: edit it freely, then export again to publish it. Delete it and the next export writes a new one. OneLake Studio's Report tab, after Model and Visual,
draws this same file from this zip, and draws it again when the zip changes; its Visual's **Add to report**
and a tile's ✕ write it here.

${onModel(plan) ? '' : `\`model.ossie.yaml\` (\`model.bim\` for a .bim model), at the root, is the model the app runs on: read it for the
tables, columns and measures a tile can name.
`}
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
  shelves, the same SELECT over the model as OneLake Studio's Visual writes. ${onModel(plan)
  ? 'The page turns it into DAX and runs it on the semantic model.' : 'The page compiles it (dax-sql) to SQL over the tables, and DuckDB-WASM runs it.'}
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
- A tile's own, beside \`pivot\`: \`"showTitle": false\`, \`"titleSize": "S"\` or \`"L"\`, and \`"ignore": ["<filter bar
  field>"]\`, the filter bar's filters it does not follow.
- \`theme\`, beside \`pages\`: \`{ "palette": "ocean" | "warm" | "mono", "textSize": "S" | "L", "colors": { "<value>":
  "#rrggbb" } }\` for every page; \`colors\` gives a value of any column (a fuel, a region) the same colour in every tile.
- \`filters\`, beside \`pages\`: the filter bar over every page, each \`{ "field": "table.column", "style": "dropdown" |
  "list" | "dates" }\`. What a viewer picks in it filters every tile, but those whose \`ignore\` names it.
- This is a zip: unzip it, edit, and zip it again with the same entries at its root.

## Layers

| Layer | Path | |
|---|---|---|
| Report | \`site/report.json\` | the pages the app shows: yours, kept by every export |
| Page | \`site/index.html\`, \`site/app.js\` | the Report over the data source |
| Explore | \`site/explore/\` | OneLake Studio's, the same files the extension runs; \`report.js\` draws the Report, with Visual's drawing for a pivot tile |
| Compiler | \`site/semantic/src/\`, \`site/semantic/formats/\` | dax-sql (\`${PINS.daxSql}\`): SQL over the model, as SQL over \`v_<table>\` |
| Packages | \`site/vendor/\`, not in this zip | DuckDB-WASM (\`${WEBAPP.duckdbWasm}\`, DuckDB ${WEBAPP.duckdb}) with its ${WEBAPP.extensions.join(' and ')} extensions, Arrow, the Rayfin SDK and its semantic-model connector, ECharts: OneLake Studio's own, added when it publishes; nothing from a CDN |
| Data source | \`site/storage/\` | signs in (Rayfin Fabric SSO), asks the function, downloads into the browser (OPFS) what the Report reads of the tables (of a large one, only the columns it reads: \`storage/ranges.js\`), DuckDB-WASM |
| Function | \`rayfin/functions/src/function_app.ts\` | reads the model, the tables' metadata locations, a read-only SAS on \`Tables/\`; on a semantic model it is not deployed |

Tables the app reads (\`v_<table>\` ← \`schema.table\`):

${plan.tables.map(([n, s]) => `- \`${n}\` ← \`${s}\``).join('\n')}

Exporting again from OneLake Studio rewrites every entry of this zip but \`site/report.json\`, and updates the
same app; \`export.json\` is its record of what was published.

The workspace must allow **OneLake user-delegated SAS tokens** (workspace settings → OneLake): the
function signs one. The page needs a browser with OPFS shared access handles (Chrome or Edge 121+).
`;

// --- The local copy: one zip ------------------------------------------------------

// A zip's entries, path -> bytes: the ones zip() writes (deflated), and stored ones, as another tool
// re-zips the app. Folders are left out, a backslash is a slash, and one top folder holding every
// entry (a folder zipped whole) is taken off.
const MAX_ENTRY_BYTES = 256 * 1024 * 1024;
function unzip(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error('no zip directory');
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const out = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error('a broken zip directory');
    const method = buf.readUInt16LE(at + 10), size = buf.readUInt32LE(at + 20), raw = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28), extra = buf.readUInt16LE(at + 30), note = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42), crc = buf.readUInt32LE(at + 16);
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString('utf8').split('\\').join('/');
    at += 46 + nameLen + extra + note;
    if (name.endsWith('/')) continue;
    if (method !== 0 && method !== 8) throw new Error(`${name} is compressed in a way this can't read (method ${method})`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const packed = buf.subarray(start, start + size);
    // No more than the entry says it holds, and no entry that says more than an app's file could: a few
    // kilobytes can otherwise unpack to all the memory there is.
    if (raw > MAX_ENTRY_BYTES) throw new Error(`${name} is too big to be an app's file`);
    let data;
    try { data = method === 8 ? zlib.inflateRawSync(packed, { maxOutputLength: Math.max(1, raw) }) : Buffer.from(packed); }
    catch { throw new Error(`${name} is damaged`); }
    if (data.length !== raw || crc32(data) !== crc) throw new Error(`${name} is damaged`);
    out.set(name, data);
  }
  const tops = new Set([...out.keys()].map(p => (p.includes('/') ? p.slice(0, p.indexOf('/') + 1) : '')));
  if (tops.size === 1 && ![...tops][0].match(/^(|site\/|rayfin\/)$/)) {
    const [top] = tops;
    return new Map([...out].map(([p, b]) => [p.slice(top.length), b]));
  }
  return out;
}

/**
 * The local copy, read: { files: Map(path -> bytes), marker }; null when there is no such file.
 * Throws for a file that is not an app Export to Fabric wrote, which is never written over.
 */
async function readApp(zipPath) {
  const bytes = await fsp.readFile(zipPath).catch(e => (e.code === 'ENOENT' ? null : Promise.reject(e)));
  if (!bytes) return null;
  let files;
  try { files = unzip(bytes); } catch (e) { throw new Error(`${zipPath} is not a zip Export to Fabric can read: ${e.message}`); }
  let marker = null;
  try { marker = JSON.parse(files.get(MARKER).toString('utf8')); } catch { /* not ours */ }
  if (!marker || typeof marker !== 'object') throw new Error(`${zipPath} was not written by Export to Fabric: rename it, or choose another folder`);
  files.delete(MARKER);
  return { files, marker };
}

// A zip's entries in path order, as every export writes, hashes and uploads them.
const byPath = files => [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

/** Writes the local copy, its entries sorted and its marker last: beside it first, then renamed into place. */
async function writeApp(zipPath, files, marker) {
  const all = byPath(files).filter(([p]) => p !== MARKER);
  all.push([MARKER, Buffer.from(JSON.stringify(marker, null, 2) + '\n', 'utf8')]);
  await fsp.mkdir(dirname(zipPath), { recursive: true });
  const tmp = `${zipPath}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, await zip(all));
  await fsp.rename(tmp, zipPath);
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

/**
 * The app's entries, path -> bytes, as the local copy holds them: no packages (vendorFiles).
 * `kept`: the zip's own site/report.json, which no export writes over, or the one Studio kept
 * before the first export (else a Report with no tiles);
 * `redirects`: the app's sign-in redirects so far.
 * `model`: the model the page runs on, read (modelDoc's doc): site/model.json.
 * `modelText`, `modelFile`: client side, the model's text and its file's name, kept as model.ossie.yaml (setModelCopy).
 * `fabricAppDir`: the extension's fabric_app/; `appDir`: Studio's page modules (page/, or
 * webview/ installed); `daxSqlDir`: vendor/npm/<PINS.daxSql>.
 */
async function appFiles({ plan, state, model, modelText = null, modelFile = 'model.yaml', kept = null, redirects = [], fabricAppDir, appDir, daxSqlDir }) {
  if (!model) throw new Error('an app needs the model it runs on');
  const sql = onModel(plan);
  const text = s => Buffer.from(s, 'utf8');
  const files = new Map([
    ...await filesOf(join(fabricAppDir, 'site'), 'site/', rel => (sql ? DUCKDB_ONLY.site : MODEL_ONLY).includes(rel)),
    ...await filesOf(join(appDir, 'explore'), 'site/explore/'),
    ['site/paths.js', await fsp.readFile(join(appDir, 'paths.js'))],
    // As the package lays them out: formats/ imports ../src/.
    ...await filesOf(join(daxSqlDir, 'src'), 'site/semantic/src/'),
    ...await filesOf(join(daxSqlDir, 'formats'), 'site/semantic/formats/'),
    ...await filesOf(join(fabricAppDir, 'rayfin'), 'rayfin/', rel => rel.split('/').includes('node_modules')),
  ]);
  files.set('rayfin/rayfin.yml', text(rayfinYml(files.get('rayfin/rayfin.yml').toString('utf8'), plan.name, redirects,
                                                sql ? plan.semanticModel : null)));
  files.set(REPORT, kept ?? text(EMPTY_REPORT));
  files.set('site/explore.json', text(JSON.stringify(state || null)));
  setModel(files, model);
  if (!sql && modelText != null) setModelCopy(files, modelFile, modelText);
  // On a semantic model, its name: what the page says when it refuses the person signed in.
  files.set('site/engine.json', text(JSON.stringify(sql
    ? { engine: 'semanticModel', ...(plan.semanticModel ? { name: plan.semanticModel.name } : {}) } : { engine: 'duckdb' })));
  files.set('AGENTS.md', text(agentsMd(plan)));
  return files;
}

// A semantic model, as it is: the app queries it, not the tables.
const onModel = plan => plan.engine === 'semanticModel';

// site/model.json, the model the page runs on: client side model.yaml read, on a semantic model its
// local copy, which the page writes its DAX from (storage/modeldata.js). Written at each export, As Is too.
const setModel = (files, model) => files.set('site/model.json', Buffer.from(JSON.stringify(model), 'utf8'));

// What a zip's site runs on: its marker's engine ('duckdb', 'semanticModel', or an older 'directLake',
// 'directQuery'), else its engine.json's; a site with none (an older client-side one) is DuckDB.
function engineOf(files, marker) {
  if (marker && marker.engine) return marker.engine;
  const said = files.get('site/engine.json');
  if (!said) return 'duckdb';
  try { return JSON.parse(said.toString('utf8')).engine || 'semanticModel'; } catch { return 'semanticModel'; }
}

// Client side: what site/ leaves out, the semantic model's data source.
const MODEL_ONLY = ['storage/modeldata.js', 'storage/modelrows.js'];

// On a semantic model: what site/ leaves out, the page reading nothing in the browser. Paths under
// fabric_app/site, and under vendor/webapp. DuckDB's Arrow only: the semantic-model connector
// decodes with an Arrow of its own version (WEBAPP.rayfinSemanticModel). The other way round, the
// client-side site keeps the connector's few hundred KB, which its page never loads.
const DUCKDB_ONLY = {
  site: ['storage/data.js', 'storage/blockcache.js', 'storage/catalog.js', 'storage/prefetch.js', 'storage/ranges.js',
         'storage/queue.js', 'storage/results.js', 'storage/snapshots.js', 'storage/kv.js'],
  vendor: [/^npm\/@duckdb(\/|$)/, /^duckdb-ext(\/|$)/, new RegExp(`^npm/${WEBAPP.arrow.replace(/[.]/g, '\\.')}(/|$)`)],
};

/** The packages the page runs, as site/vendor/ is uploaded: `webappDir` (vendor/webapp), less DuckDB's on a semantic model. */
const vendorFiles = (webappDir, engine) => {
  const sql = engine !== 'duckdb';
  return filesOf(webappDir, 'vendor/', rel => sql && DUCKDB_ONLY.vendor.some(re => re.test(rel)));
};

// What the packages weigh: { total, parts: [[name, bytes]] }, a part per package
// (npm/<pkg>@<v>, npm/@<scope>/<pkg>@<v>) or extension, largest first.
function vendorSize(vendor) {
  const parts = new Map();
  let total = 0;
  for (const [path, bytes] of vendor) {
    const seg = path.split('/').slice(1);
    const name = seg[0] === 'npm' ? seg.slice(1, seg[1].startsWith('@') ? 3 : 2).join('/')
      : seg[0] === 'duckdb-ext' ? `${seg[seg.length - 1].replace(/\.duckdb_extension\.wasm$/, '')} extension` : seg.join('/');
    parts.set(name, (parts.get(name) || 0) + bytes.length);
    total += bytes.length;
  }
  return { total, parts: [...parts].sort((a, b) => b[1] - a[1]) };
}

// --- What changed in the zip since it was published -------------------------------

// The zip's entries — what an export writes and an agent edits — as { 'a/b': sha256 }. The
// Report isn't counted: no export rewrites it, so an edit to it is never at risk and never asked about.
function fingerprint(files) {
  const out = {};
  for (const [p, bytes] of byPath(files)) {
    if (p !== REPORT && p !== MARKER) out[p] = createHash('sha256').update(bytes).digest('hex');
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
 * What is uploaded, path -> bytes: the zip's site/ at the root, every relative import given
 * ?v=<build> and __BUILD__ the build, so a browser never runs the files of two deploys together;
 * then `vendor` (vendorFiles), byte for byte, and rayfin.config.json, which the browser SDK fetches
 * from the site's root.
 */
function buildDist(files, config, vendor = new Map(), build = buildId()) {
  const out = new Map();
  for (const [path, raw] of byPath(files)) {
    if (!path.startsWith('site/')) continue;
    const rel = path.slice('site/'.length);
    let bytes = raw;
    // vendor/ is pinned packages, already versioned by their path: left byte for byte.
    if (/\.(html|js)$/.test(rel) && !rel.startsWith('vendor/')) {
      bytes = Buffer.from(Buffer.from(raw).toString('utf8')
        .replaceAll('__BUILD__', build)
        .replace(/(\b(?:from|import)\s*\(?\s*["']\.{1,2}\/[\w./-]+\.js)(["'])/g, `$1?v=${build}$2`)
        .replace(/(<link rel="stylesheet" href="\.\/[\w./-]+\.css)(")/g, `$1?v=${build}$2`), 'utf8');
    }
    out.set(rel, bytes);
  }
  for (const [path, bytes] of vendor) out.set(path, bytes);
  out.set('rayfin.config.json', Buffer.from(JSON.stringify(config, null, 2) + '\n', 'utf8'));
  return out;
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

module.exports = { planExport, planOnModel, modelDoc, appFiles, setModel, engineOf, readApp, writeApp, unzip, vendorFiles,
                   vendorSize, buildDist, fingerprint, localChanges, zip, crc32, rayfinYml, appName, dfsUrl, MARKER, REPORT,
                   APP_EXT, MODEL_COPIES, setModelCopy, modelCopyOf, tablesOf };
