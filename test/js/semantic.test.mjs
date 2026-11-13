// page/semantic.js: which YAML in Files/ is an Apache Ossie model, and opens as one.
import { test } from "node:test";
import assert from "node:assert/strict";

const { isOssie, isOssiePath } = await import("../../page/semantic.js");

test("an Ossie model is told from any other YAML by its text", () => {
  const ossie = "# models/aac/model.bim as Apache Ossie\nversion: 0.2.0.dev0\nname: aac\ndatasets:\n  - name: dim_calendar\n";
  assert.equal(isOssie(ossie), true);
  assert.equal(isOssie("version: 2\nmodels:\n  - name: stg_orders\n"), false, "a dbt schema.yml is a document");
  assert.equal(isOssie("steps:\n  datasets:\n    - x\nversion: 1\n"), false, "datasets must be at the top level");
  assert.equal(isOssie(""), false);
});

test("a .yaml or .yml is read as Ossie, anything else as TMSL", () => {
  assert.equal(isOssiePath("Files/m/aac.yaml"), true);
  assert.equal(isOssiePath("abfss://ws@onelake.dfs.fabric.microsoft.com/lh/Files/A.YML"), true);
  assert.equal(isOssiePath("C:/models/ws/Sales.bim"), false);
});

test("only a statement about a semantic model waits for the views", async () => {
  const { aboutModels } = await import("../../page/semantic.js");
  for (const sql of ['SELECT AGG("x") FROM ws.m_semanticmodel', "SHOW SEMANTIC VIEWS", "show semantic metrics in ws.m_semanticmodel",
                     "DESCRIBE ws.m_semanticmodel"]) assert.equal(aboutModels(sql), true, sql);
  // Nor is a shorter name a model's.
  for (const sql of ["SHOW ALL TABLES;", "SELECT * FROM w.lh_lakehouse.dbo.t", "SELECT 1", "SELECT AGG(Total) FROM shop", "DESCRIBE ws.SHOP"]) {
    assert.equal(aboutModels(sql), false, sql);
  }
});

test("Explore's upper bound on a date takes in that whole day, on a timestamp too", async () => {
  const { modelSql, buildQuery } = await import("../../page/explore/explore.js");
  const column = id => (id === "t.d" ? { table: "t", name: "d", type: "date" } : id === "t.s" ? { table: "t", name: "s", type: "text" } : null);
  const where = (...w) => modelSql({ select: { d: "t.d" }, where: w }, column);
  assert.match(where(["t.d", "<=", "2026-01-31"]), /"?d"? < DATE '2026-02-01'/);
  assert.match(where(["t.d", "between", "2026-01-01", "2026-12-31"]), /"?d"? >= DATE '2026-01-01' AND .*"?d"? < DATE '2027-01-01'/);
  // A date in text is compared as text, and nothing else moves.
  assert.match(where(["t.s", "<=", "2026-01-31"]), /<= '2026-01-31'/);
  assert.match(where(["t.d", ">=", "2026-01-31"]), />= DATE '2026-01-31'/);
  // A column named as one of an object's own methods is a column.
  assert.ok(buildQuery({ rows: ["t.constructor"], cols: [], values: [], filters: [] }));
});

test("a visual asks for as many rows as the host's row limit, and Top N stays under it", async () => {
  const { buildQuery, setRowCap } = await import("../../page/explore/explore.js");
  const shelves = (extra = {}) => ({ rows: ["t.a"], cols: [], values: [], filters: [], ...extra });
  setRowCap(200000);
  assert.equal(buildQuery(shelves()).top, 200000);
  assert.equal(buildQuery(shelves({ top: 10 })).top, 10);
  setRowCap(3);
  assert.equal(buildQuery(shelves({ top: 10 })).top, 3);
  assert.equal(buildQuery(shelves(), { cap: 0 }).top, undefined, "the CSV asks for all of them");
  setRowCap(0);
  assert.equal(buildQuery(shelves()).top, 3, "no number keeps the last one");
  setRowCap(5000);
});

// A semantic model's one SQL name, and the ones a statement names that are not open yet.
test("a model is ws.model_semanticmodel, and a statement's unopened models are found", async () => {
  const { modelSqlName, unopenedModels, defineView } = await import("../../page/semantic.js");
  assert.equal(modelSqlName("a ws", "Sales"), '"a ws".Sales_semanticmodel');
  assert.deepEqual(unopenedModels('SELECT AGG(x) FROM "a ws"."Sales Model_semanticmodel" JOIN b.c_semanticmodel ON 1=1'),
    [{ workspace: "a ws", model: "Sales Model" }, { workspace: "b", model: "c" }]);
  // Each once; not in a string or a comment; a table's name is not a model's.
  assert.deepEqual(unopenedModels("SELECT * FROM w.m_semanticmodel, w . M_semanticmodel"), [{ workspace: "w", model: "m" }]);
  assert.deepEqual(unopenedModels("SELECT 'w.m_semanticmodel' -- w.m_semanticmodel\n/* w.m_semanticmodel */"), []);
  assert.deepEqual(unopenedModels("SELECT * FROM w.lh_lakehouse.dbo.t, w.lh_lakehouse.dbo.x_semanticmodel, x_semanticmodel"), []);
  // In the engine's catalog, where it is listed, it is the same model.
  assert.deepEqual(unopenedModels("SELECT * FROM memory.w.m_semanticmodel"), [{ workspace: "w", model: "m" }]);
  await assert.rejects(defineView("Sales", "Sales.bim", "{}"), /<workspace>\.<model>_semanticmodel: Sales has no workspace/);
});

test("Model's YAML colours a model's file and changes none of its text", async () => {
  const { prettyModelText, PRETTY_MAX } = await import("../../page/explore/pretty.js");
  const plain = html => html.replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
  const yaml = [
    "# a model",
    "name: nyc_taxi",
    "tables:",
    "  - name: 'fact & </script>'",
    "    rows: 12.5   # a comment",
    "    hidden: true",
    "    expression: |",
    "      CALCULATE(SUM(t[a]), t[b] = \"x: y\")",
    "",
    "      -- still the block",
    "    url: http://a#b\r",
    "  -",
  ].join("\n");
  const y = prettyModelText(yaml, "yaml");
  assert.equal(plain(y), yaml);
  assert.ok(!y.includes("</script>") && y.includes("&amp;"), "a value is escaped");
  assert.match(y, /<span class="tk-key">name<\/span>:/);
  assert.match(y, /<span class="tk-com"># a comment<\/span>/);
  assert.match(y, /<span class="tk-num">12\.5<\/span>/);
  assert.match(y, /<span class="tk-lit">true<\/span>/);
  assert.ok(!/tk-key">\s*CALCULATE/.test(y), "a block's lines are not keys");

  const bim = '{"model":{"name":"m","n":3,"ok":false,"x":null,"s":"a</script>\\"b"}}';
  const j = prettyModelText(bim, "bim");
  assert.equal(plain(j), JSON.stringify(JSON.parse(bim), null, 2));
  assert.ok(!j.includes("</script>"));
  assert.match(j, /<span class="tk-key">&quot;name&quot;<\/span>: <span class="tk-str">&quot;m&quot;<\/span>/);
  assert.match(j, /<span class="tk-num">3<\/span>/);
  assert.match(j, /<span class="tk-lit">false<\/span>/);

  // An integer past 2^53 would come back as another number: such a .bim is coloured as stored.
  const big = '{"id":12345678901234567890}';
  assert.equal(plain(prettyModelText(big, "bim")), big);

  assert.equal(prettyModelText("a: b\n".repeat(PRETTY_MAX / 5 + 1), "yaml"), null);
});

test("Model's YAML sets a custom_extensions block apart, line by line, and nothing after it", async () => {
  const { prettyModelText, extensionVendors } = await import("../../page/explore/pretty.js");
  const yaml = [
    "datasets:",
    "  - name: fct",
    "    fields:",
    "      - name: fare",
    "        datatype: Decimal",
    "        custom_extensions:",
    "          - vendor_name: POWER_BI",
    "            data: '{\"formatString\":\"#,##0.00\"}'",
    "      - name: id",
    "    metrics:",
    "      - name: total",
    "custom_extensions:",
    "- vendor_name: POWER_BI",
    "  data: '{}'",
    "version: 0.2.0.dev0",
  ].join("\n");
  const lines = prettyModelText(yaml, "yaml").split("\n");
  const ext = lines.map(l => l.startsWith('<span class="tk-ext">'));
  assert.deepEqual(ext, [false, false, false, false, false, true, true, true, false, false, false, true, true, true, false]);
  assert.match(lines[6], /^<span class="tk-ext">.*<span class="tk-key">vendor_name<\/span>.*<\/span>$/, "its own colours inside");
  assert.deepEqual(extensionVendors(yaml), ["POWER_BI"]);
  assert.deepEqual(extensionVendors("datasets: []\n"), []);
});

test("Model's YAML sets apart an expression in a dialect other than Ossie SQL, its whole item", async () => {
  const { prettyModelText, foreignDialects } = await import("../../page/explore/pretty.js");
  const yaml = [
    "metrics:",                              // 0
    "  - name: ytd",                         // 1
    "    expression:",                       // 2
    "      dialects:",                       // 3
    "        - dialect: DAX",                // 4  amber
    "          expression: |",               // 5  amber
    "            TOTALYTD([mw],",            // 6  amber
    "              'date'[date])",           // 7  amber
    "        - expression: SUM(mw)",         // 8  amber: its dialect comes after
    "          dialect: ANSI_SQL",           // 9  amber
    "        - dialect: OSSIE_SQL_2026",     // 10
    "          expression: SUM(mw)",         // 11
    "    datatype: Double",                  // 12
    "  - name: total",                       // 13
    "    expression:",                       // 14
    "      sql: SUM(mw)",                    // 15
    "    custom_extensions:",                // 16 amber, as before
    "      - vendor_name: POWER_BI",         // 17 amber
    "version: 0.2.0.dev0",                   // 18
  ].join("\n");
  const amber = prettyModelText(yaml, "yaml").split("\n").map((l, i) => (l.startsWith('<span class="tk-ext">') ? i : -1)).filter(i => i >= 0);
  assert.deepEqual(amber, [4, 5, 6, 7, 8, 9, 16, 17]);
  assert.deepEqual(foreignDialects(yaml), ["DAX", "ANSI_SQL"]);
  assert.deepEqual(foreignDialects("metrics:\n  - expression:\n      dialects:\n        - dialect: OSSIE_SQL_2026\n"), []);
});

test("a profile shows no planning or rows scanned it doesn't carry", async () => {
  const { parseProfile } = await import("../../page/explore/profile.js");
  // One timed run (the exported app's on a semantic model, modeldata.js): its time, and its operators' rows.
  const endpoint = parseProfile({ latency: 5.66, operator: [{ operator_name: "TOP", operator_timing: 5.66, operator_cardinality: 5000,
    children: [{ operator_name: "TABLE SCAN", operator_timing: 0, operator_cardinality: 100000, extra_info: { Table: "t" }, children: [] }] }] });
  assert.equal(endpoint.scanned, null);
  assert.equal(endpoint.planning, null);
  assert.equal(endpoint.rows, 5000);
  // DuckDB's, as app.js profileJson flattens 2.0's: both are there, as is a scan's 0.
  const duck = parseProfile({ latency: 0.036, planner: 0.0128, all_optimizers: 0.0032, physical_planner: 0.0005, cumulative_rows_scanned: 100000,
    operator: [{ operator_type: "TOP_N", operator_timing: 0.003, operator_cardinality: 5000,
      children: [{ operator_type: "TABLE_SCAN", operator_timing: 0.0096, operator_cardinality: 100000, operator_rows_scanned: 100000, children: [] }] }] });
  assert.equal(duck.scanned, 100000);
  assert.ok(duck.planning > 0);
  assert.equal(parseProfile({ planner: 0.001, operator: [{ operator_type: "TABLE_SCAN", operator_rows_scanned: 0, children: [] }] }).scanned, 0);
});

test("a profile's time is the clock's, not every thread's added up", async () => {
  const { parseProfile } = await import("../../page/explore/profile.js");
  // 3 s on 8 threads: the operators' times add up to 24 s.
  const p = parseProfile({ latency: 3, planner: 0.004, cumulative_rows_scanned: 0,
    operator: [{ operator_type: "HASH_GROUP_BY", operator_timing: 16, operator_cardinality: 293430,
      children: [{ operator_type: "TABLE_SCAN", operator_timing: 8, operator_cardinality: 591729858, operator_rows_scanned: 0, children: [] }] }] });
  assert.equal(p.total, 3000);
  assert.equal(Math.round(p.execution), 2996);
  assert.equal(Math.round(p.operators.reduce((s, o) => s + o.ms, 0)), 2996, "each operator its share of the execution");
  assert.deepEqual(p.operators.map(o => o.cpu), [8000, 16000], "and its threads' time kept");
  assert.equal(p.scanned, null, "a scan that passed rows on and says it read none: unknown");
});
