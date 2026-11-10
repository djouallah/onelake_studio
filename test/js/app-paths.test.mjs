// The panel's own page/paths.js — a separate copy from the website's, tested here.
import { test } from "node:test";
import assert from "node:assert/strict";

test("a never-written table gets an empty view typed from its Iceberg schema", async () => {
  const { emptyTableSql, icebergToDuckType } = await import("../../page/paths.js");
  assert.equal(icebergToDuckType("long"), "BIGINT");
  assert.equal(icebergToDuckType("decimal(10, 2)"), "DECIMAL(10,2)");
  assert.equal(icebergToDuckType("struct<a, b>"), "VARCHAR");
  assert.equal(emptyTableSql([{ name: "id", type: "long" }, { name: 'a"b', type: "string" }]),
    `SELECT CAST(NULL AS BIGINT) AS "id", CAST(NULL AS VARCHAR) AS "a""b" WHERE false`);
});

test("a SQL box says a file by its name, with its reader only where DuckDB needs one", async () => {
  const { fileSqlName, fileSource } = await import("../../page/paths.js");
  assert.equal(fileSqlName("aemo", "data.Lakehouse/Files/a/x.parquet"), "lakehouse.aemo.data/Files/a/x.parquet");
  assert.equal(fileSqlName("ANZ Retail", "select.Lakehouse/Files/a b.csv"), 'lakehouse."ANZ Retail"."select"/Files/a b.csv');
  assert.equal(fileSqlName("ws", "dw.Warehouse/Tables/x"), null);
  const name = "lakehouse.aemo.data/Files/x";
  for (const ext of ["parquet", "csv", "tsv", "json", "jsonl", "csv.gz"]) assert.equal(fileSource(ext, name), `'${name}'`, ext);
  assert.equal(fileSource("pq", name), `read_parquet(['${name}'])`);
  assert.equal(fileSource("xlsx", name), `read_xlsx('${name}')`);
  assert.equal(fileSource("avro", name), `read_avro('${name}')`);
  assert.ok(fileSource("log", name).includes(`read_csv('${name}'`), "a text file reads as lines");
  assert.equal(fileSource("csv", "lakehouse.a.b/Files/it's.csv"), "'lakehouse.a.b/Files/it''s.csv'");
});

const dbFixture = {
  alias: "shop",
  schemas: [{ id: "1", parent: null, name: "main" }, { id: "2", parent: null, name: "sales" },
            { id: "3", parent: "2", name: "emea" }, { id: "4", parent: null, name: "unused" }],
  objects: [
    { schema_id: "2", id: "v1", name: "all_orders", kind: "view", estimate: null, comment: null, sql: "CREATE VIEW" },
    { schema_id: "2", id: "t2", name: "Orders", kind: "table", estimate: 3, comment: "the orders", sql: "CREATE TABLE" },
    { schema_id: "2", id: "t1", name: "customers", kind: "table", estimate: 2, comment: null, sql: null },
    { schema_id: "3", id: "t3", name: "select", kind: "table", estimate: 0, comment: null, sql: null },
  ],
  columns: [
    { owner: "t1", name: "id", type: "INTEGER", nullable: false, dflt: null, comment: null },
    { owner: "t2", name: "id", type: "INTEGER", nullable: false, dflt: null, comment: null },
    { owner: "t2", name: "cust", type: "INTEGER", nullable: true, dflt: "3", comment: "who" },
  ],
  constraints: [
    { owner: "t2", type: "PRIMARY KEY", text: "PRIMARY KEY(id)", cols: '["id"]', ref: null },
    { owner: "t2", type: "FOREIGN KEY", text: "FOREIGN KEY (cust) REFERENCES customers(id)", cols: '["cust"]', ref: "customers" },
  ],
  indexes: [{ owner: "t2", name: "ix", sql: "CREATE INDEX ix" }],
};

test("a database file's catalog: schemas by their whole path, tables before views, names that run", async () => {
  const { dbCatalog, dbRowsText, dbCountSql } = await import("../../page/paths.js");
  const c = dbCatalog(dbFixture);
  assert.deepEqual(c.schemas.map(s => s.name), ["sales", "sales.emea"], "what holds nothing isn't listed");
  assert.deepEqual(c.schemas[0].objects.map(o => o.name), ["customers", "Orders", "all_orders"]);
  assert.deepEqual(c.objects.map(o => o.sqlName),
    ["shop.sales.customers", "shop.sales.Orders", "shop.sales.all_orders", 'shop.sales.emea."select"']);
  const orders = c.objects[1];
  assert.deepEqual(orders.columns.map(x => [x.name, x.pk, x.fk, x.nullable, x.dflt]),
    [["id", true, null, false, null], ["cust", false, "customers", true, "3"]]);
  assert.deepEqual(orders.constraints.map(x => x.type), ["PRIMARY KEY", "FOREIGN KEY"]);
  assert.deepEqual(orders.indexes, [{ name: "ix", sql: "CREATE INDEX ix" }]);
  assert.equal(dbRowsText(orders), "≈ 3", "an estimate says so");
  assert.equal(dbRowsText(c.objects[2]), "", "a view has no count");
  assert.equal(dbRowsText({ rows: 1234, rowsExact: true }), "1,234");
  const sqlite = dbCatalog({ ...dbFixture, estimated: false });
  assert.equal(sqlite.objects[0].rows, null, "SQLite's estimate means nothing");
  assert.equal(dbCountSql(c.objects.slice(0, 2)),
    "SELECT 't1' AS id, count(*) AS n FROM shop.sales.customers UNION ALL SELECT 't2' AS id, count(*) AS n FROM shop.sales.Orders");
});

test("a database file's tree: what is open, and what a filter keeps", async () => {
  const { dbCatalog, dbTreeRows } = await import("../../page/paths.js");
  const c = dbCatalog(dbFixture);
  const names = o => dbTreeRows(c, o).map(r => r.name);
  assert.deepEqual(names(), ["sales", "customers", "Orders", "all_orders", "sales.emea", "select"]);
  assert.deepEqual(names({ closed: new Set(["sales"]) }), ["sales", "sales.emea", "select"]);
  assert.deepEqual(names({ open: new Set(["t2"]) }), ["sales", "customers", "Orders", "id", "cust", "all_orders", "sales.emea", "select"]);
  assert.deepEqual(names({ filter: "ORDERS" }), ["sales", "Orders", "all_orders"], "any case, and a table's columns stay shut");
  assert.deepEqual(names({ filter: "cust", closed: new Set(["sales"]) }), ["sales", "customers", "Orders", "id", "cust"],
    "a column's match shows it, in a schema that was shut");
  assert.deepEqual(names({ filter: "nothing" }), []);
  assert.equal(dbTreeRows(c, { filter: "ORDERS" })[0].count, 2, "a schema counts what is on show");
});

test("a result past the cap says so: the host sends a count for the rows it stopped sending", async () => {
  const { rowCollector } = await import("../../page/paths.js");
  const fields = [{ name: "a", type: "BIGINT" }];
  const cut = rowCollector(2);
  cut.add({ fields, rows: [{ a: 1 }, { a: 2 }], numRows: 2 });
  cut.add({ fields, rows: [], numRows: 5 });
  assert.deepEqual(cut.result(), { fields: ["a"], types: ["BIGINT"], rows: [{ a: 1 }, { a: 2 }], numRows: 7, truncated: true, limit: 2 });

  const exact = rowCollector(2);
  exact.add({ fields, rows: [{ a: 1 }, { a: 2 }], numRows: 2 });
  assert.equal(exact.result().truncated, false, "exactly the cap is every row");

  const over = rowCollector(1);
  over.add({ fields, rows: [{ a: 1 }, { a: 2 }], numRows: 2 });
  assert.equal(over.result().rows.length, 1);
  assert.equal(over.result().truncated, true, "rows past the page's own cap are not kept");

  assert.deepEqual(rowCollector(2).result(), { fields: [], types: [], rows: [], numRows: 0, truncated: false, limit: 2 });
});

test("an answer says how old its tables are, once that is worth saying", async () => {
  const { ageNote } = await import("../../page/paths.js");
  const HOUR = 3_600_000, now = 100 * 24 * HOUR;
  assert.equal(ageNote(null, now), "", "no table read");
  assert.equal(ageNote(now - HOUR / 2, now), "", "within the hour");
  assert.equal(ageNote(now - HOUR, now), "tables as of 1 hour ago");
  assert.equal(ageNote(now - 14 * HOUR, now), "tables as of 14 hours ago");
  assert.equal(ageNote(now - 47 * HOUR, now), "tables as of 47 hours ago");
  assert.equal(ageNote(now - 72 * HOUR, now), "tables as of 3 days ago");
});

test("CSV quotes a cell holding a quote, a comma, or either line break", async () => {
  const { toCsv } = await import("../../page/paths.js");
  const rows = [{ a: 'x"y', b: "1,2" }, { a: "cr\rhere", b: "lf\nhere" }, { a: null, b: 3 }];
  assert.equal(toCsv(["a", "b"], rows),
    'a,b\r\n"x""y","1,2"\r\n"cr\rhere","lf\nhere"\r\n,3');
  assert.equal(toCsv(["a"], [{ a: 1 }], { eol: "\n" }), "a\n1");
});
