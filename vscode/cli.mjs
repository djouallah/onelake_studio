#!/usr/bin/env node
// =============================================================================
// cli.mjs — OneLake and semantic models from a shell: the extension, without VS Code
// =============================================================================
// The same modules the extension runs — the cache-first catalog (src/onelake.js), DuckDB
// (src/engine-host.js), the read-only guard (src/sql.js), the DAX compiler behind a .bim
// (app/semantic.js) — signed in with the Azure CLI instead of VS Code. Written for an agent
// to run: answers as markdown on stdout, progress on stderr. Read only, like the extension.
//
//   node cli.mjs ls                                   workspaces
//   node cli.mjs ls <ws>                              its lakehouses/warehouses and semantic models
//   node cli.mjs ls <ws> <item>                       its tables
//   node cli.mjs table <ws> <item> <schema.table>     columns and stats (metadata only)
//   node cli.mjs model <ws> <model> [--fresh]         columns, relationships, measures + DAX
//   node cli.mjs sql "<sql>" [--in <ws>/<item>] [--limit N] [--csv]
//
// In `sql`, every downloaded model is a table you can name: AGG("measure") is the measure,
// computed by dax-sql — SELECT t.col, AGG("Sales") FROM model GROUP BY ALL. `--in` makes a
// lakehouse's tables nameable as schema.table (and as table, when the name is unique).
//
// Shares with the extension: the .bim downloads (~/OneLakeStudio/semantic-models, or
// $ONELAKE_MODELS). Its own: the cache, under ~/.onelake-studio.
// =============================================================================
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFile, writeFile, readdir, mkdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { createCatalog } = require("./src/catalog.js");
const { createStore } = require("./src/store.js");
const { createOneLake } = require("./src/onelake.js");
const { createEngineHost } = require("./src/engine-host.js");
const { createFabric, bimFileName } = require("./src/fabric.js");
const { PINS } = require("./src/vendored.js");
// The panel's modules: app/ in a checkout, its staged copy webview/ in an installed vsix.
const APP = existsSync(join(here, "app", "semantic.js")) ? "app" : "webview";
const appModule = f => import(pathToFileURL(join(here, APP, f)).href);
const { quoteIdent, sqlNeedsTable, emptyTableSql } = await appModule("paths.js");
const semantic = await appModule("semantic.js");

const HOME = join(homedir(), ".onelake-studio");
const MODELS = process.env.ONELAKE_MODELS || join(homedir(), "OneLakeStudio", "semantic-models");
const say = m => process.stderr.write(m + "\n");

// ---------------------------------------------------------------------------
// Sign-in: the Azure CLI's, one token per audience, asked again only when told to
// ---------------------------------------------------------------------------
const run = promisify(execFile);
const az = async (...args) =>
  (await run("az", [...args, "-o", "json"], { shell: process.platform === "win32", windowsHide: true })).stdout;
const tokens = new Map();
function tokenFor(resource) {
  return async ({ fresh = false } = {}) => {
    if (!fresh && tokens.has(resource)) return tokens.get(resource);
    try {
      const t = JSON.parse(await az("account", "get-access-token", "--resource", resource)).accessToken;
      tokens.set(resource, t);
      return t;
    } catch (e) {
      throw new Error(`no Azure CLI token for ${resource} — run \`az login\` (${String(e.message).split("\n")[0]})`);
    }
  };
}
const storageToken = tokenFor("https://storage.azure.com");
const fabricToken = tokenFor("https://api.fabric.microsoft.com");

// ---------------------------------------------------------------------------
// The extension's own layers, pointed at this account's cache
// ---------------------------------------------------------------------------
const reads = { hits: 0, net: 0, netMs: 0 };
const tally = e => { if (e.cache === "hit") reads.hits++; else { reads.net++; reads.netMs += e.ms || 0; } };

let account = null, onelake = null, fabric = null, engine = null;
async function setup() {
  if (onelake) return;
  // Who az is signed in as, from its own profile file: asking `az account show` costs
  // seconds of Python start-up, and a cached answer needs no token at all.
  let who = null;
  try {
    const profile = JSON.parse((await readFile(join(homedir(), ".azure", "azureProfile.json"), "utf8")).replace(/^﻿/, ""));
    const s = (profile.subscriptions || []).find(x => x.isDefault);
    if (s) who = { u: s.user && s.user.name, t: s.tenantId };
  } catch (_) {}
  who ??= JSON.parse(await az("account", "show", "--query", "{u:user.name,t:tenantId}"));
  account = createHash("sha256").update(`${who.u}|${who.t}`).digest("hex").slice(0, 16);
  fabric = createFabric({ getFabricToken: fabricToken });
  onelake = createOneLake({
    catalog: createCatalog({ getToken: storageToken, onRequest: tally }),
    store: createStore({ dir: join(HOME, "store", account) }),
    fabric, onHit: tally, prefetchEnabled: () => false,
  });
}

function getEngine() {
  engine ??= createEngineHost({
    getToken: storageToken,
    bundledExtensions: join(here, "duckdb-extensions"),
    extensionDir: join(HOME, "duckdb-extensions"),
    fileCacheDir: join(HOME, "file-cache", account),
    fileCacheMaxBytes: 10 * 1024 ** 3,
    onWarn: w => say(`(engine) ${w}`),
  });
  return engine;
}
const query = sql => getEngine().call("query", [sql]);

// ---------------------------------------------------------------------------
// Names as a person types them
// ---------------------------------------------------------------------------
// An item is "sales.Lakehouse" in OneLake; "sales" will do when it is unambiguous.
async function itemOf(ws, name) {
  const items = await onelake.items(ws);
  const lc = String(name).toLowerCase();
  const hit = items.find(i => i.name.toLowerCase() === lc) ||
              items.filter(i => i.name.toLowerCase().replace(/\.[^.]+$/, "") === lc)[0];
  if (!hit) throw new Error(`no item "${name}" in ${ws} — \`ls ${ws}\` lists them`);
  return { workspace: ws, item: hit.name };
}

async function modelOf(ws, name) {
  const list = await onelake.models(ws);
  const hit = list.find(m => m.name.toLowerCase() === String(name).toLowerCase());
  if (!hit) throw new Error(`no semantic model "${name}" in ${ws} — \`ls ${ws}\` lists them`);
  return hit;
}

const bimPath = (ws, model) => join(MODELS, bimFileName(ws).replace(/\.bim$/, ""), bimFileName(model));
const exists = p => stat(p).then(() => true, () => false);

// Every downloaded .bim, registered so SQL can name its model.
let compiler = null;
async function registerAll() {
  compiler ??= await Promise.all([
    import(pathToFileURL(join(here, "vendor", "gh", PINS.daxSql, "src", "index.js")).href),
    import(pathToFileURL(join(here, "vendor", "gh", PINS.daxSql, "formats", "tmsl.js")).href),
  ]).then(([c, t]) => ({ createCompiler: c.createCompiler, tmslToModel: t.tmslToModel }),
          e => { throw new Error(`the DAX compiler is not in vendor/ — run \`node vendor.mjs\` (${e.message})`); });
  const seen = new Map();
  for (const ws of await readdir(MODELS).catch(() => [])) {
    for (const f of await readdir(join(MODELS, ws)).catch(() => [])) {
      if (!f.toLowerCase().endsWith(".bim")) continue;
      try {
        const m = await semantic.registerModel(f, await readFile(join(MODELS, ws, f), "utf8"), compiler);
        if (seen.has(m.name)) say(`note: model ${m.name} is in both ${seen.get(m.name)} and ${ws}; ${ws}'s is used`);
        seen.set(m.name, ws);
      } catch (e) { say(`skipped ${ws}/${f}: ${e.message}`); }
    }
  }
  return seen;
}

// A table as a view DuckDB can select from: iceberg_scan over the metadata file the cache
// holds, exactly as the panel opens one (data.js openTableView).
async function openView(lh, t, schema, name = t.table) {
  const meta = await onelake.table(lh, t, { onWait: say });
  const ident = schema ? `${quoteIdent(schema)}.${quoteIdent(name)}` : quoteIdent(name);
  if (schema) await query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schema)}`);
  const body = meta.empty ? emptyTableSql(meta.schemaFields)
    : `SELECT * FROM ${(await getEngine().openTable({ metadataLocation: meta.metadataLocation })).ident}`;
  await query(`CREATE OR REPLACE VIEW ${ident} AS ${body}`);
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------
const cell = v => v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
function table(cols, rows) {
  const md = v => cell(v).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  return [`| ${cols.map(md).join(" | ")} |`, `|${cols.map(() => "---").join("|")}|`,
          ...rows.map(r => `| ${r.map(md).join(" | ")} |`)].join("\n");
}
const csv = (cols, rows) => [cols, ...rows].map(r => r.map(v => {
  const s = cell(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}).join(",")).join("\n");

function printResult(res, { limit = 100, asCsv = false } = {}) {
  const cols = res.fields.map(f => f.name);
  const rows = res.rows.map(r => cols.map(c => r[c]));
  if (asCsv) { console.log(csv(cols, rows)); return; }
  console.log(table(cols, rows.slice(0, limit)));
  const n = res.numRows ?? rows.length;
  console.log(`\n${n.toLocaleString("en")} row(s)` + (n > Math.min(limit, rows.length) ? `, first ${Math.min(limit, rows.length)} shown` : ""));
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
async function ls([ws, item], { fresh }) {
  if (!ws) {
    const list = await onelake.workspaces({ fresh });
    console.log(table(["workspace"], list.map(w => [w])));
    return;
  }
  if (!item) {
    const items = await onelake.items(ws, { fresh });
    console.log(table(["item", "kind"], items.map(i => [i.name, i.kind])));
    try {
      const models = await onelake.models(ws, { fresh });
      const rows = [];
      for (const m of models) rows.push([m.name, await exists(bimPath(ws, m.name)) ? "downloaded" : "", m.description]);
      console.log("\n" + (rows.length ? table(["semantic model", "", "description"], rows) : "No semantic models."));
    } catch (e) { say(`semantic models not listed: ${e.message}`); }
    return;
  }
  const lh = await itemOf(ws, item);
  const tables = await onelake.tables(lh, { fresh });
  console.log(table(["table"], tables.map(t => [t.schema ? `${t.schema}.${t.table}` : t.table])));
}

async function describeTable([ws, item, name], { fresh }) {
  if (!name) throw new Error("usage: table <ws> <item> <schema.table>");
  const lh = await itemOf(ws, item);
  const [schema, tname] = name.includes(".") ? [name.slice(0, name.indexOf(".")), name.slice(name.indexOf(".") + 1)] : ["dbo", name];
  const m = await onelake.table(lh, { schema, table: tname }, { fresh, onWait: say });
  const s = m.stats || {};
  const n = v => v == null ? "—" : Number(v).toLocaleString("en");
  console.log(table(["", ""], [
    ["rows", n(m.totalRecords)], ["data files", n(s.totalDataFiles)], ["delete files", n(s.totalDeleteFiles)],
    ["size (bytes)", n(s.totalFilesSize)], ["last write", s.snapshotTs ? new Date(s.snapshotTs).toISOString() : "—"],
    ["partitioned by", (s.partitionColumns || []).join(", ") || "none"],
    ["metadata as of", new Date(m.at).toISOString() + (m.cached ? " (cached)" : "")],
  ]));
  console.log("\n" + table(["column", "type"], (m.schemaFields || []).map(f => [f.name, f.type])));
}

async function model([ws, name], { fresh }) {
  if (!name) throw new Error("usage: model <ws> <model>");
  let path = bimPath(ws, name);
  if (fresh || !await exists(path)) {
    const m = await modelOf(ws, name);
    path = bimPath(ws, m.name);
    say(`downloading ${ws}/${m.name} from Fabric…`);
    const bytes = await fabric.getBim(ws, m.id);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  }
  await registerAll();
  const text = await readFile(path, "utf8");
  const bim = JSON.parse(text.replace(/^﻿/, ""));
  const m = await semantic.registerModel(bimFileName(name), text, compiler);
  console.log(`# ${m.name} — semantic model (${ws}), from ${path}\n`);
  console.log(`Query it as \`FROM ${m.name}\`; a measure is \`AGG("name")\`. Direct Lake tables: ${m.directLake}.\n`);
  const rels = (bim.model?.relationships || []).map(r =>
    [`${r.fromTable}[${r.fromColumn}]`, `${r.toTable}[${r.toColumn}]`, r.isActive === false ? "inactive" : ""]);
  if (rels.length) console.log(table(["from (many)", "to (one)", ""], rels) + "\n");
  printResult(await query(semantic.rewrite(`DESCRIBE ${m.name}`).sql), { limit: 100000 });
  console.log(`\nExample:\n\n${m.sample}`);
}

async function sql([text], { in: inLh, limit, csv: asCsv }) {
  if (!text) throw new Error('usage: sql "<query>"');
  await registerAll();
  const t0 = Date.now();
  const rewritten = semantic.rewrite(text);
  for (const x of rewritten ? rewritten.tables : []) await openView(x.lh, x.t, x.viewSchema);
  if (inLh) {
    const [ws, item] = inLh.split("/");
    const lh = await itemOf(ws, item);
    const tables = await onelake.tables(lh);
    const named = tables.filter(t => sqlNeedsTable(text, t.table));
    for (const t of named) {
      await openView(lh, t, t.schema || null);
      if (tables.filter(o => o.table === t.table).length === 1 && t.schema) await openView(lh, t, null);
    }
  }
  const res = await query(rewritten ? rewritten.sql : text);
  printResult(res, { limit, asCsv });
  if (!asCsv) say(`${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

// ---------------------------------------------------------------------------
const COMMANDS = { ls, table: describeTable, model, sql };
const argv = process.argv.slice(2);
const opts = { limit: 100 }, args = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--fresh") opts.fresh = true;
  else if (a === "--csv") opts.csv = true;
  else if (a === "--in") opts.in = argv[++i];
  else if (a === "--limit") opts.limit = Number(argv[++i]) || 100;
  else args.push(a);
}
const cmd = COMMANDS[args[0]];
if (!cmd) {
  console.log(readFileSyncHelp());
  process.exit(args[0] ? 1 : 0);
}
let code = 0;
try {
  await setup();
  await cmd(args.slice(1), opts);
} catch (e) {
  say(`error: ${e.message}`);
  code = 1;
} finally {
  if (reads.hits || reads.net)
    say(`reads: ${reads.hits} from disk, ${reads.net} from OneLake/Fabric (${(reads.netMs / 1000).toFixed(1)}s)`);
  if (engine) await engine.close().catch(() => {});
}
process.exit(code);

function readFileSyncHelp() {
  return `onelake — OneLake and semantic models, read only

  ls                                  workspaces
  ls <ws>                             its lakehouses/warehouses and semantic models
  ls <ws> <item>                      its tables
  table <ws> <item> <schema.table>    columns and stats (metadata only)
  model <ws> <model>                  columns, relationships, measures with their DAX
  sql "<sql>"                         read-only SQL; a downloaded model is a table:
                                        SELECT d.col, AGG("measure") FROM model GROUP BY ALL
    --in <ws>/<item>                  that lakehouse's tables, as schema.table
    --limit N  --csv
  --fresh                             re-read from OneLake/Fabric instead of the cache`;
}
