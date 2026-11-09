#!/usr/bin/env node
// =============================================================================
// bin/cli.mjs — ask OneLake Studio, from a shell
// =============================================================================
// A doorbell first: the arguments go to the extension over a local pipe (src/bridge.js), the
// extension answers with its own sign-in, cache and engine (src/agent.js), and this prints the
// answer — the answer alone on stdout, notes on stderr, and the exit code an agent can branch on
// (EXIT, in bridge.js). With VS Code closed, on Windows, the same answer comes from dist/standalone.js,
// on a sign-in of its own (signin). `serve` is always that: it stays, for Excel to connect to.
// Written for an agent to run. Read only, but for export, which you confirm in VS Code.
//
//   node bin/cli.mjs --help
// =============================================================================
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
  files: "  files <ws> <item> [<dir>]           a lakehouse's Files/ listing, with sizes and SQL names",
  find: `  find <text>                         every cached name containing it: items, tables, columns,
                                        semantic models, a downloaded model's tables/measures;
                                        --fresh reads every listing first`,
  table: "  table <ws> <item> <schema.table>    columns and stats (metadata only)",
  exists: `  exists <ws> <item> <schema.table>   whether a table is there, from the listings: yes (exit 0),
                                        no with the closest names (exit 1), not cached (exit 4)`,
  model: "  model <ws> <model>                  relationships, columns, measures with their DAX",
  sql: `  sql "<sql>"                         read-only SQL; a table is kind.workspace.item.schema.table
                                        (lakehouse.aemo.data.dbo.dim_duid); a file is
                                        'lakehouse.aemo.data/Files/x.parquet'; a downloaded model is a
                                        table: SELECT d.col, AGG("measure") FROM semanticmodel.ws.model GROUP BY ALL
  sql -                               the SQL from stdin: no shell quoting to get wrong
    --show-sql                       print the SQL a model query compiles to`,
  export: `  export <ws> <model>                 Export to Fabric, as Explore's button does it: the app
                                        queries the semantic model as it is, and nothing is written
                                        to it (open it in the tree once first).
                                        VS Code asks where the local copy goes and for the OK.
                                        The app is one file, <app>.fabricapp: the model's Report,
                                        site/report.json in the zip, yours to grow
  export <ws> <item> <Files/path>     the same, for a model file (.bim, Ossie .yaml) in Files/: the
                                        app reads its tables client side, DuckDB in the browser.
                                        For an app on a semantic model of it, semanticmodel first,
                                        then export that model`,
  semanticmodel: `  semanticmodel <ws> <item> <Files/path>  the Power BI semantic model of a model file (.bim,
                                        Ossie .yaml) in Files/, named for the file, in its workspace,
                                        and no app. Asks in VS Code before it updates one of that name
    --mode directlake|directquery     on Direct Lake (the default) or the SQL endpoint`,
  status: `  status                              this window: its build, session, startup timeline, catalog,
                                        sync, and where its files are. Answers signed out too`,
  log: `  log [<text>]                        this window's own log, the lines holding <text> if given,
                                        newest last (default 200; --limit N)`,
  signin: `  signin                              with VS Code closed: sign in, in the browser, once. Needs no
                                        app registration, and the answers come from the same cache`,
  signout: "  signout                             forgets that sign-in. VS Code's own is its own",
  serve: `  serve <model.yaml|.bim>             an OLAP server on a model file, for Excel's PivotTables, until
                                        stopped. Prints how to connect; a refresh sees an edit to the file
    --workspace <ws>                  its workspace, if it can't be read from where its tables are
    --name <model>                    its name, if not the file's: semanticmodel.<ws>.<model>
    --open                            and a new workbook on it, in Excel`,
};

const OPTIONS = `  --limit N                           rows printed (default 100; --csv prints all unless given)
  --csv                               one table, raw values, on stdout
  --json                              { ok, columns, rows, total, truncated, complete, cachedAt, notes }
                                        or { ok: false, error: { code, message, retry }, notes }
  --fresh                             ask OneLake/Fabric now, ahead of the background's listings, and for sql, read its tables' metadata first: listings and metadata come only
                                        from the cache otherwise, and say so when it has nothing
  --timeout SEC                       give up and stop the query (default 600; 0 waits; export waits)
  --                                  what follows is not an option
  -h, --help  --version

exit codes: 0 answered (--json: complete, truncated say how much)  1 failed, or no such table  2 wrong call
            3 not signed in (signin), or no VS Code for export  4 not cached (--fresh)  5 you declined  6 timed out`;

const HELP = `onelake — ask OneLake Studio: VS Code if it is open, and if not, on Windows, this
on a sign-in of its own. Read only, but for export, which waits for your OK in VS Code.

${Object.values(USAGE).join("\n")}
${OPTIONS}`;

const SWITCHES = { "--fresh": "fresh", "--csv": "csv", "--json": "json", "--show-sql": "showSql", "--downloaded": "downloaded", "--open": "open" };
const VALUES = { "--limit": "limit", "--timeout": "timeout", "--workspace": "workspace", "--name": "name", "--mode": "mode" };
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

// The answer with VS Code closed: Windows for now, as its token cache is DPAPI's, and a Node with
// node:sqlite, as what is remembered is in SQLite. null without either, or from a checkout not bundled.
function standalone() {
  const file = fileURLToPath(new URL("../dist/standalone.js", import.meta.url));
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (process.platform !== "win32" || major < 22 || (major === 22 && minor < 5) || !existsSync(file)) return null;
  return require(file).createStandalone({ say: m => process.stderr.write(`${m}\n`) });
}

// Everything it opened holds the process, and what's written to a pipe has to get there first.
async function leave(alone) {
  await Promise.race([alone.close().catch(() => {}), new Promise(r => setTimeout(r, 5000))]);
  await new Promise(r => process.stdout.write("", r));
  process.exit(process.exitCode || 0);
}

const LOCAL = { signin: [0, "signin"], signout: [0, "signout"], serve: [1, "serve <model.yaml|.bim>"] };

async function local(name) {
  const [wanted, usage] = LOCAL[name];
  if (args.length - 1 !== wanted) return fail(EXIT.USAGE, `usage: ${usage}`);
  const alone = standalone();
  if (!alone) return fail(EXIT.UNAVAILABLE, `${name} needs an installed OneLake Studio on Windows, and Node 22.5 or later`);
  const answered = fields => { if (opts.json) console.log(JSON.stringify({ ok: true, command: name, ...fields })); };
  try {
    if (name === "signin") {
      process.stderr.write("Signing in: finish it in the browser…\n");
      const account = await alone.signin();
      answered({ account });
      if (!opts.json) console.log(`signed in as ${account}`);
    } else if (name === "signout") {
      await alone.signout();
      answered({});
      if (!opts.json) console.log("signed out");
    } else {
      const served = await alone.serve({ file: args[1], workspace: opts.workspace, name: opts.name, open: !!opts.open });
      answered(served);
      if (!opts.json) console.log(`serving ${served.catalog}\n\nconnection string:\n${served.connection}`);
      process.stderr.write("Serving until this is stopped (Ctrl+C).\n");
      await new Promise(r => { process.once("SIGINT", r); process.once("SIGTERM", r); });
    }
  } catch (e) {
    fail(e.code === EXIT.UNAVAILABLE ? EXIT.UNAVAILABLE : EXIT.FAILED, e.message);
  }
  await leave(alone);
}

async function ask() {
  if (wrong) return fail(EXIT.USAGE, wrong);
  if (Object.hasOwn(LOCAL, args[0])) return local(args[0]);
  const seconds = opts.timeout != null ? Number(opts.timeout) : args[0] === "export" || args[0] === "semanticmodel" ? 0 : DEFAULT_TIMEOUT_S;
  if (!(seconds >= 0)) return fail(EXIT.USAGE, `--timeout takes seconds, not "${opts.timeout}"`);
  const timeoutMs = seconds * 1000;
  let alone = null;
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
    let r;
    try {
      r = await askBridge(request, undefined, { timeoutMs });
    } catch (e) {
      if (e.code !== "NO_EXTENSION" || !(alone = standalone())) throw e;
      const stop = new AbortController();
      r = await withinTimeout(alone.answer(request, { signal: stop.signal }), timeoutMs).catch(x => { stop.abort(); throw x; });
      if (r.code === EXIT.UNAVAILABLE && args[0] !== "export") process.stderr.write(`Sign in with: node "${fileURLToPath(import.meta.url)}" signin\n`);
    }
    if (r.out) process.stdout.write(r.out + "\n");
    if (r.err) process.stderr.write(r.err + "\n");
    process.exitCode = r.code || 0;
  } catch (e) {
    const code = e.code === "NO_EXTENSION" ? EXIT.UNAVAILABLE : e.code === "TIMEOUT" ? EXIT.TIMEOUT : EXIT.FAILED;
    fail(code, e.message);
  } finally {
    // Whatever was still reading stdin has no more to do.
    process.stdin.destroy();
    if (alone) await leave(alone);
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
