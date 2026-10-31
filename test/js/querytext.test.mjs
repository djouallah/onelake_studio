// querytext.js: the statements of the SQL box's text, where DuckDB's error points, and the
// dotted name being typed.
import { test } from "node:test";
import assert from "node:assert/strict";

const q = await import("../../app/querytext.js");
const texts = (t, list) => list.map(s => t.slice(s.start, s.end));

test("statements split on ';' outside quotes and comments, each from its first code", () => {
  const t = "-- hi\nSELECT 1;\n\nSELECT ';' AS x -- ;\n FROM t;\n/* only; a comment */;\n  SELECT $$a;b$$, \"c;d\"";
  assert.deepEqual(texts(t, q.statements(t)), ["SELECT 1", "SELECT ';' AS x -- ;\n FROM t", "SELECT $$a;b$$, \"c;d\""]);
  assert.deepEqual(q.statements("  \n-- nothing\n"), []);
  assert.deepEqual(texts("SELECT 'it''s; fine'", q.statements("SELECT 'it''s; fine'")), ["SELECT 'it''s; fine'"]);
});

test("the cursor's statement: the one it is in, else the one just before it", () => {
  const t = "SELECT 1;\nSELECT 2;\n";
  const list = q.statements(t);
  assert.equal(t.slice(...Object.values(q.statementAt(list, 3))), "SELECT 1");
  assert.equal(t.slice(...Object.values(q.statementAt(list, t.indexOf("SELECT 2") + 2))), "SELECT 2");
  assert.equal(t.slice(...Object.values(q.statementAt(list, t.length))), "SELECT 2");
  assert.equal(q.statementAt([], 0), null);
});

test("DuckDB's LINE/caret is found in the statement as written, comments and all", () => {
  const msg = 'Parser Error: syntax error at or near "FORM"\n\nLINE 1: SELECT * FORM t\n                 ^';
  const sql = "-- a comment the page drops\nSELECT * FORM t";
  assert.equal(sql.slice(q.errorOffset(msg, sql)), "FORM t");
  // A long line is cut to a window: "..." at its start does not count.
  const cut = `Binder Error: no\n\nLINE 1: ...prefix SELECT nope FROM t\n${" ".repeat("LINE 1: ...prefix SELECT ".length)}^`;
  const long = "SELECT 1 AS a very long prefix SELECT nope FROM t";
  assert.equal(long.slice(q.errorOffset(cut, long)), "nope FROM t");
  assert.equal(q.errorOffset("Catalog Error: Table x does not exist", "SELECT * FROM x"), null);
  assert.equal(q.errorOffset(msg, "SELECT something else"), null);
});

test("query variables: SET VARIABLE is kept, getvariable() is bound, a typed value is quoted", () => {
  assert.deepEqual(q.setVariable("SET VARIABLE year = 2024;"), { name: "year", value: "2024" });
  assert.deepEqual(q.setVariable("set variable \"my v\" TO DATE '2024-01-01'"), { name: "my v", value: "DATE '2024-01-01'" });
  assert.equal(q.setVariable("SELECT 1"), null);
  // A selection of a SET and a query is not a SET; a comment is not part of the value.
  assert.equal(q.setVariable("SET VARIABLE x = 1;\nSELECT getvariable('x') AS v"), null);
  assert.deepEqual(q.setVariable("SET VARIABLE y = 2024 -- the year"), { name: "y", value: "2024" });
  assert.deepEqual(q.setVariable("SET VARIABLE s = '-- not a comment' /* note */;"), { name: "s", value: "'-- not a comment'" });
  assert.deepEqual(q.variablesIn("SELECT getvariable('year'), GETVARIABLE( 'Year' ), getvariable('it''s')"), ["year", "it's"]);
  assert.equal(q.bindVariables("WHERE y = getvariable('Year') AND n = getvariable('none')", new Map([["year", "2024"]])),
    "WHERE y = (2024) AND n = getvariable('none')");
  assert.deepEqual(["42", "-1.5e3", "abc", "'x'", "o'k", "NULL"].map(q.literal), ["42", "-1.5e3", "'abc'", "'x'", "'o''k'", "NULL"]);
});
