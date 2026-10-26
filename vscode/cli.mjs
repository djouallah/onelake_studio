#!/usr/bin/env node
// =============================================================================
// cli.mjs — ask the running OneLake Studio extension, from a shell
// =============================================================================
// A doorbell, nothing more: the arguments go to the extension over a local pipe
// (src/bridge.js), the extension answers with its own sign-in, cache and engine
// (src/agent.js), and this prints the answer — markdown on stdout, notes on stderr.
// Written for an agent to run. Read only. Needs VS Code open with the extension signed in.
//
//   node cli.mjs ls                                   workspaces
//   node cli.mjs ls <ws>                              its lakehouses/warehouses and semantic models
//   node cli.mjs ls <ws> <item>                       its tables, and their names for --in
//   node cli.mjs table <ws> <item> <schema.table>     columns and stats (metadata only)
//   node cli.mjs model <ws> <model> [--fresh]         relationships, columns, measures + DAX
//   node cli.mjs sql "<sql>" [--in <ws>/<item>] [--limit N] [--csv]
// =============================================================================
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { askBridge } = require("./src/bridge.js");

const HELP = `onelake — ask OneLake Studio (VS Code must be open, signed in). Read only.

  ls                                  workspaces
  ls <ws>                             its lakehouses/warehouses and semantic models
  ls <ws> <item>                      its tables, and their names for sql --in
  table <ws> <item> <schema.table>    columns and stats (metadata only)
  model <ws> <model>                  relationships, columns, measures with their DAX
  sql "<sql>"                         read-only SQL; a downloaded model is a table:
                                        SELECT d.col, AGG("measure") FROM model GROUP BY ALL
    --in <ws>/<item>                  that lakehouse's tables, as <item>_<schema>.<table>
    --limit N  --csv
  --fresh                             re-read from OneLake/Fabric instead of the cache`;

const argv = process.argv.slice(2);
const opts = {}, args = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--fresh") opts.fresh = true;
  else if (a === "--csv") opts.csv = true;
  else if (a === "--in") opts.in = argv[++i];
  else if (a === "--limit") opts.limit = Number(argv[++i]);
  else args.push(a);
}
if (!args.length || args[0] === "help" || args[0] === "--help") {
  console.log(HELP);
  process.exit(0);
}

try {
  const r = await askBridge({ args, opts });
  if (r.out) console.log(r.out);
  if (r.err) console.error(r.err);
  process.exit(r.code || 0);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
