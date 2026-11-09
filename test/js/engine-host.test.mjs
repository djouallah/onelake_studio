// The native engine on its own: real @duckdb/node-api, no editor, no page, no OneLake.
// Needs node_modules (npm ci) and network for DuckDB's first
// INSTALL of iceberg/azure/httpfs — so CI runs it in its own job, not in `npm test`.
//
// Run: node --test test/js/engine-host.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { READS, WRITES } from "./sql-disagreements.mjs";

const require = createRequire(import.meta.url);
const { createEngineHost, jsonSafe, sameSources, isOneLakeMetadata, isOneLakeTable, duckdbPath, READ_FAILURE, AUTH_FAILURE, FORBIDDEN } = require("../../src/engine-host.js");

// What fetch-extensions.mjs put next to the extension, when CI ran it for this platform.
const BUNDLED = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "duckdb-extensions");

test("the engine runs in UTC, whatever this machine's zone: a date joins a timestamp at its midnight", async t => {
  const extDir = await mkdtemp(join(tmpdir(), "onelake-ext-"));
  const zone = process.env.TZ;
  process.env.TZ = "Europe/Paris";
  const engine = createEngineHost({ extensionDir: extDir, bundledExtensions: existsSync(BUNDLED) ? BUNDLED : null });
  t.after(async () => {
    if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone;
    await engine.close();
    await rm(extDir, { recursive: true, force: true }).catch(() => {});
  });
  const { rows } = await engine.agentQuery("SELECT current_setting('TimeZone') AS zone, TIMESTAMPTZ '2024-01-15 00:00:00+00' = DATE '2024-01-15' AS joins");
  assert.equal(rows[0].zone, "UTC");
  assert.equal(rows[0].joins, true);
});

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

test("with no cache folder: a OneLake table is refused, never read past the lake; offline a file is too, and the catalog still answers", async t => {
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
  const FILE = `SELECT * FROM '${METADATA.replace("metadata/1.metadata.json", "x.parquet")}'`;
  await assert.rejects(engine.call("query", ["SELECT * FROM lakehouse.w.lh.dbo.t"]),
    /lakehouse\.w\.lh\.dbo\.t: a OneLake table is read through the lake, and this engine has none/);
  await assert.rejects(engine.call("query", [FILE]), /This statement: reading rows needs OneLake, and there is no internet/);
  reason = "not signed in";
  await assert.rejects(engine.call("query", [FILE]), /you are not signed in/);
  const batches = [];
  await assert.rejects(engine.call("stream", ["SELECT * FROM lakehouse.w.lh.dbo.t"], b => batches.push(b)), /read through the lake/);
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

test("a file's name reaches DuckDB as its URL, one that can't be found never does, and a value stays a value", async t => {
  const extDir = await mkdtemp(join(tmpdir(), "onelake-ext-"));
  const asked = [];
  const engine = createEngineHost({
    extensionDir: extDir,
    bundledExtensions: existsSync(BUNDLED) ? BUNDLED : null,
    offlineReason: () => "no internet",
    resolveFile: async ref => {
      asked.push(ref.item);
      if (ref.item !== "lh") throw new Error(`${ref.written}: there is no lakehouse ${ref.item}`);
      return { workspace: "ws", item: "lh.Lakehouse" };
    },
  });
  t.after(async () => {
    await engine.close();
    await rm(extDir, { recursive: true, force: true }).catch(() => {});
  });

  // Refused as a read of OneLake, which is what only its URL can be.
  for (const sql of ["SELECT * FROM 'lakehouse.WS.lh/Files/x.parquet'", "SELECT * FROM read_csv('lakehouse.ws.lh/Files/*.csv', header = true)"]) {
    await assert.rejects(engine.call("query", [sql]), /This statement: reading rows needs OneLake/, sql);
  }
  assert.deepEqual(asked, ["lh", "lh"]);
  await assert.rejects(engine.call("query", ["SELECT * FROM glob('lakehouse.ws.nosuch/Files/*')"]), /there is no lakehouse nosuch/);
  await assert.rejects(engine.call("query", ["SELECT * FROM glob('lakehouse.ws.lh/Tables/*')"]), /a table's name is/);
  const value = "lakehouse.ws.nosuch/Files/x.parquet";
  assert.equal((await engine.call("query", [`SELECT '${value}' AS v`])).rows[0].v, value);
});

test("what the read-only guard takes as a read or a write, DuckDB's own parser does too", async t => {
  const extDir = await mkdtemp(join(tmpdir(), "onelake-ext-"));
  const engine = createEngineHost({ extensionDir: extDir, bundledExtensions: existsSync(BUNDLED) ? BUNDLED : null });
  t.after(async () => {
    await engine.close();
    await rm(extDir, { recursive: true, force: true }).catch(() => {});
  });
  const parsed = async sql => {
    const { rows } = await engine.call("query", [`SELECT json_serialize_sql('${sql.replace(/'/g, "''")}') AS j`]);
    return JSON.parse(rows[0].j);
  };
  for (const sql of READS) {
    const j = await parsed(sql);
    assert.equal(j.error, false, `DuckDB does not read this as a query: ${sql}`);
    assert.equal(j.statements.length, 1, `DuckDB does not read this as one statement: ${sql}`);
  }
  for (const sql of WRITES) {
    const j = await parsed(sql);
    assert.ok(j.error === true || j.statements.length !== 1, `DuckDB reads this as one query, so it is no way past the guard: ${sql}`);
    await assert.rejects(engine.call("query", [sql]), /Read only/, sql);
  }
  // What the parser can't write as JSON still reads, under both walls.
  assert.equal((await engine.call("query", ["EXPLAIN SELECT 1"])).rows.length > 0, true);
  assert.equal((await engine.call("query", ["EXPLAIN ANALYZE SELECT 1 -- with a comment"])).rows.length > 0, true);
  assert.deepEqual((await engine.call("query", [
    "/* a comment */ PIVOT (SELECT 'x' AS k, 1 AS v) ON k USING sum(v)"])).rows, [{ x: 1 }]);
  assert.deepEqual((await engine.call("query", [
    "SELECT * FROM (PIVOT (SELECT 'x' AS k, 1 AS v) ON k IN ('x') USING sum(v))"])).rows, [{ x: 1 }]);
  assert.deepEqual((await engine.call("query", [
    "WITH x AS (SELECT 'x' AS k, 1 AS v) PIVOT x ON k USING sum(v)"])).rows, [{ x: 1 }]);
  await assert.rejects(engine.call("query", ["SELECT * FROM query('SELECT * FROM quack' || '_stop(''quack:127.0.0.1:1'')')"]), /Read only/);
  await assert.rejects(engine.call("query", ["SELECT write_log('forged', level := 'error', log_type := 'Quack')"]), /Read only/);
  // Nothing loads after the lockdown, with unsigned extensions allowed for ours.
  assert.deepEqual((await engine.call("query", [
    "SELECT current_setting('autoload_known_extensions') AS a, current_setting('autoinstall_known_extensions') AS b"])).rows, [{ a: false, b: false }]);
  await assert.rejects(engine.call("query", ["PRAGMA database_list"]), /PRAGMA is not a read/);
  await assert.rejects(engine.call("query", ["SELECT * FROM ducklake_cleanup_old_files('lake', cleanup_all => true)"]), /Read only/);
  await assert.rejects(engine.call("query", ["SELECT * FROM truncate_duckdb_logs()"]), /Read only/);
  // A mistake is DuckDB's own to report, with where it is.
  await assert.rejects(engine.call("query", ["SELECT 1 FROM"]), /syntax error/i);
  // An export goes inside a COPY of ours, so a read that closes its parenthesis isn't one.
  await assert.rejects(engine.exportTo("SELECT 1) TO 'x.csv' (FORMAT csv) --", "csv"), /syntax error/i);
});

test("DuckDB's words for a failed read are the ones the engine looks for", async t => {
  const extDir = await mkdtemp(join(tmpdir(), "onelake-ext-"));
  const engine = createEngineHost({ extensionDir: extDir, bundledExtensions: existsSync(BUNDLED) ? BUNDLED : null, lockdown: false });
  t.after(async () => {
    await engine.close();
    await rm(extDir, { recursive: true, force: true }).catch(() => {});
  });
  await assert.rejects(engine.call("query", [`SELECT * FROM read_parquet('${join(extDir, "no_such.parquet").replace(/\\/g, "/")}')`]),
    e => READ_FAILURE.test(e.message), "a read that fails");
  await assert.rejects(engine.call("query", ["SELECT nope FROM range(1)"]), e => !READ_FAILURE.test(e.message), "a mistake asks OneLake nothing");
  // A table's or a column's name is no token failure.
  assert.ok(!AUTH_FAILURE.test("Binder Error: column fact_401 not found"));
  assert.ok(AUTH_FAILURE.test("IO Error: HTTP 401 from the server"));
  assert.ok(AUTH_FAILURE.test("AuthenticationFailed: Server failed to authenticate the request"));
});

test("an answer knows when its oldest table was read from OneLake, and fresh asks again", async t => {
  const extDir = await mkdtemp(join(tmpdir(), "onelake-ext-"));
  const asked = [];
  const engine = createEngineHost({
    extensionDir: extDir,
    bundledExtensions: existsSync(BUNDLED) ? BUNDLED : null,
    resolveTable: async (ref, o = {}) => {
      asked.push(!!o.fresh);
      return { ...ref, emptySql: "SELECT 1 AS a", at: ref.table === "old" ? 1000 : 2000 };
    },
  });
  t.after(async () => {
    await engine.close();
    await rm(extDir, { recursive: true, force: true }).catch(() => {});
  });
  const both = "SELECT * FROM lakehouse.w.lh.dbo.old, lakehouse.w.lh.dbo.new";
  assert.equal((await engine.call("query", [both])).asOf, 1000);
  assert.equal((await engine.call("stream", [both], () => {})).asOf, 1000);
  assert.equal((await engine.call("query", ["SELECT 1"])).asOf, null, "no table, no age");
  assert.ok(asked.every(f => !f), "kept unless asked");
  assert.equal((await engine.agentQuery(both, { fresh: true })).asOf, 1000);
  assert.ok(asked.some(f => f), "--fresh reads OneLake first");
});

test("Stop reaches a statement still being prepared: it answers at once, and never runs", async t => {
  const extDir = await mkdtemp(join(tmpdir(), "onelake-ext-"));
  let release;
  const held = new Promise(r => { release = r; });
  let asked = 0;
  const engine = createEngineHost({
    extensionDir: extDir,
    bundledExtensions: existsSync(BUNDLED) ? BUNDLED : null,
    // The Iceberg catalog, taking its time: 5s, 12s and 114s were measured on a real tenant.
    resolveTable: async ref => { asked++; await held; return { ...ref, emptySql: "SELECT 1 AS a" }; },
  });
  t.after(async () => {
    release();
    await engine.close();
    await rm(extDir, { recursive: true, force: true }).catch(() => {});
  });
  await engine.call("query", ["SELECT 1"]);

  const batches = [];
  const running = engine.call("stream", ["SELECT * FROM lakehouse.w.lh.dbo.t"], b => batches.push(b));
  while (!asked) await new Promise(r => setTimeout(r, 10));
  const at = Date.now();
  await engine.call("cancel");
  await assert.rejects(running, e => e.cancelled === true);
  assert.ok(Date.now() - at < 5000, "said at once, not when the catalog answers");

  // The catalog answers late, and nothing is left to run.
  release();
  await new Promise(r => setTimeout(r, 300));
  assert.deepEqual(batches, []);

  // A Stop belongs to what was running when it came.
  await engine.call("cancel");
  assert.deepEqual((await engine.call("query", ["SELECT * FROM lakehouse.w.lh.dbo.t"])).rows, [{ a: 1 }]);
});

// With a cache folder the engine keeps OneLake tables in the lake, which needs the ducklake build the bundle has.
const LAKE_BUILD = join(BUNDLED, "ducklake.duckdb_extension");

test("offline with the lake: a table never read here says so at once, with nothing sent", { skip: !existsSync(LAKE_BUILD) }, async t => {
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
    e => /lakehouse\.w\.lh\.dbo\.t: this table isn't cached on this machine, and there is no internet/.test(e.message) && offline(e));
  // A file read past the lake isn't kept anywhere: refused at once too.
  await assert.rejects(engine.call("query", [`SELECT * FROM '${METADATA.replace("metadata/1.metadata.json", "x.parquet")}'`]),
    e => /This statement: reading rows needs OneLake/.test(e.message) && offline(e));
  assert.ok(Date.now() - t0 < 20000, "answered from this machine, not timed out");
  assert.equal((await engine.call("query", ["SELECT 42 AS a"])).rows[0].a, 42);
  // The lake is how a table is read, not tables of the user's. Its metadata is listed, and read, as system_internal.
  const listed = (await engine.call("query", ["SHOW ALL TABLES"])).rows.map(r => r.database);
  assert.ok(!listed.includes("lake"), listed.join(", "));
  assert.ok(listed.includes("system_internal"), listed.join(", "));
  assert.ok((await engine.call("query", ["SELECT count(*) AS n FROM system_internal.ducklake_snapshot"])).rows[0].n > 0);
});

test("the internet going during a read is checked once, and the statement runs again, offline", { skip: !existsSync(LAKE_BUILD) }, async t => {
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

  // The second run fails as the first did, now saying the engine is offline.
  await assert.rejects(engine.call("query", ["SELECT * FROM lakehouse.w.lh.dbo.t"]), /IO Error[\s\S]*OneLake Studio is offline: no internet/);
  assert.equal(checks, 1);
  // Asked, asked again after the failure, and then both once more for the second run.
  assert.equal(opened, 4, "run again once the check found no internet");
});

test("a read that fails with the internet still there stays that failure, and runs once", { skip: !existsSync(LAKE_BUILD) }, async t => {
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
    { kind: "lakehouse", workspace: "cat1", item: "lh", schema: "dbo", table: "unread" },
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
    assert.ok(caps.delta, "delta loaded: how a Delta table is read");
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
      ["lakehouse", "cat1.lh.dbo", "unread", "[]", "[]"],
      ["warehouse", "cat1.wh.sales", "e", "['id']", "['INTEGER']"],
    ]);
    // Listed by name before its columns are known, and an error rather than no rows if it is ever read unnamed.
    const viewSql = async name => (await engine.call("query", [`SELECT sql FROM duckdb_views() WHERE view_name = '${name}' AND schema_name <> 'main'`])).rows[0].sql;
    assert.match(await viewSql("unread"), /is not open/);
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
    // A cached table that is empty is its own truth; one that is not would fail if a name the
    // engine cannot see read it, rather than answer no rows.
    assert.doesNotMatch(await viewSql("e"), /is not open/);
    assert.match(await viewSql("t"), /is not open/);
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
    assert.deepEqual(ours(r.rows).map(x => [x.schema, x.name]), [["cat1.lh.dbo", "t"], ["cat1.lh.dbo", "unread"], ["cat1.wh.sales", "e"]]);
    // Its columns read since: the same entry, now with them.
    cached = cached.map(x => (x.table === "unread" ? { ...x, columns: [{ name: "now", type: "BIGINT" }] } : x));
    engine.catalogChanged();
    r = await engine.call("query", ["SHOW ALL TABLES"]);
    assert.equal(ours(r.rows).find(x => x.name === "unread").column_names, "['now']");
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

  await t.test("a database file's catalog says what it holds, DuckDB's and SQLite's", async () => {
    if (!existsSync(BUNDLED)) return t.skip("no bundled extensions (run fetch-extensions.mjs)");
    const { dbCatalogSql, dbCatalog, dbCountSql } = await import("../../app/paths.js");
    const { DuckDBInstance } = require("@duckdb/node-api");
    const { DatabaseSync } = await import("node:sqlite");
    const catalogOf = async (alias, estimated) => {
      const sqls = dbCatalogSql(alias);
      const answer = async sql => (await engine.call("query", [sql])).rows;
      return dbCatalog({
        alias, estimated, schemas: await answer(sqls.schemas), objects: await answer(sqls.objects),
        columns: await answer(sqls.columns), constraints: await answer(sqls.constraints), indexes: await answer(sqls.indexes),
      });
    };

    const duck = join(outside, "shop.duckdb");
    const made = await DuckDBInstance.create(duck);
    const c = await made.connect();
    await c.run(`CREATE SCHEMA sales; CREATE SCHEMA sales.emea; CREATE SCHEMA "odd name"; CREATE SCHEMA empty_one;
                 CREATE TABLE sales.customers (id INT PRIMARY KEY, name VARCHAR NOT NULL);
                 CREATE TABLE sales.orders (id INT, cust INT REFERENCES sales.customers (id), CHECK (id > 0));
                 CREATE INDEX ix ON sales.orders (cust);
                 CREATE TABLE sales.emea.orders (x INT);
                 CREATE TABLE "odd name"."select" (x INT);
                 CREATE VIEW sales.v AS SELECT * FROM sales.orders;
                 INSERT INTO sales.customers VALUES (1, 'a'), (2, 'b');
                 COMMENT ON TABLE sales.customers IS 'who';
                 CHECKPOINT;`);
    c.closeSync();
    made.closeSync();
    await engine.call("attachFile", [{ path: await engine.copyToTemp("ws/lh/Files/shop.duckdb", await readFile(duck)), alias: "shopduck" }]);
    const d = await catalogOf("shopduck", true);
    assert.deepEqual(d.schemas.map(s => s.name), ["odd name", "sales", "sales.emea"], "only what holds something, nested by its whole path");
    const of = name => d.objects.find(o => o.sqlName === name);
    const customers = of("shopduck.sales.customers");
    assert.equal(customers.rows, 2);
    assert.equal(customers.comment, "who");
    assert.deepEqual(customers.columns.map(x => [x.name, x.type, x.nullable, x.pk]),
      [["id", "INTEGER", false, true], ["name", "VARCHAR", false, false]]);
    const orders = of("shopduck.sales.orders");
    assert.equal(orders.columns.find(x => x.name === "cust").fk, "customers");
    assert.ok(orders.constraints.some(x => /^CHECK/.test(x.text)));
    assert.deepEqual(orders.indexes.map(x => x.name), ["ix"]);
    assert.equal(of("shopduck.sales.v").kind, "view");
    for (const o of d.objects) await engine.call("query", [`SELECT * FROM ${o.sqlName}`]);   // every name runs as written
    assert.ok(of('shopduck."odd name"."select"'), d.objects.map(o => o.sqlName).join());

    const lite = join(outside, "shop.sqlite");
    const s = new DatabaseSync(lite);
    s.exec(`CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
            CREATE VIEW v AS SELECT * FROM customers;
            INSERT INTO customers (name) VALUES ('a'), ('b'), ('c');`);
    s.close();
    await engine.call("attachFile", [{ path: await engine.copyToTemp("ws/lh/Files/shop.sqlite", await readFile(lite)), alias: "shoplite", sqlite: true }]);
    const l = await catalogOf("shoplite", false);
    assert.deepEqual(l.objects.map(o => [o.sqlName, o.kind, o.rows]),
      [["shoplite.main.customers", "table", null], ["shoplite.main.v", "view", null]], "SQLite's estimate isn't shown");
    const [count] = (await engine.call("query", [dbCountSql(l.objects.filter(o => o.kind === "table"))])).rows;
    assert.equal(Number(count.n), 3);
    await engine.call("releaseFiles", [{ attached: ["shopduck", "shoplite"] }]);
  });

  await t.test("Export writes every row into the temp directory, around a read only", async () => {
    const path = await engine.exportTo("SELECT range AS n FROM range(3);", "csv");
    assert.ok(existsSync(path), path);
    const r = await engine.call("query", [`SELECT sum(n) AS s, count(*) AS c FROM read_csv('${path}')`]);
    assert.equal(r.rows[0].s, 3);
    assert.equal(r.rows[0].c, 3);
    const pq = await engine.exportTo("SELECT 42 AS answer", "parquet");
    assert.equal((await engine.call("query", [`SELECT answer FROM '${pq}'`])).rows[0].answer, 42);
    // A ';' before a closing comment isn't left inside the COPY's parenthesis.
    const noted = await engine.exportTo("SELECT 7 AS n; -- note", "parquet");
    assert.equal((await engine.call("query", [`SELECT n FROM '${noted}'`])).rows[0].n, 7);
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
test("only a OneLake table folder is read with delta_scan", () => {
  assert.ok(isOneLakeTable("abfss://ws@onelake.dfs.fabric.microsoft.com/lh.Lakehouse/Tables/dbo/t"));
  assert.ok(isOneLakeTable("abfss://ANZ Retail Demo@onelake.dfs.fabric.microsoft.com/lh.Lakehouse/Tables/dbo/t"));
  for (const bad of [null, "", 42, "C:/Users/x", "file:///C:/x", "https://onelake.dfs.fabric.microsoft.com/ws/lh/Tables/t",
    "abfss://ws@evil.example.com/x/t", "abfss://ws@onelake.dfs.fabric.microsoft.com/lh/Tables/t\nATTACH 'x'", "abfss://ws@onelake.dfs.fabric.microsoft.com/"]) {
    assert.equal(isOneLakeTable(bad), false, String(bad));
  }
});

test("a number JSON has no word for says what it is, and doesn't become NULL", () => {
  assert.equal(jsonSafe(NaN), "NaN");
  assert.equal(jsonSafe(-Infinity), "-Infinity");
  assert.equal(jsonSafe(1.5), 1.5);
  assert.deepEqual(jsonSafe([1, NaN]), [1, "NaN"]);
});

test("a statement's tables read the same whenever they were read, unless what they read moved", () => {
  const t = { name: "n", source: "SELECT 1", logMoves: 0 };
  assert.ok(sameSources([{ ...t, at: 1 }], [{ ...t, at: 2 }]));
  assert.ok(!sameSources([{ ...t, at: 1 }], [{ ...t, at: 2, logMoves: 1 }]), "a Delta table's log has changed under the same folder");
  assert.ok(!sameSources([{ ...t, at: 1 }], [{ ...t, at: 1, source: "SELECT 2" }]));
});

test("a kept log's folder is spelled the way the lockdown keeps it", () => {
  assert.equal(duckdbPath("c:\\Users\\x\\file-cache-v1\\a\\delta\\b"), "C:/Users/x/file-cache-v1/a/delta/b");
  assert.equal(duckdbPath("C:/Users/x"), "C:/Users/x");
  assert.equal(duckdbPath("/home/x/cache"), "/home/x/cache");
});

test("with no cache folder, a Delta table is refused, never read past the lake, and an empty one still answers", async t => {
  const extDir = await mkdtemp(join(tmpdir(), "onelake-delta-offline-"));
  const engine = createEngineHost({
    extensionDir: extDir,
    bundledExtensions: existsSync(BUNDLED) ? BUNDLED : null,
    offlineReason: () => "no internet",
    catalogTables: async () => [],
    resolveTable: async ref => (ref.table === "never_written"
      ? { ...ref, emptySql: "SELECT 1 AS a WHERE false" }
      : { ...ref, metadataLocation: "abfss://w@onelake.dfs.fabric.microsoft.com/lh.Lakehouse/Tables/dbo/t/metadata/1.metadata.json",
          deltaTable: "abfss://w@onelake.dfs.fabric.microsoft.com/lh.Lakehouse/Tables/dbo/t" }),
  });
  t.after(async () => {
    await engine.close();
    await rm(extDir, { recursive: true, force: true }).catch(() => {});
  });
  await engine.warm();
  await assert.rejects(engine.call("query", ["SELECT * FROM lakehouse.w.lh.dbo.t"]),
    /lakehouse\.w\.lh\.dbo\.t: a OneLake table is read through the lake, and this engine has none/);
  const r = await engine.call("query", ["SELECT * FROM lakehouse.w.lh.dbo.never_written"]);
  assert.equal(r.rows.length, 0);
});

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

test("a statement that reads a table says it was used, and a table being kept doesn't", async t => {
  const extDir = await mkdtemp(join(tmpdir(), "onelake-ext-"));
  const used = [];
  const listed = ref => ({ workspace: ref.workspace, item: `${ref.item}.Lakehouse`, schema: ref.schema, table: ref.table });
  const engine = createEngineHost({
    extensionDir: extDir, bundledExtensions: existsSync(BUNDLED) ? BUNDLED : null,
    resolveTable: async ref => ({ ...ref, listed: listed(ref), emptySql: "SELECT 1 AS a" }),
    onTablesUsed: list => used.push(list.map(u => `${u.item}/${u.table}`)),
  });
  t.after(async () => { await engine.close(); await rm(extDir, { recursive: true, force: true }).catch(() => {}); });
  const name = "lakehouse.w.i.dbo.t";

  await engine.call("query", [`SELECT * FROM ${name}`]);
  assert.deepEqual(used, [["i.Lakehouse/t"]]);
  await engine.call("query", [`SELECT * FROM ${name}`]);
  assert.equal(used.length, 2, "every statement, not once per table");
  await engine.call("query", [`SELECT * FROM ${name} JOIN lakehouse.w.i.dbo.u USING (a)`]);
  assert.deepEqual(used[2], ["i.Lakehouse/t", "i.Lakehouse/u"]);
  used.length = 0;
  await engine.call("query", [`DESCRIBE ${name}`]);
  await engine.call("query", [`EXPLAIN SELECT * FROM ${name}`]);
  await assert.rejects(engine.call("query", [`SELECT nope FROM ${name}`]));
  assert.deepEqual(used, [], "naming it reads nothing, and a failure read nothing");
  await engine.call("query", [`EXPLAIN ANALYZE SELECT * FROM ${name}`]);
  assert.equal(used.length, 1, "a Plan runs it");
  used.length = 0;

  const kept = await engine.keepTable(name);
  assert.deepEqual(kept.rows.map(r => r.column_name), ["a"], "it names the table, and reads none of its rows");
  assert.deepEqual(used, [], "or a table would keep itself in use for ever");
  const gone = new AbortController();
  gone.abort();
  await assert.rejects(engine.keepTable(name, { signal: gone.signal }), /nobody is waiting/);
});

// What OneLake's table read API answers, as an Arrow stream file, written by a DuckDB of the test's own.
async function writeArrowStream(file, select) {
  const { DuckDBInstance } = require("@duckdb/node-api");
  const duck = await DuckDBInstance.create(":memory:", { allow_unsigned_extensions: "true" });
  const c = await duck.connect();
  try {
    const shipped = join(BUNDLED, "nanoarrow.duckdb_extension");
    if (existsSync(shipped)) await c.run(`LOAD '${shipped.replace(/\\/g, "/")}'`);
    else { await c.run("INSTALL nanoarrow FROM community"); await c.run("LOAD nanoarrow"); }
    await c.run(`COPY (${select}) TO '${file.replace(/\\/g, "/")}' (FORMAT arrows)`);
  } finally { c.closeSync(); duck.closeSync(); }
}

test("a table with OneLake security: a 403 moves it to its Arrow files, under the same name, and only it", { skip: !existsSync(LAKE_BUILD) }, async t => {
  const extDir = await mkdtemp(join(tmpdir(), "onelake-ext-"));
  const cacheDir = await mkdtemp(join(tmpdir(), "onelake-cache-"));
  const copy = join(cacheDir, "secured", "abc", "1");
  await mkdir(copy, { recursive: true });
  const files = [join(copy, "s0.arrows"), join(copy, "s1.arrows")];
  await writeArrowStream(files[0], "SELECT range::INTEGER AS i, 'a' AS region FROM range(3)");
  await writeArrowStream(files[1], "SELECT (range + 3)::INTEGER AS i, 'b' AS region FROM range(2)");
  // OneLake's refusal as the engine meets it, from a source that reads the lake as a real table's does.
  const REFUSED = "SELECT NULL::INTEGER AS i, NULL::VARCHAR AS region /* FROM lake.t */ WHERE error('IO Error: AzureDfsStorageFileSystem open file failed: HTTP 403 (AuthorizationPermissionMismatch)') IS NULL";
  const asked = [];
  const engine = createEngineHost({
    extensionDir: extDir,
    bundledExtensions: BUNDLED,
    fileCacheDir: cacheDir,
    fileCacheMaxBytes: 1024 ** 3,
    resolveTable: async (ref, o = {}) => {
      asked.push(`${ref.table}${o.secured ? " secured" : ""}`);
      if (ref.table === "open") return { ...ref, emptySql: "SELECT 2 AS b /* FROM lake.t */" };
      if (ref.table === "elsewhere") return { ...ref, arrowFiles: [join(extDir, "x.arrows")], secured: true };
      return o.secured ? { ...ref, arrowFiles: files, secured: true, at: 7 } : { ...ref, emptySql: REFUSED };
    },
  });
  t.after(async () => {
    await engine.close();
    await rm(extDir, { recursive: true, force: true }).catch(() => {});
    await rm(cacheDir, { recursive: true, force: true }).catch(() => {});
  });
  const name = table => `lakehouse.w.lh.dbo.${table}`;

  const r = await engine.call("query", [`SELECT i, region FROM ${name("sec")} ORDER BY i`]);
  assert.deepEqual(r.rows.map(x => x.i), [0, 1, 2, 3, 4], "every stream, read as one table");
  assert.equal(r.asOf, 7, "as of when it was read");
  assert.deepEqual(asked, ["sec", "sec secured"]);

  asked.length = 0;
  await engine.call("query", [`SELECT count(*) AS n FROM ${name("sec")}`]);
  assert.deepEqual(asked, ["sec secured"], "known now: no refusal first");

  asked.length = 0;
  const joined = await engine.agentQuery(`SELECT count(*)::INTEGER AS n FROM ${name("sec2")} s, ${name("open")} o WHERE o.b = 2`);
  assert.equal(joined.rows[0].n, 5);
  assert.ok(asked.includes("sec2 secured"), asked.join(", "));
  assert.ok(!asked.includes("open secured"), "the table that read fine stays as it is");

  await assert.rejects(engine.call("query", [`SELECT * FROM ${name("elsewhere")}`]), /aren't where this engine reads/);
});

test("OneLake's words for a refused file are the ones the engine looks for", () => {
  assert.ok(FORBIDDEN.test("IO Error: AzureBlobStorageFileSystem could not open file: 403 This request is not authorized to perform this operation using this permission. (AuthorizationPermissionMismatch)"));
  assert.ok(FORBIDDEN.test("IO Error: Generic MicrosoftAzure error: response error \"Forbidden\""));
  assert.ok(!FORBIDDEN.test("Binder Error: column fact_403x not found"));
  assert.ok(!FORBIDDEN.test("Binder Error: no column y\n\nLINE 1: SELECT y FROM t WHERE x = 403"), "a statement quoted in an error");
  assert.ok(!FORBIDDEN.test("IO Error: HTTP 401 Unauthorized"));
});

// A Delta table written here by hand, a commit at a time: a Parquet file DuckDB writes, and its log line.
async function deltaCommit(c, root, version, from, to) {
  const file = `part-${version}.parquet`;
  await mkdir(join(root, "_delta_log"), { recursive: true });
  await c.run(`COPY (SELECT range::INTEGER AS a FROM range(${from}, ${to})) TO '${duckdbPath(join(root, file))}' (FORMAT parquet)`);
  const { size } = await stat(join(root, file));
  const lines = [
    ...(version === 0 ? [{ protocol: { minReaderVersion: 1, minWriterVersion: 2 } }, { metaData: { id: "t", format: { provider: "parquet", options: {} },
      schemaString: JSON.stringify({ type: "struct", fields: [{ name: "a", type: "integer", nullable: true, metadata: {} }] }),
      partitionColumns: [], configuration: {}, createdTime: 0 } }] : []),
    { add: { path: file, partitionValues: {}, size, modificationTime: 0, dataChange: true, stats: JSON.stringify({ numRecords: to - from }) } },
  ];
  await writeFile(join(root, "_delta_log", `${String(version).padStart(20, "0")}.json`), lines.map(l => JSON.stringify(l)).join("\n") + "\n");
}

test("a table the lake holds is read as it is, with nothing asked of OneLake, after a restart too; a sync reads only what is new", { skip: !existsSync(LAKE_BUILD) }, async t => {
  const H = await import("./lake-helpers.mjs");
  const { syncTable } = require("../../src/onelaketable.js");
  const extDir = await mkdtemp(join(tmpdir(), "onelake-ext-"));
  const cacheDir = await mkdtemp(join(tmpdir(), "onelake-cache-"));
  const FOLDER = "abfss://ws@onelake.dfs.fabric.microsoft.com/lh.Lakehouse/Tables/dbo/t";
  const LOC = `${FOLDER}/metadata/1.metadata.json`;
  const listed = { workspace: "ws", item: "lh.Lakehouse", schema: "dbo", table: "t" };
  // The lake as an earlier server left it: this table synced, with no file in it. Its folder is on OneLake, which
  // this engine has no token for, so any read of its log would fail.
  const lakeName = `t_${createHash("sha256").update(FOLDER.toLowerCase()).digest("hex").slice(0, 24)}`;
  const local = duckdbPath(join(cacheDir, "src", "u"));
  {
    await mkdir(join(cacheDir, "lake"), { recursive: true });
    const lake = await H.openLake({ extensions: ["ducklake"], dir: join(cacheDir, "lake") });
    try {
      const state = { format: "delta", version: 3, root: FOLDER, partitionColumns: [], columnMapping: "none", files: [],
        fields: [{ name: "a", physical: "a", type: "INTEGER", children: [] }], log: { metaData: {}, adds: [] } };
      await syncTable(lake.c, lakeName, state, { dvDir: lake.dvDir, synced: { folder: FOLDER, location: LOC, listed } });
      await deltaCommit(lake.c, local, 0, 0, 3);
    } finally { lake.close(); }
  }
  const asked = [];
  const open = () => createEngineHost({
    extensionDir: extDir, bundledExtensions: BUNDLED, fileCacheDir: cacheDir, fileCacheMaxBytes: 1024 ** 3,
    resolveTable: async (ref, o = {}) => {
      if (o.held) asked.push((await o.held({ deltaTable: FOLDER, metadataLocation: LOC })).name);
      return { ...ref, deltaTable: FOLDER, metadataLocation: LOC, at: 1, listed };
    },
  });
  let engine = open();
  t.after(async () => {
    await engine.close();
    await rm(extDir, { recursive: true, force: true }).catch(() => {});
    await rm(cacheDir, { recursive: true, force: true }).catch(() => {});
  });
  const syncedAt = async () => (await engine.lakeTables()).find(r => r.name === lakeName).syncedAt;
  const before = await syncedAt();

  assert.equal((await engine.call("query", ["SELECT count(*)::INTEGER AS n FROM lakehouse.ws.lh.dbo.t"])).rows[0].n, 0);
  assert.deepEqual(asked, [lakeName], "the engine says the lake holds it");
  assert.equal(await syncedAt(), before, "not synced");

  // A table the lake has no record of is synced first; after that, a sync reads only the commits since.
  const first = await engine.lakeSync({ deltaTable: local, metadataLocation: null, listed: { ...listed, table: "u" } });
  assert.deepEqual([first.added, first.commitsRead, first.version], [1, 1, "0"]);
  const count = async () => (await engine.agentQuery(`SELECT count(*)::INTEGER AS n FROM lake.main.${first.name}`)).rows[0].n;
  assert.equal(await count(), 3);
  {
    const db = await H.openLake({ extensions: ["ducklake"], dir: await mkdtemp(join(tmpdir(), "onelake-w-")) });
    try { await deltaCommit(db.c, local, 1, 3, 5); await deltaCommit(db.c, local, 2, 5, 9); } finally { db.close(); }
  }
  assert.equal(await count(), 3, "a commit that landed isn't read until a sync");
  const next = await engine.lakeSync({ deltaTable: local, metadataLocation: null });
  assert.deepEqual([next.added, next.commitsRead, next.version], [2, 2, "2"]);
  assert.equal(await count(), 9);
  assert.deepEqual((await engine.lakeTables()).map(r => [r.name, r.version]).sort(), [[lakeName, "3"], [first.name, "2"]].sort());

  // The server starts again: what the lake was synced to is still known, and nothing is read again.
  await engine.close();
  engine = open();
  asked.length = 0;
  assert.equal((await engine.call("query", ["SELECT count(*)::INTEGER AS n FROM lakehouse.ws.lh.dbo.t"])).rows[0].n, 0);
  assert.deepEqual(asked, [lakeName]);
  assert.equal(await syncedAt(), before);
  assert.equal((await engine.lakeTable({ deltaTable: local, check: true })).name, first.name);
  assert.equal((await engine.lakeTable({ deltaTable: `${FOLDER}_never`, check: true })).name, null, "never synced here");
});
