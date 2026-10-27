'use strict';
// =============================================================================
// report.js — Generate Report: an Ossie model, bootstrapped into a Fabric app
// =============================================================================
// Right-click an Apache Ossie model (.yaml) in Files/. The model is the only input: its
// Direct Lake expression names the lakehouse by GUID, and that lakehouse's OneLake Iceberg
// catalog is what the app reads. What is written to a folder of this machine is
// analytics-as-code's Fabric app on the Iceberg catalog, vendored at PINS.reportTemplate:
//   rayfin/          the Rayfin project; its one function opens the catalog and signs a
//                    read-only SAS (CATALOG_URL, its secret, is the lakehouse's catalog)
//   site/storage/    the data source: DuckDB-WASM reads the tables in the browser
//   site/semantic/   query.js and dax-sql (PINS.daxSql): the model's fields as DAX, the DAX
//                    as SQL over the tables
//   duckdb.mjs       fetches DuckDB-WASM 2.0 and its extensions at build
// The template's page is that repo's dashboard, which is not generic, so the page here is
// generated: one chart, the model's first measure by a column that slices it (semantic.js's
// starterChart). An agent grows it from there: the folder's AGENTS.md says how.
//
// Nothing is deployed and nothing is written to Fabric: the folder's deploy.mjs is its
// owner's to run.
// No `vscode` import: the extension passes in what it owns.
// =============================================================================

const { join, dirname, basename } = require('node:path');
const fsp = require('node:fs/promises');
const { TABLE_ORIGIN } = require('./catalog');
const { PINS } = require('./vendored');

// The Rayfin CLI the folder installs: the version the template's function and sign-in use.
const RAYFIN_CLI = '^1.36.1';

// The template's files, from its root (vendor/gh/<PINS.reportTemplate>), and where each goes.
// A directory is copied whole; common/site lands over the app's site/ (its sign-in, auth.js).
const COPY = [
  ['dashboard/fabric_app/iceberg/duckdb.mjs', 'duckdb.mjs'],
  ['dashboard/fabric_app/iceberg/rayfin', 'rayfin'],
  ['dashboard/fabric_app/iceberg/site', 'site'],
  ['dashboard/fabric_app/common/site', 'site'],
  ['dashboard/page/storage/queue.js', 'site/storage/queue.js'],
  ['dashboard/page/frontend/perflog.js', 'site/frontend/perflog.js'],
  ['dashboard/page/semantic/query.js', 'site/semantic/query.js'],
];

// A Rayfin item id: lower case, letters, digits and dashes.
function slug(s) {
  const out = String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return !out ? 'report' : /^[a-z]/.test(out) ? out : `r-${out}`;
}

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/**
 * What a model's report is, before anything is written: its name, its lakehouse and catalog,
 * and its chart. Throws, saying why, when the model cannot make one.
 * `mods`: the agent's modules() — { compiler: { parseYaml, ossieToTmsl, createCompiler,
 * tmslToModel }, semantic: app/semantic.js }.
 */
function planReport(text, fileName, { compiler, semantic }) {
  const body = String(text).replace(/^﻿/, '');
  if (!semantic.isOssie(body)) throw new Error(`${fileName} is not an Apache Ossie model: it has no top-level version and datasets`);
  let doc;
  try { doc = compiler.parseYaml(body); }
  catch (e) { throw new Error(`${fileName} is not YAML: ${e.message}`); }
  const bim = compiler.ossieToTmsl(doc);
  const lakes = semantic.lakehousesOf(bim);
  if (!lakes.length) {
    throw new Error(`${fileName} names no lakehouse: its Direct Lake expression must hold ` +
      'https://onelake.dfs.fabric.microsoft.com/<workspace id>/<lakehouse id>');
  }
  if (lakes.length > 1) throw new Error(`${fileName} names ${lakes.length} lakehouses: the app reads one catalog`);
  const [lake] = lakes;
  const chart = semantic.starterChart(compiler.createCompiler(compiler.tmslToModel(bim)).model);
  if (!chart) throw new Error(`${fileName} has no metric to chart`);
  // query.js names a column as table.column: a table of one word, a column with no dot or
  // bracket. Any other cannot be asked that way, and the chart is the measure alone.
  if (chart.column && !(/^\w+$/.test(chart.column.table) && /^[^.[\]]+$/.test(chart.column.name))) chart.column = null;
  const warnings = (doc.datasets || [])
    .filter(d => !/^\w+\.\w+$/.test(String(d.source || '')))
    .map(d => `dataset ${d.name}: its source "${d.source || ''}" is not schema.table, which the app's function opens`);
  return {
    doc, chart, warnings,
    name: slug(doc.name || basename(fileName).replace(/\..*$/, '')),
    title: String(doc.name || basename(fileName).replace(/\..*$/, '')),
    workspace: lake.workspace, lakehouse: lake.item,
    catalogUrl: `${TABLE_ORIGIN}/iceberg/${lake.workspace}/${lake.item}`,
  };
}

// The starter chart as query.js asks: an object of the model's own fields (its toDax).
function chartQuery({ measure, column }) {
  if (!column) return { select: { [measure]: measure } };
  return {
    select: { [column.name]: `${column.table}.${column.name}`, [measure]: measure },
    orderBy: [[measure, 'desc']],
    top: 20,
  };
}

// The template's rayfin.yml, for this app: its own id and name, the self-contained build,
// and none of the template's own deployments' sign-in redirects.
function rayfinYml(text, name) {
  let out = String(text);
  const swap = (re, to, what) => {
    if (!re.test(out)) throw new Error(`the template's rayfin.yml has no ${what} — is PINS.reportTemplate a different layout?`);
    out = out.replace(re, to);
  };
  swap(/^id: .*$/m, `id: ${name}`, 'id');
  swap(/^name: .*$/m, `name: ${name}`, 'name');
  swap(/node \.\.\/common\/build\.mjs/, 'node build.mjs', 'build command');
  return out.replace(/^[ \t]*- https:\/\/\S+\.fabricapps\.net[ \t]*\r?\n/gm, '');
}

const packageJson = plan => JSON.stringify({
  name: plan.name,
  private: true,
  version: '0.1.0',
  type: 'module',
  description: `${plan.title}: a Fabric app (Rayfin) on DuckDB-WASM over the OneLake Iceberg catalog of lakehouse ${plan.lakehouse}`,
  scripts: {
    postinstall: 'npm ci --prefix rayfin/functions --no-audit --no-fund',
    build: 'node duckdb.mjs && node build.mjs',
    deploy: 'node deploy.mjs',
  },
  devDependencies: {
    '@microsoft/rayfin-cli': RAYFIN_CLI,
    yaml: `^${PINS.yaml.split('@').pop()}`,
  },
}, null, 2) + '\n';

const BUILD_MJS = `// build.mjs — the static site, into dist/ (rayfin.yml's buildCommand, after duckdb.mjs)
//   site/              the page, its data source and the compiler, as they are
//   model/ossie.yaml   as semantic/ossie.json: the browser reads no YAML
//   vendor/            DuckDB-WASM and its extensions (duckdb.mjs), copied after the stamping
// Every relative import gets ?v=<build> and __BUILD__ becomes the build, so a browser never
// runs the files of two deploys together.
import { rm, cp, readFile, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const dist = "dist";
const BUILD = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);

await rm(dist, { recursive: true, force: true });
await cp("site", dist, { recursive: true });
await writeFile(join(dist, "semantic", "ossie.json"), JSON.stringify(parse(await readFile("model/ossie.yaml", "utf8"))));
for (const f of await readdir(dist, { recursive: true })) {
  if (!/\\.(html|js)$/.test(f)) continue;
  const s = await readFile(join(dist, f), "utf8");
  await writeFile(join(dist, f), s
    .replaceAll("__BUILD__", BUILD)
    .replace(/(\\b(?:from|import)\\s*["']\\.{1,2}\\/[\\w./-]+\\.js)(["'])/g, \`$1?v=\${BUILD}$2\`));
}
if (existsSync("vendor")) await cp("vendor", dist, { recursive: true });
console.log(\`site/ + model/ossie.yaml + vendor/ -> \${dist}/ (build \${BUILD})\`);
`;

const deployMjs = plan => `// deploy.mjs — the app, to Fabric (npm run deploy). Nothing runs it for you.
//   1. rayfin up                 the item, the site (rayfin.yml's buildCommand) and the function
//   2. rayfin secret CATALOG_URL the function's one secret: the lakehouse's Iceberg catalog
//   3. rayfin up functions       the function again, with its secret
// Signs in as you: RAYFIN_TOKEN when it is set, else a Fabric token from \`az login\`'s session.
// The workspace must allow OneLake user-delegated SAS tokens (its OneLake settings): the
// function signs one for the browser.
import { execSync } from "node:child_process";

const CATALOG_URL = ${JSON.stringify(plan.catalogUrl)};

const run = (cmd, input) => {
  console.log(\`> \${cmd}\`);
  execSync(cmd, { stdio: [input == null ? "inherit" : "pipe", "inherit", "inherit"], input });
};
process.env.RAYFIN_TOKEN ||= execSync(
  "az account get-access-token --resource https://api.fabric.microsoft.com --query accessToken -o tsv",
  { encoding: "utf8" }).trim();
run("npx rayfin up --yes");
run("npx rayfin secret set CATALOG_URL --stdin", CATALOG_URL);
run("npx rayfin up functions deploy");
`;

const indexHtml = plan => {
  const caption = plan.chart.column ? `${plan.chart.measure} by ${plan.chart.column.name}` : plan.chart.measure;
  const about = String(plan.doc.description || '').split(/(?<=\.)\s/)[0].slice(0, 240);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(plan.title)}</title>
<style>
  /* auth.js's sign-in gate takes --bg, --muted, --accent and --on-accent too. */
  :root { --bg: #0a0c10; --panel: #12151b; --text: #e6e9ef; --muted: #9aa3b2; --grid: #262b35;
          --series: #4c8bf5; --accent: #f2f4f8; --on-accent: #0a0c10; }
  @media (prefers-color-scheme: light) {
    :root { --bg: #f7f8fa; --panel: #ffffff; --text: #14171c; --muted: #5b6472; --grid: #e3e6eb;
            --series: #2f6fdf; --accent: #14171c; --on-accent: #ffffff; }
  }
  body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, sans-serif; }
  main { max-width: 1100px; margin: 0 auto; padding: 24px 16px; }
  h1 { font-size: 1.4rem; margin: 0; }
  .about { color: var(--muted); margin: 4px 0 20px; }
  h2 { font-size: 1rem; font-weight: 600; margin: 0 0 8px; }
  #chart { height: 480px; background: var(--panel); border-radius: 8px; }
  #status, footer { color: var(--muted); font-size: .8rem; margin-top: 8px; }
</style>
<script src="https://cdn.jsdelivr.net/npm/${PINS.echarts}/dist/echarts.min.js"></script>
</head>
<body>
<main>
  <h1>${esc(plan.title)}</h1>
  <p class="about">${esc(about)}</p>
  <h2>${esc(caption)}</h2>
  <div id="chart"></div>
  <div id="status">Starting…</div>
  <footer>build __BUILD__</footer>
</main>
<script type="module">import { start } from "./app.js"; start();</script>
</body>
</html>
`;
};

const appJs = plan => `// app.js — the page: one chart, generated from the model (OneLake Studio's Generate Report).
// storage/data.js signs in, asks the function where the tables are and opens them in
// DuckDB-WASM; semantic/query.js turns a query of the model's own fields into DAX, and the DAX
// into SQL over the tables' views (dax-sql). Another chart is another query object and
// another draw: AGENTS.md says how.
import { createDataSource } from "./storage/data.js";
import { createModel } from "./semantic/query.js";

// The starter chart: the model's first measure by a column that slices it.
export const CHART = ${JSON.stringify(chartQuery(plan.chart), null, 2)};

const status = s => { document.getElementById("status").textContent = s; };
const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// A result (an Arrow table) as [label, value] rows: the first column the label, the last the
// value. A measure alone is one row, labelled with its name.
function rows(table, measure) {
  const fields = table.schema.fields.map(f => f.name);
  const label = fields.length > 1 ? fields[0] : null, value = fields.at(-1);
  return table.toArray().map(r => [label ? String(r[label] ?? "(blank)") : measure, Number(r[value])]);
}

function draw(el, data, measure) {
  const chart = echarts.init(el);
  const axis = { color: css("--muted") };
  chart.setOption({
    backgroundColor: "transparent",
    tooltip: { trigger: "axis" },
    grid: { left: 16, right: 16, top: 24, bottom: 16, containLabel: true },
    xAxis: { type: "category", data: data.map(r => r[0]), axisLabel: { ...axis, rotate: data.length > 8 ? 30 : 0 } },
    yAxis: { type: "value", axisLabel: axis, splitLine: { lineStyle: { color: css("--grid") } } },
    series: [{ type: "bar", name: measure, data: data.map(r => r[1]), itemStyle: { color: css("--series") } }],
  });
  addEventListener("resize", () => chart.resize());
}

export async function start() {
  try {
    const model = createModel(createDataSource({
      onStatus: status,
      onProgress: p => p && status(p.detail || p.label),
    }));
    await model.init();
    status("Querying…");
    const t0 = performance.now();
    const measure = ${JSON.stringify(plan.chart.measure)};
    const data = rows(await model.query(CHART), measure);
    draw(document.getElementById("chart"), data, measure);
    status(\`\${data.length} row(s) in \${Math.round(performance.now() - t0)} ms\`);
    // The model's other tables, opened in the background for the next query.
    model.attachAgg();
  } catch (e) {
    console.error(e);
    status(\`Error: \${e?.message || e}\`);
  }
}
`;

const agentsMd = plan => {
  const { doc, chart } = plan;
  const fields = d => (d.fields || []).map(f => f.name).join(', ');
  const datasets = (doc.datasets || []).map(d => `- \`${d.name}\` (\`${d.source || '?'}\`): ${fields(d)}`).join('\n');
  const metrics = (doc.metrics || []).map(m => `- \`${m.name}\`${m.description ? ` — ${String(m.description).split(/(?<=\.)\s/)[0]}` : ''}`).join('\n');
  const col = chart.column ? `${chart.column.table}.${chart.column.name}` : null;
  return `# ${plan.title} — a Fabric app on DuckDB-WASM

Generated by OneLake Studio's **Generate Report** from \`model/ossie.yaml\` (Apache Ossie, measures in
DAX). It is a bootstrap: one page, one chart. Grow it from here.

- Lakehouse: workspace \`${plan.workspace}\`, item \`${plan.lakehouse}\`
- Iceberg catalog (the function's \`CATALOG_URL\` secret): ${plan.catalogUrl}
- Template: \`${PINS.reportTemplate}\` (\`dashboard/fabric_app/iceberg\`), compiler \`${PINS.daxSql}\`

## How a chart gets its rows

| Layer | File | Yours to edit? |
|---|---|---|
| Page | \`site/index.html\`, \`site/app.js\` | yes: generated, the report itself |
| Model | \`model/ossie.yaml\` | yes: tables, relationships, measures (DAX) |
| Query | \`site/semantic/query.js\` | no: a query object as DAX, the DAX as SQL |
| Compiler | \`site/semantic/dax-sql/\`, \`site/semantic/formats/\` | no: dax-sql |
| Data source | \`site/storage/*.js\` | no: signs in, opens the catalog, reads the tables in DuckDB-WASM |
| Function | \`rayfin/functions/src/function_app.ts\` | no: the catalog's metadata locations and a read-only SAS |

\`app.js\` builds the data source and the model, \`await model.init()\`, then \`model.query(q)\` returns an
Arrow table. \`q\` is an object of the model's own fields (\`toDax\` in \`semantic/query.js\`):

\`\`\`js
{
  select: { "<output name>": "<table>.<column>" | "<measure>" | { min: "<table>.<column>" } | { max: ... } },
  where: [["<table>.<column>", "=" | "<>" | "<" | "<=" | ">" | ">=", value],
          ["<table>.<column>", "between", from, to], ["<table>.<column>", "in", [values]],
          { any: [condition, ...] }],
  having: [["<output name>", ">", 0]],
  totals: { "<output name>": ["<table>.<column>", ...] },
  orderBy: [["<output name>", "desc"]],
  top: 10,
}
\`\`\`

The starter chart is \`CHART\` in \`site/app.js\`: \`${chart.measure}\`${col ? ` by \`${col}\`` : ''}. To add a
chart, add a \`<div>\` to \`index.html\`, then a query and a draw to \`app.js\` (ECharts is loaded as
\`echarts\`). A table opens on the first query that reads it, so the first paint pays only for the
tables it reads. Call \`model.attachAgg()\` after the first paint to open the rest in the background.

## The model

Datasets (\`name\` (\`source\`): fields):

${datasets || '- (none)'}

Metrics:

${metrics || '- (none)'}

A dataset's \`source\` must be \`schema.table\`: the function opens only those. A table named in a
query object must be one word (\`\\w+\`).

## Build and deploy

\`\`\`sh
npm install          # the Rayfin CLI, yaml, and rayfin/functions' packages
npm run build        # duckdb.mjs (DuckDB-WASM 2.0 into vendor/), then build.mjs (into dist/)
npm run deploy       # rayfin up, the CATALOG_URL secret, the function again (deploy.mjs)
\`\`\`

- \`duckdb.mjs\` downloads GitHub Actions artifacts, so it needs \`gh\` signed in. Those artifacts expire
  after 90 days. When they do, pin newer runs in its \`PINS\`.
- \`deploy.mjs\` signs in with \`az login\`'s session (or \`RAYFIN_TOKEN\`).
- The workspace must allow **OneLake user-delegated SAS tokens** (workspace settings → OneLake).
- \`rayfin.yml\` lists the sign-in redirect URIs. If sign-in on the deployed app is refused for its
  redirect, add the app's URL under \`services.auth.allowedRedirectUris\` and deploy again.
`;
};

const GITIGNORE = `node_modules
dist
vendor
*.tsbuildinfo
# Rayfin's generated or secret-bearing files, and its generated agent context
rayfin/.env*
rayfin/.deployments.json
rayfin/.temp/
.agents/
.mcp.json
`;

/**
 * Writes the report's folder. `plan`: planReport's. `outDir` must not exist, or be empty.
 * `templateDir`: vendor/gh/<PINS.reportTemplate>; `daxSqlDir`: vendor/gh/<PINS.daxSql>.
 */
async function generateReport({ plan, text, outDir, templateDir, daxSqlDir }) {
  const entries = await fsp.readdir(outDir).catch(e => (e.code === 'ENOENT' ? [] : Promise.reject(e)));
  if (entries.length) throw new Error(`${outDir} already exists and is not empty`);
  const at = (root, p) => join(root, ...p.split('/'));
  for (const [from, to] of COPY) await fsp.cp(at(templateDir, from), at(outDir, to), { recursive: true });
  await fsp.cp(join(daxSqlDir, 'src'), at(outDir, 'site/semantic/dax-sql'), { recursive: true });
  for (const f of ['tmsl.js', 'ossie.js']) {
    await fsp.cp(join(daxSqlDir, 'formats', f), at(outDir, `site/semantic/formats/${f}`));
  }
  const yml = at(outDir, 'rayfin/rayfin.yml');
  await fsp.writeFile(yml, rayfinYml(await fsp.readFile(yml, 'utf8'), plan.name));
  const files = {
    'package.json': packageJson(plan),
    'build.mjs': BUILD_MJS,
    'deploy.mjs': deployMjs(plan),
    'site/index.html': indexHtml(plan),
    'site/app.js': appJs(plan),
    'model/ossie.yaml': String(text),
    'AGENTS.md': agentsMd(plan),
    '.gitignore': GITIGNORE,
  };
  for (const [p, body] of Object.entries(files)) {
    await fsp.mkdir(dirname(at(outDir, p)), { recursive: true });
    await fsp.writeFile(at(outDir, p), body);
  }
  return {
    dir: outDir, name: plan.name, workspace: plan.workspace, lakehouse: plan.lakehouse,
    catalogUrl: plan.catalogUrl, warnings: plan.warnings,
    chart: plan.chart.column ? `${plan.chart.measure} by ${plan.chart.column.table}[${plan.chart.column.name}]` : plan.chart.measure,
  };
}

module.exports = { planReport, generateReport, chartQuery, rayfinYml };
