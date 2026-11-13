// SQL's writes to a lakehouse, for real: the engine as a tab and the command line run it (engine-host.js runWrite),
// with its lockdown and its lake, against the CI lakehouse on fabriccat (ONELAKE_CI_WORKSPACE /
// ONELAKE_CI_LAKEHOUSE), on the CI identity's storage token (ONELAKE_TOKEN).
//
// Each of DuckDB's Iceberg writes goes through the lakehouse's Iceberg catalog and is held to DuckDB's own plan of
// it. What it wrote is then read twice: by the engine itself, by the table's SQL name through the lake (what
// a SELECT after it in a tab reads), and by a DuckDB of the test's own, straight from the catalog. A COPY to Files/,
// what is refused, a Delta table, and two writes at once. The tables a run makes are dropped after, by the test's
// own DuckDB: the engine drops nothing. Skipped without those variables, set only by the lake's workflow.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const { ONELAKE_TOKEN: TOKEN, ONELAKE_CI_WORKSPACE: WS, ONELAKE_CI_LAKEHOUSE: LH } = process.env;
const skip = !(TOKEN && WS && LH) && "ONELAKE_TOKEN, ONELAKE_CI_WORKSPACE and ONELAKE_CI_LAKEHOUSE are set only by the lake's workflow";
if (skip && process.env.NO_SKIP) throw new Error(skip);

const require = createRequire(import.meta.url);
// Loaded only when it runs: npm test's job has no DuckDB.
const { createEngineHost } = skip ? {} : require("../../core/engine/engine-host.js");
const { DuckDBInstance } = skip ? {} : require("@duckdb/node-api");
const { sourceFormat } = require("../../core/names.js");
const BUNDLED = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "duckdb-extensions");
const ICEBERG = "https://onelake.table.fabric.microsoft.com/iceberg";
const DFS = "onelake.dfs.fabric.microsoft.com";
const ITEM = `${LH}.Lakehouse`;
const WAREHOUSE = `${WS}/${ITEM}`;
const q = s => `"${String(s).replace(/"/g, '""')}"`;
const lit = s => `'${String(s).replace(/'/g, "''")}'`;
const auth = { authorization: `Bearer ${TOKEN}` };

// The catalog's prefix for the lakehouse, which it gives by name (catalog.js ircPrefixFor).
async function prefixOf() {
  const r = await fetch(`${ICEBERG}/v1/config?warehouse=${encodeURIComponent(WAREHOUSE)}`, { headers: auth });
  assert.ok(r.ok, `the Iceberg catalog's config: ${r.status}`);
  return (await r.json()).overrides.prefix;
}
const loadTable = (prefix, schema, table) =>
  fetch(`${ICEBERG}/v1/${prefix}/namespaces/${encodeURIComponent(schema)}/tables/${encodeURIComponent(table)}`, { headers: auth });

// A table as the store resolves one (onelake.js summarize, sqltables.js resolve): Delta when the catalog's metadata
// says it was converted from Delta, empty with no snapshot, else Iceberg by its metadata location. Always asked of
// OneLake, as after a Refresh.
function resolverFor(prefix) {
  return async ref => {
    const schema = ref.schema || "dbo";
    const named = { kind: "lakehouse", workspace: WS, item: LH, schema, table: ref.table, at: Date.now() };
    const r = await loadTable(prefix, schema, ref.table);
    if (r.status === 404) throw Object.assign(new Error(`there is no table ${ref.table}`), { noTable: true });
    assert.ok(r.ok, `loadTable ${ref.table}: ${r.status}`);
    const { metadata, "metadata-location": location } = await r.json();
    if (sourceFormat(metadata).format === "delta") return { ...named, deltaTable: location.replace(/\/metadata\/[^/]+$/, "").replace(/^abfs:/, "abfss:") };
    const snap = metadata["current-snapshot-id"];
    if (snap == null || String(snap) === "-1" || !(metadata.snapshots || []).length) return { ...named, emptySql: "SELECT NULL AS nothing WHERE false" };
    return { ...named, metadataLocation: location, tableUuid: metadata["table-uuid"] || null };
  };
}

test("SQL writes to a lakehouse on OneLake, and reads back what it wrote", { skip, timeout: 900_000 }, async t => {
  const prefix = await prefixOf();
  // The workspace's GUID, off a table of it, as sqltables.js lakehouseOf reads it: the catalog writes there.
  const known = await (await loadTable(prefix, "test", "lakeci_plain")).json();
  const wsId = (/^abfss?:\/\/([0-9a-f-]{36})@/i.exec(known["metadata-location"]) || [])[1];
  assert.ok(wsId, `a table's metadata names its workspace by GUID: ${known["metadata-location"]}`);
  console.log(`prefix ${prefix}, workspace ${wsId}`);
  const extDir = await mkdtemp(join(tmpdir(), "onelake-ext-"));
  const cacheDir = await mkdtemp(join(tmpdir(), "onelake-cache-"));
  const warnings = [], written = [];
  const engine = createEngineHost({
    extensionDir: extDir, bundledExtensions: existsSync(BUNDLED) ? BUNDLED : null,
    fileCacheDir: cacheDir, fileCacheMaxBytes: 1e9,
    getToken: async () => TOKEN,
    onWarn: w => warnings.push(w),
    onWritten: w => written.push(w),
    resolveLakehouse: async ref => {
      assert.equal(String(ref.workspace).toLowerCase(), WS.toLowerCase());
      assert.equal(String(ref.item).toLowerCase(), LH.toLowerCase());
      return { workspace: WS, item: ITEM, warehouse: WAREHOUSE,
               scopes: [WS, wsId].flatMap(w => [`abfss://${w}@${DFS}/`, `abfs://${w}@${DFS}/`]) };
    },
    resolveTable: resolverFor(prefix),
    resolveFile: async () => ({ workspace: WS, item: ITEM }),
  });
  const run = `w${Date.now().toString(36)}`;
  const schema = `lakeci_${run}`;
  const lh = `${q(WS)}.${q(`${LH}_lakehouse`)}`;
  const tbl = (name, s = "test") => `${lh}.${q(s)}.${q(name)}`;
  const file = `lakeci/${run}.parquet`;
  const made = [];   // [schema, table] to drop after

  // The test's own DuckDB, which reads straight from the catalog what the engine wrote, and drops it after.
  const own = await DuckDBInstance.create(":memory:", { allow_unsigned_extensions: "true" });
  const c = await own.connect();
  for (const ext of ["iceberg", "azure", "httpfs"]) {
    const shipped = join(BUNDLED, `${ext}.duckdb_extension`).replace(/\\/g, "/");
    await c.run(existsSync(shipped) ? `LOAD ${lit(shipped)}` : `LOAD ${ext}`);
  }
  await c.run("SET TimeZone = 'UTC'");
  await c.run(`CREATE SECRET onelake (TYPE azure, PROVIDER access_token, ACCESS_TOKEN ${lit(TOKEN)})`);
  await c.run(`CREATE SECRET ice (TYPE iceberg, TOKEN ${lit(TOKEN)})`);
  await c.run(`ATTACH ${lit(WAREHOUSE)} AS back (TYPE iceberg, URI ${lit(ICEBERG)}, SECRET ice,
    ACCESS_DELEGATION_MODE 'none', STAGE_CREATE_TABLES false, SKIP_CREATE_TABLE_METADATA_UPDATES true, DEFAULT_SCHEMA 'dbo')`);
  const back = async sql => (await c.runAndReadAll(sql)).getRowObjectsJson();

  t.after(async () => {
    for (const [s, n] of made) await c.run(`DROP TABLE IF EXISTS back.${q(s)}.${q(n)}`).catch(e => console.log(`left ${s}.${n}: ${e.message}`));
    await c.run(`DROP SCHEMA IF EXISTS back.${q(schema)}`).catch(e => console.log(`left schema ${schema}: ${e.message}`));
    await fetch(`https://${DFS}/${WS}/${ITEM}/Files/${file}`, { method: "DELETE", headers: { ...auth, "x-ms-version": "2023-11-03" } }).catch(() => {});
    c.closeSync();
    await engine.close();
    await rm(extDir, { recursive: true, force: true }).catch(() => {});
    await rm(cacheDir, { recursive: true, force: true }).catch(() => {});
    console.log(warnings.length ? `warnings:\n${warnings.join("\n")}` : "no warnings");
  });

  const sql = async text => {
    const t0 = Date.now();
    const res = await engine.agentQuery(text);
    console.log(`${String(Date.now() - t0).padStart(6)}ms  ${text.replace(/\s+/g, " ").slice(0, 110)}  ->  ${JSON.stringify(res.rows).slice(0, 100)}`);
    return res.rows;
  };
  // Each value as text, null as null: the engine's rows and node-api's JSON spell a BIGINT differently.
  const norm = rows => rows.map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v == null ? null : String(v)])));
  // What the engine reads now by the table's name, and what the catalog holds: the same rows, in order.
  const both = async (name, cols, order, s = "test") => {
    const mine = norm(await sql(`SELECT ${cols} FROM ${tbl(name, s)} ORDER BY ${order}`));
    const theirs = norm(await back(`SELECT ${cols} FROM back.${q(s)}.${q(name)} ORDER BY ${order}`));
    if (JSON.stringify(mine) !== JSON.stringify(theirs)) {
      // What the table's manifests list now, for the reason.
      console.log(JSON.stringify(await back(`SELECT manifest_path, status, content, file_path, record_count
        FROM iceberg_metadata(back.${q(s)}.${q(name)})`), null, 1));
    }
    assert.deepEqual(mine, theirs, `${name}: the engine reads what the catalog holds`);
    return mine;
  };

  const a = `${run}_a`;
  made.push(["test", a]);

  await t.test("CREATE TABLE, then INSERT: read back by its name, at once", async () => {
    await sql(`CREATE TABLE ${tbl(a)} (id INTEGER, name VARCHAR)`);
    const res = await sql(`INSERT INTO ${tbl(a)} VALUES (1, 'a'), (2, 'b'), (3, 'c')`);
    assert.equal(Number(Object.values(res[0])[0]), 3, "INSERT says how many rows");
    assert.deepEqual(await both(a, "id, name", "id"), [{ id: "1", name: "a" }, { id: "2", name: "b" }, { id: "3", name: "c" }]);
    assert.ok(written.some(w => w.kind === "tables" && w.item === ITEM), "the listing is read again");
  });

  await t.test("UPDATE, DELETE and MERGE INTO: each read back at once", async () => {
    await sql(`UPDATE ${tbl(a)} SET name = 'B' WHERE id = 2`);
    assert.deepEqual(await both(a, "id, name", "id"), [{ id: "1", name: "a" }, { id: "2", name: "B" }, { id: "3", name: "c" }]);
    await sql(`DELETE FROM ${tbl(a)} WHERE id = 3`);
    assert.deepEqual(await both(a, "id, name", "id"), [{ id: "1", name: "a" }, { id: "2", name: "B" }]);
    await sql(`MERGE INTO ${tbl(a)} t USING (SELECT 1 AS id, 'A' AS name UNION ALL SELECT 4, 'd') s ON t.id = s.id
      WHEN MATCHED THEN UPDATE SET name = s.name WHEN NOT MATCHED THEN INSERT VALUES (s.id, s.name)`);
    assert.deepEqual(await both(a, "id, name", "id"), [{ id: "1", name: "A" }, { id: "2", name: "B" }, { id: "4", name: "d" }]);
  });

  await t.test("an UPDATE then a DELETE of the same rows' file: two delete files on one data file, read as one", async () => {
    const m = `${run}_m`;
    made.push(["test", m]);
    await sql(`CREATE TABLE ${tbl(m)} AS SELECT i AS id, 'v' || i AS v FROM range(10) r(i)`);
    await sql(`UPDATE ${tbl(m)} SET v = 'changed' WHERE id = 3`);
    await sql(`DELETE FROM ${tbl(m)} WHERE id IN (5, 7)`);
    await sql(`DELETE FROM ${tbl(m)} WHERE id = 9`);
    const rows = await both(m, "id, v", "id");
    assert.deepEqual(rows.map(r => r.id), ["0", "1", "2", "3", "4", "6", "8"]);
    assert.equal(rows.find(r => r.id === "3").v, "changed");
  });

  await t.test("ALTER TABLE adds a column, and the next INSERT fills it", async () => {
    await sql(`ALTER TABLE ${tbl(a)} ADD COLUMN n INTEGER`);
    await sql(`INSERT INTO ${tbl(a)} VALUES (5, 'e', 50)`);
    assert.deepEqual(await both(a, "id, name, n", "id"),
      [{ id: "1", name: "A", n: null }, { id: "2", name: "B", n: null }, { id: "4", name: "d", n: null }, { id: "5", name: "e", n: "50" }]);
  });

  await t.test("a write that reads a OneLake table through the lake", async () => {
    const b = `${run}_b`;
    made.push(["test", b]);
    await sql(`CREATE TABLE ${tbl(b)} AS SELECT id * 10 AS id, upper(name) AS name FROM ${tbl(a)} WHERE id < 5`);
    assert.deepEqual(await both(b, "id, name", "id"), [{ id: "10", name: "A" }, { id: "20", name: "B" }, { id: "40", name: "D" }]);
  });

  await t.test("CREATE TABLE AS in dbo, with each common type", async () => {
    const d = `${run}_types`;
    made.push(["dbo", d]);
    await sql(`CREATE TABLE ${tbl(d, "dbo")} AS SELECT 42::BIGINT AS b, 7::INTEGER AS i, 1.5::DOUBLE AS f, 12.34::DECIMAL(18,2) AS m,
      'x' AS s, true AS yes, DATE '2024-01-02' AS d, TIMESTAMP '2024-01-02 03:04:05' AS ts, TIMESTAMPTZ '2024-01-02 03:04:05+00' AS tz`);
    const cols = "b, i, f, m::VARCHAR AS m, s, yes, d::VARCHAR AS d, ts::VARCHAR AS ts, tz::VARCHAR AS tz";
    const rows = await both(d, cols, "b", "dbo");
    assert.deepEqual(rows, [{ b: "42", i: "7", f: "1.5", m: "12.34", s: "x", yes: "true", d: "2024-01-02", ts: "2024-01-02 03:04:05", tz: "2024-01-02 03:04:05+00" }]);
  });

  await t.test("a big INSERT: many rows, read back counted and summed", async () => {
    const big = `${run}_big`;
    made.push(["test", big]);
    await sql(`CREATE TABLE ${tbl(big)} (i BIGINT, s VARCHAR)`);
    await sql(`INSERT INTO ${tbl(big)} SELECT i, 'row ' || i FROM range(500000) r(i)`);
    const mine = norm(await sql(`SELECT count(*)::BIGINT AS n, sum(i)::BIGINT AS total FROM ${tbl(big)}`));
    assert.deepEqual(mine, [{ n: "500000", total: "124999750000" }]);
    assert.deepEqual(norm(await back(`SELECT count(*)::BIGINT AS n, sum(i)::BIGINT AS total FROM back.test.${q(big)}`)), mine);
  });

  await t.test("a partitioned table", async () => {
    const p = `${run}_part`;
    made.push(["test", p]);
    await sql(`CREATE TABLE ${tbl(p)} (d DATE, v INTEGER)`);
    await sql(`ALTER TABLE ${tbl(p)} SET PARTITIONED BY (month(d))`);
    await sql(`INSERT INTO ${tbl(p)} VALUES (DATE '2024-01-05', 1), (DATE '2024-02-07', 2), (DATE '2024-02-20', 3)`);
    assert.deepEqual(await both(p, "d::VARCHAR AS d, v", "v"),
      [{ d: "2024-01-05", v: "1" }, { d: "2024-02-07", v: "2" }, { d: "2024-02-20", v: "3" }]);
  });

  await t.test("CREATE SCHEMA, and a table in it", async () => {
    await sql(`CREATE SCHEMA ${lh}.${q(schema)}`);
    const s = `${run}_s`;
    made.push([schema, s]);
    await sql(`CREATE TABLE ${tbl(s, schema)} AS SELECT 1 AS one`);
    assert.deepEqual(await both(s, "one", "one", schema), [{ one: "1" }]);
  });

  await t.test("two writes at once, each with a catalog of its own", async () => {
    const x = `${run}_x`, y = `${run}_y`;
    made.push(["test", x], ["test", y]);
    await Promise.all([sql(`CREATE TABLE ${tbl(x)} AS SELECT 'x' AS w`), sql(`CREATE TABLE ${tbl(y)} AS SELECT 'y' AS w`)]);
    assert.deepEqual(await both(x, "w", "w"), [{ w: "x" }]);
    assert.deepEqual(await both(y, "w", "w"), [{ w: "y" }]);
  });

  await t.test("COPY to the lakehouse's Files/, read back by its name", async () => {
    await sql(`COPY (SELECT 7 AS seven) TO '${WS}.${LH}_lakehouse/Files/${file}' (FORMAT parquet)`);
    assert.deepEqual(norm(await back(`SELECT seven FROM read_parquet(${lit(`abfss://${WS}@${DFS}/${ITEM}/Files/${file}`)})`)), [{ seven: "7" }]);
    assert.deepEqual(norm(await sql(`SELECT seven FROM '${WS}.${LH}_lakehouse/Files/${file}'`)), [{ seven: "7" }]);
    assert.ok(written.some(w => w.kind === "files" && w.dir === "lakeci"), "its folder is listed again");
  });

  await t.test("a Delta table is not written", async () => {
    await assert.rejects(engine.agentQuery(`INSERT INTO ${tbl("lakeci_plain")} SELECT * FROM ${tbl("lakeci_plain")} LIMIT 0`),
      /lakeci_plain is a Delta table, and SQL here writes Iceberg tables only/);
  });

  await t.test("what is refused writes nothing, and leaves nothing attached", async () => {
    const count = async () => String((await back(`SELECT count(*)::INTEGER AS n FROM back.test.${q(a)}`))[0].n);
    const before = await count();
    for (const [text, why] of [
      [`DROP TABLE ${tbl(a)}`, /DROP is blocked/],
      [`DROP SCHEMA ${lh}.${q(schema)} CASCADE`, /DROP is blocked/],
      [`CREATE OR REPLACE TABLE ${tbl(a)} AS SELECT 1 AS id`, /CREATE OR REPLACE isn't/],
      [`INSERT INTO ${tbl(a)} SELECT 9, 'z', 9 ON CONFLICT DO NOTHING`, /ON CONFLICT isn't/],
      [`TRUNCATE ${tbl(a)}`, /TRUNCATE isn't/],
      [`CREATE VIEW ${tbl(`${run}_v`)} AS SELECT 1`, /CREATE VIEW isn't/],
      ["INSERT INTO memory.main.x SELECT 1", /engine's own/],
      ["CREATE TABLE lake.main.x AS SELECT 1", /engine's own/],
      [`INSERT INTO ${q(WS)}.${q(`${LH}_warehouse`)}.dbo.t SELECT 1`, /lakehouse only/],
      ["COPY (SELECT 1) TO 'x.csv'", /COPY writes to a lakehouse's Files/],
      [`COPY (SELECT 1) TO 'abfss://${WS}@${DFS}/${ITEM}/Files/x.csv'`, /COPY writes to a lakehouse's Files/],
      ["ATTACH ':memory:' AS x", /ATTACH is not a read/],
      ["SELECT * FROM ice_0123456789abcdef.dbo.t", /a write's catalog is the engine's own/],
    ]) await assert.rejects(engine.agentQuery(text), why, text);
    assert.equal(await count(), before, "nothing was written by any of them");
    assert.deepEqual(await sql("SELECT database_name FROM duckdb_databases() WHERE starts_with(database_name, 'ice_')"), []);
  });

  await t.test("offline, a write is refused at once", async () => {
    const off = createEngineHost({ extensionDir: extDir, bundledExtensions: existsSync(BUNDLED) ? BUNDLED : null, offlineReason: () => "no internet",
      resolveLakehouse: async () => { throw new Error("asked offline"); } });
    try { await assert.rejects(off.agentQuery(`INSERT INTO ${tbl(a)} VALUES (6, 'f', 6)`), /a write needs OneLake, and there is no internet/); }
    finally { await off.close(); }
  });
});
