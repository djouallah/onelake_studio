// The native engine on its own: real @duckdb/node-api, no editor, no page, no OneLake.
// Needs node_modules (npm ci) and network for DuckDB's first
// INSTALL of iceberg/azure/httpfs — so CI runs it in its own job, not in `npm test`.
//
// Run: node --test test/engine-host.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { createEngineHost, isOneLakeMetadata } = require("../src/engine-host.js");

// What fetch-extensions.mjs put next to the extension, when CI ran it for this platform.
const BUNDLED = join(fileURLToPath(new URL(".", import.meta.url)), "..", "duckdb-extensions");

test("native engine host", async t => {
  const extDir = await mkdtemp(join(tmpdir(), "onelake-ext-"));
  const outside = await mkdtemp(join(tmpdir(), "onelake-outside-"));
  await writeFile(join(outside, "secret.csv"), "a\n1\n");
  const warnings = [];
  // Tables by SQL name, answered without OneLake: each one's view is a typed empty SELECT
  // (what a table nobody wrote to gets), here returning one row so the test can read it.
  const resolved = [];
  const resolveTable = async ref => {
    resolved.push(ref);
    if (ref.item.toLowerCase() === "missing") throw new Error(`there is no ${ref.kind} ${ref.item}`);
    return { kind: ref.kind, workspace: ref.workspace === "anz ws" ? "ANZ ws" : ref.workspace,
             item: ref.item, schema: ref.schema, table: ref.table,
             emptySql: `SELECT 7 AS answer, ${JSON.stringify(ref.table).replace(/"/g, "'")} AS t` };
  };
  // What the host's cache holds: listed in DuckDB's catalog without resolveTable ever asked.
  let cached = [
    { kind: "lakehouse", workspace: "cat1", item: "lh", schema: "dbo", table: "t", columns: [{ name: "a", type: "BIGINT" }] },
    { kind: "lakehouse", workspace: "Cat ws", item: "lh", schema: "dbo", table: "t",
      columns: [{ name: "b", type: "VARCHAR" }, { name: "c", type: "DECIMAL(10,2)" }] },
    { kind: "warehouse", workspace: "cat1", item: "wh", schema: "sales", table: "e",
      emptySql: "SELECT CAST(NULL AS INTEGER) AS id WHERE false" },
  ];
  const engine = createEngineHost({ extensionDir: extDir, onWarn: w => warnings.push(w), resolveTable,
                                    catalogTables: async () => cached,
                                    bundledExtensions: existsSync(BUNDLED) ? BUNDLED : null });
  t.after(async () => {
    await engine.close();
    await rm(extDir, { recursive: true, force: true }).catch(() => {});
  });

  const collect = async sql => {
    const batches = [];
    const res = await engine.call("stream", [sql], b => batches.push(b));
    return { res, batches };
  };

  await t.test("boots on DuckDB 2.0 with the required extensions", async () => {
    const r = await engine.call("query", ["SELECT version() AS v"]);
    assert.match(r.rows[0].v, /^v2\./, `running ${r.rows[0].v}`);
    const { capabilities: caps } = await engine.call("info");
    for (const ext of ["iceberg", "azure", "httpfs"]) assert.ok(caps[ext], `${ext} loaded`);
  });

  await t.test("a table is read by its SQL name, opened by the statement that names it", async () => {
    let r = await engine.call("query", ["SELECT answer, t FROM Lakehouse.aemo.data.dbo.dim_duid"]);
    assert.deepEqual(r.rows, [{ answer: 7, t: "dim_duid" }]);
    // Any case, quoted parts; the same view, made once.
    const before = resolved.length;
    r = await engine.call("query", ['SELECT count(*)::INT AS n FROM lakehouse.AEMO."data".DBO.Dim_Duid']);
    assert.equal(r.rows[0].n, 1);
    assert.equal(resolved.length, before + 1, "asked again — the snapshot may have moved");
    // A join across kinds and workspaces, a name with spaces, and DESCRIBE.
    r = await engine.call("query", ['SELECT a.t AS x, b.t AS y FROM Warehouse."anz ws".wh.sales.f a, MirroredDatabase.w.m.dbo.c b']);
    assert.deepEqual(r.rows, [{ x: "f", y: "c" }]);
    r = await engine.call("query", ['DESCRIBE Warehouse."ANZ ws".wh.sales.f']);
    assert.deepEqual(r.rows.map(x => x.column_name), ["answer", "t"]);
    // A stream, too.
    const { batches } = await collect("SELECT t FROM SQLDatabase.ws.db.dbo.t1");
    assert.equal(batches[0].rows[0].t, "t1");
    // What does not resolve says why.
    await assert.rejects(engine.call("query", ["SELECT * FROM Lakehouse.ws.missing.dbo.t"]), /there is no lakehouse missing/);
  });

  await t.test("the cached tables are DuckDB's catalog, each schema named by its whole path", async () => {
    const before = resolved.length;
    const ours = rows => rows.filter(r => /^(cat1|"Cat ws")\./.test(r.schema));
    let r = await engine.call("query", ["SHOW ALL TABLES;"]);
    assert.deepEqual(ours(r.rows).map(x => [x.database, x.schema, x.name, x.column_names, x.column_types]), [
      ["lakehouse", '"Cat ws".lh.dbo', "t", "['b', 'c']", "['VARCHAR', 'DECIMAL(10,2)']"],
      ["lakehouse", "cat1.lh.dbo", "t", "['a']", "['BIGINT']"],
      ["warehouse", "cat1.wh.sales", "e", "['id']", "['INTEGER']"],
    ]);
    r = await engine.call("query", ["show schemas"]);
    assert.ok(r.rows.some(x => x.database_name === "lakehouse" && x.schema_name === '"Cat ws".lh.dbo'), JSON.stringify(r.rows));
    r = await engine.call("query", ['SHOW TABLES FROM lakehouse."cat ws".LH.dbo']);
    assert.deepEqual(r.rows, [{ name: "t" }]);
    r = await engine.call("query", ["SELECT count(*)::INT AS n FROM information_schema.tables WHERE table_catalog = 'warehouse' AND table_name = 'e'"]);
    assert.equal(r.rows[0].n, 1);
    assert.equal(resolved.length, before, "listing the catalog asked OneLake nothing");
    // (A list crosses to the page as DuckDB writes it, jsonSafe.)
    // A cached table that is empty is its own truth; one that is not fails when a name the
    // engine cannot see reads it, rather than answering no rows.
    r = await engine.call("query", ["SELECT count(*)::INT AS n FROM query_table('warehouse.cat1.wh.sales.e')"]);
    assert.equal(r.rows[0].n, 0);
    await assert.rejects(engine.call("query", ["SELECT * FROM query_table('lakehouse.cat1.lh.dbo.t')"]), /is not open/);
    // Named, it is the real table, and stays it when the cache is listed again.
    r = await engine.call("query", ["SELECT answer FROM lakehouse.cat1.lh.dbo.t"]);
    assert.deepEqual(r.rows, [{ answer: 7 }]);
    engine.catalogChanged();
    r = await engine.call("query", ["SHOW ALL TABLES"]);
    assert.deepEqual(ours(r.rows).find(x => x.schema === "cat1.lh.dbo").column_names, "['answer', 't']");
    // A table the cache no longer holds leaves the catalog.
    cached = cached.filter(x => x.workspace !== "Cat ws");
    engine.catalogChanged();
    r = await engine.call("query", ["SHOW ALL TABLES"]);
    assert.deepEqual(ours(r.rows).map(x => x.schema), ["cat1.lh.dbo", "cat1.wh.sales"]);
  });

  await t.test("a statement needs no Microsoft account", async () => {
    const r = await engine.call("query", ["SELECT 42 AS answer"]);
    assert.equal(r.rows[0].answer, 42);
    assert.equal(r.fields[0].name, "answer");
  });

  await t.test("an empty result still carries its schema", async () => {
    const { batches } = await collect("SELECT 1 AS a, 'x' AS b WHERE false");
    assert.equal(batches.length, 1);
    assert.deepEqual(batches[0].fields.map(f => f.name), ["a", "b"]);
    assert.equal(batches[0].numRows, 0);
  });

  await t.test("rows come back in insertion order", async () => {
    const r = await engine.call("query", ["SELECT * FROM (VALUES (3), (1), (2)) t(x)"]);
    assert.deepEqual(r.rows.map(x => x.x), [3, 1, 2]);
  });

  await t.test("past the row cap the host counts, it does not convert", async () => {
    const { res, batches } = await collect("SELECT range AS i FROM range(250000)");
    const kept = batches.reduce((n, b) => n + b.rows.length, 0);
    const counted = batches.reduce((n, b) => n + b.numRows, 0);
    assert.equal(res.numRows, 250000, "the stream reports the true total");
    assert.equal(counted, 250000, "…and so do the batches' numRows");
    assert.equal(kept, 200000, "but only the cap's worth of rows crossed");
    assert.equal(batches[0].rows[0].i, 0, "BIGINT that fits a double arrives as a number");
  });

  await t.test("a cancelled query stops, and the engine stays usable", async () => {
    const slow = collect("SELECT count(*) FROM range(10000000000) a");
    await new Promise(r => setTimeout(r, 300));
    await engine.call("cancel");
    await assert.rejects(slow, /interrupt/i);
    const r = await engine.call("query", ["SELECT 1 AS ok"]);
    assert.equal(r.rows[0].ok, 1);
  });

  await t.test("a bearer token never comes back in an error message", async () => {
    const fake = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJzb21lb25lIn0.c2lnbmF0dXJlc2lnbmF0dXJl";
    await assert.rejects(engine.call("query", [`SELECT '${fake}'::INTEGER`]), e => {
      assert.ok(!e.message.includes(fake), e.message);
      assert.match(e.message, /<token>/);
      return true;
    });
  });

  await t.test("bundled extensions load from the package, not the network", async () => {
    if (!existsSync(BUNDLED)) return t.skip("no bundled extensions (run fetch-extensions.mjs)");
    const fromRepo = warnings.filter(w => /bundled '.*' would not load/.test(w));
    assert.deepEqual(fromRepo, [], fromRepo.join(" | "));
    const r = await engine.call("query", [
      "SELECT extension_name AS n, install_path AS p FROM duckdb_extensions() WHERE loaded AND extension_name IN ('iceberg','azure','httpfs','avro')"]);
    assert.equal(r.rows.length, 4, JSON.stringify(r.rows));
  });

  await t.test("the lockdown: no local file outside the engine's own directories", async () => {
    const p = join(outside, "secret.csv").replace(/\\/g, "/");
    await assert.rejects(engine.call("query", [`SELECT * FROM read_csv('${p}')`]), /Permission|disabled by configuration/i,
      "reading a file the page has no business with is refused");
    await assert.rejects(engine.call("query", [`COPY (SELECT 1) TO '${join(outside, "out.csv").replace(/\\/g, "/")}'`]),
      /Read only|Permission|disabled by configuration/i, "and so is writing one");
    await assert.rejects(engine.call("query", [`SELECT * FROM read_csv('${join(outside, "..", "x.csv").replace(/\\/g, "/")}')`]),
      /Permission|disabled by configuration|No files found/i, "dot-dot does not climb out");
  });

  await t.test("zip:// reaches remote archives only, never a local one", async () => {
    const zip = join(outside, "local.zip").replace(/\\/g, "/");
    await assert.rejects(engine.call("query", [`SELECT * FROM read_csv('zip://${zip}/x.csv')`]),
      /Permission|disabled by configuration/i);
  });

  await t.test("the lockdown cannot be turned off from SQL", async () => {
    await assert.rejects(engine.call("query", ["SET enable_external_access = true"]), /Read only|lock/i);
    await assert.rejects(engine.call("query", ["SET allowed_directories = ['/']"]), /Read only|lock/i);
  });

  await t.test("a file the host copied in reads, from the engine's temp directory", async () => {
    const path = await engine.copyToTemp("ws/lh/Files/n.csv", Buffer.from("a\n40\n2\n"));
    const r = await engine.call("query", [`SELECT sum(a) AS s FROM read_csv('${path}')`]);
    assert.equal(r.rows[0].s, 42);
    assert.equal(await engine.copyToTemp("ws/lh/Files/n.csv", Buffer.from("ignored")), path,
      "one copy per file per session");
  });

  await t.test("the page reaches only query, stream, cancel and info", async () => {
    for (const m of ["openTable", "copyToTemp", "registerFileBuffer", "constructor", "__proto__"]) {
      await assert.rejects(engine.call(m, []), /unknown engine method/, `${m} is not a page method`);
    }
  });

  await t.test("a closed engine stays closed", async () => {
    const other = createEngineHost({ extensionDir: extDir });
    await other.call("query", ["SELECT 1"]);
    await other.close();
    await assert.rejects(other.call("query", ["SELECT 1"]), /closed/);
  });
});

// The metadata location arrives from the page and is spliced into iceberg_scan(...), so
// only the shape the catalog returns may pass; everything else takes the ATTACH path.
test("only a OneLake metadata.json is read with iceberg_scan", () => {
  assert.ok(isOneLakeMetadata(
    "abfss://ws@onelake.dfs.fabric.microsoft.com/lh.Lakehouse/Tables/dbo/t/metadata/00001-ab.metadata.json"));
  // A workspace named with spaces gets name-based paths with them, and they read fine.
  assert.ok(isOneLakeMetadata(
    "abfss://ANZ Retail Demo@onelake.dfs.fabric.microsoft.com/lh_contoso.Lakehouse/Tables/dbo/date/metadata/v3.metadata.json"));
  for (const bad of [
    "abfss://ws@onelake.dfs.fabric.microsoft.com/lh/Tables/t/metadata/v1.metadata.json\nATTACH 'x'; --.metadata.json",
    null, "", 42,
    "file:///etc/passwd.metadata.json",
    "https://onelake.dfs.fabric.microsoft.com/ws/lh.Lakehouse/Tables/t/metadata/v1.metadata.json",
    "abfss://ws@evil.example.com/x/v1.metadata.json",
    "abfss://ws@onelake.dfs.fabric.microsoft.com/lh/Tables/t/metadata/v1.metadata.json') ; DROP TABLE x; --",
    "abfss://ws@onelake.dfs.fabric.microsoft.com/lh/Tables/t/data/part.parquet",
  ]) assert.equal(isOneLakeMetadata(bad), false, String(bad));
});
