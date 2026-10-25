// Tests for site/semantic.js: what a .bim's model is called, where its Direct Lake tables
// are read from, and which queries are compiled and which are left alone. The compiler is
// a stand-in here (npm test runs offline); test/run-semantic-smoke.mjs runs the real one.

import { test } from "node:test";
import assert from "node:assert/strict";

import { modelName, directLakeTables, registerModel, rewrite, tablesFor } from "../site/semantic.js";

const WS = "11111111-2222-3333-4444-555555555555";
const LH = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const BIM = {
  model: {
    expressions: [{ name: "DatabaseQuery", kind: "m",
      expression: ["let", `    Source = AzureStorage.DataLake("https://onelake.dfs.fabric.microsoft.com/${WS}/${LH}", [HierarchicalNavigation=true])`, "in Source"] }],
    tables: [
      { name: "Sales", partitions: [{ mode: "directLake", source: { type: "entity", entityName: "fact_sales", schemaName: "mart", expressionSource: "DatabaseQuery" } }] },
      { name: "Region", partitions: [{ mode: "directLake", source: { type: "entity", entityName: "Region", expressionSource: "DatabaseQuery" } }] },
      { name: "Imported", partitions: [{ source: { type: "m", expression: "..." } }] },
    ],
  },
};

// Enough of dax-sql's surface to drive semantic.js: compileStatement names every table
// through tableSource, as the real compiler does.
const stub = {
  tmslToModel: bim => bim,
  createCompiler: (bim, { tableSource }) => {
    const tables = new Map(bim.model.tables.map(t => [t.name.toLowerCase(), {
      name: t.name, columns: [{ name: "Name", type: "string" }],
      source: { schema: t.partitions[0].source.schemaName ?? null, entity: t.partitions[0].source.entityName ?? t.name } }]));
    return {
      model: { tables, measures: new Map(), state: () => null, reaches: () => true },
      compileStatement: (sql, name) => ({
        sql: /region/i.test(sql) ? `SELECT * FROM ${tableSource(tables.get("region"))}`
                                 : `SELECT * FROM ${tableSource(tables.get("sales"))} JOIN ${tableSource(tables.get("imported"))}`,
      }),
    };
  },
};

test("a model is named after its file, as a bare identifier", () => {
  assert.equal(modelName("nem.bim"), "nem");
  assert.equal(modelName("dax_sql_test/nem.bim"), "nem");
  assert.equal(modelName("Sales Model.bim"), "Sales_Model");
  assert.equal(modelName("2024.bim"), "_2024");
});

test("Direct Lake tables: the item the expression names, the partition's schema and entity", () => {
  const t = directLakeTables(BIM);
  assert.equal(t.size, 2);
  assert.deepEqual(t.get("sales"), {
    lh: { workspace: WS, item: LH }, t: { schema: "mart", table: "fact_sales" },
    viewSchema: "mart_aaaaaaaa", ident: '"mart_aaaaaaaa"."fact_sales"' });
  // No schemaName: OneLake's schema-less lakehouses answer as dbo.
  assert.deepEqual(t.get("region").t, { schema: "dbo", table: "Region" });
  assert.equal(t.get("imported"), undefined);
  assert.equal(directLakeTables({ model: { tables: [] } }).size, 0);
});

test("a query that names the model is compiled, and opens only the tables it reads", async () => {
  const m = await registerModel("Files/models/nem.bim", JSON.stringify(BIM), stub);
  assert.equal(m.name, "nem");
  assert.equal(m.directLake, 2);

  const one = rewrite("SELECT Region.Name, AGG(x) FROM nem GROUP BY ALL -- region");
  assert.equal(one.sql, 'SELECT * FROM "dbo_aaaaaaaa"."Region"');
  assert.deepEqual(one.tables.map(x => x.ident), ['"dbo_aaaaaaaa"."Region"']);

  // A table that is not Direct Lake is the model's own source name, and nothing to open.
  const two = rewrite('SELECT AGG(x) FROM "nem"');
  assert.equal(two.sql, 'SELECT * FROM "mart_aaaaaaaa"."fact_sales" JOIN "Imported"');
  assert.deepEqual(two.tables.map(x => x.t), [{ schema: "mart", table: "fact_sales" }]);
});

test("tablesFor: the Direct Lake tables a compiled SQL reads, once each", () => {
  const sql = 'SELECT * FROM "dbo_aaaaaaaa"."Region" r JOIN "dbo_aaaaaaaa"."Region" s USING (Name)';
  assert.deepEqual(tablesFor(sql).map(x => x.t), [{ schema: "dbo", table: "Region" }]);
  assert.deepEqual(tablesFor("SELECT 1"), []);
});

test("every other query is left alone", () => {
  assert.equal(rewrite("SELECT 42"), null);
  assert.equal(rewrite("SELECT * FROM nem_bim"), null);   // the .bim file's own view
  assert.equal(rewrite("SELECT 1 -- about nem"), null);
});

test("DESCRIBE lists the model's fields without compiling anything", () => {
  const d = rewrite("DESCRIBE nem;");
  assert.deepEqual(d.tables, []);
  assert.match(d.sql, /^SELECT \* FROM \(VALUES/);
  assert.match(d.sql, /'Sales\.Name', 'VARCHAR', 'column'/);
});

test("a .bim that is not JSON says so", async () => {
  await assert.rejects(registerModel("bad.bim", "{nope", stub), /bad\.bim is not a TMSL model/);
});
