// SQL's writes to a lakehouse, for real: the engine as a tab and the command line run it (engine-host.js runWrite),
// with its lockdown and its lake, against the CI lakehouse on fabriccat (ONELAKE_CI_WORKSPACE /
// ONELAKE_CI_LAKEHOUSE), on the CI identity's storage token (ONELAKE_TOKEN).
//
// Each of DuckDB's Iceberg writes goes through the lakehouse's Iceberg catalog and is held to DuckDB's own plan of
// it. What it wrote is then read twice: by the engine itself, by the table's SQL name through the lake (what
// a SELECT after it in a tab reads), and by a DuckDB of the test's own, straight from the catalog. A COPY to Files/,
// what is refused, two writes at once, and INSERTs into Delta tables, which the delta extension writes to their
// Delta log. The tables a run makes are dropped after, by the test's
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
const { TABLE_PROPERTIES } = require("../../core/sql.js");
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
  const lh = `${q(WS)}.${q(LH)}`;
  const tbl = (name, s = "test") => `${lh}.${q(s)}.${q(name)}`;
  const file = `lakeci/${run}.parquet`;
  const made = [];   // [schema, table] to drop after

  // The test's own DuckDB, which reads straight from the catalog what the engine wrote, and drops it after.
  const own = await DuckDBInstance.create(":memory:", { allow_unsigned_extensions: "true" });
  const c = await own.connect();
  for (const ext of ["iceberg", "azure", "httpfs", "delta"]) {
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

  // The engine gives every table it makes the properties of sql.js TABLE_PROPERTIES. A writer that ignores one looks
  // the same as one that keeps it, so what it wrote is read from the files' footers.
  await t.test("a new table is written as Direct Lake reads it best: its properties kept, its row groups in the millions", async () => {
    const lay = `${run}_layout`;
    made.push(["test", lay]);
    await sql(`CREATE TABLE ${tbl(lay)} AS SELECT i::BIGINT AS i, (i % 1000)::INTEGER AS k, 'row ' || (i % 100) AS s FROM range(5000000) r(i)`);
    const props = (await (await loadTable(prefix, "test", lay)).json()).metadata.properties || {};
    for (const [k, v] of Object.entries(TABLE_PROPERTIES)) assert.equal(props[k], v, `the table keeps ${k}`);
    const files = (await back(`SELECT DISTINCT file_path FROM iceberg_metadata(back.test.${q(lay)}) WHERE file_path ILIKE '%.parquet'`))
      .map(r => r.file_path);
    assert.ok(files.length, "it has data files");
    const groups = await back(`SELECT file_name, row_group_id, any_value(row_group_num_rows)::BIGINT AS n
      FROM parquet_metadata([${files.map(lit).join(", ")}]) GROUP BY ALL ORDER BY ALL`);
    const rows = groups.map(g => Number(g.n));
    console.log(`${lay}: ${files.length} file(s), row groups of ${rows.join(", ")} rows`);
    assert.equal(rows.reduce((a, b) => a + b, 0), 5_000_000, "every row is in a row group");
    // A row group closes near its budget, not at it: DuckDB flushes what each thread collected. So not 4M exactly,
    // only rows in the millions, as against DuckDB's default of 122,880 a group (some 41 for these 5M rows).
    assert.ok(5_000_000 / groups.length >= 1_000_000, `row groups of a million rows or more on average, not DuckDB's default: ${rows.join(", ")}`);  });

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
    await sql(`COPY (SELECT 7 AS seven) TO '${WS}.${LH}/Files/${file}' (FORMAT parquet)`);
    assert.deepEqual(norm(await back(`SELECT seven FROM read_parquet(${lit(`abfss://${WS}@${DFS}/${ITEM}/Files/${file}`)})`)), [{ seven: "7" }]);
    assert.deepEqual(norm(await sql(`SELECT seven FROM '${WS}.${LH}/Files/${file}'`)), [{ seven: "7" }]);
    assert.ok(written.some(w => w.kind === "files" && w.dir === "lakeci"), "its folder is listed again");
  });

  // The Delta tables written to: the plain case as lakeci_deltawrite, and a case of each Delta feature as
  // lakeci_dw_<case>, uploaded again for this test alone by each run (lake-tables.yml), so a write damages no table
  // another test reads. Each is written by DuckDB's delta extension, by its folder, and read back three ways: by
  // the engine through the lake, by delta_scan of the test's own DuckDB, and by the table's Delta log.
  const DW = "lakeci_deltawrite";
  const FEATURES = ["dv_packed", "column_mapping", "part_multi", "checkpoint", "types", "empty"].map(c => `lakeci_dw_${c}`);
  const folders = new Map();   // table -> its folder, from the catalog
  const deltaLog = async name => {
    const r = await fetch(`https://${DFS}/${encodeURIComponent(WS)}?resource=filesystem&recursive=false&directory=${encodeURIComponent(`${ITEM}/Tables/test/${name}/_delta_log`)}`,
      { headers: { ...auth, "x-ms-version": "2023-11-03" } });
    assert.ok(r.ok, `${name}'s _delta_log listing: ${r.status}`);
    return (await r.json()).paths.map(p => `${p.name.replace(/^.*\//, "")} ${p.contentLength}`).sort();
  };
  const commits = log => log.filter(l => /^\d{20}\.json /.test(l)).length;
  // Its rows as the Delta log has them, read by the delta extension itself.
  const deltaRows = async name => String((await back(`SELECT count(*)::BIGINT AS n FROM delta_scan(${lit(folders.get(name))})`))[0].n);
  const deltaState = async name => ({ log: await deltaLog(name), rows: await deltaRows(name) });
  const noneAttached = async () => assert.deepEqual(
    await sql("SELECT database_name FROM duckdb_databases() WHERE regexp_full_match(database_name, '(ice|delta)_[0-9a-f]{16}')"), [],
    "no write's catalog is left attached");

  await t.test("each Delta table to write to has its Iceberg face", async () => {
    const until = Date.now() + 5 * 60_000;
    for (const name of [DW, ...FEATURES]) {
      for (;;) {
        const r = await loadTable(prefix, "test", name);
        if (r.ok) {
          const body = await r.json();
          if (sourceFormat(body.metadata).format === "delta") {
            folders.set(name, body["metadata-location"].replace(/\/metadata\/[^/]+$/, "").replace(/^abfs:/, "abfss:"));
            break;
          }
        }
        if (r.status === 404 && name !== DW && !(await fetch(`https://${DFS}/${encodeURIComponent(WS)}?resource=filesystem&recursive=false&directory=${encodeURIComponent(`${ITEM}/Tables/test/${name}`)}`,
          { headers: { ...auth, "x-ms-version": "2023-11-03" } })).ok) { console.log(`${name}: not uploaded (its case wasn't made)`); break; }
        assert.ok(Date.now() < until, `${name} has no Iceberg face after 5 minutes: ${r.status}`);
        await new Promise(res => setTimeout(res, 10_000));
      }
    }
    assert.ok(folders.has(DW), `${DW} is a Delta table`);
  });

  // Past the engine: the test's own DuckDB, on the lakehouse's Iceberg catalog, writes to the Delta table's Iceberg
  // face, as any Iceberg client could. OneLake's face of a Delta table is read only, so it must refuse.
  await t.test("OneLake refuses an Iceberg write to a Delta table's Iceberg face", async () => {
    assert.ok(folders.has(DW), "the Delta table was read");
    const before = await deltaState(DW);
    for (const text of [
      `INSERT INTO back.test.${q(DW)} SELECT * FROM back.test.${q(DW)} LIMIT 1`,
      `DELETE FROM back.test.${q(DW)} WHERE true`,
    ]) {
      let said = null;
      try { await c.run(text); } catch (e) { said = e.message; }
      console.log(`OneLake on ${text}: ${said ?? "ACCEPTED"}`);
      assert.ok(said, `OneLake accepted ${text}`);
    }
    assert.deepEqual(await deltaState(DW), before, "the Delta table is as it was: no commit, the same rows");
  });

  await t.test("an INSERT into a Delta table is one more commit in its Delta log, read back at once", async () => {
    assert.ok(folders.has(DW), "the Delta table was read");
    const before = await deltaState(DW);
    assert.notEqual(before.rows, "0", `${DW} has rows`);
    await sql(`INSERT INTO ${tbl(DW)} SELECT * FROM ${tbl(DW)} LIMIT 3`);
    const after = await deltaState(DW);
    assert.equal(commits(after.log), commits(before.log) + 1, `one commit: ${after.log.join(", ")}`);
    assert.equal(after.rows, String(Number(before.rows) + 3), "three rows more, as the Delta log has them");
    assert.equal(String((await sql(`SELECT count(*)::BIGINT AS n FROM ${tbl(DW)}`))[0].n), after.rows, "the engine reads them at once");
    const cols = (await back(`DESCRIBE SELECT * FROM delta_scan(${lit(folders.get(DW))})`)).map(r => q(r.column_name)).join(", ");
    assert.deepEqual(norm(await sql(`SELECT ${cols} FROM ${tbl(DW)} ORDER BY ALL`)),
      norm(await back(`SELECT ${cols} FROM delta_scan(${lit(folders.get(DW))}) ORDER BY ALL`)), "the same rows as delta_scan");
    assert.ok(written.some(w => w.kind === "tables"), "its lakehouse's tables are listed again");
    await noneAttached();
  });

  await t.test("every other write to a Delta table is refused, and changes nothing", async () => {
    assert.ok(folders.has(DW), "the Delta table was read");
    const before = await deltaState(DW);
    const cols = (await back(`DESCRIBE SELECT * FROM delta_scan(${lit(folders.get(DW))})`)).map(r => r.column_name);
    const first = q(cols[0]);
    const only = new RegExp(`${DW} is a Delta table, and DuckDB's only write to a Delta table is INSERT`);
    for (const [text, why] of [
      [`UPDATE ${tbl(DW)} SET ${first} = ${first}`, only],
      [`DELETE FROM ${tbl(DW)} WHERE true`, only],
      [`MERGE INTO ${tbl(DW)} AS t USING (SELECT * FROM ${tbl(DW)} LIMIT 1) AS s ON t.${first} = s.${first} WHEN MATCHED THEN DELETE`, only],
      [`ALTER TABLE ${tbl(DW)} ADD COLUMN lakeci_extra INTEGER`, only],
      [`CREATE TABLE ${tbl(DW)} AS SELECT 1 AS id`, new RegExp(`${DW} is already there, as a Delta table`)],
    ]) await assert.rejects(engine.agentQuery(text), why, text);
    assert.deepEqual(await deltaState(DW), before, "the Delta table is as it was");
    await noneAttached();
  });

  // Each Delta feature's table, INSERTed into: what the delta extension can write, and that what it wrote reads.
  // What it can't write is refused, with nothing written: column mapping as Spark writes it is on writer version 5,
  // whose legacy features include checkConstraints, which delta-kernel doesn't write.
  const REFUSED = { lakeci_dw_column_mapping: /Feature 'checkConstraints' is not supported/ };
  for (const name of FEATURES) {
    await t.test(`an INSERT into ${name}`, async ctx => {
      if (!folders.has(name)) return ctx.skip("not uploaded");
      const before = await deltaState(name);
      const add = before.rows === "0" ? 0 : 2;
      let said = null;
      try { await sql(`INSERT INTO ${tbl(name)} SELECT * FROM ${tbl(name)} LIMIT ${add}`); }
      catch (e) { said = e.message; }
      const after = await deltaState(name);
      console.log(`${name}: ${said ? `refused — ${said}` : `written, ${before.rows} -> ${after.rows} rows`}`);
      await noneAttached();
      if (said) assert.deepEqual(after.log, before.log, `${name}: refused, and its log is as it was`);
      if (REFUSED[name]) {
        assert.match(String(said), REFUSED[name], `${name} is refused for what delta-kernel can't write`);
        assert.equal(after.rows, before.rows, `${name}: no rows added`);
        return;
      }
      assert.equal(said, null, `${name} is written`);
      assert.equal(after.rows, String(Number(before.rows) + add), `${name}: ${add} rows more, as its Delta log has them`);
      assert.equal(String((await sql(`SELECT count(*)::BIGINT AS n FROM ${tbl(name)}`))[0].n), after.rows, `${name}: the engine reads them at once`);
    });
  }

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
      ["INSERT INTO onelake.main.x SELECT 1", /engine's own/],
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
