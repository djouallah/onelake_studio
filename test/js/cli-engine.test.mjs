// The command line with nothing stood in for but OneLake itself: the real bin/cli.mjs, bridge and
// agent, the real engine, dax-sql and YAML reader, over tables that answer with rows. This is the
// path a skill takes: list, read the model, run what it printed, compute a measure.
//
// Needs node_modules, DuckDB's extensions (scripts/fetch-extensions.mjs) and vendor/ (scripts/
// vendor.mjs), so CI runs it in the engine job, not in `npm test`.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { withAgent, csvRows } from "./cli-harness.mjs";

const require = createRequire(import.meta.url);
const { createEngineHost } = require("../../src/engine-host.js");
const { createAgent } = require("../../src/agent.js");
const { PINS } = require("../../src/vendored.js");
const { sqlName } = require("../../src/names.js");
const { EXIT } = require("../../src/bridge.js");

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const BUNDLED = join(ROOT, "duckdb-extensions");
const VENDOR = join(ROOT, "vendor");

// A Direct Lake model, as Fabric defines one: its tables are in a lakehouse named by GUIDs.
const LAKE = "https://onelake.dfs.fabric.microsoft.com/11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222";
const partition = table => [{ name: table, mode: "directLake",
  source: { type: "entity", entityName: table, schemaName: "dbo", expressionSource: "DatabaseQuery" } }];
const BIM = {
  compatibilityLevel: 1604,
  model: {
    defaultMode: "directLake",
    expressions: [{ name: "DatabaseQuery", kind: "m", expression: `let Source = AzureStorage.DataLake("${LAKE}") in Source` }],
    tables: [
      { name: "fct_sales", partitions: partition("fct_sales"),
        columns: [{ name: "customer_id", dataType: "int64", sourceColumn: "customer_id" },
                  { name: "amount", dataType: "double", sourceColumn: "amount" }],
        measures: [{ name: "Total Sales", expression: "SUM ( fct_sales[amount] )" },
                   { name: "Customer Count", expression: "DISTINCTCOUNT ( fct_sales[customer_id] )" }] },
      { name: "dim_customer", partitions: partition("dim_customer"),
        columns: [{ name: "customer_id", dataType: "int64", sourceColumn: "customer_id", isKey: true },
                  { name: "Region", dataType: "string", sourceColumn: "Region" }] },
    ],
    relationships: [{ name: "r", fromTable: "fct_sales", fromColumn: "customer_id", toTable: "dim_customer", toColumn: "customer_id" }],
  },
};

// The rows behind it: East sold 12.5 to one customer, West 5 to another.
const ROWS = {
  fct_sales: "SELECT * FROM (VALUES (1, 10.0::DOUBLE), (2, 5.0::DOUBLE), (1, 2.5::DOUBLE)) t(customer_id, amount)",
  dim_customer: "SELECT * FROM (VALUES (1, 'East'), (2, 'West')) t(customer_id, \"Region\")",
};

const dir = await mkdtemp(join(tmpdir(), "onelake-cli-engine-"));
const extDir = join(dir, "ext");
await mkdir(extDir);
const load = p => import(pathToFileURL(join(VENDOR, "npm", p)).href);
const { tmslToOssie } = await load(`${PINS.daxSql}/formats/ossie.js`);
const { stringify } = await load(`${PINS.yaml}/+esm.js`);
const modelFile = name => join(dir, `${name}.yaml`);
const OSSIE = stringify(tmslToOssie(BIM, "sales_model"));
for (const name of ["sales_model", "opened_model"]) await writeFile(modelFile(name), OSSIE);
await writeFile(modelFile("broken_model"), "datasets: [this is : not an ossie model");
// The same tables with no lakehouse behind them, as an Import model has none.
const IMPORT = { compatibilityLevel: 1604, model: { ...BIM.model, expressions: [], tables: BIM.model.tables.map(({ partitions, ...t }) => t) } };
await writeFile(modelFile("import_model"), stringify(tmslToOssie(IMPORT, "import_model")));

const engine = createEngineHost({
  extensionDir: extDir,
  bundledExtensions: existsSync(BUNDLED) ? BUNDLED : null,
  catalogTables: async () => [{ kind: "semanticmodel", workspace: "shop", model: "sales_model" }],
  resolveTable: async ref => {
    const sql = ROWS[ref.table.toLowerCase()];
    if (!sql) throw new Error(`there is no ${ref.kind} table ${ref.workspace}.${ref.item}.${ref.schema}.${ref.table}`);
    return { kind: ref.kind, workspace: ref.workspace, item: ref.item, schema: ref.schema, table: ref.table, emptySql: sql };
  },
});
after(async () => {
  await engine.close();
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

// What the extension keeps: the views the panel and the command line share.
const kept = new Map();
const semviews = {
  texts: async () => {
    const { readFile } = await import("node:fs/promises");
    return Promise.all([...kept.values()].map(async v => ({ ...v, text: await readFile(v.path, "utf8") })));
  },
  put: async (name, path, schema) => { kept.set(`${schema}/${name}`, { name, path, schema }); },
};

const at = Date.now() - 60_000;
const cached = v => ({ value: v, at });
const opened = [];
const queries = [];
const agent = createAgent({
  onelake: {
    cached: {
      workspaces: async () => cached(["shop"]),
      items: async () => cached([{ name: "data.Lakehouse", kind: "Lakehouse" }]),
      models: async () => cached([{ id: "m1", name: "sales_model", description: "" }]),
      tables: async () => cached(Object.keys(ROWS).map(table => ({ schema: "dbo", table }))),
      table: async () => null,
    },
  },
  semviews,
  engine: async () => ({
    agentQuery: (sql, o) => { const p = engine.agentQuery(sql, o); queries.push(p); return p; },
  }),
  modelPath: (ws, model) => modelFile(model),
  appDir: join(ROOT, "app"), vendorDir: VENDOR, daxSqlPin: PINS.daxSql, yamlPin: PINS.yaml,
  openModel: async ({ workspace, model }) => {
    opened.push(model);
    const { readFile } = await import("node:fs/promises");
    return { name: model, path: modelFile(model), text: await readFile(modelFile(model), "utf8"), schema: workspace };
  },
  nameTables: async list => list.map(x => sqlName({ kind: "lakehouse", workspace: "shop", item: "data", schema: x.schema, table: x.table })),
});
const REGIONS = 'SELECT dim_customer.Region, AGG("Total Sales") AS sales, AGG("Customer Count") AS customers ' +
                "FROM semanticmodel.shop.sales_model GROUP BY ALL ORDER BY 1";
const asRegions = rows => rows.map(([region, sales, customers]) => [region, Number(sales), Number(customers)]);
const EXPECTED = [["East", 12.5, 1], ["West", 5, 1]];

test("a query that names a model not open yet opens it, and answers", async () => {
  await withAgent(agent, async ({ cli }) => {
    const r = await cli(["sql", 'SELECT AGG("Total Sales") AS sales FROM semanticmodel.shop.opened_model', "--json"]);
    assert.equal(r.code, EXIT.OK, r.stdout);
    assert.deepEqual(opened, ["opened_model"]);
    assert.equal(Number(JSON.parse(r.stdout).rows[0][0]), 17.5);
  });
});

test("the skill's path: list, read the model, run what it printed, compute a measure", async () => {
  await withAgent(agent, async ({ cli }) => {
    // 1. A table's SQL name, as listed, is what SQL takes.
    let r = await cli(["ls", "shop", "data", "--json"]);
    assert.equal(r.code, EXIT.OK, r.stdout);
    const list = JSON.parse(r.stdout);
    const nameAt = list.columns.findIndex(c => c.name === "sql_name");
    const named = new Map(list.rows.map(row => [row[0], row[nameAt]]));
    r = await cli(["sql", `SELECT count(*) AS n FROM ${named.get("dbo.fct_sales")}`, "--csv"]);
    assert.equal(r.code, EXIT.OK, r.stderr);
    assert.deepEqual(csvRows(r.stdout), [["n"], ["3"]]);

    // 2. The model, every section of it, from the real Ossie file through the real compiler.
    r = await cli(["model", "shop", "sales_model", "--json"]);
    assert.equal(r.code, EXIT.OK, r.stdout);
    const model = JSON.parse(r.stdout);
    assert.equal(model.data.name, "semanticmodel.shop.sales_model");
    assert.equal(model.data.directLake, 2);
    assert.deepEqual(model.tables.relationships.rows, [["fct_sales[customer_id]", "dim_customer[customer_id]", true]]);
    const nameOf = t => { const i = t.columns.findIndex(c => c.name === "name"); return t.rows.map(row => row[i]); };
    assert.deepEqual(nameOf(model.tables.metrics).sort(), ["Customer Count", "Total Sales"]);
    assert.ok(nameOf(model.tables.dimensions).includes("Region"));
    const raw = model.tables.rawTables.rows.map(row => row[1]).sort();
    assert.deepEqual(raw, ["lakehouse.shop.data.dbo.dim_customer", "lakehouse.shop.data.dbo.fct_sales"]);

    // The same model, for a person to read.
    r = await cli(["model", "shop", "sales_model"]);
    assert.equal(r.code, EXIT.OK, r.stderr);
    for (const re of [/^# semanticmodel\.shop\.sales_model/m, /## Dimensions/, /## Metrics/, /## Raw tables/, /Total Sales/, /SUM/, /Example:/]) {
      assert.match(r.stdout, re);
    }

    // 3. The example it printed, comment and all, runs as printed: stdin, so no quoting.
    r = await cli(["sql", "-", "--json"], { stdin: model.data.example });
    assert.equal(r.code, EXIT.OK, `${model.data.example}\n${r.stdout}`);
    assert.deepEqual(JSON.parse(r.stdout).rows.map(([region, sales]) => [region, Number(sales)]), [["East", 12.5], ["West", 5]]);

    // 4. The measures, by a dimension: the numbers the rows say, in every format.
    r = await cli(["sql", REGIONS, "--csv"]);
    assert.equal(r.code, EXIT.OK, r.stderr);
    assert.deepEqual(asRegions(csvRows(r.stdout).slice(1)), EXPECTED);
    r = await cli(["sql", REGIONS, "--json"]);
    assert.deepEqual(asRegions(JSON.parse(r.stdout).rows), EXPECTED);
    r = await cli(["sql", REGIONS]);
    assert.match(r.stdout, /\| East \| 12\.5 \|/);
    assert.match(r.stdout, /2 row\(s\)$/m);

    // 5. Checking a measure against its raw table: the same total.
    r = await cli(["sql", `SELECT sum(amount) AS total FROM ${raw[1]}`, "--csv"]);
    assert.equal(Number(csvRows(r.stdout)[1][0]), 17.5);
  });
});

test("--show-sql: the SQL a model query compiles to, never inside a --csv", async () => {
  await withAgent(agent, async ({ cli }) => {
    let r = await cli(["sql", REGIONS, "--show-sql", "--csv"]);
    assert.equal(r.code, EXIT.OK, r.stderr);
    assert.deepEqual(asRegions(csvRows(r.stdout).slice(1)), EXPECTED, "the CSV parses as if it had not been asked");
    assert.match(r.stderr, /lakehouse\.shop\.data\.dbo\.fct_sales/);

    r = await cli(["sql", REGIONS, "--show-sql"]);
    assert.match(r.stdout, /^```sql\n[\s\S]*lakehouse\.shop\.data\.dbo\.fct_sales[\s\S]*```/);

    r = await cli(["sql", REGIONS, "--show-sql", "--json"]);
    assert.match(JSON.parse(r.stdout).data.sql, /lakehouse\.shop\.data\.dbo\.fct_sales/);

    // Plain SQL compiles to nothing: there is nothing to show.
    r = await cli(["sql", "SELECT 1 AS one", "--show-sql", "--csv"]);
    assert.equal(r.stdout, "one\n1\n");
  });
});

test("--csv and --json carry what the engine answered", async () => {
  await withAgent(agent, async ({ cli }) => {
    const sql = `SELECT 1 AS i, 'a,"b"' AS s, NULL::VARCHAR AS n, 1.5::DOUBLE AS f, TRUE AS b, 'two\nlines' AS l, DATE '2026-01-02' AS d`;
    let r = await cli(["sql", sql, "--csv"]);
    assert.equal(r.code, EXIT.OK, r.stderr);
    const [head, row] = csvRows(r.stdout);
    assert.deepEqual(head, ["i", "s", "n", "f", "b", "l", "d"]);
    assert.deepEqual(row.slice(0, 6), ["1", 'a,"b"', "", "1.5", "true", "two\nlines"]);
    assert.match(row[6], /^2026-01-02/);

    r = await cli(["sql", sql, "--json"]);
    const body = JSON.parse(r.stdout);
    assert.deepEqual(body.columns.slice(0, 5).map(c => c.type), ["INTEGER", "VARCHAR", "VARCHAR", "DOUBLE", "BOOLEAN"]);
    assert.deepEqual(body.rows[0].slice(0, 6), [1, 'a,"b"', null, 1.5, true, "two\nlines"]);
    assert.equal(body.cachedAt, null, "a query is not off the listing cache");

    r = await cli(["sql", "SELECT * FROM range(0) t(a)", "--csv"]);
    assert.equal(r.stdout, "a\n", "no rows: the header");
  });
});

test("SHOW ALL TABLES on the real engine: Markdown counts the columns, --json has them", async () => {
  await withAgent(agent, async ({ cli }) => {
    let r = await cli(["sql", "SHOW ALL TABLES"]);
    assert.equal(r.code, EXIT.OK, r.stderr);
    assert.match(r.stdout, /^\| database \| schema \| name \| columns \|$/m);
    assert.match(r.stdout, /^\| semanticmodel \| shop \| sales_model \| 1 \|$/m);
    assert.doesNotMatch(r.stdout, /column_names|VARCHAR/);

    r = await cli(["sql", "SHOW ALL TABLES", "--json"]);
    const { columns } = JSON.parse(r.stdout);
    assert.deepEqual(columns.map(c => c.name), ["database", "schema", "name", "column_names", "column_types", "temporary"]);
  });
});

test("NULL and an empty string stay apart on the real engine", async () => {
  await withAgent(agent, async ({ cli }) => {
    const sql = "SELECT NULL AS a, '' AS b";
    assert.match((await cli(["sql", sql])).stdout, /^\| NULL \|  \|$/m);
    assert.equal((await cli(["sql", sql, "--csv"])).stdout, 'a,b\n,""\n');
  });
});

test("past what a query keeps: --csv fails, --limit and --json say how many", async () => {
  await withAgent(agent, async ({ cli }) => {
    const big = "SELECT * FROM range(200001) t(a)";
    let r = await cli(["sql", big, "--csv"]);
    assert.equal(r.code, EXIT.FAILED);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /200,001 rows.*keeps 200,000/);

    r = await cli(["sql", big, "--csv", "--limit", "5"]);
    assert.equal(r.code, EXIT.OK, r.stderr);
    assert.equal(csvRows(r.stdout).length, 6);
    assert.match(r.stderr, /first 5 of 200001/);

    r = await cli(["sql", big, "--json"]);
    const body = JSON.parse(r.stdout);
    assert.equal(body.total, 200001);
    assert.equal(body.rows.length, 100);
    assert.equal(body.truncated, true);
  });
});

test("a statement that fails, or would write: exit 1, why on stderr, nothing on stdout", async () => {
  await withAgent(agent, async ({ cli }) => {
    for (const [sql, why] of [["SELECT * FORM t", /syntax error/i], ["SELECT * FROM nosuch", /nosuch/],
                              ["COPY (SELECT 1) TO 'x.csv'", /Read only/], ["SELECT 1; SELECT 2", /one statement at a time/]]) {
      const r = await cli(["sql", sql]);
      assert.equal(r.code, EXIT.FAILED, sql);
      assert.equal(r.stdout, "", sql);
      assert.match(r.stderr, why);
      assert.doesNotMatch(r.stderr, /^\s+at /m, `${sql}: a stack trace`);
    }
    const r = await cli(["sql", "SELEC 1", "--json"]);
    assert.equal(JSON.parse(r.stdout).error.code, "FAILED");
  });
});

test("a model file that does not parse: exit 1 and why, not a stack trace", async () => {
  await withAgent(agent, async ({ cli }) => {
    const r = await cli(["model", "shop", "broken_model"]);
    assert.equal(r.code, EXIT.FAILED);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /broken_model\.yaml/);
    assert.doesNotMatch(r.stderr, /^\s+at /m);
  });
});

test("a model table with no OneLake table is refused, never read by a shorter name", async () => {
  await withAgent(agent, async ({ cli }) => {
    const r = await cli(["sql", 'SELECT AGG("Total Sales") AS sales FROM semanticmodel.shop.import_model']);
    assert.equal(r.code, EXIT.FAILED, r.stdout);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /fct_sales is not a OneLake table, so it has no five-part name to read/);
  });
});

const SLOW = "SELECT sum(a) FROM range(1000000000000) t(a)";
const stopsSoon = async (query, what) => {
  const limit = new Promise((_, reject) => { setTimeout(() => reject(new Error(`${what}: the query is still running`)), 60_000).unref(); });
  await assert.rejects(Promise.race([query, limit]), e => !/still running/.test(e.message), what);
};

test("--timeout stops the query in the engine, not only the wait for it", async () => {
  await withAgent(agent, async ({ cli }) => {
    const before = queries.length;
    const r = await cli(["sql", SLOW, "--timeout", "2"]);
    assert.equal(r.code, EXIT.TIMEOUT, r.stderr);
    await stopsSoon(queries[before], "--timeout");
  });
});

test("a command line that is killed stops its query in the engine", async () => {
  await withAgent(agent, async ({ cli }) => {
    const before = queries.length;
    let child;
    const done = cli(["sql", SLOW], { onSpawn: c => { child = c; } });
    while (queries.length === before) await new Promise(res => setTimeout(res, 50));
    await new Promise(res => setTimeout(res, 1000));   // running, not still being prepared
    child.kill();
    await done;
    await stopsSoon(queries[before], "killed");
    // The engine is still there for the next question.
    const r = await cli(["sql", "SELECT 1 AS one", "--csv"]);
    assert.equal(r.stdout, "one\n1\n");
  });
});
