// The guard on SQL, attacked from outside its own reading of the text. sql.test.mjs holds the cases someone
// thought of; here a statement that writes is dressed up in every way DuckDB reads as the same statement, and
// must still be refused, and a read that only mentions a write must still pass. Then random text: whatever it
// is, the guard answers with an Error or nothing, in bounded time.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { eachSeed } from "./fuzz.mjs";
import { READS as TRICKY_READS, WRITES as TRICKY_WRITES } from "./sql-disagreements.mjs";

const require = createRequire(import.meta.url);
const sql = require("../../core/sql.js");
const { sqlPart } = require("../../core/names.js");
const { assertReads, tableRefs, oneLakeScopes, statementsOf } = sql;

// One statement each, and none of them a read.
const WRITES = [
  "INSERT INTO ws.lh.dbo.t VALUES (1)",
  "INSERT INTO t SELECT * FROM u",
  "UPDATE ws.lh.dbo.t SET a = 1",
  "DELETE FROM ws.lh.dbo.t",
  "MERGE INTO t USING u ON t.a = u.a WHEN MATCHED THEN DELETE",
  "TRUNCATE t",
  "CREATE TABLE ws.lh.dbo.t (a INT)",
  "CREATE TABLE t AS SELECT 1",
  "CREATE OR REPLACE VIEW v AS SELECT 1",
  "CREATE MACRO m() AS 1",
  "CREATE SECRET s (TYPE azure)",
  "CREATE SCHEMA ws.lh.raw",
  "DROP TABLE ws.lh.dbo.t",
  "DROP VIEW v",
  "ALTER TABLE t ADD COLUMN b INT",
  "COPY (SELECT 1) TO 'x.csv'",
  "COPY t FROM 'x.csv'",
  "EXPORT DATABASE 'dir'",
  "IMPORT DATABASE 'dir'",
  "ATTACH 'x.duckdb' AS x",
  "DETACH x",
  "INSTALL httpfs",
  "LOAD httpfs",
  "FORCE INSTALL httpfs",
  "SET memory_limit = '1GB'",
  "RESET memory_limit",
  "PRAGMA database_list",
  "CALL pragma_version()",
  "CHECKPOINT",
  "VACUUM",
  "ANALYZE",
  "BEGIN",
  "COMMIT",
  "PREPARE p AS DELETE FROM t",
  "EXECUTE p",
  "COMMENT ON TABLE t IS 'x'",
  "WITH x AS (SELECT 1 AS a) INSERT INTO t SELECT * FROM x",
  "WITH x AS (SELECT 1 AS a) DELETE FROM t WHERE a IN (SELECT a FROM x)",
  "WITH x AS (SELECT 1 AS a) UPDATE t SET a = 2",
  "EXPLAIN ANALYZE DELETE FROM t",
  "EXPLAIN INSERT INTO t VALUES (1)",
  "EXPLAIN (ANALYZE) COPY (SELECT 1) TO 'x.csv'",
];
// A read by its first word, and still not one a statement may be.
const FORBIDDEN_READS = [
  "SELECT 1; DELETE FROM t",
  "SELECT 1; SELECT 2",
  "SELECT * FROM query('DELETE FROM t')",
  "SELECT * FROM query_table('t')",
  "SELECT * FROM json_execute_serialized_sql(json_serialize_sql('SELECT 1'))",
  "SELECT * FROM \"json_execute_serialized_sql\" ('{}')",
  "SELECT * FROM \"query\"('DELETE FROM t')",
  "SELECT quack_stop('quack:127.0.0.1:1')",
  "SELECT * FROM quack_query('quack:127.0.0.1:1', 'SELECT 1')",
  "SELECT * FROM ducklake_cleanup_old_files('lake', cleanup_all => true)",
  "SELECT * FROM \"ducklake_expire_snapshots\" ('lake')",
  "SELECT * FROM ducklake_delete_orphaned_files /* c */ ('lake')",
  "SELECT * FROM lake.expire_snapshots(older_than => now())",
  "SELECT * FROM \"lake\" . cleanup_old_files (cleanup_all => true)",
  "SELECT * FROM lake.main.merge_adjacent_files()",
  "SELECT * FROM system_internal.anything()",
  "SELECT write_blob('x', 'y')",
  "SELECT write_log('forged')",
  "SELECT * FROM truncate_duckdb_logs()",
  "CALL enable_logging('Quack')",
  "SELECT * FROM read_parquet('abfss://ws@evil.example.com/f.parquet')",
  "SELECT * FROM 'az://account.blob.core.windows.net/c/f.parquet'",
  "SELECT * FROM ice_0123456789abcdef.dbo.t",
  "SELECT * FROM delta_0123456789abcdef.t",
  "",
  ";",
  "   ",
];
// One read each, however much they talk about writing.
const READS = [
  "SELECT 1",
  "SELECT * FROM ws.lh.dbo.t WHERE note = 'DELETE FROM t; DROP TABLE t'",
  "SELECT 'ducklake_cleanup_old_files(' AS a, 'query(' AS b, 'write_blob(' AS c",
  "SELECT \"delete\", \"copy\" FROM ws.lh.dbo.t",
  "SELECT 1 -- ; DELETE FROM t",
  "SELECT 1 /* ; COPY (SELECT 1) TO 'x' */",
  "SELECT $$; DROP TABLE t; $$ AS a",
  "WITH insert_log AS (SELECT 1 AS a) SELECT * FROM insert_log",
  "WITH x AS (SELECT 1 AS a), y AS (SELECT a FROM x) SELECT * FROM y",
  "FROM ws.lh.dbo.t SELECT a",
  "VALUES (1), (2)",
  "TABLE ws.lh.dbo.t",
  "DESCRIBE ws.lh.dbo.t",
  "SUMMARIZE ws.lh.dbo.t",
  "SHOW ALL TABLES",
  "(SELECT 1) UNION ALL (SELECT 2)",
  "EXPLAIN SELECT 1",
  "EXPLAIN ANALYZE SELECT 1",
  "EXPLAIN (ANALYZE, FORMAT json) SELECT 1",
  "SELECT ducklake_mart.dbo.t.a FROM ducklake_mart.dbo.t",
  "SELECT lake.a, snowflake.b(1) FROM t AS lake",
  "SELECT * FROM system_internal.ducklake_snapshot",
  "SELECT * FROM ws.lake.dbo.t",
  "SELECT 'lake.expire_snapshots(' AS note",
  "SELECT update_time, delete_flag, copy_count FROM ws.lh.dbo.t",
  "SELECT * FROM read_parquet('abfss://ws@onelake.dfs.fabric.microsoft.com/lh.Lakehouse/Files/x.parquet')",
  "SELECT 1;",
  "SELECT 1 ;  ",
];

// Ways to write the same statement, as DuckDB reads it: what is before it, after it, and its case.
const BEFORE = ["", " ", "\n\n", "\t", "/* c */ ", "/* /* nested */ */", "-- c\n", "-- c\r", "/**/", " ", "　\n", "﻿", "/* SELECT 1 */ ", "-- SELECT 1\n"];
const AFTER = ["", ";", " ;", ";;", " -- c", " /* c */", ";\n-- SELECT 1", "\n", "; "];
const CASES = [s => s, s => s.toUpperCase(), s => s.toLowerCase()];
const dressed = s => BEFORE.flatMap(b => AFTER.flatMap(a => CASES.map(c => `${b}${c(s)}${a}`)));

test("a statement that writes is refused however it is dressed", () => {
  let n = 0;
  for (const w of [...WRITES, ...TRICKY_WRITES]) {
    for (const d of dressed(w)) {
      assert.throws(() => assertReads(d), Error, `passed as a read: ${JSON.stringify(d)}`);
      n++;
    }
  }
  // A zero-width space is a space to DuckDB and no space to JavaScript: in front of a write it must not make a read of it.
  for (const w of WRITES) assert.throws(() => assertReads(`​${w}`), Error, w);
  assert.ok(n > 5000, `${n} spellings`);
});

test("a read that is more than a statement may be is refused however it is dressed", () => {
  for (const s of FORBIDDEN_READS.filter(x => x.trim() && x.trim() !== ";")) {
    for (const d of dressed(s)) assert.throws(() => assertReads(d), /Not run|is not a read/, `passed: ${JSON.stringify(d)}`);
  }
  for (const s of ["", ";", "   ", "\n", "-- only a comment", "/* only a comment */", ";;;"]) assert.throws(() => assertReads(s), /Not run/, JSON.stringify(s));
});

test("a read is a read however it is dressed, and whatever it says in its strings and comments", () => {
  for (const r of [...READS, ...TRICKY_READS]) {
    // An upper-cased $tag$ or E'' string is still its own: only what is before and after changes here.
    for (const b of BEFORE) for (const a of AFTER) {
      // A line comment after a read that ends in one would join them; a statement that ends in ';' takes no second one.
      if (/;\s*$/.test(r) && a.trim().startsWith(";")) continue;
      // Two ';' in a row is refused as two statements, the second empty: stricter than DuckDB, and not a way in.
      if (a.includes(";;")) continue;
      const d = `${b}${r}${a}`;
      assert.doesNotThrow(() => assertReads(d), `refused: ${JSON.stringify(d)}`);
    }
  }
});

test("a write put after a read, with any separator between them, never rides along", () => {
  for (const r of READS.filter(x => !/;\s*$/.test(x) && !/--|\/\*/.test(x))) {
    for (const w of WRITES.slice(0, 12)) {
      for (const sep of [";", " ; ", ";\n", "; ", "; -- c\n", "; /* c */ ", ";;", ";\r"]) {
        assert.throws(() => assertReads(`${r}${sep}${w}`), /Not run|is not a read/, `${JSON.stringify(r + sep + w)}`);
      }
    }
  }
});

test("a statement cut into its pieces: every piece of a selection is one statement, and none is lost", () => {
  if (typeof statementsOf !== "function") return;
  const pieces = statementsOf("SELECT 1; SELECT ';' AS a; /* ; */ SELECT 3 -- ;\n; SELECT $$;$$");
  const texts = pieces.map(p => (typeof p === "string" ? p : p.sql ?? p.text ?? String(p)));
  assert.equal(texts.length, 4, JSON.stringify(texts));
  for (const t of texts) assert.doesNotThrow(() => assertReads(t), JSON.stringify(t));
});

// --- names ---

const NAME_PIECES = ["a", "B", "z9", "_", " ", ".", "-", "\"", "\"\"", "`", "'", "$", "é", "日本", "select", "order", "(", ")", ";", "--", "/*", "*/", "\\", "\n", "\t", "%", "#", "@", " ", "Ω"];

test("property: a table's name written by sqlPart is read back as the same four parts, whatever is in them", () => {
  eachSeed(r => {
    // A first part with a letter in front: a name that begins with one of the engine's own catalogs is DuckDB's.
    const part = lead => lead + r.text(NAME_PIECES, 1 + r.int(5));
    const parts = [part("w"), part("i"), part("s"), part("t")];
    const name = parts.map(sqlPart).join(".");
    for (const statement of [`SELECT * FROM ${name}`, `SELECT 1 FROM x JOIN ${name} ON true`, `DESCRIBE ${name}`,
                             `SELECT '${name.replace(/'/g, "''")}' AS not_a_table, a FROM ${name} -- ${name.replace(/[\r\n]/g, " ")}`]) {
      const refs = tableRefs(statement).filter(x => x.table === parts[3] || x.workspace === parts[0]);
      assert.equal(refs.length, 1, `${JSON.stringify(statement)} -> ${JSON.stringify(tableRefs(statement))}`);
      const ref = refs[0];
      const item = ref.asLakehouse ?? ref.item;
      assert.deepEqual([ref.workspace, item, ref.schema, ref.table], parts, JSON.stringify(statement));
    }
  }, 1500);
});

test("property: no part can end its own quotes and say something else", () => {
  eachSeed(r => {
    const evil = r.text(["\"", "\"\"", ";", " ", "DROP TABLE t", "--", "/*", "'", "x", ".", "\n"], 2 + r.int(6));
    const quoted = sqlPart(evil);
    // Whatever was in it, the statement around it is still one read, and it names one table.
    const statement = `SELECT * FROM w.i.s.${quoted}`;
    assert.doesNotThrow(() => assertReads(statement), JSON.stringify(statement));
    const refs = tableRefs(statement);
    assert.equal(refs.length, 1, JSON.stringify([statement, refs]));
    assert.equal(refs[0].table, evil);
  }, 1500);
});

// --- random text ---

const TOKENS = ["SELECT", "FROM", "WHERE", "WITH", "AS", "INSERT", "INTO", "DELETE", "UPDATE", "COPY", "TO", "PIVOT", "ON", "USING", "EXPLAIN", "ANALYZE",
  "VALUES", "SET", "DROP", "TABLE", "(", ")", "(", ")", ";", ",", ".", "*", "=", "'", "''", "\"", "`", "$$", "$t$", "E'", "\\", "--", "/*", "*/", "\n", "\r",
  " ", " ", " ", " ", "​", "a", "t", "ws.lh.dbo.t", "1", "x'", "query", "ducklake_x", "quack_y", "abfss://", "@", "onelake.dfs.fabric.microsoft.com", "/Files/",
  "'ws.lh/Files/x.csv'", "é", "\u0000", "\ud83d", "ice_0123456789abcdef"];

test("fuzz: random SQL-shaped text is answered with an Error or with nothing, never with a mistake of the guard's own", () => {
  const started = Date.now();
  let passed = 0, refused = 0;
  eachSeed(r => {
    const text = r.text(TOKENS, 1 + r.int(40));
    for (const check of [assertReads, tableRefs, oneLakeScopes, sql.fileRefs, sql.statementsOf, sql.useOf, sql.readsOnly].filter(f => typeof f === "function")) {
      try { check(text); if (check === assertReads) passed++; }
      catch (e) {
        if (check === assertReads) refused++;
        assert.ok(e instanceof Error, `${check.name} threw a ${typeof e}`);
        assert.ok(!(e instanceof TypeError) && !(e instanceof RangeError) && !(e instanceof ReferenceError),
          `${check.name} failed on ${JSON.stringify(text)} with its own mistake: ${e.stack}`);
      }
    }
  }, 6000);
  assert.ok(Date.now() - started < 20_000, `took ${Date.now() - started} ms`);
  assert.ok(passed > 0 && refused > 0, `the text was varied enough to pass (${passed}) and to be refused (${refused})`);
});

test("a long statement is read in time linear in its length: no pattern here goes back over it", () => {
  const cases = {
    "open parentheses": "SELECT " + "(".repeat(200_000),
    "open comments": "SELECT 1 " + "/*".repeat(200_000),
    "quotes": "SELECT " + "'".repeat(200_001),
    "dollars": "SELECT " + "$a".repeat(100_000),
    "dots": "SELECT * FROM " + "a.".repeat(200_000) + "t",
    "urls": "SELECT " + "abfss://x@".repeat(40_000),
    "semicolons": "SELECT 1" + ";".repeat(200_000),
    "spaces before explain": "EXPLAIN " + " ".repeat(200_000) + "(",
  };
  for (const [what, text] of Object.entries(cases)) {
    const started = Date.now();
    for (const check of [assertReads, tableRefs, oneLakeScopes]) { try { check(text); } catch (e) { assert.ok(e instanceof Error); } }
    assert.ok(Date.now() - started < 4000, `${what}: ${Date.now() - started} ms for ${text.length} characters`);
  }
});

// --- what a database file keeps ---

test("a view, a macro or a column default kept in a file is held to what a statement may call, and the first that isn't is named", () => {
  const { storedFault } = sql;
  const of = (kind, body, name = "x") => storedFault([{ kind, schema: "main", name, body }]);
  assert.equal(storedFault([]), null);
  assert.equal(of("view", "CREATE VIEW x AS SELECT * FROM t;"), null);
  assert.equal(of("macro", "(a + b)"), null);
  assert.equal(of("column", "nextval('seq')"), null);
  assert.equal(of("view", "CREATE VIEW x AS SELECT 'ducklake_snapshots(''lake'')' AS note, 'query(' AS q;"), null, "said in a string, not called");
  for (const [kind, body] of [
    ["view", "CREATE VIEW x AS SELECT * FROM ducklake_snapshots('lake');"],
    ["view", "CREATE VIEW x AS SELECT * FROM DUCKLAKE_cleanup_old_files('lake', cleanup_all => true);"],
    ["view", "CREATE VIEW x AS SELECT * FROM lake.expire_snapshots(older_than => now());"],
    ["view", "CREATE VIEW x AS SELECT * FROM \"lake\".\"main\".cleanup_old_files();"],
    ["view", "CREATE VIEW x AS SELECT * FROM query('SELECT 1');"],
    ["view", "CREATE VIEW x AS SELECT * FROM json_execute_serialized_sql(json_serialize_sql('SELECT 1'));"],
    ["view", "CREATE VIEW x AS SELECT * FROM quack_query('quack:127.0.0.1:1', 'SELECT 1');"],
    ["view", "CREATE VIEW x AS SELECT * FROM read_parquet('abfss://ws@evil.example.com/f.parquet');"],
    ["macro", "SELECT * FROM query(s)"],
    ["macro", "write_blob(a, b)"],
    ["column", "write_log('x')"],
  ]) {
    const said = of(kind, body, "thing");
    assert.match(String(said), new RegExp(`^its ${kind} main\\.thing is not one a statement could be: `), `${body} -> ${said}`);
  }
  // One bad one among many good ones is found, wherever it is.
  const many = Array.from({ length: 500 }, (_, i) => ({ kind: "view", schema: "s", name: `v${i}`, body: `CREATE VIEW v${i} AS SELECT ${i};` }));
  many.splice(317, 0, { kind: "macro", schema: "s", name: "run", body: "SELECT * FROM query(s)" });
  assert.match(storedFault(many), /^its macro s\.run /);
});
