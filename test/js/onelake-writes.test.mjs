// SQL's writes to a lakehouse, for real: the engine as a tab and the command line run it (engine-host.js runWrite),
// with its lockdown, against the CI lakehouse on fabriccat (ONELAKE_CI_WORKSPACE / ONELAKE_CI_LAKEHOUSE), on the
// CI identity's storage token (ONELAKE_TOKEN). Each of DuckDB's Iceberg writes, through the lakehouse's Iceberg
// catalog, held to DuckDB's own plan of it; a COPY to its Files/; and what is refused. What was written is read
// back on a DuckDB of the test's own, past the engine, and its tables dropped there after: the engine drops nothing.
// Skipped without those variables, set only by the lake's workflow.
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
const { createEngineHost } = require("../../core/engine/engine-host.js");
const { DuckDBInstance } = require("@duckdb/node-api");
const BUNDLED = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "duckdb-extensions");
const ICEBERG = "https://onelake.table.fabric.microsoft.com/iceberg";
const DFS = "onelake.dfs.fabric.microsoft.com";
const ITEM = `${LH}.Lakehouse`;
const q = s => `"${String(s).replace(/"/g, '""')}"`;
const lit = s => `'${String(s).replace(/'/g, "''")}'`;

// The lakehouse's GUIDs, as OneLake's Iceberg catalog gives them (catalog.js ircPrefixFor, sqltables.js lakehouseOf).
async function prefix() {
  const r = await fetch(`${ICEBERG}/v1/config?warehouse=${encodeURIComponent(`${WS}/${ITEM}`)}`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.ok(r.ok, `the Iceberg catalog's config: ${r.status}`);
  return (await r.json()).overrides.prefix;
}

test("SQL writes to a lakehouse on OneLake: each of DuckDB's Iceberg writes, a COPY to Files/, and what is refused", { skip, timeout: 600_000 }, async t => {
  const ids = await prefix();
  const [wsId, itemId] = String(ids).split("/");
  assert.match(String(ids), /^[0-9a-f-]{36}\/[0-9a-f-]{36}$/i, "the catalog names the item by its GUIDs");
  const extDir = await mkdtemp(join(tmpdir(), "onelake-ext-"));
  const warnings = [];
  const engine = createEngineHost({
    extensionDir: extDir, bundledExtensions: existsSync(BUNDLED) ? BUNDLED : null,
    getToken: async () => TOKEN,
    onWarn: w => warnings.push(w),
    resolveLakehouse: async ref => {
      assert.equal(String(ref.workspace).toLowerCase(), WS.toLowerCase());
      return { workspace: WS, item: ITEM, warehouse: `${wsId}/${itemId}`, scope: `abfss://${wsId}@${DFS}/` };
    },
    // Not in a listing here: no table is Delta, and every one is read back below, past the engine.
    resolveTable: async ref => { throw Object.assign(new Error(`${ref.table}: not listed in this test`), { noTable: true }); },
    resolveFile: async () => ({ workspace: WS, item: ITEM }),
  });
  const run = `w${Date.now().toString(36)}`;
  const five = name => `lakehouse.${q(WS)}.${q(LH)}.test.${q(name)}`;
  const three = name => `${q(WS)}.${q(LH)}.${q(name)}`;
  const file = `lakeci/${run}.parquet`;

  // The test's own DuckDB, which reads back what the engine wrote, and drops it after.
  const own = await DuckDBInstance.create(":memory:", { allow_unsigned_extensions: "true" });
  const c = await own.connect();
  for (const ext of ["iceberg", "azure", "httpfs"]) {
    const shipped = join(BUNDLED, `${ext}.duckdb_extension`).replace(/\\/g, "/");
    await c.run(existsSync(shipped) ? `LOAD ${lit(shipped)}` : `LOAD ${ext}`);
  }
  await c.run(`CREATE SECRET onelake (TYPE azure, PROVIDER access_token, ACCESS_TOKEN ${lit(TOKEN)})`);
  await c.run(`CREATE SECRET ice (TYPE iceberg, TOKEN ${lit(TOKEN)})`);
  await c.run(`ATTACH ${lit(`${wsId}/${itemId}`)} AS back (TYPE iceberg, URI ${lit(ICEBERG)}, SECRET ice,
    ACCESS_DELEGATION_MODE 'none', STAGE_CREATE_TABLES false, SKIP_CREATE_TABLE_METADATA_UPDATES true, DEFAULT_SCHEMA 'dbo')`);
  const rows = async sql => (await c.runAndReadAll(sql)).getRowObjectsJson();

  t.after(async () => {
    for (const x of [`back.test.${q(`${run}_a`)}`, `back.dbo.${q(`${run}_b`)}`]) await c.run(`DROP TABLE IF EXISTS ${x}`).catch(() => {});
    await fetch(`https://${DFS}/${WS}/${ITEM}/Files/${file}`, { method: "DELETE", headers: { authorization: `Bearer ${TOKEN}`, "x-ms-version": "2023-11-03" } }).catch(() => {});
    c.closeSync();
    await engine.close();
    await rm(extDir, { recursive: true, force: true }).catch(() => {});
  });

  const a = five(`${run}_a`);
  const say = async (sql, expect) => {
    const t0 = Date.now();
    const res = await engine.agentQuery(sql);
    console.log(`${Date.now() - t0}ms  ${sql.split("\n")[0].slice(0, 100)}  ->  ${JSON.stringify(res.rows).slice(0, 120)}`);
    if (expect) expect(res);
    return res;
  };

  await t.test("CREATE TABLE, then INSERT", async () => {
    await say(`CREATE TABLE ${a} (id INTEGER, name VARCHAR)`);
    await say(`INSERT INTO ${a} VALUES (1, 'a'), (2, 'b'), (3, 'c')`);
    assert.deepEqual(await rows(`SELECT id, name FROM back.test.${q(`${run}_a`)} ORDER BY id`), [{ id: 1, name: "a" }, { id: 2, name: "b" }, { id: 3, name: "c" }]);
  });

  await t.test("UPDATE, DELETE and MERGE INTO", async () => {
    await say(`UPDATE ${a} SET name = 'B' WHERE id = 2`);
    await say(`DELETE FROM ${a} WHERE id = 3`);
    await say(`MERGE INTO ${a} t USING (SELECT 1 AS id, 'A' AS name UNION ALL SELECT 4, 'd') s ON t.id = s.id
      WHEN MATCHED THEN UPDATE SET name = s.name WHEN NOT MATCHED THEN INSERT VALUES (s.id, s.name)`);
    assert.deepEqual(await rows(`SELECT id, name FROM back.test.${q(`${run}_a`)} ORDER BY id`), [{ id: 1, name: "A" }, { id: 2, name: "B" }, { id: 4, name: "d" }]);
  });

  await t.test("ALTER TABLE", async () => {
    await say(`ALTER TABLE ${a} ADD COLUMN n INTEGER`);
    assert.deepEqual((await rows(`DESCRIBE back.test.${q(`${run}_a`)}`)).map(r => r.column_name), ["id", "name", "n"]);
  });

  await t.test("CREATE TABLE AS, by the three-part name: dbo", async () => {
    await say(`CREATE TABLE ${three(`${run}_b`)} AS SELECT 42 AS answer`);
    assert.deepEqual(await rows(`SELECT answer FROM back.dbo.${q(`${run}_b`)}`), [{ answer: 42 }]);
  });

  await t.test("COPY to the lakehouse's Files/", async () => {
    await say(`COPY (SELECT 7 AS seven) TO 'lakehouse.${WS}.${LH}/Files/${file}' (FORMAT parquet)`);
    assert.deepEqual(await rows(`SELECT seven FROM read_parquet(${lit(`abfss://${WS}@${DFS}/${ITEM}/Files/${file}`)})`), [{ seven: 7 }]);
  });

  await t.test("several at once from the command line's way in: each, in turn", async () => {
    // agentQuery runs one statement; the command line splits them (agent.js), as the page does.
    await say(`INSERT INTO ${a} VALUES (5, 'e', NULL)`);
    assert.equal((await rows(`SELECT count(*)::INTEGER AS n FROM back.test.${q(`${run}_a`)}`))[0].n, 4);
  });

  await t.test("what is refused writes nothing", async () => {
    await assert.rejects(engine.agentQuery(`DROP TABLE ${a}`), /DROP is blocked/);
    await assert.rejects(engine.agentQuery(`CREATE OR REPLACE TABLE ${a} AS SELECT 1 AS id`), /CREATE OR REPLACE isn't/);
    await assert.rejects(engine.agentQuery(`INSERT INTO memory.main.x SELECT 1`), /engine's own/);
    await assert.rejects(engine.agentQuery(`COPY (SELECT 1) TO 'x.csv'`), /COPY writes to a lakehouse's Files/);
    assert.equal((await rows(`SELECT count(*)::INTEGER AS n FROM back.test.${q(`${run}_a`)}`))[0].n, 4);
    // Nothing of a write's catalog is left attached.
    const left = (await engine.agentQuery("SELECT database_name FROM duckdb_databases() WHERE starts_with(database_name, 'ice_')")).rows;
    assert.deepEqual(left, []);
  });

  console.log(warnings.length ? `warnings:\n${warnings.join("\n")}` : "no warnings");
});
