// =============================================================================
// data.js — DataSource: the catalog's tables, read by DuckDB-WASM from a local store
// =============================================================================
// The Iceberg backend of Export to Fabric's app (OneLake Studio). Its inputs are the semantic
// model and a OneLake Iceberg catalog, nothing else: no import, no file written for it. The
// model is the site's own, model.json, made by the export from the model.yaml the app's file
// holds: the app runs on the model as exported. The app's function answers where each of its
// tables is now and a read-only SAS (catalog.js). The model names the tables (an Ossie dataset's
// `source`, or a TMSL table's Direct Lake partition: schema.table).
// The page is the only thing that reads OneLake, and the SAS never leaves it: it plans each
// table itself (metadata.json, manifest list, manifests: prefetch.js's planTable) and
// downloads what a query reads into the local store (OPFS, blockcache.js) before the query
// runs. DuckDB reads only that store, by names registered to
// https://store.local/... (duckdb-wasm's own file system): no httpfs, no SAS in any view, and
// its worker refuses every other request (blockcache.js). The engine is duckdb-wasm's npm
// release (DuckDB 2.0), with two of DuckDB's signed extensions: parquet, and icu for time
// zones (TIMESTAMPTZ). All of it ships with the site, in vendor/ (core/vendored.js, WEBAPP):
// nothing is loaded from a CDN or DuckDB's repository.
//
// A table is opened when a query first names its view, v_<table>, so the first paint pays only
// for the tables it reads. Opening it: its record (the snapshot's live data and delete files),
// planned by the page at load, or kept from an earlier visit in this browser (snapshots.js,
// keyed by the metadata location the function gave: a commit always writes a new one); then
// what the store lacks downloaded, six at a time; then its view, on each engine. A table whose
// files are small (SMALL_BYTES, from its metadata.json) comes down whole and is copied into the
// engine's memory, and its view reads that. A larger one is read in place, read_parquet over
// its files, and only what its queries read comes down (ranges.js): each file's footer, from
// which DuckDB gives the table's layout (parquet_metadata, the byte range of each column in each
// row group), then the chunks of the columns a query names, before it runs, the ones the store
// holds left out. Should DuckDB still read bytes the store lacks, the store says which
// ({ miss }): the page downloads them, with the columns they are of, and runs the query again.
// A table's position deletes are applied by its view; its delete files come down whole. A
// table the page cannot plan, or that a view cannot read (equality deletes, a deletion vector),
// fails: there is no other way in.
// Only the tables a query names are downloaded and opened: none in the background, as a
// slow connection would spend itself on tables no chart reads.
// Each view is at the snapshot the catalog named (catalog.js keeps that answer up to ~55
// minutes, so a reload within it reads the same snapshots).
// DuckDB-WASM runs single-threaded here, so the page runs a pool of engines (ENGINES, each its
// own worker and memory: half the machine's cores, 2 at least and 4 at most; `?engines=N` in the
// URL, 1 to 4, to compare), fed by one queue: a free engine takes the next query, so a
// render's queries run side by side and a long one holds up only its own engine. A table is planned
// and its files downloaded once, whichever engine opens it first; each engine then has its own
// view (and its own copy of a small table). All the workers share the store.
// A query's scan of a large table is shared out between the engines, each over its share of the
// files, and the rest of it run by one (split.js): about four times faster on four engines
// (3.6 GB, 2026-11-11). Only a table of ten million rows or more: a smaller one's scan is too short
// to win back what sharing it out costs. `?split=0` in the URL runs every query whole, to compare.
//
// The members the page calls:
//   init            sign in, locate the tables, size them; nothing opened yet
//   model, query
// =============================================================================

import * as duckdb from "../vendor/npm/@duckdb/duckdb-wasm@1.33.1-dev114.0/+esm.js";
import { engineQueue } from "./queue.js";
import { SETTINGS, DIRECT_IO, openEngine } from "./session.js";
import { createResults } from "./results.js";
import { createAuth } from "./auth.js";
import { createCatalog } from "./catalog.js";
import { createSnapshots } from "./snapshots.js";
import { createKv } from "./kv.js";
import { planTable, prefetchFiles, prioritize } from "./prefetch.js";
import { columnsIn, readsAll, columnRanges, tailOf, piecesOf } from "./ranges.js";
import { splitPlan, carried } from "./split.js";
import { quoteIdent as ident, sqlStr as lit } from "../paths.js";

const SMALL_BYTES = 32 * 1024 * 1024;   // a table up to this much Parquet is copied into memory
// How many times a query is run again after the store said it lacked bytes it read: each time
// downloads what was missed, with whole columns, so a query needs one or two at most.
const HEALS = 8;
const BATCH_MS = 20;   // how long a larger table's new columns gather into one download
// The site's own copy of the engine (vendor/, core/vendored.js WEBAPP), the base build: the page
// needs Chrome or Edge 121+, which always runs it.
const VENDOR = new URL('../vendor/', import.meta.url).href;
const WASM = `${VENDOR}npm/@duckdb/duckdb-wasm@1.33.1-dev114.0/dist/`;
const BUNDLE = { mainModule: `${WASM}duckdb-base.wasm`, mainWorker: `${WASM}duckdb-browser-base.worker.js`, pthreadWorker: null };
// The DuckDB that build is: its extensions are vendored under this version, and an engine that
// says another would ask for files the site does not have.
const DUCKDB = 'v2.0.0';
// The extensions DuckDB installs, from the site's own repository (vendor/duckdb-ext): Parquet,
// and icu for time zones (TIMESTAMPTZ). No httpfs: DuckDB reads only the local store.
const EXTENSIONS = ['parquet', 'icu'];
const EXT_REPO = `${VENDOR}duckdb-ext`;
// The local store DuckDB reads from, and its worker's only way out (blockcache.js).
const BLOCKCACHE = new URL('./blockcache.js' + new URL(import.meta.url).search, import.meta.url).href;
// The model, the site's own (fabric_app/export/exportapp.js, setModel), of this build.
const MODEL_JSON = new URL("../model.json" + new URL(import.meta.url).search, import.meta.url).href;
const ENGINES = (() => {
  try { const n = Number(new URLSearchParams(location.search).get('engines')); if (n >= 1 && n <= 4) return Math.floor(n); } catch (e) {}
  // Half the cores: the page, the store's worker and the browser need the rest. Four engines shared a scan
  // out about four times faster than one; eight, little more than four.
  let cores = 4; try { cores = navigator.hardwareConcurrency || 4; } catch (e) {}
  return Math.min(4, Math.max(2, Math.floor(cores / 2)));
})();
// A table's scan is shared out between the engines (split.js) when it has SPLIT_ROWS rows or more: sharing
// out costs about 0.1 s whatever the table (the answers cross between engines), which a table of 4 million
// rows did not win back, and one of tens of millions won back many times over (2026-11-11).
// `?split=N` in the URL: tables of N rows or more instead; `?split=0`, none. With `split` in the URL at
// all, no result is read back from this browser and each query's time is written to the console, to compare.
const SPLIT_ASKED = (() => { try { return new URLSearchParams(location.search).get('split'); } catch (e) { return null; } })();
const SPLIT_ROWS = SPLIT_ASKED == null || !(Number(SPLIT_ASKED) >= 0) ? 10_000_000 : Number(SPLIT_ASKED);
const SPLIT = SPLIT_ROWS > 0, TIMED = SPLIT_ASKED != null;
const STORE_WAIT = 30000;   // how long the page waits for the store's writer to answer

// An Ossie dataset's table as schema.table, or null when it reads none. `source` is required
// by the spec, so a model from Power BI has one even for a calculation group or a calculated
// table: its partition, kept in the POWER_BI extension, says it has no entity. A bare name is
// in dbo, as in a TMSL partition; item.schema.table is its last two parts.
function ossieSource(d) {
  const pbi = (d.custom_extensions ?? []).find(e => String(e.vendor_name).toUpperCase() === 'POWER_BI');
  let partition;
  try { partition = JSON.parse(pbi.data).partitions?.[0]; } catch { /* no extension: its source alone */ }
  if (!d.source || (partition && !partition.source?.entityName)) return null;
  const s = String(d.source);
  // A table named <item>.<schema>.<table>, in the lakehouse the app reads: its schema.table.
  const parts = (s.match(/"(?:[^"]|"")*"|[^.]+/g) ?? []).map(p => (p.startsWith('"') ? p.slice(1, -1).replace(/""/g, '"') : p));
  if (parts.length === 3) return `${parts[1]}.${parts[2]}`;
  return s.includes('.') ? s : `dbo.${s}`;
}

// The model's tables: name -> { source: schema.table, columns }. Ossie: a dataset's table
// and its fields' columns. TMSL (model.bim): a table's Direct Lake partition and its columns.
function modelTables(model) {
  const out = new Map();
  const column = f => f.expression?.dialects?.[0]?.expression ?? f.name;
  for (const d of model.datasets ?? []) {
    const source = ossieSource(d);
    if (source) out.set(d.name, { source, columns: new Set((d.fields ?? []).map(column)) });
  }
  for (const t of (model.model ?? model).tables ?? []) {
    const s = t.partitions?.[0]?.source;
    if (s?.entityName) out.set(t.name, { source: `${s.schemaName ?? 'dbo'}.${s.entityName}`,
      columns: new Set((t.columns ?? []).map(c => c.sourceColumn ?? c.name)) });
  }
  return out;
}

// A OneLake file, abfss://<ws>@onelake.dfs.fabric.microsoft.com/<lh>/..., as
//   https    the URL the page downloads it with (the SAS: the page's alone);
//   storePath its key in the store (blockcache.js), the URL without the SAS;
//   localName the name DuckDB reads it by, registered to localUrl, which the store answers.
// Some writers name the same file abfs:// (no s): one file either way.
const ABFSS = /^abfss?:\/\/([^@/]+)@([^/]+)\//;
// The SAS is per table, by its folder under Tables/: the one this file is in.
function sasOf(abfss, sas) {
  const under = String(abfss).split('/Tables/')[1] ?? '';
  const folder = Object.keys(sas ?? {}).find(f => under.startsWith(`${f}/`));
  if (!folder) throw new Error(`${abfss} is not in a table this app reads`);
  return sas[folder];
}
const https = (abfss, sas) => `${abfss.replace(ABFSS, 'https://$2/$1/')}?${sasOf(abfss, sas)}`;
const storePath = abfss => abfss.replace(ABFSS, 'https://$2/$1/');
const localName = abfss => abfss.replace(ABFSS, 'store/$1/');
const localUrl = abfss => abfss.replace(ABFSS, 'https://store.local/$1/');

// DuckDB downloads its extensions one at a time. On a browser's first load the page fetches
// them all at once, as soon as the engine says its version, into the browser's cache, where
// DuckDB's own request finds them. After that the store answers DuckDB (blockcache.js), and the
// page fetches nothing (the version it loaded is remembered).
const EXT_KEY = 'duckdb_extensions';
const extensionUrl = (version, e) => `${EXT_REPO}/${version}/wasm_eh/${e}.duckdb_extension.wasm`;
function warmExtensions(version) {
  let known = null; try { known = localStorage.getItem(EXT_KEY); } catch (e) {}
  if (known === version) return;
  Promise.all(EXTENSIONS.map(e => fetch(extensionUrl(version, e)).then(r => r.arrayBuffer())))
    .catch(() => {});
}

// onProgress({ label, done, total, detail }) while a long download runs, null when it ends.
export function createDataSource({ onStatus = () => {}, onProgress = () => {} } = {}) {
  // The function's answer and the snapshot records, kept in IndexedDB (kv.js); the keys
  // localStorage held them under are moved over on the first load.
  const kv = createKv('iceberg-app', { legacy: { catalog: 'rayfin_catalog', snapshots: 'iceberg_snapshots' } });
  const catalog = createCatalog(() => auth.client(), kv);
  const snapshots = createSnapshots(kv);
  // A kept answer from the function needs no session: the page starts without the Rayfin SDK.
  const auth = createAuth({ ready: catalog.fresh });
  let tables = new Map(), model = null;
  // table name -> { location, bytes, planning, record, stored, ready, layout, coming,
  // gathering, downloading }. `ready`: the table's record, and in the store a small table's
  // files, or a larger one's footers and its layout ({ columns, rows, files: path -> { size, chunks } }):
  // once for every engine. `coming`: each column (lowercase) a larger table's queries named, its
  // download; `gathering`, the batch of them not started yet, and `downloading`, the last one.
  const located = new Map();
  const small = t => t.bytes != null && t.bytes <= SMALL_BYTES;

  // The engines: each its worker, connection, the tables opened on it (`opened`: name ->
  // promise of its opening) and the files registered on it. One queue feeds them all
  // (queue.js); of the free engines, a query goes to the one with more of its tables open.
  let engines = [];
  const queue = engineQueue({ pick: (job, free) => free.reduce((a, b) =>
    (job.names ?? []).filter(n => b.opened.has(n)).length > (job.names ?? []).filter(n => a.opened.has(n)).length ? b : a) });
  const submit = queue.submit;
  const q = (e, sql) => submit(() => e.conn.query(sql), { engine: e });

  // The SAS per table from the function: the page's downloads use them, and nothing else does. A
  // page open longer than them gets new ones shortly before they expire (a failed renewal is tried
  // again a minute later); the views read the store, so no view changes.
  let sas = null;
  // A download refused: the SAS it was signed with has run out before the timer below got to it. One renewal,
  // whoever was refused; the URL is built for each request, so the next try is signed with the new one.
  let renewing = null;
  const renewSas = () => (renewing ||= catalog.open({ renew: true }).then(a => { sas = a.sas; }).finally(() => { renewing = null; }));
  function renewLater() {
    setTimeout(async () => {
      try { sas = (await catalog.open({ renew: true })).sas; renewLater(); }
      catch { setTimeout(renewLater, 60000); }
    }, Math.max(catalog.renewAt() - Date.now(), 0));
  }

  // The store, over its channel (blockcache.js): its writer says it is there ({ writer }), what
  // it lacks or holds ({ missing, id }, { held, id }), and that a file or a piece handed to it
  // is kept ({ stored, at }); a DuckDB worker, the bytes it read that the store lacked ({ miss }),
  // kept a minute for the query that failed on them.
  const channel = new BroadcastChannel('blockcache');
  let storeUp;
  const storeReady = new Promise(r => { storeUp = r; });
  // Each key holds the waiters for its answer: the same file can be handed over twice at once,
  // and the one answer settles both.
  const answers = new Map();   // id -> [resolve], for { missing }
  const stored = new Map();    // `${store path}@${at}` -> [resolve], for { store }
  let misses = [];             // [{ path, from, to, seen }], store paths
  // What was asked and not answered yet, to ask again of a new writer: one that took over from
  // a closed tab never saw the question.
  const unanswered = new Map();   // the waiters' list -> send
  const settle = (map, key, d) => {
    const waiting = map.get(key);
    if (!waiting) return;
    map.delete(key);
    unanswered.delete(waiting);
    for (const resolve of waiting) resolve(d);
  };
  channel.onmessage = ({ data: d }) => {
    if (d?.writer) { storeUp(); for (const send of [...unanswered.values()]) send(); }
    if (d?.id != null) settle(answers, d.id, d);
    if (d?.stored) settle(stored, `${d.stored}@${d.at ?? 0}`, d);
    if (d?.miss) {
      const now = Date.now();
      misses = [...misses.filter(m => now - m.seen < 60000), { path: d.miss, from: d.from, to: d.to, seen: now }];
    }
  };
  // `resend`: false for a send that cannot be repeated (bytes transferred away).
  const waitFor = (map, key, send, what, { resend = true } = {}) => new Promise((resolve, reject) => {
    const waiting = map.get(key) ?? [];
    waiting.push(resolve);
    map.set(key, waiting);
    if (resend) unanswered.set(waiting, send);
    send();
    setTimeout(() => {
      const i = waiting.indexOf(resolve);
      if (i < 0 || map.get(key) !== waiting) return;
      waiting.splice(i, 1);
      if (!waiting.length) { map.delete(key); unanswered.delete(waiting); }
      reject(new Error(`the local store did not answer (${what})`));
    }, STORE_WAIT);
  });
  // The files of `paths` (abfss) the store does not hold whole.
  async function lacking(paths) {
    const id = `${Date.now()}-${Math.random()}`;
    const missing = new Set((await waitFor(answers, id, () => channel.postMessage({ missing: paths.map(storePath), id }), 'what it holds')).missing);
    return paths.filter(p => missing.has(storePath(p)));
  }
  // The blocks the store holds of each of `paths` (abfss): path -> runs [[n0, n1]].
  async function held(paths) {
    const id = `${Date.now()}-${Math.random()}`;
    const d = await waitFor(answers, id, () => channel.postMessage({ held: paths.map(storePath), id }), 'what it holds');
    return new Map(paths.map(p => [p, d.held?.[storePath(p)]?.runs ?? []]));
  }
  // This tab's store worker (blockcache.js, the writer's role): the downloads go to it,
  // transferred rather than copied, and it hands them to whichever store worker writes (and
  // again to a new one, after a tab closes). The DuckDB workers only read the store.
  let storeWorker = null;
  const storeWorkerOf = () => storeWorker ??= new Worker(URL.createObjectURL(new Blob(
    [`self.BLOCKCACHE_ROLE = 'writer';\nimportScripts(${JSON.stringify(BLOCKCACHE)});\n`], { type: 'text/javascript' })));
  // A file the page downloaded, whole or the piece of it from `at` (of a file of `size` bytes),
  // handed to the store: resolved once the writer keeps it, rejected when it says it could not.
  // `bytes` (an ArrayBuffer) is the store's from then on.
  const toStore = (path, bytes, at = 0, size = bytes.byteLength) =>
    waitFor(stored, `${storePath(path)}@${at}`, () => storeWorkerOf().postMessage({ store: storePath(path), bytes, at, size }, [bytes]),
            path.split('/').pop(), { resend: false })
      .then(d => { if (d?.error) throw new Error(`the local store could not keep ${path.split('/').pop()}: ${d.error}`); });

  // Opens a table: its view, over a copy in memory or over the files. Runs inside a queued
  // job, so it calls the connection itself. One opening per table and engine, whoever asks; a
  // failed one can be asked for again.
  // A view over iceberg_scan would plan the table again for every query that reads it
  // (metadata.json, the manifest list and every manifest, one request at a time). So a table
  // is planned once, by the page, and its record kept: the view is read_parquet over the
  // snapshot's files, written as literals, and a query reads only Parquet (footers held by
  // parquet_metadata_cache). The columns are the files' own: a table's columns change only
  // with a rebuild, never in place.
  // A record kept from an earlier visit that fails to open (a file gone, a record of another
  // build) is dropped and the table planned again, once.
  function open(e, name) {
    const t = located.get(name);
    return e.opened.get(name) ?? e.opened.set(name, (async () => {
      prioritize(name);
      try { await bind(e, name, t, await readyOf(name, t)); }
      catch (err) {
        if (!t.stored) throw err;
        snapshots.drop(name); t.record = null; t.stored = false; t.ready = null;
        t.layout = null; t.coming = new Map(); t.gathering = t.downloading = null;
        t.planning = planFor(t);
        await bind(e, name, t, await readyOf(name, t));
      }
    })().catch(err => { e.opened.delete(name); throw err; })).get(name);
  }
  // The table ready for `sql` (none: as it is): its record, and in the store a small table's
  // files, or a larger one's footers, its layout and the chunks of the columns `sql` names. A
  // table whose files' sizes are not all known comes down whole.
  function readyOf(name, t, sql) {
    const ready = t.ready ??= (async () => {
      const record = t.record ?? await planned(name, t);
      // What a view cannot read (no data file, a file that is not Parquet such as a deletion
      // vector, an equality delete) is an error: there is no other way in.
      if (record.scan) throw new Error(`${name}: not readable as Parquet with position deletes (no data file, equality deletes or a deletion vector)`);
      if (small(t) || !record.files.every(f => f.size > 0)) await local(name, t, [...record.files, ...record.deleteFiles]);
      else {
        await local(name, t, record.deleteFiles);
        t.layout = await layoutOf(name, t, record);
      }
      return record;
    })().catch(err => { t.ready = null; throw err; });
    return sql == null ? ready : ready.then(record => (t.layout ? columnsFor(name, t, sql) : null)).then(() => ready);
  }

  // The table's record, planned by the page (`planning`, started at load).
  async function planned(name, t) {
    let plan;
    try { plan = await t.planning; }
    catch (e) {
      // Planned again by the next query: one request that failed is not the table's answer for the visit.
      if (!t.error) { t.planning = planFor(t); t.planning.catch(() => {}); }
      throw e;
    }
    const record = { location: t.location, bytes: t.bytes, ...plan.record };
    snapshots.put(name, record);
    t.record = record;
    return record;
  }
  // `files` in the store whole: the ones it lacks downloaded.
  async function local(name, t, files) {
    if (!files.length) return;
    const missing = new Set(await lacking(files.map(f => f.path)));
    await download(name, t, files.filter(f => missing.has(f.path)));
  }
  // A larger table's layout, from its files' footers: its columns, and each file's size and the
  // byte range of each column in each row group, with its bloom filter (which DuckDB reads to
  // skip a row group). The footers come down first, each file's last bytes (ranges.js TAIL),
  // and DuckDB reads them from the store (parquet_metadata); a footer longer than that is
  // downloaded when DuckDB misses it (healing).
  async function layoutOf(name, t, record) {
    const runs = await held(record.files.map(f => f.path));
    await download(name, t, record.files.flatMap(f => piecesOf(f.path, f.size, [tailOf(f.size)], runs.get(f.path))));
    const rows = await healing(() => submit(async e => {
      await register(e, record.files);
      const r = await e.conn.query(`SELECT file_name, path_in_schema, dictionary_page_offset, data_page_offset,
          total_compressed_size, bloom_filter_offset, bloom_filter_length, row_group_id, row_group_num_rows
        FROM parquet_metadata([${record.files.map(f => lit(localName(f.path))).join(', ')}])`);
      return r.toArray().map(x => x.toJSON());
    }));
    const byName = new Map(record.files.flatMap(f => [[localName(f.path), f.path], [localUrl(f.path), f.path]]));
    const files = new Map(record.files.map(f => [f.path, { size: f.size, chunks: [] }]));
    const columns = new Set();
    // The table's rows: each file's row groups', counted once (a row group has a line a column).
    const groups = new Map();
    for (const r of rows) {
      const file = files.get(byName.get(r.file_name));
      if (!file) continue;
      groups.set(`${r.file_name} ${r.row_group_id}`, Number(r.row_group_num_rows));
      // A nested column's leaves are "s, x": the table's column is the first part.
      const col = String(r.path_in_schema).split(', ')[0];
      columns.add(col);
      // A dictionary comes before its data pages; some writers say 0 for none.
      const data = Number(r.data_page_offset), dict = r.dictionary_page_offset == null ? null : Number(r.dictionary_page_offset);
      const from = dict != null && dict > 0 && dict < data ? dict : data;
      file.chunks.push({ col, from, to: from + Number(r.total_compressed_size) - 1 });
      if (r.bloom_filter_offset != null && Number(r.bloom_filter_length) > 0)
        file.chunks.push({ col, from: Number(r.bloom_filter_offset), to: Number(r.bloom_filter_offset) + Number(r.bloom_filter_length) - 1 });
    }
    return { columns: [...columns], files, rows: [...groups.values()].reduce((n, x) => n + x, 0) };
  }
  // The chunks of the columns `sql` names of a larger table, in the store. Those no query named
  // before come down together, so that a file's chunks merge into fewer requests (ranges.js).
  function columnsFor(name, t, sql) {
    const named = (readsAll(sql, name) ? t.layout.columns : columnsIn(sql, t.layout.columns)).map(c => c.toLowerCase());
    const fresh = named.filter(c => !t.coming.has(c));
    if (fresh.length) comingFor(name, t, fresh);
    return Promise.all(named.map(c => t.coming.get(c)));
  }
  // The download of the columns `cols` (lowercase) of a larger table, and of the byte ranges
  // `extra` ([{ path, from, to }], what DuckDB missed), each column's promise in t.coming until
  // it fails. A render sends its queries together: their new columns join one batch, gathered
  // for BATCH_MS and downloaded once the table's batch before it is done, so a file's chunks
  // merge into fewer requests and no block comes down twice. Every column wanted so far is in
  // the ranges, so a new chunk merges with the held ones it is near (held blocks are left out).
  function comingFor(name, t, cols, extra = []) {
    let batch = t.gathering;
    if (!batch) {
      batch = t.gathering = { cols: new Set(), extra: [] };
      const before = t.downloading ?? Promise.resolve();
      batch.done = (async () => {
        await new Promise(r => setTimeout(r, BATCH_MS));
        if (t.gathering === batch) t.gathering = null;
        await before.catch(() => {});
        const wanted = new Set(t.coming.keys());
        const paths = [...t.layout.files.keys()];
        const runs = await held(paths);
        await download(name, t, paths.flatMap(p => {
          const f = t.layout.files.get(p);
          const ranges = [...columnRanges(f.chunks, wanted), ...batch.extra.filter(x => x.path === p).map(x => [x.from, x.to])];
          return piecesOf(p, f.size, ranges, runs.get(p));
        }));
      })();
      t.downloading = batch.done;
      batch.done.catch(() => { for (const c of batch.cols) if (t.coming.get(c) === batch.done) t.coming.delete(c); });
    }
    for (const c of cols) { batch.cols.add(c); t.coming.set(c, batch.done); }
    batch.extra.push(...extra);
    return batch.done;
  }
  // fn run, and when it fails having read bytes the store lacks (its { miss }), those downloaded,
  // with every column they are of in each file of their table, and fn run again: HEALS times
  // at most.
  async function healing(fn) {
    for (let tries = 0; ; tries++) {
      const started = Date.now();
      try { return await fn(); }
      catch (err) {
        if (err?.skipped) throw err;
        // The store's word comes on a channel of its own, maybe after the query's error.
        await new Promise(r => setTimeout(r, 200));
        const seen = misses.filter(m => m.seen >= started);
        if (!seen.length || tries >= HEALS) throw err;
        console.warn(`[store] a query read ${seen.length} range(s) the store lacked; downloading them and running it again`, seen);
        await fetchMissed(seen);
      }
    }
  }
  async function fetchMissed(seen) {
    for (const t of located.values()) {
      const files = new Map((t.record?.files ?? []).map(f => [storePath(f.path), f]));
      const extra = seen.filter(m => files.has(m.path)).map(m => ({ path: files.get(m.path).path, from: m.from, to: m.to }));
      if (!extra.length) continue;
      if (!t.layout) {
        // Its footers, before its layout: the bytes missed alone.
        const runs = await held(extra.map(x => x.path));
        await download(t.name, t, extra.flatMap(x => piecesOf(x.path, files.get(storePath(x.path)).size, [[x.from, x.to]], runs.get(x.path))));
        continue;
      }
      const cols = new Set();
      for (const x of extra) for (const c of t.layout.files.get(x.path)?.chunks ?? []) if (c.from <= x.to && c.to >= x.from) cols.add(c.col.toLowerCase());
      await comingFor(t.name, t, [...cols], extra);
    }
  }
  // `items` into the store, six at a time: whole files ({ path, size }) or pieces of them
  // ({ path, size, from, to }), then checked kept. A large table shows how far it has got
  // (onProgress): what a query reads comes down before its charts draw.
  async function download(name, t, items) {
    if (!items.length) return;
    const shown = !small(t);
    const left = new Map();   // path -> its items not done yet
    for (const f of items) left.set(f.path, (left.get(f.path) ?? 0) + 1);
    const count = left.size;
    // `got` counts bytes as they arrive, not files done: a file of 250 MB, six at a time, is
    // ~1.5 GB before the first one is done. The speed is over the last 10 s, and with it how
    // long is left, once 10 s have passed.
    const length = f => (f.from != null ? f.to - f.from + 1 : f.size);
    const whole = items.every(f => length(f) > 0) ? items.reduce((s, f) => s + length(f), 0) : null;
    const MB = n => Math.round(n / 1048576).toLocaleString('en-US');
    let done = 0, got = 0, drawn = 0;
    const started = Date.now(), seen = [[started, 0]];
    const rate = () => {
      const now = Date.now();
      seen.push([now, got]);
      while (seen.length > 2 && now - seen[1][0] >= 10000) seen.shift();
      const [t0, g0] = seen[0];
      return now - started >= 10000 && now > t0 ? (got - g0) / ((now - t0) / 1000) : null;
    };
    const progress = (force = false) => {
      if (!shown) return;
      const now = Date.now();
      if (!force && now - drawn < 500) return;
      drawn = now;
      const r = rate();
      const left = r > 0 && whole ? Math.max(whole - got, 0) / r : null;
      const time = left == null ? '' : left < 90 ? `, about ${Math.max(Math.round(left), 1)} s left` : `, about ${Math.round(left / 60)} min left`;
      onProgress({ label: `Downloading ${name}`, done, total: count,
        detail: `Downloading ${name}: ${done} of ${count} files, ${MB(got)} MB${whole ? ` of ${MB(whole)} MB` : ''}` +
          `${r > 0 ? `, ${r < 10485760 ? (r / 1048576).toFixed(1) : MB(r)} MB/s${time}` : ''}. Kept in this browser for the next visit.` });
    };
    progress(true);
    try {
      await prefetchFiles(name, items, f => https(f, sas),
        (path, bytes, f) => (f.from != null ? toStore(path, bytes, f.from, f.size) : toStore(path, bytes)),
        (size, f) => { left.set(f.path, left.get(f.path) - 1); if (!left.get(f.path)) done++; progress(true); },
        n => { got += n; progress(); }, renewSas);
    } finally { if (shown) onProgress(null); }
    const wholes = items.filter(f => f.from == null), pieces = items.filter(f => f.from != null);
    const still = new Set(await lacking(wholes.map(f => f.path)));
    if (pieces.length) {
      const runs = await held([...new Set(pieces.map(f => f.path))]);
      for (const f of pieces) if (piecesOf(f.path, f.size, [[f.from, f.to]], runs.get(f.path)).length) still.add(f.path);
    }
    if (still.size) throw new Error(`${name}: ${still.size} files not in the local store after their download`);
  }
  // The files registered on engine `e`, by their local names.
  async function register(e, files) {
    for (const f of files) {
      if (e.registered.has(f.path)) continue;
      await e.db.registerFileURL(localName(f.path), localUrl(f.path), duckdb.DuckDBDataProtocol.HTTP, DIRECT_IO);
      e.registered.add(f.path);
    }
  }
  // The table's view on engine `e`, over a copy in its memory or over the files.
  async function bind(e, name, t, record) {
    await register(e, [...record.files, ...record.deleteFiles]);
    // The positions the delete files remove, read once per session into memory.
    if (record.deleteFiles.length)
      await e.conn.query(
        `CREATE OR REPLACE TABLE ${ident(deletesOf(name))} AS
         SELECT DISTINCT regexp_replace(file_path, '^abfss?://([^@/]+)@([^/]+)/', 'store/\\1/') AS path, pos
         FROM read_parquet([${record.deleteFiles.map(f => lit(localName(f.path))).join(', ')}])`);
    if (small(t))
      await e.conn.query(
        `CREATE OR REPLACE TABLE ${ident(name)} AS ${selectOf(name, record)}; CREATE OR REPLACE VIEW ${ident('v_' + name)} AS SELECT * FROM ${ident(name)}`);
    else {
      await e.conn.query(
        `CREATE OR REPLACE VIEW ${ident('v_' + name)} AS ${selectOf(name, record)}`);
      // This engine's share of the table's files (split.js).
      const share = SPLIT ? sharesOf(record)[e.index] : [];
      if (share.length)
        await e.conn.query(`CREATE OR REPLACE VIEW ${ident('p_' + name)} AS ${selectOf(name, record, share)}`);
    }
  }
  // A table's files dealt out between the engines, the largest first, each to the share with
  // the fewest bytes so far: the same shares for the visit, so an engine reads the same footers.
  const shares = new WeakMap();   // record -> [files], one list an engine
  function sharesOf(record) {
    if (!shares.has(record)) {
      const out = Array.from({ length: ENGINES }, () => ({ files: [], bytes: 0 }));
      for (const f of [...record.files].sort((a, b) => (b.size ?? 0) - (a.size ?? 0))) {
        const least = out.reduce((a, b) => (b.bytes < a.bytes ? b : a));
        least.files.push(f);
        least.bytes += f.size ?? 0;
      }
      shares.set(record, out.map(x => x.files));
    }
    return shares.get(record);
  }
  // A query split (split.js): each CTE that reads a large table runs on every engine over its
  // share of the files, its answer copied out as Parquet (the engine's own types: a result
  // read by the page has its BIGINTs and DECIMALs as DOUBLEs); then the statement, over those
  // answers, on one engine. Null when nothing of `sql` splits.
  let splits = 0, shared = 0, splitFailed = false;
  function splitRun(sql, options) {
    if (!SPLIT || engines.length < 2) return null;
    // A table worth sharing out: of several files, and of rows enough to win back what sharing out costs.
    const plan = splitPlan(sql, n => { const t = located.get(n); return !!t && (t.record?.files.length ?? 0) >= 2 && (t.layout?.rows ?? 0) >= SPLIT_ROWS; });
    if (!plan) return null;
    const id = ++splits, started = performance.now();
    return (async () => {
      const answers = await Promise.all(plan.parts.flatMap(part => {
        const share = sharesOf(located.get(part.table).record);
        return engines.filter(e => share[e.index].length).map(e => submit(async () => {
          const t0 = performance.now();
          await open(e, part.table);
          await openFor(e, part.partialSql);
          const name = `part_${id}_${part.cte}_${e.index}.parquet`;
          // The answer's types, which the final statement gives back to what it adds up.
          const types = Object.fromEntries((await e.conn.query(`DESCRIBE ${part.partialSql}`)).toArray().map(r => [r.column_name, r.column_type]));
          await e.conn.query(`COPY (${carried(part.partialSql, types)}) TO ${lit(name)} (FORMAT parquet)`);
          const bytes = await e.db.copyFileToBuffer(name);
          await e.db.dropFile(name);
          return { cte: part.cte, name, bytes, types, size: bytes.byteLength, engine: e.index, ms: Math.round(performance.now() - t0) };
        }, { ...options, engine: e }));
      }));
      const partsDone = performance.now();
      const final = plan.finalSql(cte => answers.filter(a => a.cte === cte).map(a => a.name), cte => answers.find(a => a.cte === cte)?.types);
      const result = await submit(async e => {
        for (const a of answers) await e.db.registerFileBuffer(a.name, a.bytes);
        try {
          await openFor(e, final);
          return await e.conn.query(final);
        } finally { for (const a of answers) await e.db.dropFile(a.name).catch(() => {}); }
      }, { ...options, names: namedIn(final) });
      shared++;
      if (TIMED) console.log(`[split] ${Math.round(performance.now() - started)} ms: ${plan.parts.map(p => p.table).join(', ')} on ${engines.length} engines, ` +
        `parts ${answers.map(a => `${a.cte}@${a.engine} ${a.ms} ms`).join(', ')} (${answers.reduce((n, a) => n + a.size, 0)} bytes), ` +
        `the rest ${Math.round(performance.now() - partsDone)} ms`);
      return result;
    })();
  }
  // What a view reads: read_parquet over the files' local names. With delete files, the rows
  // whose file and position (file_row_number, 0-based as Iceberg's pos) a delete file names are
  // left out: `filename` is the local name, the delete file's file_path written the same way.
  const deletesOf = name => `__deletes_${name}`;
  const selectOf = (name, record, share = record.files) => {
    const files = `[${share.map(f => lit(localName(f.path))).join(', ')}]`;
    if (!record.deleteFiles.length) return `SELECT * FROM read_parquet(${files})`;
    return `SELECT * EXCLUDE (__file, file_row_number)
      FROM read_parquet(${files}, filename = '__file', file_row_number = true) AS d
      ANTI JOIN ${ident(deletesOf(name))} AS x ON x.path = d.__file AND x.pos = d.file_row_number`;
  };
  // The tables a query names (v_<table>) that are not open yet, opened first.
  const namedIn = sql => [...new Set([...sql.matchAll(/\bv_(\w+)\b/g)].map(m => m[1]))].filter(n => located.has(n));
  async function openFor(e, sql) {
    for (const name of namedIn(sql)) await open(e, name);
  }
  // Every table a query names, planned and what the query reads of it in the store, all of them
  // together and before the query takes an engine: a download holds no engine, and one table's
  // download does not wait for another's. Their files go first in the downloads.
  function readyFor(sql) {
    const names = namedIn(sql);
    prioritize(...names);
    return Promise.all(names.map(n => readyOf(n, located.get(n), sql)));
  }

  // A new snapshot planned by the page, at once, off every engine: opening the table waits for it.
  let access = null;
  // The engines and the store, starting (init): what a query that computes waits for.
  let enginesUp = null;
  function planFor(t) {
    return (t.m ? Promise.resolve(t.m) : metadataOf(t.location)).then(m => planTable(t.name, m, f => https(f, sas || access.sas)));
  }
  async function metadataOf(location) {
    const r = await fetch(https(location, sas || access.sas));
    if (!r.ok) throw new Error(`metadata.json: HTTP ${r.status}`);
    return r.json();
  }
  // Each table's size, from its metadata.json, all at once (the page's own requests, in
  // parallel): the current snapshot's total-files-size; and its plan, started, not awaited.
  // A table whose location has a record (the same snapshot as last planned) fetches nothing:
  // its size is the record's, and it opens from it.
  async function sizeAll() {
    const metas = await Promise.all([...tables].map(async ([name, t]) => {
      const location = access.metadata[t.source];
      if (!location) return null;
      const record = snapshots.get(name, location);
      if (record) return { name, location, m: null, bytes: record.bytes, record };
      // The function's answer holds the snapshot (an app exported since it did): no metadata.json to fetch, which
      // was a request to OneLake for each table before the first tile. All a plan reads of it is put back together.
      const told = access.snapshots?.[t.source];
      if (told) {
        const m = told.manifestList ? { 'current-snapshot-id': 1, snapshots: [{ 'snapshot-id': 1, 'manifest-list': told.manifestList }] }
          : { snapshots: [] };
        return { name, location, m, bytes: told.bytes ?? null };
      }
      try {
        const m = await metadataOf(location);
        const s = (m.snapshots ?? []).find(s => String(s['snapshot-id']) === String(m['current-snapshot-id']));
        const bytes = s ? Number(s.summary?.['total-files-size'] ?? NaN) : 0;
        return { name, location, m, bytes: Number.isNaN(bytes) ? null : bytes };
      } catch (e) {
        return { name, location, m: null, bytes: null, error: e };   // the table fails when opened
      }
    }));
    // Smallest first: the downloads are served first come, first served, and a small table's
    // few files would otherwise wait behind a large one's.
    for (const t of metas.filter(Boolean).sort((a, b) => (a.bytes ?? Infinity) - (b.bytes ?? Infinity))) {
      const planning = t.record ? null : t.error ? Promise.reject(t.error) : planFor(t);
      planning?.catch(() => {});   // thrown when the table opens
      located.set(t.name, { name: t.name, location: t.location, bytes: t.bytes, planning, record: t.record ?? null,
        stored: !!t.record, ready: null, layout: null, coming: new Map(), gathering: null, downloading: null });
    }
  }


  async function init() {
    storeWorkerOf();   // the store's writer, waiting for the lock from the start
    // The browser may drop a site's storage when the disk is short: asked to keep this one, which is gigabytes
    // of downloads. It answers with no prompt, and a no changes nothing.
    try { navigator.storage?.persist?.().catch(() => {}); } catch (e) {}
    // Before sign-in: a kept answer from the function is what lets the page start without one.
    await kv.load();
    // Asked for, and waited for below: the model and the engines need no session, and start meanwhile. Only the
    // function's answer waits for it.
    const signed = auth.signIn();
    signed.catch(() => {});
    onStatus("Loading the query engine…");
    // The model, the function's answer (where its tables are, the SAS), the tables' sizes and
    // their plans, while DuckDB's bundle loads: none of them needs it.
    const modelRead = fetch(MODEL_JSON).then(r => {
      if (!r.ok) throw new Error(`the site has no model.json (HTTP ${r.status}): export the app again`);
      return r.json();
    });
    const ready = Promise.all([modelRead, signed.then(() => catalog.open())]).then(async ([doc, answer]) => {
      access = answer;
      model = doc;
      tables = modelTables(model);
      sas = access.sas;
      await sizeAll();
    });
    ready.catch(() => {});   // awaited below

    // Single-threaded (the base bundle): the page is not cross-origin isolated. ENGINES of them,
    // started together, and not waited for here: a tile whose result this browser kept (results.js) draws with
    // no engine, and the tables' plans and downloads need none. A query that needs one waits (`enginesUp`).
    enginesUp = (async () => {
    const bundle = BUNDLE;
    const workerUrl = URL.createObjectURL(
      // The store lets the worker fetch extensions from EXT_REPO, and nothing else.
      new Blob([`self.DUCKDB_EXT_REPO = ${JSON.stringify(EXT_REPO)};
importScripts("${BLOCKCACHE}");
importScripts("${bundle.mainWorker}");`], { type: "text/javascript" }));
    let warmed = false;
    engines = new Array(ENGINES).fill(null);
    await Promise.all(Array.from({ length: ENGINES }, async (_, i) => {
      const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(), new Worker(workerUrl));
      await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
      await openEngine(db);   // session.js: one at a time
      const version = await db.getVersion();
      if (version !== DUCKDB) throw new Error(`the engine is DuckDB ${version}, but the site's extensions are for ${DUCKDB}`);
      if (!warmed) { warmed = true; warmExtensions(version); }
      const e = { index: i, db, conn: await db.connect(), opened: new Map(), registered: new Set() };
      engines[i] = e;
      queue.add(e);   // its setup below runs through the queue, on it
      // Installing needs a home directory.
      await q(e, `SET home_directory = '/tmp'; SET custom_extension_repository = ${lit(EXT_REPO)}; ${EXTENSIONS.map(x => `INSTALL ${x}; LOAD ${x};`).join(' ')}`);
      try { localStorage.setItem(EXT_KEY, version); } catch (x) {}
      for (const sql of SETTINGS) await q(e, sql);   // session.js
      return e;
    }));
    URL.revokeObjectURL(workerUrl);
    // The store: there is no other way to the data, so no store, no page.
    channel.postMessage({ ping: true });
    await Promise.race([storeReady, new Promise((_, reject) => setTimeout(() =>
      reject(new Error('no local store in this browser (OPFS with shared access handles, Chrome or Edge 121+)')), STORE_WAIT))]);
    })();
    enginesUp.catch(() => {});   // said by the first query that needs an engine

    await signed;
    onStatus('Reading the model and its tables from the lakehouse…');
    await ready;
    renewLater();
  }

  // A query's result saved in this browser, across visits (results.js). What identifies the
  // data it reads: the metadata location of every table it names, as its view (v_<table>),
  // its copy in memory (<table>) or its deletes (__deletes_<table>), so a new snapshot of
  // any of them is a new key. A query that names no table has no snapshot to tie its result
  // to, so it is not kept.
  const results = createResults('iceberg-results');
  const resultKey = sql => {
    const versions = [...located].filter(([n]) => new RegExp(`\\b(?:v_|__deletes_)?${n}\\b`).test(sql))
      .map(([n, t]) => `${n} ${t.location}`).sort();
    return versions.length ? results.key(sql, versions) : null;
  };

  return {
    init,
    // The semantic model as the lakehouse holds it (an Ossie document or TMSL), once init has
    // answered.
    model: () => model,
    // How many queries were shared out between the engines so far (split.js).
    shared: () => shared,
    // `options`: the page's for the queue (queue.js): `stale`, `early`, `later`.
    // A result already computed on these snapshots, on this visit or an earlier one, is read
    // back from this browser (results.js) instead: the page's own cache (explore/view.js) holds the
    // last 40 for the visit, this one survives a reload.
    query: async (sql, options) => {
      const key = TIMED ? null : resultKey(sql);
      const saved = key && await results.get(key);
      if (saved) return saved;
      await enginesUp;
      const whole = async () => {
        const started = performance.now();
        const r = await submit(async e => {
          await openFor(e, sql);
          return e.conn.query(sql);
        }, { ...options, names: namedIn(sql) });
        if (TIMED) console.log(`[split] ${Math.round(performance.now() - started)} ms: one engine, ${namedIn(sql).join(', ')}`);
        return r;
      };
      // Shared out when it can be; should that fail, whole, on one engine: sharing a query out is for
      // speed, and must not be why a tile has no answer. Said once, in the console.
      return healing(() => readyFor(sql).then(() => splitRun(sql, options)?.catch(err => {
        if (err?.skipped) throw err;
        if (!splitFailed) { splitFailed = true; console.warn('[split] a query shared out between the engines failed, and runs whole instead', err); }
        return whole();
      }) ?? whole())).then(r => {
        if (key) results.put(key, r);
        return r;
      });
    },
  };
}
