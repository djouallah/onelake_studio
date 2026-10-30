// test/sql/*.test, in sqllogictest form (DuckDB's own), run through the command line's `sql`
// on the real engine — so what a user types, in the panel or a shell, keeps answering as DuckDB
// would. Every file runs against one cache, CACHED below, which nothing asks OneLake about.
//
//   # a comment
//   statement ok                 the statement runs
//   <sql, up to a blank line>
//
//   statement error              the statement fails; the error contains the text after ----
//   <sql>
//   ----
//   <part of the message>
//
//   query TTI [rowsort]          one letter per column; the rows, tab-separated, after ----
//   <sql>                        (rowsort: compared sorted). NULL is written NULL; a list is
//   ----                         written as DuckDB prints it, ['a', 'b'].
//   <rows>
//
// Needs node_modules, DuckDB's extensions (scripts/fetch-extensions.mjs) and vendor/ (scripts/
// vendor.mjs, for dax-sql), so CI runs it in the engine job, not in `npm test`.
//
// Run: node --test test/js/sqllogic.test.mjs
// SQLLOGIC_RECORD=1 writes each query's rows as they come back, in place of what the file
// expects: for writing a new test, whose rows are then read before they are committed.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { createEngineHost } = require("../../src/engine-host.js");
const { createAgent } = require("../../src/agent.js");
const { PINS } = require("../../src/vendored.js");

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const SQL_DIR = join(ROOT, "test", "sql");
const BUNDLED = join(ROOT, "duckdb-extensions");

// What the host's cache holds, for every file: dbo.t in two workspaces (two tables, never one),
// a warehouse table nothing was written to, and a semantic model.
const CACHED = [
  { kind: "lakehouse", workspace: "cat1", item: "lh", schema: "dbo", table: "t", columns: [{ name: "a", type: "BIGINT" }] },
  { kind: "lakehouse", workspace: "cat2", item: "lh", schema: "dbo", table: "t",
    columns: [{ name: "b", type: "VARCHAR" }, { name: "c", type: "DECIMAL(10,2)" }] },
  { kind: "warehouse", workspace: "cat1", item: "wh", schema: "sales", table: "e",
    emptySql: "SELECT CAST(NULL AS INTEGER) AS id WHERE false" },
  { kind: "semanticmodel", workspace: "cat1", model: "Sales" },
];

// The records of one .test file: { kind, sql, expected, types, rowsort, line }.
function parse(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const records = [];
  let i = 0;
  while (i < lines.length) {
    const head = lines[i].trim();
    if (!head || head.startsWith("#")) { i++; continue; }
    const line = i + 1;
    const [kind, arg, sort] = head.split(/\s+/);
    if (!["statement", "query"].includes(kind)) throw new Error(`line ${line}: expected statement or query, got "${head}"`);
    i++;
    const sql = [], expected = [];
    while (i < lines.length && lines[i].trim() !== "" && lines[i] !== "----") sql.push(lines[i++]);
    if (lines[i] === "----") {
      i++;
      while (i < lines.length && lines[i] !== "") expected.push(lines[i++]);
    }
    records.push({ kind: kind === "query" ? "query" : arg, sql: sql.join("\n"), expected, types: kind === "query" ? arg : "",
                   rowsort: sort === "rowsort", line });
  }
  return records;
}

// The command line's CSV, as rows of strings (an empty cell is NULL).
function csvRows(text) {
  const rows = [];
  let row = [], cell = "", quoted = false, i = 0;
  const end = () => { row.push(cell); cell = ""; };
  for (; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") end();
    else if (ch === "\n") { end(); rows.push(row); row = []; }
    else cell += ch;
  }
  end(); rows.push(row);
  return rows.map(r => r.map(v => (v === "" ? "NULL" : v)));
}

test("test/sql/*.test, through the command line's sql", async t => {
  const extDir = await mkdtemp(join(tmpdir(), "onelake-sqllogic-ext-"));
  // A table a statement names is the cache's, empty: its columns and no rows.
  const resolveTable = async ref => {
    const c = CACHED.find(x => x.kind === ref.kind && x.workspace.toLowerCase() === ref.workspace.toLowerCase() &&
                               x.item.toLowerCase() === ref.item.toLowerCase() &&
                               x.table.toLowerCase() === ref.table.toLowerCase());
    if (!c) throw new Error(`there is no ${ref.kind} table ${ref.workspace}.${ref.item}.${ref.schema}.${ref.table}`);
    const cols = (c.columns || []).map(x => `CAST(NULL AS ${x.type}) AS "${x.name}"`).join(", ");
    return { kind: c.kind, workspace: c.workspace, item: c.item, schema: c.schema, table: c.table,
             emptySql: c.emptySql || `SELECT ${cols} WHERE false` };
  };
  const engine = createEngineHost({ extensionDir: extDir, resolveTable, catalogTables: async () => CACHED,
                                    bundledExtensions: existsSync(BUNDLED) ? BUNDLED : null });
  t.after(async () => {
    await engine.close();
    await rm(extDir, { recursive: true, force: true }).catch(() => {});
  });
  const agent = createAgent({
    onelake: {}, modelPath: () => "", engine: async () => engine, semviews: { texts: async () => [] },
    appDir: join(ROOT, "app"), vendorDir: join(ROOT, "vendor"), daxSqlPin: PINS.daxSql, yamlPin: PINS.yaml,
  });

  const files = (await readdir(SQL_DIR)).filter(f => f.endsWith(".test")).sort();
  assert.ok(files.length, "test/sql has .test files");
  const record = !!process.env.SQLLOGIC_RECORD;
  for (const file of files) {
    await t.test(file, async () => {
      const text = await readFile(join(SQL_DIR, file), "utf8");
      const recorded = [];   // [line of the record, its rows], for SQLLOGIC_RECORD
      for (const r of parse(text)) {
        const where = `${file}:${r.line}: ${r.sql.split("\n")[0]}`;
        const res = await agent.run({ args: ["sql", r.sql], opts: { csv: true, limit: 1e6 } });
        if (r.kind === "error") {
          assert.equal(res.code, 1, `${where}\nran, but should have failed`);
          if (r.expected.length) assert.ok(res.err.includes(r.expected.join("\n")), `${where}\nfailed with: ${res.err}`);
          continue;
        }
        assert.equal(res.code, 0, `${where}\n${res.err}`);
        if (r.kind !== "query") continue;
        const [, ...rows] = csvRows(res.out);
        for (const row of rows) {
          assert.equal(row.length, r.types.length, `${where}\n${r.types.length} column(s) expected, got ${row.length}`);
        }
        const got = rows.map(x => x.join("\t"));
        const want = [...r.expected];
        if (r.rowsort) { got.sort(); want.sort(); }
        if (record) { recorded.push([r.line, got]); continue; }
        assert.deepEqual(got, want, where);
      }
      if (record) {
        // From the last record up, so the earlier ones' lines stay where they were.
        const lines = text.replace(/\r\n/g, "\n").split("\n");
        for (const [line, rows] of recorded.reverse()) {
          let i = line;
          while (i < lines.length && lines[i] !== "----") i++;
          let j = i + 1;
          while (j < lines.length && lines[j] !== "") j++;
          lines.splice(i + 1, j - i - 1, ...rows);
        }
        await writeFile(join(SQL_DIR, file), lines.join("\n"));
      }
    });
  }
});
