// The native engine on its own: real @duckdb/node-api, no editor, no page, no OneLake.
// Needs node_modules (npm ci) and network for DuckDB's first
// INSTALL of iceberg/azure/httpfs — so CI runs it in its own job, not in `npm test`.
//
// Run: node --test test/js/engine-host.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { createEngineHost, isOneLakeMetadata } = require("../../src/engine-host.js");

// What fetch-extensions.mjs put next to the extension, when CI ran it for this platform.
const BUNDLED = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "duckdb-extensions");

test("warm() boots the engine and lists the catalog ahead of the first statement", async t => {
  const extDir = await mkdtemp(join(tmpdir(), "onelake-ext-"));
  let listings = 0;
  const seen = [];
  const warnings = [];
  const engine = createEngineHost({
    extensionDir: extDir,
    bundledExtensions: existsSync(BUNDLED) ? BUNDLED : null,
    onCatalog: m => seen.push(m),
    onWarn: w => warnings.push(w),
    catalogTables: async () => {
      listings++;
      return [
        { kind: "lakehouse", workspace: "w", item: "lh", schema: "dbo", table: "bad", emptySql: "SELECT FROM WHERE (" },
        { kind: "lakehouse", workspace: "w", item: "lh", schema: "dbo", table: "t", columns: [{ name: "a", type: "BIGINT" }] },
      ];
    },
  });
  t.after(async () => {
    await engine.close();
    await rm(extDir, { recursive: true, force: true }).catch(() => {});
  });

  await engine.warm();
  assert.equal(listings, 1);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].count, 2);
  const r = await engine.call("query", ["SHOW ALL TABLES"]);
  assert.deepEqual(r.rows.map(x => [x.schema, x.name]), [["w.lh.dbo", "t"]], "a bad entry costs only itself");
  assert.equal(warnings.filter(w => /bad could not be listed/.test(w)).length, 1, warnings.join(" | "));
  assert.equal(listings, 1, "the statement found the catalog already listed");
});

test("offline with no disk cache: a read of OneLake is refused at once, and the rest of the catalog still answers", async t => {
  const extDir = await mkdtemp(join(tmpdir(), "onelake-ext-"));
  let reason = "no internet";
  const METADATA = "abfss://ws@onelake.dfs.fabric.microsoft.com/lh.Lakehouse/Tables/dbo/t/metadata/1.metadata.json";
  const engine = createEngineHost({
    extensionDir: extDir,
    bundledExtensions: existsSync(BUNDLED) ? BUNDLED : null,
    offlineReason: () => reason,
    catalogTables: async () => [{ kind: "lakehouse", workspace: "w", item: "lh", schema: "dbo", table: "t", columns: [{ name: "a", type: "BIGINT" }] }],
    resolveTable: async ref => (ref.table === "never_written"
      ? { ...ref, emptySql: "SELECT 1 AS a WHERE false" }
      : { ...ref, metadataLocation: METADATA }),
  });
  t.after(async () => {
    await engine.close();
    await rm(extDir, { recursive: true, force: true }).catch(() => {});
  });

  const t0 = Date.now();
  await assert.rejects(engine.call("query", ["SELECT * FROM lakehouse.w.lh.dbo.t"]),
    /lakehouse\.w\.lh\.dbo\.t: reading rows needs OneLake, and there is no internet/);
  await assert.rejects(engine.call("query", [`SELECT * FROM '${METADATA.replace("metadata/1.metadata.json", "x.parquet")}'`]),
    /This statement: reading rows needs OneLake/);
  reason = "not signed in";
  await assert.rejects(engine.call("query", ["SELECT * FROM lakehouse.w.lh.dbo.t"]), /you are not signed in/);
  const batches = [];
  await assert.rejects(engine.call("stream", ["SELECT * FROM lakehouse.w.lh.dbo.t"], b => batches.push(b)), /reading rows needs OneLake/);
  assert.ok(Date.now() - t0 < 20000, "refused, not timed out");

  const r = await engine.call("query", ["SHOW ALL TABLES"]);
  assert.deepEqual(r.rows.map(x => x.name), ["t"]);
  assert.equal((await engine.call("query", ["SELECT 42 AS a"])).rows[0].a, 42);
  // A OneLake URL that is only a value, as a model's path is in SHOW SEMANTIC VIEWS.
  const url = "abfss://w@onelake.dfs.fabric.microsoft.com/lh.Lakehouse/Files/m.bim";
  for (const sql of [`SELECT '${url}' AS path`, `SELECT * FROM (VALUES ('${url}'), ('x')) t(path)`]) {
    assert.equal((await engine.call("query", [sql])).rows[0].path, url, sql);
  }
  assert.deepEqual((await engine.call("query", ["SELECT * FROM lakehouse.w.lh.dbo.never_written"])).rows, []);
});

const CACHE_BUILD = join(BUNDLED, "cache_httpfs.duckdb_extension");

test("offline with the disk cache: what it doesn't keep says so at once, with nothing sent", { skip: !existsSync(CACHE_BUILD) }, async t => {
  const extDir = await mkdtemp(join(tmpdir(), "onelake-ext-"));
  const cacheDir = await mkdtemp(join(tmpdir(), "onelake-cache-"));
  const METADATA = "abfss://ws@onelake.dfs.fabric.microsoft.com/lh.Lakehouse/Tables/dbo/t/metadata/1.metadata.json";
  const engine = createEngineHost({
    extensionDir: extDir,
    bundledExtensions: BUNDLED,
    fileCacheDir: cacheDir,
    fileCacheMaxBytes: 1024 ** 3,
    offlineReason: () => "no internet",
    resolveTable: async ref => ({ ...ref, metadataLocation: METADATA }),
  });
  t.after(async () => {
    await engine.close();
    await rm(extDir, { recursive: true, force: true }).catch(() => {});
    await rm(cacheDir, { recursive: true, force: true }).catch(() => {});
  });

  const t0 = Date.now();
  const offline = e => { assert.equal(e.offline, true); return true; };
  await assert.rejects(engine.call("query", ["SELECT * FROM lakehouse.w.lh.dbo.t"]),
    e => /lakehouse\.w\.lh\.dbo\.t: this part isn't cached on this machine\. Read it once online\./.test(e.message) && offline(e));
  await assert.rejects(engine.call("query", [`SELECT * FROM '${METADATA.replace("metadata/1.metadata.json", "x.parquet")}'`]),
    e => /This statement: this part isn't cached/.test(e.message) && offline(e));
  assert.ok(Date.now() - t0 < 20000, "answered from this machine, not timed out");
  assert.equal((await engine.call("query", ["SELECT 42 AS a"])).rows[0].a, 42);
});

test("the internet going during a read is checked once, and the statement runs again from what is kept", { skip: !existsSync(CACHE_BUILD) }, async t => {
  const extDir = await mkdtemp(join(tmpdir(), "onelake-ext-"));
  const cacheDir = await mkdtemp(join(tmpdir(), "onelake-cache-"));
  let reason = null;
  let checks = 0;
  let opened = 0;
  const engine = createEngineHost({
    extensionDir: extDir,
    bundledExtensions: BUNDLED,
    fileCacheDir: cacheDir,
    fileCacheMaxBytes: 1024 ** 3,
    offlineReason: () => reason,
    checkConnectivity: async () => { checks++; reason = "no internet"; return false; },
    // An IO Error at once, with nothing leaving this machine, as a read with no network is.
    resolveTable: async ref => { opened++; return { ...ref, emptySql: "SELECT * FROM read_parquet('https://127.0.0.1:1/gone.parquet')" }; },
  });
  t.after(async () => {
    await engine.close();
    await rm(extDir, { recursive: true, force: true }).catch(() => {});
    await rm(cacheDir, { recursive: true, force: true }).catch(() => {});
  });

  // https goes through the disk cache too, so the second run is answered from it: not kept.
  await assert.rejects(engine.call("query", ["SELECT * FROM lakehouse.w.lh.dbo.t"]), /this part isn't cached on this machine/);
  assert.equal(checks, 1);
  // Asked, asked again after the failure, and then both once more for the second run.
  assert.equal(opened, 4, "run again once the check found no internet");
});

test("a read that fails with the internet still there stays that failure, and runs once", { skip: !existsSync(CACHE_BUILD) }, async t => {
  const extDir = await mkdtemp(join(tmpdir(), "onelake-ext-"));
  const cacheDir = await mkdtemp(join(tmpdir(), "onelake-cache-"));
  let checks = 0;
  let opened = 0;
  const engine = createEngineHost({
    extensionDir: extDir,
    bundledExtensions: BUNDLED,
    fileCacheDir: cacheDir,
    fileCacheMaxBytes: 1024 ** 3,
    checkConnectivity: async () => { checks++; return true; },
    resolveTable: async ref => { opened++; return { ...ref, emptySql: "SELECT * FROM read_parquet('https://127.0.0.1:1/gone.parquet')" }; },
  });
  t.after(async () => {
    await engine.close();
    await rm(extDir, { recursive: true, force: true }).catch(() => {});
    await rm(cacheDir, { recursive: true, force: true }).catch(() => {});
  });

  await assert.rejects(engine.call("query", ["SELECT * FROM lakehouse.w.lh.dbo.t"]), /IO Error/);
  assert.equal(checks, 1);
  assert.equal(opened, 2, "asked, and asked again after the failure, and no second run");
});

test("a read that fails asks for the table again, once, and only a read does", async t => {
  const extDir = await mkdtemp(join(tmpdir(), "onelake-ext-"));
  // Refused at once, with nothing leaving this machine: an IO Error, as a read of a metadata file
  // that has gone is.
  const BROKEN = "SELECT * FROM read_parquet('https://127.0.0.1:1/gone.parquet')";
  let answers = {};
  const asked = [];
  const engine = createEngineHost({
    extensionDir: extDir,
    bundledExtensions: existsSync(BUNDLED) ? BUNDLED : null,
    resolveTable: async (ref, o) => {
      asked.push(`${ref.table}${o && o.fresh ? " fresh" : ""}`);
      const a = answers[ref.table];
      return { ...ref, emptySql: o && o.fresh ? a.fresh : a.kept };
    },
  });
  t.after(async () => {
    await engine.close();
    await rm(extDir, { recursive: true, force: true }).catch(() => {});
  });
  const name = table => `lakehouse.w.lh.dbo.${table}`;

  await t.test("the table moved: the statement answers from where it is now", async () => {
    answers = { moved: { kept: BROKEN, fresh: "SELECT 7 AS answer" } };
    const r = await engine.call("query", [`SELECT answer FROM ${name("moved")}`]);
    assert.deepEqual(r.rows, [{ answer: 7 }]);
    assert.deepEqual(asked, ["moved", "moved fresh"]);
    asked.length = 0;
    // A stream too, before its first batch.
    answers = { moved2: { kept: BROKEN, fresh: "SELECT 8 AS answer" } };
    const batches = [];
    await engine.call("stream", [`SELECT answer FROM ${name("moved2")}`], b => batches.push(b));
    assert.deepEqual(batches[0].rows, [{ answer: 8 }]);
  });

  await t.test("the table says the same again: DuckDB's error stands, with no second try", async () => {
    asked.length = 0;
    answers = { same: { kept: BROKEN, fresh: BROKEN } };
    await assert.rejects(engine.call("query", [`SELECT * FROM ${name("same")}`]), /IO Error/);
    assert.deepEqual(asked, ["same", "same fresh"]);
  });

  await t.test("a statement's own mistake asks OneLake nothing", async () => {
    asked.length = 0;
    answers = { fine: { kept: "SELECT 1 AS a", fresh: "SELECT 2 AS a" } };
    await assert.rejects(engine.call("query", [`SELECT nope FROM ${name("fine")}`]), /Binder Error/);
    assert.deepEqual(asked, ["fine"]);
  });

  await t.test("a failure with no OneLake table in it asks for nothing", async () => {
    asked.length = 0;
    await assert.rejects(engine.call("query", [BROKEN]));
    assert.deepEqual(asked, []);
  });
});

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
    { kind: "semanticmodel", workspace: "cat1", model: "Sales Model" },
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
    // Semantic models are a catalog of their own, one schema per workspace.
    r = await engine.call("query", ["SHOW ALL TABLES"]);
    assert.deepEqual(r.rows.filter(x => x.database === "semanticmodel").map(x => [x.schema, x.name, x.column_names]),
      [["cat1", "Sales Model", "['model']"]]);
    r = await engine.call("query", ["SHOW TABLES FROM semanticmodel.cat1"]);
    assert.deepEqual(r.rows, [{ name: "Sales Model" }]);
    // What SHOW SEMANTIC VIEWS reads (app/semantic.js): the catalog has the model, opened or not.
    r = await engine.call("query", ["SELECT schema_name, view_name FROM duckdb_views() WHERE database_name = 'semanticmodel'"]);
    assert.deepEqual(r.rows, [{ schema_name: "cat1", view_name: "Sales Model" }]);
    await assert.rejects(engine.call("query", ['SELECT * FROM semanticmodel.cat1."Sales Model"']),
      /semanticmodel\.cat1\."Sales Model" is a semantic model that is not open/);
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

  await t.test("Export writes every row into the temp directory, around a read only", async () => {
    const path = await engine.exportTo("SELECT range AS n FROM range(3);", "csv");
    assert.ok(existsSync(path), path);
    const r = await engine.call("query", [`SELECT sum(n) AS s, count(*) AS c FROM read_csv('${path}')`]);
    assert.equal(r.rows[0].s, 3);
    assert.equal(r.rows[0].c, 3);
    const pq = await engine.exportTo("SELECT 42 AS answer", "parquet");
    assert.equal((await engine.call("query", [`SELECT answer FROM '${pq}'`])).rows[0].answer, 42);
    await assert.rejects(engine.exportTo(`COPY (SELECT 1) TO '${path}'`, "csv"), /Read only/);
    await assert.rejects(engine.exportTo("SELECT 1", "exe"), /no export format/);
  });

  await t.test("the page reaches only query, stream, cancel and info", async () => {
    for (const m of ["openTable", "copyToTemp", "exportTo", "registerFileBuffer", "constructor", "__proto__"]) {
      await assert.rejects(engine.call(m, []), /unknown engine method/, `${m} is not a page method`);
    }
  });

  await t.test("threads, the spill limit and the row limit reach the engine", async () => {
    const other = createEngineHost({ extensionDir: extDir, threads: 2, spillMaxGB: 1, maxRows: 1000 });
    try {
      assert.equal(other.maxRows, 1000);
      const s = await other.call("query", ["SELECT current_setting('threads') AS t, current_setting('max_temp_directory_size') AS m"]);
      assert.equal(Number(s.rows[0].t), 2);
      assert.match(String(s.rows[0].m), /^(953\.6 MiB|1\.0 GB|1 GB)$/);
      const r = await other.call("query", ["SELECT * FROM range(1500)"]);
      assert.equal(r.rows.length, 1000, "rows past the limit are not kept");
      assert.equal(r.numRows, 1500, "and are still counted");
    } finally { await other.close(); }
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
