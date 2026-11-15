// A big write, as a user runs one: through the engine's server process (engine-server.js), over Quack, from a
// window joined to it, against the CI lakehouse. onelake-writes.test.mjs runs every kind of write on an engine in
// its own process and with a few rows; this one runs the coffee benchmark's tables at LAKECI_COFFEE_ROWS orders
// (20 million unless set), which is the statement a server on a user's machine died under with no word in its log.
//
// What is held to: the write finishes, the server that started it is the one that answers after it (same pid, no
// window told it went, nothing in its log about stopping), it answers its windows while the write runs, a write
// that is stopped leaves it answering, and one with too little memory either finishes or says so and leaves it
// answering. What is printed, for whoever reads the run: the server's peak memory, how long its windows waited
// for it, DuckDB's own log's size, and the Parquet it wrote (files, row groups, encodings), for a table with the
// engine's properties and for one with a 128 MB file target.
// Skipped without the lake workflow's variables.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const { ONELAKE_TOKEN: TOKEN, ONELAKE_CI_WORKSPACE: WS, ONELAKE_CI_LAKEHOUSE: LH } = process.env;
const skip = !(TOKEN && WS && LH) && "ONELAKE_TOKEN, ONELAKE_CI_WORKSPACE and ONELAKE_CI_LAKEHOUSE are set only by the lake's workflow";
if (skip && process.env.NO_SKIP) throw new Error(skip);
const ORDERS = Math.max(1000, Number(process.env.LAKECI_COFFEE_ROWS) || 20_000_000);

const require = createRequire(import.meta.url);
// Loaded only when it runs: npm test's job has no DuckDB.
const { createEngineHost } = skip ? {} : require("../../core/engine/engine-host.js");
const { createRemote } = skip ? {} : require("../../core/engine/engine-client.js");
const { DuckDBInstance } = skip ? {} : require("@duckdb/node-api");
const { sourceFormat } = require("../../core/names.js");
const { TABLE_PROPERTIES, statementsOf } = require("../../core/sql.js");
const here = fileURLToPath(new URL(".", import.meta.url));
const SCRIPT = join(here, "..", "..", "core", "engine", "engine-server.js");
const BUNDLED = join(here, "..", "..", "duckdb-extensions");
const COFFEE = join(here, "..", "fixtures", "coffee", "coffee.sql");
const ICEBERG = "https://onelake.table.fabric.microsoft.com/iceberg";
const DFS = "onelake.dfs.fabric.microsoft.com";
const ITEM = `${LH}.Lakehouse`;
const WAREHOUSE = `${WS}/${ITEM}`;
const q = s => `"${String(s).replace(/"/g, '""')}"`;
const lit = s => `'${String(s).replace(/'/g, "''")}'`;
const auth = { authorization: `Bearer ${TOKEN}` };
const MB = n => `${Math.round(Number(n) / 1048576)} MB`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function prefixOf() {
  const r = await fetch(`${ICEBERG}/v1/config?warehouse=${encodeURIComponent(WAREHOUSE)}`, { headers: auth });
  assert.ok(r.ok, `the Iceberg catalog's config: ${r.status}`);
  return (await r.json()).overrides.prefix;
}
const loadTable = (prefix, schema, table) =>
  fetch(`${ICEBERG}/v1/${prefix}/namespaces/${encodeURIComponent(schema)}/tables/${encodeURIComponent(table)}`, { headers: auth });
// A table as the store resolves one, always asked of OneLake (onelake-writes.test.mjs resolverFor).
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

// The most memory the process has held, as its system counts it; null where it can't be asked.
function peakMemory(pid) {
  try {
    if (process.platform === "win32") {
      return Number(execFileSync("powershell", ["-NoProfile", "-Command", `(Get-Process -Id ${pid}).PeakWorkingSet64`], { encoding: "utf8" }).trim()) || null;
    }
    const kb = /VmHWM:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
    return kb ? Number(kb[1]) * 1024 : null;
  } catch (_) { return null; }
}
const within = (p, ms) => {
  let timer;
  return Promise.race([p.then(v => ({ v }), e => ({ e })), new Promise(r => { timer = setTimeout(() => r({ late: true }), ms); })])
    .finally(() => clearTimeout(timer));
};

// A server of its own and windows joined to it, as engines.js makes them: the lake and its file cache on, every
// core, no memory limit unless one is given, and the server's own self-check.
async function server(t, prefix, wsId, more = {}) {
  const dir = await mkdtemp(join(tmpdir(), "onelake-bigwrite-"));
  let secret;
  const options = { extensionDir: join(dir, "extensions"), bundledExtensions: existsSync(BUNDLED) ? BUNDLED : null,
                    fileCacheDir: join(dir, "cache"), fileCacheMaxBytes: 20e9, lakeFolder: "lake", ...more };
  const gone = [], warnings = [];
  const open = () => {
    const window = createEngineHost({
      ...options,
      getToken: async () => TOKEN,
      onWarn: w => warnings.push(w),
      tableWritesAllowed: () => true, dropAllowed: () => false, copyAllowed: () => true,
      resolveLakehouse: async () => ({ workspace: WS, item: ITEM, warehouse: WAREHOUSE,
        scopes: [WS, ...(wsId ? [wsId] : [])].flatMap(w => [`abfss://${w}@${DFS}/`, `abfs://${w}@${DFS}/`]) }),
      resolveTable: resolverFor(prefix),
      resolveFile: async () => ({ workspace: WS, item: ITEM }),
      remote: createRemote({ key: `bigwrite-${dir}`, script: SCRIPT, options, stateDir: join(dir, "state"), idleMs: 60_000,
        getToken: async () => secret, setToken: async s => { secret = s; }, onGone: () => gone.push(window) }),
    });
    t.after(() => window.close({ stop: true }).catch(() => {}));
    return window;
  };
  t.after(() => rm(dir, { recursive: true, force: true }).catch(() => {}));
  const log = () => {
    const state = join(dir, "state");
    const f = existsSync(state) && readdirSync(state).find(n => n.endsWith(".log"));
    return f ? readFileSync(join(state, f), "utf8") : "";
  };
  const a = open(), b = open();
  const first = await a.stats();
  console.log(`server pid ${first.pid}: memory limit ${first.memoryLimit}, ${first.threads} threads`);

  // The server is the one that started, and answers: asked after everything that could have ended it.
  const alive = async what => {
    const bad = log().split("\n").filter(l => /\b(stopping:|ended:|stuck:)/.test(l));
    assert.deepEqual(bad, [], `${what}: the server's log says it went`);
    assert.equal(gone.length, 0, `${what}: a window was told its server went`);
    const got = await within(b.agentQuery("SELECT 1 AS up"), 120_000);
    assert.ok(!got.late && !got.e, `${what}: the server answers a SELECT 1${got.e ? ` — ${got.e.message}` : got.late ? " — nothing in 2 minutes" : ""}`);
    const now = await within(a.stats(), 120_000);
    assert.ok(now.v, `${what}: the server says how it is${now.e ? ` — ${now.e.message}` : ""}`);
    assert.equal(now.v.pid, first.pid, `${what}: the server is the one that started`);
  };

  // A statement on window a, with window b asking the server how it is, and a SELECT of its own, every 5 s.
  const watched = async (what, text, { signal } = {}) => {
    let on = true, slowest = 0, late = 0, most = 0, asked = 0;
    const watching = (async () => {
      while (on) {
        const t0 = Date.now();
        const [s, one] = await Promise.all([within(b.stats(), 120_000), within(b.agentQuery("SELECT 42 AS n"), 120_000)]);
        asked++;
        if (s.late || one.late) late++;
        if (s.v) most = Math.max(most, Number(s.v.memoryBytes) || 0);
        slowest = Math.max(slowest, Date.now() - t0);
        for (let i = 0; on && i < 50; i++) await sleep(100);
      }
    })();
    const t0 = Date.now();
    let res = null, error = null;
    try { res = await a.agentQuery(text, { signal }); } catch (e) { error = e; }
    on = false;
    await watching;
    console.log(`${what}: ${error ? `failed (${String(error.message).slice(0, 200)})` : JSON.stringify(res.rows).slice(0, 80)} in ${((Date.now() - t0) / 1000).toFixed(1)} s; `
      + `asked ${asked} times while it ran, slowest answer ${slowest} ms, ${late} unanswered in 2 minutes; DuckDB's memory at most ${MB(most)}, `
      + `the server's peak ${peakMemory(first.pid) == null ? "unknown" : MB(peakMemory(first.pid))}`);
    return { res, error, late };
  };
  return { a, b, alive, watched, log, warnings, pid: first.pid };
}

test("a big write through the engine's server, and the server after it", { skip, timeout: 3_300_000 }, async t => {
  const prefix = await prefixOf();
  const known = await (await loadTable(prefix, "test", "lakeci_plain")).json();
  const wsId = (/^abfss?:\/\/([0-9a-f-]{36})@/i.exec(known["metadata-location"]) || [])[1] || null;
  const run = `s${process.platform.slice(0, 3)}${Date.now().toString(36)}`;
  const lh = `${q(WS)}.${q(LH)}`;
  const tbl = name => `${lh}."test".${q(name)}`;
  const made = [];
  const file = `lakeci/${run}_sales.parquet`;

  // The test's own DuckDB, which reads from the catalog what the server wrote, and drops it after.
  const own = await DuckDBInstance.create(":memory:", { allow_unsigned_extensions: "true" });
  const c = await own.connect();
  for (const ext of ["iceberg", "azure", "httpfs"]) {
    const shipped = join(BUNDLED, `${ext}.duckdb_extension`).replace(/\\/g, "/");
    await c.run(existsSync(shipped) ? `LOAD ${lit(shipped)}` : `LOAD ${ext}`);
  }
  await c.run(`CREATE SECRET onelake (TYPE azure, PROVIDER access_token, ACCESS_TOKEN ${lit(TOKEN)})`);
  await c.run(`CREATE SECRET ice (TYPE iceberg, TOKEN ${lit(TOKEN)})`);
  await c.run(`ATTACH ${lit(WAREHOUSE)} AS back (TYPE iceberg, URI ${lit(ICEBERG)}, SECRET ice,
    ACCESS_DELEGATION_MODE 'none', STAGE_CREATE_TABLES false, SKIP_CREATE_TABLE_METADATA_UPDATES true, DEFAULT_SCHEMA 'dbo')`);
  const back = async sql => (await c.runAndReadAll(sql)).getRowObjectsJson();
  t.after(async () => {
    for (const n of made) await c.run(`DROP TABLE IF EXISTS back.test.${q(n)}`).catch(e => console.log(`left test.${n}: ${e.message}`));
    await fetch(`https://${DFS}/${WS}/${ITEM}/Files/${file}`, { method: "DELETE", headers: { ...auth, "x-ms-version": "2023-11-03" } }).catch(() => {});
    c.closeSync();
  });

  // The Parquet a table is made of, read from its files' footers: printed, and its rows counted.
  const layout = async name => {
    const files = (await back(`SELECT DISTINCT file_path FROM iceberg_metadata(back.test.${q(name)}) WHERE file_path ILIKE '%.parquet'`)).map(r => r.file_path);
    assert.ok(files.length, `${name} has data files`);
    const list = `[${files.map(lit).join(", ")}]`;
    const groups = await back(`SELECT file_name, row_group_id, any_value(row_group_num_rows)::BIGINT AS n,
      sum(total_compressed_size)::BIGINT AS packed, sum(total_uncompressed_size)::BIGINT AS raw
      FROM parquet_metadata(${list}) GROUP BY ALL ORDER BY ALL`);
    const perFile = new Map();
    for (const g of groups) {
      const f = perFile.get(g.file_name) || { groups: [], packed: 0 };
      f.groups.push(Number(g.n));
      f.packed += Number(g.packed);
      perFile.set(g.file_name, f);
    }
    console.log(`${name}: ${files.length} file(s), ${groups.length} row group(s)`);
    for (const f of perFile.values()) console.log(`  a file of ${MB(f.packed)}: row groups of ${f.groups.join(", ")} rows`);
    console.log(`  a row group's bytes before compression: ${groups.map(g => MB(g.raw)).join(", ")}`);
    const cols = await back(`SELECT path_in_schema AS col, count(*)::INTEGER AS chunks,
      (count(*) FILTER (WHERE encodings NOT ILIKE '%DICTIONARY%'))::INTEGER AS plain, string_agg(DISTINCT encodings, ' | ') AS encodings
      FROM parquet_metadata(${list}) GROUP BY ALL ORDER BY ALL`);
    for (const k of cols) console.log(`  ${k.col}: ${k.plain} of ${k.chunks} chunk(s) with no dictionary (${k.encodings})`);
    const rows = groups.reduce((n, g) => n + Number(g.n), 0);
    return { files: files.length, groups: groups.map(g => Number(g.n)), rows, sizes: [...perFile.values()].map(f => f.packed) };
  };

  const names = { dim_locations: `${run}_locations`, dim_products: `${run}_products`, fact_sales: `${run}_sales` };
  made.push(...Object.values(names));
  const coffee = statementsOf(readFileSync(COFFEE, "utf8").replace(/getvariable\('num_rows'\)/g, String(ORDERS))
    .replace(/\b(dim_locations|dim_products|fact_sales)\b/g, (_, n) => tbl(names[n]))).slice(0, 3);
  const s = await server(t, prefix, wsId);
  t.after(() => console.log(s.warnings.length ? `the server's windows warned:\n${s.warnings.join("\n")}` : "no warnings"));
  let lines = 0;

  await t.test(`the coffee benchmark's tables at ${ORDERS} orders`, async () => {
    for (const st of coffee.slice(0, 2)) await s.a.agentQuery(st);
    // DuckDB's own log, which the server keeps in memory and reads on a timer: how much a big write adds to it.
    const logRows = () => s.a.agentQuery("SELECT count(*)::BIGINT AS n FROM duckdb_logs").then(r => r.rows[0].n, e => `unread (${e.message.slice(0, 80)})`);
    const logBefore = await logRows();
    const { error, late } = await s.watched("fact_sales", coffee[2]);
    await s.alive("after the big CREATE TABLE AS");
    assert.equal(error, null, "the big CREATE TABLE AS ran");
    assert.equal(late, 0, "the server answered its other window while the write ran");
    console.log(`DuckDB's log held ${logBefore} rows before the write and ${await logRows()} after`);
    const [theirs] = await back(`SELECT count(*)::BIGINT AS n FROM back.test.${q(names.fact_sales)}`);
    lines = Number(theirs.n);
    assert.ok(lines >= ORDERS, `an order has a line or more: ${lines}`);
    const [mine] = (await s.a.agentQuery(`SELECT count(*)::BIGINT AS n FROM ${tbl(names.fact_sales)}`)).rows;
    assert.equal(String(mine.n), String(theirs.n), "the server reads, by the table's name, every row the catalog holds");
    await s.alive("after reading the table back");
  });

  await t.test("the Parquet it wrote: the engine's properties, and row groups in the millions", async () => {
    const props = (await (await loadTable(prefix, "test", names.fact_sales)).json()).metadata.properties || {};
    for (const [k, v] of Object.entries(TABLE_PROPERTIES)) assert.equal(props[k], v, `the table keeps ${k}`);
    const lay = await layout(names.fact_sales);
    assert.equal(lay.rows, lines, "every row is in a row group");
    assert.ok(lay.rows / lay.groups.length >= 1_000_000, `row groups of a million rows or more on average: ${lay.groups.join(", ")}`);
  });

  // What a 128 MB file target does to the same rows, read from the big table through the lake: printed, to be read
  // against the layout above. Nothing of its shape is held to: it is DuckDB-Iceberg's to decide.
  await t.test("the same rows with a 128 MB file target, read from the table just written", async () => {
    const small = `${run}_sales128`;
    made.push(small);
    const { error } = await s.watched("fact_sales, 128 MB files", `CREATE TABLE ${tbl(small)} WITH ('write.target-file-size-bytes' = '134217728') AS SELECT * FROM ${tbl(names.fact_sales)}`);
    await s.alive("after a CREATE TABLE AS that reads a big table");
    assert.equal(error, null, "it ran");
    const lay = await layout(small);
    assert.equal(lay.rows, lines, "every row is in a row group");
  });

  await t.test("a big COPY to Files/, and a table made from that file", async () => {
    const copied = await s.watched("COPY to Files/", `COPY (SELECT * FROM ${tbl(names.fact_sales)}) TO '${WS}.${LH}/Files/${file}' (FORMAT parquet)`);
    await s.alive("after a big COPY to Files/");
    assert.equal(copied.error, null, "the COPY ran");
    const fromFile = `${run}_fromfile`;
    made.push(fromFile);
    const { error } = await s.watched("CREATE TABLE AS from the file", `CREATE TABLE ${tbl(fromFile)} AS SELECT * FROM '${WS}.${LH}/Files/${file}'`);
    await s.alive("after a CREATE TABLE AS from a big file");
    assert.equal(error, null, "it ran");
    const [theirs] = await back(`SELECT count(*)::BIGINT AS n FROM back.test.${q(fromFile)}`);
    assert.equal(Number(theirs.n), lines, "every row of the file is in the table");
  });

  await t.test("a write that is stopped leaves the server answering", async () => {
    const stopped = `${run}_stopped`;
    made.push(stopped);
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 10_000).unref();
    const { error } = await s.watched("a write stopped after 10 s",
      `CREATE TABLE ${tbl(stopped)} AS SELECT i, md5(i::VARCHAR) AS m FROM range(2000000000) r(i)`, { signal: stop.signal });
    assert.ok(error, "it ended as stopped, not as done");
    await s.alive("after a stopped write");
  });

  // A server with far less memory than the write wants: it may finish (DuckDB spills) or say it ran out, and
  // either way it is still there.
  await t.test("the same write on a server with 2 GB: done or refused in words, and the server answers", async () => {
    const tight = await server(t, prefix, wsId, { memoryLimit: "2GB" });
    const low = `${run}_sales2gb`;
    made.push(low);
    const { error } = await tight.watched("fact_sales on 2 GB", coffee[2].replace(tbl(names.fact_sales), tbl(low)));
    if (error) assert.match(error.message, /memory/i, "what it says is that memory ran out");
    await tight.alive("after a write with too little memory");
    console.log(tight.warnings.length ? `the 2 GB server's windows warned:\n${tight.warnings.join("\n")}` : "no warnings on 2 GB");
  });
});
