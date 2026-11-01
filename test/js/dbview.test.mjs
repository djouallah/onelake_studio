// dbview.js: the two cards a database file's tree opens. Names come from a file, so what matters
// most is that they stay text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dbObjectHtml, dbOverviewHtml } from "../../app/dbview.js";
import { dbCatalog } from "../../app/paths.js";

const EVIL = `<img src=x onerror="alert(1)">`;
const catalog = dbCatalog({
  alias: "shop",
  schemas: [{ id: "1", parent: null, name: EVIL }],
  objects: [
    { schema_id: "1", id: "t", name: EVIL, kind: "table", estimate: 2, comment: EVIL, sql: `CREATE TABLE ${EVIL}` },
    { schema_id: "1", id: "v", name: "plain", kind: "view", estimate: null, comment: null, sql: null },
  ],
  columns: [{ owner: "t", name: EVIL, type: EVIL, nullable: true, dflt: EVIL, comment: EVIL }],
  constraints: [{ owner: "t", type: "CHECK", text: EVIL, cols: "[]", ref: null }],
  indexes: [{ owner: "t", name: EVIL, sql: EVIL }],
});
const info = { engine: "DuckDB", size: "1 KB", alias: "shop" };

test("nothing from the file reaches the page as markup", () => {
  for (const html of [dbOverviewHtml(catalog, info), dbObjectHtml(catalog.objects[0])]) {
    assert.ok(!html.includes("<img"), html);
    assert.ok(html.includes("&lt;img"), html);
  }
});

test("the overview says what the file holds, and a name opens its table", () => {
  const html = dbOverviewHtml(catalog, info);
  for (const fact of ["DuckDB", "1 KB", "shop"]) assert.ok(html.includes(fact), fact);
  assert.match(html, /data-object="1">plain</);
  assert.match(html, /≈ 2/);
  assert.match(html, /Rows/);
  assert.match(dbOverviewHtml(dbCatalog({ alias: "e", schemas: [], objects: [], columns: [] }), info), /holds no tables or views/);
});

test("a card leaves out what its table doesn't have", () => {
  const view = dbObjectHtml(catalog.objects[1]);
  for (const absent of ["Rows", "Constraints", "Indexes", "Definition", "<h3>Columns"]) assert.ok(!view.includes(absent), absent);
  const table = dbObjectHtml(catalog.objects[0]);
  for (const present of ["Rows", "estimate", "Constraints", "Indexes", "Definition", "<h3>Columns", "Default", "Comment"]) {
    assert.ok(table.includes(present), present);
  }
  const noKey = dbObjectHtml({ ...catalog.objects[0], comment: null, columns: [{ name: "a", type: "INT", nullable: false, dflt: null, comment: null, pk: false, fk: null }] });
  for (const absent of ["<th>Default", "<th>Key", "<th>Comment"]) assert.ok(!noKey.includes(absent), absent);
  assert.match(noKey, /<td>no<\/td>/);
});
