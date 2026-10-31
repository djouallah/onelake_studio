#!/usr/bin/env node
// =============================================================================
// bin/cli.mjs — ask the running OneLake Studio extension, from a shell
// =============================================================================
// A doorbell, nothing more: the arguments go to the extension over a local pipe
// (src/bridge.js), the extension answers with its own sign-in, cache and engine
// (src/agent.js), and this prints the answer — the answer alone on stdout, notes on stderr,
// and the exit code an agent can branch on (EXIT, in bridge.js).
// Written for an agent to run. Read only, but for export, which you confirm in VS Code.
// Needs VS Code open with the extension signed in; --help and a wrong call do not.
//
//   node bin/cli.mjs --help
// =============================================================================
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const { askBridge, EXIT, failureJson, checkRequest, MAX_REQUEST } = require("../src/bridge.js");

const USAGE = {
  ls: `  ls                                  workspaces
  ls <ws>                             its lakehouses/warehouses and semantic models
  ls <ws> <item>                      its tables with rows, size and last write, and their
                                        SQL names`,
  models: `  models [<ws>]                       semantic models in every workspace (or one), counted
    --downloaded                      only those on this machine: readable with no download`,
  items: "  items [<ws>]                        lakehouses and warehouses in every workspace (or one)",
  files: "  files <ws> <item> [<dir>]           a lakehouse's Files/ listing, with sizes",
  find: `  find <text>                         every cached name containing it: items, tables, columns,
                                        semantic models, a downloaded model's tables/measures;
                                        --fresh reads every listing first`,
  table: "  table <ws> <item> <schema.table>    columns and stats (metadata only)",
  model: "  model <ws> <model>                  relationships, columns, measures with their DAX",
  sql: `  sql "<sql>"                         read-only SQL; a table is kind.workspace.item.schema.table
                                        (lakehouse.aemo.data.dbo.dim_duid); a downloaded model is a
                                        table: SELECT d.col, AGG("measure") FROM semanticmodel.ws.model GROUP BY ALL
  sql -                               the SQL from stdin: no shell quoting to get wrong
    --in <ws>/<item>                  that lakehouse's files as 'Files/…' (read_parquet('Files/x.parquet'))
    --show-sql                        print the SQL a model query compiles to`,
  export: `  export <ws> <model>                 Export to Fabric, as Explore's button does it: the model's
                                        .yaml in its lakehouse (open it in the tree once first).
                                        VS Code asks where the local copy goes and for the OK;
                                        the app opens on Explore's default view
  export <ws> <item> <Files/path>     the same, for a model file (.bim, Ossie .yaml) in Files/`,
};

const OPTIONS = `  --limit N                           rows printed (default 100; --csv prints all unless given)
  --csv                               one table, raw values, on stdout
  --json                              { ok, columns, rows, total, truncated, complete, cachedAt, notes }
                                        or { ok: false, error: { code, message, retry }, notes }
  --fresh                             ask OneLake/Fabric now: listings and metadata come only
                                        from the cache otherwise, and say so when it has nothing
  --timeout SEC                       give up and stop the query (default 600; 0 waits; export waits)
  --                                  what follows is not an option
  -h, --help  --version

exit codes: 0 answered (--json: complete, truncated say how much)  1 failed  2 wrong call
            3 VS Code not open or not signed in  4 not cached (--fresh)  5 you declined  6 timed out`;

const HELP = `onelake — ask OneLake Studio (VS Code must be open, signed in). Read only, but
for export, which waits for your OK in VS Code.

${Object.values(USAGE).join("\n")}
${OPTIONS}`;

const SWITCHES = { "--fresh": "fresh", "--csv": "csv", "--json": "json", "--show-sql": "showSql", "--downloaded": "downloaded" };
const VALUES = { "--limit": "limit", "--in": "in", "--timeout": "timeout" };
const DEFAULT_TIMEOUT_S = 600;

function parse(argv) {
  const opts = {}, args = [];
  let help = false, version = false, wrong = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { args.push(...argv.slice(i + 1)); break; }
    if (a === "-h" || a === "--help") help = true;
    else if (a === "--version") version = true;
    else if (Object.hasOwn(SWITCHES, a)) opts[SWITCHES[a]] = true;
    else if (Object.hasOwn(VALUES, a)) {
      if (i + 1 >= argv.length) wrong ||= `${a} needs a value`;
      else opts[VALUES[a]] = argv[++i];
    }
    // Only a whole token that looks like an option is one: `sql "-- why\nSELECT 1"` is SQL.
    else if (/^--?[A-Za-z][\w-]*$/.test(a)) wrong ||= `unknown option: ${a}`;
    else args.push(a);
  }
  return { opts, args, help, version, wrong };
}

const { opts, args, help, version, wrong } = parse(process.argv.slice(2));

// A reader that stopped reading (`| head -1`) is not a failure, and is never a stack trace.
process.stdout.on("error", e => process.exit(e.code === "EPIPE" ? EXIT.OK : EXIT.FAILED));
process.stderr.on("error", () => {});

// process.exitCode, not process.exit(): exiting at once can cut a long answer still being
// written to a pipe.
function fail(code, message) {
  if (opts.json) process.stdout.write(failureJson(code, message) + "\n");
  else process.stderr.write(message + "\n");
  process.exitCode = code;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", c => { text += c; });
    process.stdin.on("end", () => resolve(text));
    process.stdin.on("error", reject);
  });
}

// Waits with the same clock as the answer: a stdin nobody closes must not hold an agent forever.
function withinTimeout(promise, ms) {
  if (!ms) return promise;
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`no answer in ${ms / 1000}s`), { code: "TIMEOUT" })), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

async function ask() {
  if (wrong) return fail(EXIT.USAGE, wrong);
  const seconds = opts.timeout != null ? Number(opts.timeout) : args[0] === "export" ? 0 : DEFAULT_TIMEOUT_S;
  if (!(seconds >= 0)) return fail(EXIT.USAGE, `--timeout takes seconds, not "${opts.timeout}"`);
  const timeoutMs = seconds * 1000;
  const { timeout: _client, ...sent } = opts;
  const bad = checkRequest({ args, opts: sent });
  if (bad) return fail(EXIT.USAGE, bad);
  try {
    if (args[0] === "sql" && args[1] === "-") {
      args[1] = await withinTimeout(readStdin(), timeoutMs);
      if (!args[1].trim()) return fail(EXIT.USAGE, "sql -: nothing on stdin");
    }
    const request = { args, opts: sent };
    if (JSON.stringify(request).length >= MAX_REQUEST) {
      return fail(EXIT.USAGE, `the request is over ${MAX_REQUEST / 1048576} MB: too long to send`);
    }
    if (args[0] === "export" && !opts.json) process.stderr.write("Export to Fabric: confirm it in VS Code…\n");
    const r = await askBridge(request, undefined, { timeoutMs });
    if (r.out) process.stdout.write(r.out + "\n");
    if (r.err) process.stderr.write(r.err + "\n");
    process.exitCode = r.code || 0;
  } catch (e) {
    const code = e.code === "NO_EXTENSION" ? EXIT.UNAVAILABLE : e.code === "TIMEOUT" ? EXIT.TIMEOUT : EXIT.FAILED;
    fail(code, e.message);
  } finally {
    // Whatever was still reading stdin has no more to do.
    process.stdin.destroy();
  }
}

if (version) {
  const { version: v } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  console.log(opts.json ? JSON.stringify({ ok: true, command: "version", version: v }) : `onelake-studio ${v}`);
} else if (help || args[0] === "help" || (!args.length && !wrong)) {
  // `ls --help`, `help ls`: that command's lines. An unknown one, everything.
  const topic = args[0] === "help" ? args[1] : args[0];
  console.log(topic && Object.hasOwn(USAGE, topic) ? `${USAGE[topic]}\n\n${OPTIONS}` : HELP);
} else {
  await ask();
}
