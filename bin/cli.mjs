#!/usr/bin/env node
// =============================================================================
// bin/cli.mjs — ask the running OneLake Studio extension, from a shell
// =============================================================================
// A doorbell, nothing more: the arguments go to the extension over a local pipe
// (src/bridge.js), the extension answers with its own sign-in, cache and engine
// (src/agent.js), and this prints the answer — markdown on stdout, notes on stderr.
// Written for an agent to run. Read only, but for export, which you confirm in VS Code.
// Needs VS Code open with the extension signed in.
//
//   node bin/cli.mjs ls                                   workspaces
//   node bin/cli.mjs ls <ws>                              its lakehouses/warehouses and semantic models
//   node bin/cli.mjs ls <ws> <item>                       its tables, and their SQL names
//   node bin/cli.mjs models [<ws>]                        semantic models in every workspace, counted
//   node bin/cli.mjs items [<ws>]                         lakehouses and warehouses in every workspace, counted
//   node bin/cli.mjs files <ws> <item> [<dir>]            a lakehouse's Files/ listing
//   node bin/cli.mjs find <text>                          every cached name that contains it
//   node bin/cli.mjs table <ws> <item> <schema.table>     columns and stats (metadata only)
//   node bin/cli.mjs model <ws> <model> [--fresh]         relationships, columns, measures + DAX
//   node bin/cli.mjs sql "<sql>" [--in <ws>/<item>] [--limit N] [--csv] [--show-sql]
//   node bin/cli.mjs dax "EVALUATE …" [--model <name>] [--show-sql]
//   node bin/cli.mjs export <ws> <model>                  Export to Fabric, as Explore's button
//   node bin/cli.mjs export <ws> <item> <Files/path>      (a model file in a lakehouse)
// =============================================================================
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { askBridge } = require("../src/bridge.js");

const HELP = `onelake — ask OneLake Studio (VS Code must be open, signed in). Read only, but
for export, which waits for your OK in VS Code.

  ls                                  workspaces
  ls <ws>                             its lakehouses/warehouses and semantic models
  ls <ws> <item>                      its tables with rows, size and last write, and their
                                        SQL names
  models [<ws>]                       semantic models in every workspace (or one), counted
  items [<ws>]                        lakehouses and warehouses in every workspace (or one)
  files <ws> <item> [<dir>]           a lakehouse's Files/ listing, with sizes
  find <text>                         every cached name containing it: items, tables, columns,
                                        semantic models, a downloaded model's tables/measures
  table <ws> <item> <schema.table>    columns and stats (metadata only)
  model <ws> <model>                  relationships, columns, measures with their DAX
  sql "<sql>"                         read-only SQL; a table is Kind.workspace.item.schema.table
                                        (lakehouse.aemo.data.dbo.dim_duid); a downloaded model is a
                                        table: SELECT d.col, AGG("measure") FROM model GROUP BY ALL
    --in <ws>/<item>                  that lakehouse's files as 'Files/…' (read_parquet('Files/x.parquet'))
    --show-sql                        print the SQL a model query compiles to
  dax "EVALUATE …"                    a DAX query against a model (Explore's DAX runs as is)
    --model <name>                    which model (needed when more than one is defined)
  export <ws> <model>                 Export to Fabric, as Explore's button does it: the model's
                                        .bim in its lakehouse (open it in the tree once first).
                                        VS Code asks where the local copy goes and for the OK;
                                        the app opens on Explore's default view
  export <ws> <item> <Files/path>     the same, for a model file (.bim, Ossie .yaml) in Files/
  --limit N  --csv
  --fresh                             ask OneLake/Fabric now: listings and metadata come only
                                        from the cache otherwise, and say so when it has nothing`;

const argv = process.argv.slice(2);
const opts = {}, args = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--fresh") opts.fresh = true;
  else if (a === "--csv") opts.csv = true;
  else if (a === "--in") opts.in = argv[++i];
  else if (a === "--limit") opts.limit = Number(argv[++i]);
  else if (a === "--show-sql") opts.showSql = true;
  else if (a === "--model") opts.model = argv[++i];
  else args.push(a);
}
if (!args.length || args[0] === "help" || args[0] === "--help") {
  console.log(HELP);
  process.exit(0);
}

try {
  if (args[0] === "export") console.error("Export to Fabric: confirm it in VS Code…");
  const r = await askBridge({ args, opts });
  if (r.out) console.log(r.out);
  if (r.err) console.error(r.err);
  process.exit(r.code || 0);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
