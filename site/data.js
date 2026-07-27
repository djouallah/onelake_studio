// =============================================================================
// data.js — OneLake Iceberg engine on DuckDB-WASM
// =============================================================================
// Given an AuthProvider (auth.js) and a lakehouse path, this module:
//   1. brings up DuckDB-WASM,
//   2. lists the lakehouse's tables over the OneLake DFS (ADLS Gen2) API by
//      friendly name (workspace/lakehouse.Lakehouse) — no GUIDs, storage token only,
//   3. for a chosen table, resolves its current metadata.json -> snapshot ->
//      manifest-list, reads the Avro manifests with DuckDB's read_avro to get the
//      data-file (parquet) paths,
//   4. registers those parquet files as URLs so DuckDB range-reads them itself, and
//      exposes the table as a read-only VIEW you can run SQL against. Nothing is
//      downloaded whole: sw.js signs DuckDB's requests, so a query pulls only the
//      row groups and columns it touches.
//
// The pure half — path and URI handling, SQL text, cache keys, version selection — lives
// in paths.js and is covered by test/paths.test.js. Anything here that can be written as
// a function of strings belongs there instead: that is where the mistakes that silently
// return the wrong rows were hiding, and clicking around does not find them.
//
// DOM-free: progress is reported through the injected `onStatus` callback.
// =============================================================================

// Pinned, not @latest: this is a CDN import with no lockfile behind it, so an unpinned
// URL means every user's browser can pick up a new DuckDB the moment one is published —
// including a build without the 'excel' extension, or with different SQL behaviour. This
// version ships DuckDB v1.5.4 and has avro + excel; it is a dev tag by choice, since the
// stable line lags. Bump it deliberately and re-run the format probe when you do.
import * as duckdb from "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.33.1-dev57.0/+esm";

import {
  DFS_HOST, strip, basename, dfsBase, dfsUrl, toHttps, pathKey, PATH_KEY_SQL,
  parseLakehouse, itemKind, holdsTables,
  fileExt, readerFor, PARQUET_EXTS, DB_EXTS, ZIP_EXTS, isSqliteHeader, isTextExt,
  sqlStr, quoteIdent, prepareReadOnlySql,
  pickMetadata, tableKey, fileKey, sanitizeIdent,
  normalizeValue, fmtBytes,
} from "./paths.js";

// There is one DuckDB connection, so DuckDB work has to be serialised — but the network
// does not. Listing a lakehouse used to be one round trip per table awaited in a for
// loop: 150+ serialised calls, tens of seconds, before the sidebar rendered.
const MAX_PARALLEL = 8;

// Materialising a result costs one JS object per row on top of DuckDB's Arrow batches, so
// an unbounded SELECT * is how you take the tab down. Cap it and say so.
const MAX_ROWS = 200_000;

// Fabric generates Iceberg metadata lazily, and Microsoft documents the conversion as
// taking between 5 seconds and 2 minutes. The old schedule gave up after 4.6s, so the
// retry usually ran out well before Fabric finished.
const RESOLVE_BACKOFF_MS = [500, 1500, 3000, 6000, 10000, 15000, 20000, 30000];

// A table directory either has metadata/ or it doesn't. OneLake surfaces everything as
// Iceberg, so "no metadata/" is a STATE — conversion hasn't run — not a second table
// format we are unable to read.
export const READY = "ready";
export const UNCONVERTED = "unconverted";

export function createEngine(auth, { onStatus = () => {} } = {}) {
  let db = null, conn = null, worker = null;
  let _seq = 0;
  let canXlsx = false;              // set by init(); see the 'excel' preload there
  let canZip = false;               // set by init(); see the 'zipfs' preload there

  const loaded = new Map();         // cache key -> info
  const resources = new Map();      // cache key -> { ident, regs[], tables[] }, for release()
  const viewNames = new Map();      // view identifier -> the cache key that owns it

  // Opening a big table is not one slow request, it is hundreds of small ones — the
  // manifest walk, then a registration per data file — and until there was a way out of
  // it every button stayed disabled for the duration with only a page reload to escape.
  //
  // A generation counter is the whole mechanism: cancelLoad() bumps it, and the load
  // checks between steps whether the number still matches. That gives up at the next
  // boundary rather than mid-request, because interrupting a fetch already in flight
  // would mean an AbortController threaded through every call and would not end the load
  // meaningfully sooner — what takes the time is the count of requests, not any one of
  // them. It also makes a superseded load (click another table while one is running)
  // stand down on its own.
  // Bumping the counter only stops the JS walk. The other half of a stuck app is a query
  // already running inside the worker — one worker, one query at a time, so a preview of
  // a 186-file table holds up everything behind it. cancelSent() reaches that; see
  // stream() for why it only works for queries issued with send().
  // conn.query() was serialised by the worker for free — statements queued and each saw
  // the whole result. conn.send() is not, and losing that guarantee is not a small thing:
  // MEASURED, starting a second query while a stream was draining truncated the first
  // SILENTLY — 4,000,000 rows came back as 22,528 with no error at all — which the app
  // then renders as a short or torn grid indistinguishable from real data. Streaming buys
  // cancellability at the price of serialising by hand, so every statement goes through
  // here and a stream holds the queue for its whole drain.
  //
  // cancelSent() deliberately does NOT queue: its entire job is to interrupt whatever is
  // holding it, and waiting its turn would mean waiting for the thing it is cancelling.
  let queue = Promise.resolve();
  function serial(fn) {
    const run = queue.then(fn, fn);   // the next statement runs however the last one ended
    queue = run.then(() => {}, () => {});
    return run;
  }
  const q = sql => serial(() => conn.query(sql));

  let loadGen = 0;
  // Fire-and-forget ON PURPOSE. The worker runs a footer-heavy bind as one long
  // synchronous stretch (its HTTP reads are sync XHR), so it only PROCESSES a cancel
  // when the current chunk yields — and awaiting the acknowledgement here parked the
  // NEXT load behind the very statement being cancelled, before it could even write
  // "Resolving…", leaving the superseded load's status on screen the whole wait.
  // Message order does the correctness work: the cancel is queued ahead of anything
  // the successor sends, so it can only ever kill the predecessor's statement.
  function cancelLoad() {
    loadGen++;
    try { if (conn) conn.cancelSent().catch(() => {}); } catch (_) { /* nothing was pending */ }
  }
  // Distinguishable so the UI can say "stopped" rather than reporting a failure.
  function cancelledError() {
    const e = new Error("load stopped");
    e.cancelled = true;
    return e;
  }
  // A superseded load gets one last resume between its awaits before check() throws,
  // and a progress message written there lands ON TOP of the successor's status —
  // "Opening <old table> — 72 file(s)…" over a screen showing the new one. Every load
  // writes status through this guard, so a load that is no longer current says nothing.
  const statusFor = gen => m => { if (gen === loadGen) onStatus(m); };

  // ---------------------------------------------------------------------------
  // DuckDB bootstrap
  // ---------------------------------------------------------------------------
  async function init() {
    onStatus("Loading DuckDB-WASM…");
    // SINGLE-THREADED (eh) BY MEASUREMENT, NOT OVERSIGHT. The threaded coi bundle exists
    // on the CDN at this pin and DOES run — measured in headless Chrome behind the
    // service worker: crossOriginIsolated=true, platform=wasm_threads, threads=4. But
    // the wasm_threads extension binaries on extensions.duckdb.org are incompatible with
    // this build: LOAD avro fails with "did not contain the expected entrypoint
    // 'avro_duckdb_cpp_init'" (excel likewise), and read_avro IS the Iceberg manifest
    // reader — threads at the cost of tables is no trade. Recheck with
    // test/sql-integration.html when bumping the pin; the coi bundle map is:
    //   coi: { mainModule: DIST+"duckdb-coi.wasm", mainWorker: DIST+"duckdb-browser-coi.worker.js",
    //          pthreadWorker: DIST+"duckdb-browser-coi.pthread.worker.js" }
    // (each worker URL wrapped in a same-origin blob importScripts shim).
    const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
    const workerUrl = URL.createObjectURL(
      new Blob([`importScripts("${bundle.mainWorker}");`], { type: "text/javascript" })
    );
    worker = new Worker(workerUrl);
    db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(), worker);
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    URL.revokeObjectURL(workerUrl);
    conn = await db.connect();
    await conn.query("SET preserve_insertion_order = false;");
    // In-session caches: parquet footers/metadata objects survive across queries instead
    // of being re-fetched and re-parsed per statement. Guarded — losing them costs
    // repeat reads, not correctness. (Cross-session caching of the immutable data files
    // themselves lives in sw.js, which can intercept DuckDB's range requests.)
    for (const s of ["SET enable_http_metadata_cache = true", "SET enable_object_cache = true"]) {
      try { await conn.query(s); } catch (e) { console.warn(`[engine] ${s}: ${e.message}`); }
    }
    // Never throws: an optional extension that won't load costs one file format, which is
    // not a reason to refuse to start. LOAD alone succeeds when the wasm build already has
    // the extension; INSTALL+LOAD is the fetch-from-the-repo fallback.
    const tryLoadExt = async (ext, repo = "") => {
      try { await conn.query(`LOAD ${ext};`); return true; }
      catch (_) {
        try { await conn.query(`INSTALL ${ext}${repo ? ` FROM ${repo}` : ""}; LOAD ${ext};`); return true; }
        catch (e) { console.warn(`[engine] ${ext} extension unavailable:`, e.message); return false; }
      }
    };
    // read_avro() (used to parse Iceberg manifests) comes from the 'avro' extension.
    // duckdb-wasm autoloads it on first use; preloading up front just makes the first
    // manifest read fast — the autoload on the first read_avro() call is the real mechanism.
    await tryLoadExt("avro");
    // read_xlsx() comes from 'excel'. Unlike avro this answer is remembered: the extension
    // is fetched over the network, so it can fail for reasons the pinned version doesn't
    // control, and offering an .xlsx that then fails to open is worse than not offering it.
    canXlsx = await tryLoadExt("excel");
    // h3_* (hexagonal spatial indexing) lives in the COMMUNITY repository — a plain
    // INSTALL looks in extensions.duckdb.org and 404s, hence FROM community. Loaded at
    // init because the editor's read-only guard blocks INSTALL/LOAD; once loaded,
    // SELECT h3_latlng_to_cell(...) just works. No capability flag: nothing in the UI
    // gates on h3, and a failure costs only the h3_* functions (warned by tryLoadExt).
    if (await tryLoadExt("h3", "community")) console.log("[engine] h3 community extension loaded");
    // zipfs (also community) is remembered like excel: it gates whether .zip files are
    // offered in the Files tree, and offering a zip that then fails to open is worse
    // than not offering it.
    canZip = await tryLoadExt("zipfs", "community");
    // `threads` is the proof, not the bundle name: >1 means the coi build actually got
    // its SharedArrayBuffer and the isolation work is paying for itself.
    let threads = "?";
    try {
      threads = (await conn.query(`SELECT current_setting('threads') AS t`)).toArray()[0].toJSON().t;
    } catch (_) {}
    console.log(`[engine] DuckDB ready — bundle=${basename(bundle.mainModule)}, ` +
                `crossOriginIsolated=${self.crossOriginIsolated}, threads=${threads}`);
    return { db, conn };
  }

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------
  async function mapPool(items, fn, limit = MAX_PARALLEL) {
    const out = new Array(items.length);
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(limit, items.length) }, async () => {
        for (;;) {
          const i = next++;
          if (i >= items.length) return;
          out[i] = await fn(items[i], i);
        }
      })
    );
    return out;
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ---------------------------------------------------------------------------
  // Authed fetch (+ one 401 retry through a silent token refresh)
  // ---------------------------------------------------------------------------
  // Only 401 means "your token expired". A 403 means "this identity may not read this",
  // which a new token will not fix — and treating it as expiry was actively harmful:
  // refreshing drops the token first, including the copy the service worker is using for
  // the tables the user CAN read. auth.refresh() coalesces concurrent callers itself.
  async function authedFetch(url, extraHeaders) {
    const headers = { ...auth.getHeaders(), ...extraHeaders };
    const r = await fetch(url, { headers });
    if (r.status !== 401) return r;
    // Hand back the credential that actually failed. Requests go out in parallel, so a
    // 401 raised against an old token can land after someone else already renewed, and
    // refresh() needs to be able to tell that apart from "the current token is dead".
    return (await auth.refresh(headers.Authorization))
      ? fetch(url, { headers: { ...auth.getHeaders(), ...extraHeaders } })
      : r;
  }

  // OneLake says why it refused, in the body, and every one of those sentences was being
  // dropped on the floor. The one that cost the most: listing a mirrored Databricks
  // catalog's table answers 400 with "Stored connections with authentication type 'Key'
  // are not supported for shortcuts of type 'DatabricksCatalog'" — the actual reason the
  // table cannot be read, and the app instead spent 86 seconds waiting for an Iceberg
  // conversion that was never going to come, then blamed the tenant's settings.
  async function oneLakeMessage(r) {
    try {
      const j = JSON.parse(await r.text());
      return (j && j.error && j.error.message) || "";
    } catch (_) { return ""; }
  }

  async function fetchAuthed(url) {
    const r = await authedFetch(url);
    if (!r.ok) {
      const said = await oneLakeMessage(r);
      const e = new Error(`HTTP ${r.status} for …${String(url).slice(-72)}` + (said ? ` — ${said}` : ""));
      e.status = r.status;          // callers retry on this (see resolveIcebergRetrying)
      e.said = said;                // ...and stop retrying when OneLake called it permanent
      throw e;
    }
    return new Uint8Array(await r.arrayBuffer());
  }
  const fetchText = async u => new TextDecoder().decode(await fetchAuthed(u));
  const fetchJson = async u => JSON.parse(await fetchText(u));

  // ADLS Gen2 "List Path" over the workspace filesystem. Returns [{name,isDir,bytes,mtime}].
  // recursive=false lists only the immediate children of `directory` (no data-file walk).
  async function listPaths(ws, directory, recursive = false) {
    const out = [];
    let cont = "";
    let page = 0;
    do {
      const u = new URL(dfsBase(ws));
      u.searchParams.set("resource", "filesystem");
      u.searchParams.set("recursive", String(recursive));
      u.searchParams.set("directory", strip(directory));
      if (cont) u.searchParams.set("continuation", cont);
      const r = await authedFetch(u.toString());
      // A 404 on the FIRST page means the directory isn't there, which is a normal answer.
      // A 404 part way through pagination means it went away under us, and returning the
      // rows gathered so far would report a truncated listing as a complete one.
      if (r.status === 404) {
        if (page === 0) return out;
        throw new Error(`Listing of ${strip(directory)} was interrupted — it changed while being read`);
      }
      if (!r.ok) {
        const said = await oneLakeMessage(r);
        const e = new Error(`list HTTP ${r.status} for ${strip(directory)}` + (said ? ` — ${said}` : ""));
        e.status = r.status;
        e.said = said;
        throw e;
      }
      const j = await r.json().catch(() => ({}));
      for (const p of (j.paths || [])) {
        out.push({
          name: p.name,
          isDir: p.isDirectory === true || p.isDirectory === "true",
          bytes: Number(p.contentLength || 0),
          mtime: Date.parse(p.lastModified || "") || 0,
        });
      }
      cont = r.headers.get("x-ms-continuation") || "";
      page++;
    } while (cont);
    return out;
  }

  // ---------------------------------------------------------------------------
  // Catalog — workspaces and their data items, from the storage token alone.
  // ---------------------------------------------------------------------------
  // OneLake answers the ADLS Gen2 "List Filesystems" call at the account root, and each
  // filesystem is a workspace. That means the whole catalog comes from the same
  // storage.azure.com token the data reads use — no Fabric REST API, no extra Entra scope
  // and no second consent prompt.
  async function listWorkspaces() {
    const out = [];
    let cont = "";
    do {
      const u = new URL(`https://${DFS_HOST}/`);
      u.searchParams.set("resource", "account");
      if (cont) u.searchParams.set("continuation", cont);
      const r = await authedFetch(u.toString());
      if (!r.ok) throw new Error(`Could not list workspaces (HTTP ${r.status})`);
      const j = await r.json().catch(() => ({}));
      for (const f of (j.fileSystems || [])) out.push(f.name);
      cont = r.headers.get("x-ms-continuation") || "";
    } while (cont);
    return out.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  }

  // The items that hold OneLake tables; which kinds those are is a rule about names, so it
  // lives in paths.js under test. Everything the workspace holds is logged, because "what
  // does OneLake actually CALL this item?" is otherwise unanswerable from inside the app —
  // and an item type spelled differently than assumed is exactly how a workspace full of
  // Databricks catalogs came up empty with nothing said.
  async function listItems(ws) {
    const entries = await listPaths(ws, "", false);
    const items = [], skipped = [];
    for (const e of entries) {
      if (!e.isDir) continue;
      const name = basename(e.name);
      if (holdsTables(name)) items.push({ name, kind: itemKind(name) });
      else if (itemKind(name)) skipped.push(name);
    }
    console.info(`[engine] ${ws}: ${items.length} item(s) with tables` +
                 (skipped.length ? `; skipped ${skipped.length} — ${skipped.join(", ")}` : ""));
    return items.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  }

  // ---------------------------------------------------------------------------
  // Files/ browsing — the unmanaged half of a lakehouse.
  // ---------------------------------------------------------------------------
  // Nothing Iceberg here: Files/ is just a directory tree, so it is listed one level at a
  // time (lazily, on expand) and a recognised data file is opened as a view the same way
  // table data files are — registerFileURL, then whichever reader the extension names.
  // The reader table itself lives in paths.js.
  const isQueryable = name => {
    const ext = fileExt(name);
    if (DB_EXTS.has(ext)) return true;      // ATTACHed read-only, not read through a reader
    if (ZIP_EXTS.has(ext)) return canZip;   // entries opened as views, not the archive itself
    if (!readerFor(ext)) return false;
    return ext === "xlsx" ? canXlsx : true;
  };

  // One level of Files/ (or a subdirectory of it). `dir` is relative to Files/.
  async function listFiles({ workspace, item }, dir = "") {
    const base = `${item}/Files${dir ? "/" + strip(dir) : ""}`;
    const entries = await listPaths(workspace, base, false);
    return entries.map(e => ({
      name: basename(e.name),
      path: e.name,                       // workspace-relative, ready for dfsUrl()
      isDir: e.isDir,
      bytes: e.bytes,
      queryable: !e.isDir && isQueryable(e.name),
    })).sort((a, b) =>
      (b.isDir - a.isDir) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  }

  // ---------------------------------------------------------------------------
  // Resource lifecycle
  // ---------------------------------------------------------------------------
  // Everything a load creates — the view, the registered file URLs, the helper tables —
  // is recorded against its cache key so it can be handed back. Without this, every table
  // opened in a session leaked its registrations plus a `__del_` table holding one row per
  // deleted row, for as long as the tab stayed open.
  function track(key) {
    let r = resources.get(key);
    if (!r) { r = { ident: null, regs: [], tables: [], attachments: [], schemas: [] }; resources.set(key, r); }
    return r;
  }

  // Every registration and every drop, with who did it and when. A load that finds its
  // file missing from the registry can then answer the only question that matters —
  // which code path took it — instead of leaving a race, a token and the wasm equally
  // suspect. Session-bounded: one small entry per registered name.
  const regLog = new Map();    // registered name -> ms timestamp
  const dropLog = new Map();   // registered name -> { why, at }
  async function drop(n, why) {
    try { await db.dropFile(n); } catch (_) {}
    dropLog.set(n, { why, at: Date.now() });
  }

  // A load that is torn down must clean up after ITSELF and nothing else.
  //
  // resources are keyed by table and track(key) hands every load of that table the SAME
  // record, which was harmless while a load could only end by finishing or failing
  // outright. Cancellation broke it: open a table, open it again before the first finishes,
  // and the first load's release(key) pulled the file registrations out from under the
  // second — surfacing as "Failed to open file: data_3.parquet" while the SECOND load was
  // creating its view, blaming a file that was fine.
  //
  // So: full teardown only while this load still owns the key; otherwise drop just the
  // files this load registered and leave the successor's alone. The superseded branch
  // knowingly leaves this load's __del_/__map_ tables and delete-file registrations in
  // the shared record — the next full release reclaims them; threading them through
  // here would widen exactly the surface being kept race-safe.
  async function releaseOwned(key, regs, gen) {
    const r = resources.get(key);
    if (!r || r.gen === gen) { await release(key); return; }
    for (const n of regs) {
      await drop(n, `teardown of a superseded load of ${key} (gen ${gen}, owner gen ${r.gen})`);
      const i = r.regs.indexOf(n);
      if (i >= 0) r.regs.splice(i, 1);
    }
  }

  async function release(key) {
    const r = resources.get(key);
    if (r) {
      // Snapshots, taken before the first await. The record is shared per table key and
      // a successor load appends to these arrays while the drops below wait their turn
      // on the serial queue — iterating the live arrays here is how a superseded load
      // dropped the files its successor had just registered.
      const gen = r.gen, ident = r.ident;
      const views = [...(r.views || [])], tables = [...r.tables];
      const schemas = [...(r.schemas || [])], attachments = [...(r.attachments || [])];
      const regs = [...r.regs];
      if (ident) { try { await q(`DROP VIEW IF EXISTS ${ident}`); } catch (_) {} }
      // Zip archives create one view per readable entry; ident is just the first.
      for (const v of views) { try { await q(`DROP VIEW IF EXISTS ${v}`); } catch (_) {} }
      for (const t of tables) { try { await q(`DROP TABLE IF EXISTS ${t}`); } catch (_) {} }
      // Schemas holding copied-in database tables: CASCADE takes the tables with them.
      for (const s of schemas) { try { await q(`DROP SCHEMA IF EXISTS ${quoteIdent(s)} CASCADE`); } catch (_) {} }
      // Attached database files: DETACH before dropping the file registration under them.
      for (const a of attachments) { try { await q(`DETACH ${quoteIdent(a)}`); } catch (_) {} }
      for (const n of regs) { await drop(n, `full release of ${key} (snapshot gen ${gen})`); }
      // A successor may have claimed the key while the drops above were queued; the
      // record, the cache entry and the view names are then ITS state, not this
      // teardown's to delete.
      if (resources.get(key) !== r || r.gen !== gen) return;
      resources.delete(key);
    }
    loaded.delete(key);
    // Zip entry views register under "<key>::<entry>" owners so same-stem entries in one
    // archive can't silently repoint each other's view — release them with their key.
    for (const [name, owner] of [...viewNames])
      if (owner === key || String(owner).startsWith(key + "::")) viewNames.delete(name);
  }

  // Called when the user switches lakehouse. Cache entries are keyed per lakehouse so a
  // stale one can no longer be served, but the DuckDB objects behind them are still there
  // and still cost memory, so give those back too.
  async function reset() {
    // Switching lakehouse supersedes whatever is loading: the in-flight load stands
    // down at its next check() as a cancel instead of finding its files gone and
    // reporting "Failed to open file" against a table the user has already left.
    await cancelLoad();
    for (const key of [...resources.keys()]) await release(key);
    loaded.clear();
    resources.clear();
    viewNames.clear();
  }

  // A DuckDB identifier for this key that no other key already owns. sanitizeIdent is
  // lossy — a/data.parquet, a-data.parquet and a.data.parquet all reduce to the same stem
  // — and CREATE OR REPLACE VIEW would silently repoint whichever got there first.
  function uniqueView(key, stem) {
    let name = sanitizeIdent(stem) || "view";
    if (/^\d/.test(name)) name = "_" + name;
    while (viewNames.has(name) && viewNames.get(name) !== key) name = `${name}_${++_seq}`;
    viewNames.set(name, key);
    return name;
  }

  // ---------------------------------------------------------------------------
  // Open one file under Files/ as a read-only view.
  // ---------------------------------------------------------------------------
  // Only parquet gets the lazy treatment — DuckDB range-reads its footer and row groups.
  // CSV/JSON have no such structure, avro is a linear container and xlsx is a zip whose
  // parts have to be inflated, so DuckDB pulls those whole however big they are; that is
  // inherent to the formats, not a shortcut taken here.
  async function loadFile(lh, file) {
    // Keyed on the full path, not the basename: Files/a/data.parquet and
    // Files/b/data.parquet are different files and must not share a cache entry.
    const key = fileKey(lh, file);
    // Supersede first, even on a cache hit: the click means "show me THIS", so whatever
    // is still loading stands down instead of repainting the screen later with a table
    // the user has left. Same discipline as loadTable, for the same reason — a file
    // opened during a table load used to leave both running and the UI split between
    // them.
    await cancelLoad();
    const gen = loadGen;
    const check = () => { if (gen !== loadGen) throw cancelledError(); };
    if (loaded.has(key)) return loaded.get(key);

    const status = statusFor(gen);
    const label = file.name;
    const ext = fileExt(file.name);
    if (DB_EXTS.has(ext)) return loadDatabaseFile(lh, file, key, gen, check);
    if (ZIP_EXTS.has(ext)) return loadZipFile(lh, file, key, gen, check);
    const reader = readerFor(ext);
    if (ext === "xlsx" && !canXlsx)
      throw new Error(`${file.name}: this DuckDB-WASM build has no 'excel' extension, so .xlsx can't be read.`);
    if (!reader)
      throw new Error(`${file.name}: unsupported file type — parquet, csv/tsv/txt, json/jsonl/ndjson, ` +
                      `avro, xlsx, zip, database files (.duckdb/.db/.sqlite) and plain text ` +
                      `(sql, yml, md, log, …) are readable; text formats also read as .gz/.zst.`);

    const res = track(key);
    res.gen = gen;
    const reg = `file_${++_seq}.${ext}`;
    await db.registerFileURL(reg, dfsUrl(lh.workspace, file.path), duckdb.DuckDBDataProtocol.HTTP, false);
    regLog.set(reg, Date.now());
    res.regs.push(reg);

    const ident = quoteIdent(uniqueView(key, file.path.replace(/^.*?\/Files\//, "")));
    try {
      // stream(): a non-parquet reader pulls the file WHOLE inside this one statement,
      // and Stop must be able to kill it.
      await stream(`CREATE OR REPLACE VIEW ${ident} AS SELECT * FROM ${reader(sqlStr(reg))}`);
      res.ident = ident;
      const columns = await describe(ident);
      const info = { label, ident, columns, fileCount: 1, posDeletes: 0, eqDeletes: 0,
                     file: true, bytes: file.bytes, ext, warnings: [] };
      loaded.set(key, info);
      status(describeLoad(info));
      return info;
    } catch (e) {
      await releaseOwned(key, [reg], gen);
      if (e.cancelled) throw e;
      throw new Error(`Could not read ${file.name}: ${e.message}`);
    }
  }

  // Zip archives: registered as an HTTP URL like every other file — the zipfs extension
  // range-reads the central directory from the archive's tail and inflates only the
  // entries actually queried, so a large archive costs what you read from it (verified
  // over a registered HTTP URL in test/extensions.html). Each entry with a known reader
  // becomes its own view; the archive itself has no rows to show.
  const ZIP_MAX_VIEWS = 50;
  async function loadZipFile(lh, file, key, gen, check) {
    if (!canZip)
      throw new Error(`${file.name}: this DuckDB-WASM build couldn't load the 'zipfs' extension, so zip archives can't be read.`);
    const status = statusFor(gen);
    const res = track(key);
    res.gen = gen;
    res.views = [];
    const reg = `zipfile_${++_seq}.zip`;
    await db.registerFileURL(reg, dfsUrl(lh.workspace, file.path), duckdb.DuckDBDataProtocol.HTTP, false);
    regLog.set(reg, Date.now());
    res.regs.push(reg);
    try {
      const entries = (await q(
        `SELECT file_name AS n FROM zip_contents(${sqlStr(reg)})
         WHERE NOT is_directory ORDER BY file_name`)).toArray().map(r => r.toJSON());
      let readable = entries.filter(e => {
        const x = fileExt(e.n);
        return readerFor(x) && (x !== "xlsx" || canXlsx);
      });
      const warnings = [];
      if (readable.length > ZIP_MAX_VIEWS) {
        warnings.push(`only the first ${ZIP_MAX_VIEWS} of ${readable.length} readable entries were opened`);
        readable = readable.slice(0, ZIP_MAX_VIEWS);
      }
      const views = [];
      for (const e of readable) {
        // One view per entry, each inflating its entry to bind — the loop that most
        // needs a way out.
        check();
        const reader = readerFor(fileExt(e.n));
        // Owner "<key>::<entry>": two entries whose names sanitize to the same identifier
        // must get distinct views, and uniqueView only dedupes across distinct owners.
        const ident = quoteIdent(uniqueView(`${key}::${e.n}`, e.n));
        try {
          await stream(`CREATE OR REPLACE VIEW ${ident} AS SELECT * FROM ${reader(sqlStr(`zip://${reg}/${e.n}`))}`);
          views.push(ident);
          res.views.push(ident);
        } catch (err) {
          if (err && err.cancelled) throw err;   // a stop is not a bad entry
          warnings.push(`${e.n}: ${err.message}`);
        }
      }
      const first = views[0] || null;
      res.ident = first;
      const columns = first ? await describe(first) : [];
      const info = { label: file.name, ident: first, columns, fileCount: entries.length,
                     posDeletes: 0, eqDeletes: 0, file: true, bytes: file.bytes, ext: "zip",
                     zip: true, zipViews: views, warnings };
      if (!first && !warnings.length)
        info.warnings.push(`no readable entries among ${entries.length} — parquet, csv, json, avro, xlsx and text formats are supported inside a zip`);
      loaded.set(key, info);
      status(describeLoad(info));
      return info;
    } catch (e) {
      await releaseOwned(key, [reg], gen);
      if (e.cancelled) throw e;
      throw new Error(`Could not read ${file.name}: ${e.message}`);
    }
  }

  // A database file's ENGINE is decided by sniffing the first 16 bytes, never by
  // extension (people store DuckDB databases as .db, and .db is also SQLite's usual
  // name):
  //   - DuckDB file  -> registered as an HTTP URL and ATTACHed read-only; block-read on
  //     demand like parquet. Its tables are queryable as alias.schema.table.
  //   - SQLite file  -> opened with sql.js and COPIED into DuckDB tables under a schema
  //     named after the file. Not a shortcut: DuckDB's sqlite extension loads in this
  //     WASM build but its VFS cannot open ANY file the app can supply — registered
  //     buffer, registered HTTP URL, or a direct URL through httpfs were all measured to
  //     fail with SQLITE_CANTOPEN — so the official SQLite build does the reading and
  //     DuckDB gets a copy. SQLite files are the xlsx of databases: page-based, usually
  //     small, meant to be local; the copy is capped rather than unbounded.
  async function loadDatabaseFile(lh, file, key, gen, check) {
    const status = statusFor(gen);
    const res = track(key);
    res.gen = gen;
    const ext = fileExt(file.name);
    const url = dfsUrl(lh.workspace, file.path);

    const head = await authedFetch(url, { Range: "bytes=0-15" });
    if (!head.ok) throw new Error(`Could not read ${file.name} (HTTP ${head.status})`);
    check();
    const sqlite = isSqliteHeader(new Uint8Array(await head.arrayBuffer()));

    // The alias is how the user names the database in SQL, so derive it from the file
    // name; uniqueView guards it against colliding with an existing view or alias.
    const alias = uniqueView(key, basename(file.name).replace(/\.[^.]+$/, ""));
    if (sqlite) return loadSqliteFile(file, key, url, alias, gen, check);

    const reg = `dbfile_${++_seq}.${ext}`;
    await db.registerFileURL(reg, url, duckdb.DuckDBDataProtocol.HTTP, false);
    regLog.set(reg, Date.now());
    res.regs.push(reg);
    try {
      // READ_ONLY is not optional: the file lives in OneLake and the app never writes.
      await q(`ATTACH ${sqlStr(reg)} AS ${quoteIdent(alias)} (READ_ONLY)`);
      res.attachments.push(alias);

      // Tables AND views — a database file that only exposes views is still queryable.
      const rows = (await q(
        `SELECT schema_name AS s, table_name AS t
           FROM duckdb_tables() WHERE database_name = ${sqlStr(alias)}
         UNION ALL
         SELECT schema_name, view_name
           FROM duckdb_views() WHERE database_name = ${sqlStr(alias)} AND NOT internal
         ORDER BY 1, 2`)).toArray().map(r => r.toJSON());
      const tables = rows.map(r => `${quoteIdent(alias)}.${quoteIdent(r.s)}.${quoteIdent(r.t)}`);

      // Describe the first table — this is the probe that forces real block reads, so an
      // unreadable or version-incompatible file fails HERE with the actual cause.
      const first = tables[0] || null;
      const columns = first ? await describe(first) : [];

      const info = { label: file.name, ident: first, columns, fileCount: 1,
                     posDeletes: 0, eqDeletes: 0, file: true, bytes: file.bytes, ext,
                     db: true, dbAlias: alias, dbTables: tables, dbEngine: "DuckDB",
                     warnings: [] };
      if (!first)
        info.warnings.push(`${alias} attached but contains no tables or views`);
      loaded.set(key, info);
      status(describeLoad(info));
      return info;
    } catch (e) {
      await releaseOwned(key, [reg], gen);
      if (e.cancelled) throw e;
      throw new Error(`Could not attach ${file.name}: ${e.message}`);
    }
  }

  // SQLite path: sql.js reads the file, DuckDB gets a copy. Pinned like every other CDN
  // dependency. Each table lands as <alias>.<table> (a schema, not an attached database,
  // so the qualifier is two-part). BLOBs don't survive the JSON hop and are nulled with
  // a warning rather than silently mangled.
  const SQLJS_VERSION = "1.13.0";
  const SQLJS_ESM = `https://cdn.jsdelivr.net/npm/sql.js@${SQLJS_VERSION}/+esm`;
  const SQLJS_DIST = `https://cdn.jsdelivr.net/npm/sql.js@${SQLJS_VERSION}/dist/`;
  const SQLITE_MAX_BYTES = 200e6;
  let _sqljs = null;

  const sqliteQuote = s => '"' + String(s).replace(/"/g, '""') + '"';

  async function loadSqliteFile(file, key, url, alias, gen, check) {
    if (file.bytes > SQLITE_MAX_BYTES)
      throw new Error(`${file.name} is ${fmtBytes(file.bytes)} — over the ${fmtBytes(SQLITE_MAX_BYTES)} ` +
                      `cap for copying a SQLite file into the browser.`);
    const status = statusFor(gen);
    status(`Fetching ${file.name} (${fmtBytes(file.bytes)}) — SQLite is read in full…`);
    const bytes = await fetchAuthed(url);

    if (!_sqljs) {
      const mod = await import(SQLJS_ESM);
      const initSqlJs = mod.default || mod;
      _sqljs = await initSqlJs({ locateFile: f => SQLJS_DIST + f });
    }
    const sdb = new _sqljs.Database(bytes);
    const res = track(key);
    res.gen = gen;
    const warnings = [];
    try {
      const master = sdb.exec(
        `SELECT name FROM sqlite_master WHERE type IN ('table','view')
         AND name NOT LIKE 'sqlite_%' ORDER BY name`);
      const names = (master[0] ? master[0].values : []).map(v => String(v[0]));

      await q(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(alias)}`);
      res.schemas.push(alias);

      const tables = [];
      status(`Copying ${names.length} table(s) from ${file.name} into DuckDB…`);
      for (const t of names) {
        // One copied table per iteration — the loop a big SQLite file spends its time in.
        check();
        const ident = `${quoteIdent(alias)}.${quoteIdent(t)}`;
        const data = sdb.exec(`SELECT * FROM ${sqliteQuote(t)}`);
        if (!data.length) {
          // No rows: keep the shape anyway, from the SQLite schema.
          const pragma = sdb.exec(`PRAGMA table_info(${sqliteQuote(t)})`);
          const cols = (pragma[0] ? pragma[0].values : []).map(v => `${quoteIdent(String(v[1]))} VARCHAR`);
          if (!cols.length) continue;
          await q(`CREATE OR REPLACE TABLE ${ident} (${cols.join(", ")})`);
          tables.push(ident);
          continue;
        }
        const { columns, values } = data[0];
        let blobs = false;
        const lines = values.map(row => JSON.stringify(Object.fromEntries(
          columns.map((c, i) => {
            let v = row[i];
            if (v instanceof Uint8Array) { blobs = true; v = null; }
            return [c, v];
          })))).join("\n");
        if (blobs) warnings.push(`${t}: BLOB values are not carried over and read as NULL`);

        const jn = `sqjson_${++_seq}.json`;
        await db.registerFileBuffer(jn, new TextEncoder().encode(lines));
        try {
          await q(`CREATE OR REPLACE TABLE ${ident} AS
                            SELECT * FROM read_json(${sqlStr(jn)}, format='newline_delimited')`);
        } finally { try { await db.dropFile(jn); } catch (_) {} }
        tables.push(ident);
      }

      const first = tables[0] || null;
      const columns = first ? await describe(first) : [];
      const info = { label: file.name, ident: first, columns, fileCount: 1,
                     posDeletes: 0, eqDeletes: 0, file: true, bytes: file.bytes, ext: fileExt(file.name),
                     db: true, dbAlias: alias, dbTables: tables, dbEngine: "SQLite", warnings };
      if (!first) info.warnings.push(`${alias}: the SQLite file has no tables`);
      loaded.set(key, info);
      status(describeLoad(info));
      return info;
    } catch (e) {
      await releaseOwned(key, [], gen);
      if (e.cancelled) throw e;
      throw new Error(`Could not read ${file.name}: ${e.message}`);
    } finally {
      try { sdb.close(); } catch (_) {}
    }
  }

  // ---------------------------------------------------------------------------
  // Table discovery — browse Tables/ by name.
  // Handles both schema-enabled (Tables/<schema>/<table>) and flat (Tables/<table>).
  // ---------------------------------------------------------------------------
  function classifyChildren(kids) {
    if (kids.some(k => k.isDir && basename(k.name) === "metadata")) return READY;
    // A table directory always holds something. An empty listing means this level is a
    // schema with no tables in it, not a table.
    return kids.length ? UNCONVERTED : null;
  }

  async function listTables(lh) {
    // Three requests instead of one per table, when the catalog is reachable.
    const viaCatalog = await ircListTables(lh);
    if (viaCatalog) return viaCatalog;
    return listTablesOverDfs(lh);
  }

  async function listTablesOverDfs({ workspace, item }) {
    const level1 = (await listPaths(workspace, `${item}/Tables`, false)).filter(e => e.isDir);
    const kidsOf = await mapPool(level1, l1 => listPaths(workspace, l1.name, false));

    // A level-1 directory is either a table (it has metadata/, or files of its own) or a
    // schema whose children are tables. Only the schema case needs a second level, and
    // those all go out at once rather than one await at a time.
    const tables = [];
    const schemaDirs = [];
    level1.forEach((l1, i) => {
      const kids = kidsOf[i];
      const kind = classifyChildren(kids);
      const looksLikeSchema = kind !== READY && kids.length > 0 && kids.every(k => k.isDir);
      if (kind === READY || !looksLikeSchema) {
        if (kind) tables.push({ schema: null, table: basename(l1.name), root: l1.name, kind });
      } else {
        for (const t of kids) schemaDirs.push({ schema: basename(l1.name), entry: t });
      }
    });

    const grandKids = await mapPool(schemaDirs, s => listPaths(workspace, s.entry.name, false));
    schemaDirs.forEach((s, i) => {
      tables.push({
        schema: s.schema,
        table: basename(s.entry.name),
        root: s.entry.name,
        kind: classifyChildren(grandKids[i]) || UNCONVERTED,
      });
    });

    return tables.sort((a, b) =>
      (a.schema || "").localeCompare(b.schema || "") || a.table.localeCompare(b.table));
  }

  // ---------------------------------------------------------------------------
  // OneLake's Iceberg REST Catalog — the fast path for discovery and metadata.
  // ---------------------------------------------------------------------------
  // OneLake exposes a read-only Iceberg REST Catalog (IRC), and it costs nothing extra to
  // use: it authenticates with the SAME https://storage.azure.com token this app already
  // holds, so there is still no second Entra scope and no second consent prompt. It also
  // accepts the friendly `workspace/item.Lakehouse` name the user already picked, so no
  // GUID lookups.
  //
  // Two things it replaces outright:
  //   - discovery. Three requests for a whole lakehouse instead of one directory listing
  //     per table (150+ serialised calls on a big one).
  //   - metadata resolution. Get table returns the entire metadata document INLINE, so
  //     there is no metadata/ listing, no version-hint.text, and no guessing which
  //     *.metadata.json is current.
  //
  // It is gated on the same tenant/workspace conversion setting that makes metadata/ exist
  // at all, so it can't see a table the DFS walk could. But it can be unreachable for
  // reasons that have nothing to do with the data — CORS, a private-link tenant, an older
  // region — so every failure falls back to the DFS walk below and is never fatal.
  const TABLE_API = "https://onelake.table.fabric.microsoft.com/iceberg";

  let ircPrefix = null;      // the `prefix` the config call hands back, per lakehouse
  let ircPrefixKey = null;
  let ircOff = false;        // one failure is enough; don't re-probe on every click

  async function ircGet(path) {
    const r = await authedFetch(TABLE_API + path);
    if (!r.ok) {
      const e = new Error(`Iceberg catalog HTTP ${r.status}`);
      e.status = r.status;
      throw e;
    }
    return r.json();
  }

  // The warehouse identifier is the whole "workspace/item" pair; the prefix it returns is
  // a PATH prefix, so its slash must survive into the next URL unencoded.
  async function ircPrefixFor(lh) {
    const warehouse = `${lh.workspace}/${lh.item}`;
    if (ircPrefixKey === warehouse && ircPrefix) return ircPrefix;
    const cfg = await ircGet(`/v1/config?warehouse=${encodeURIComponent(warehouse)}`);
    ircPrefix = (cfg.overrides && cfg.overrides.prefix) || warehouse;
    ircPrefixKey = warehouse;
    return ircPrefix;
  }

  const ircSeg = s => String(s).split("/").map(encodeURIComponent).join("/");

  // Returns the same shape as the DFS listTables(), or null if the catalog can't serve it.
  async function ircListTables(lh) {
    if (ircOff) return null;
    try {
      const prefix = await ircPrefixFor(lh);
      const ns = await ircGet(`/v1/${prefix}/namespaces`);
      // A namespace is an array of levels; OneLake only ever returns one level, and uses
      // a synthetic "dbo" for items that don't have schemas of their own.
      const names = (ns.namespaces || []).map(n => (Array.isArray(n) ? n.join(".") : String(n)));
      if (!names.length) return [];

      const lists = await mapPool(names, n =>
        ircGet(`/v1/${prefix}/namespaces/${ircSeg(n)}/tables`));

      const tables = [];
      names.forEach((schema, i) => {
        for (const id of (lists[i].identifiers || [])) {
          // `root` is only needed if we end up falling back to the DFS walk or reading a
          // conversion log; the catalog itself needs nothing but the namespace and the
          // name. It is resolved lazily by dfsRootFor(), because the namespace here may
          // be the synthetic "dbo" OneLake reports for items that have no schemas — in
          // which case Tables/dbo/<t> does not exist and Tables/<t> is the real path.
          tables.push({ schema, table: id.name, root: null, kind: READY, irc: true });
        }
      });
      return tables.sort((a, b) =>
        (a.schema || "").localeCompare(b.schema || "") || a.table.localeCompare(b.table));
    } catch (e) {
      ircOff = true;
      console.info(`[engine] Iceberg REST catalog unavailable (${e.message}); using the DFS walk`);
      return null;
    }
  }

  // Get table -> the metadata document, inline. No listing, no version guessing.
  async function ircResolve(lh, t) {
    const prefix = await ircPrefixFor(lh);
    const doc = await ircGet(
      `/v1/${prefix}/namespaces/${ircSeg(t.schema)}/tables/${ircSeg(t.table)}`);
    if (!doc || !doc.metadata) throw new Error("Iceberg catalog returned no metadata for this table");
    return {
      ...readMetadataDoc(doc.metadata, `${t.schema}.${t.table}`),
      metadataFile: basename(doc["metadata-location"] || ""),
      metadataUrl: doc["metadata-location"] ? toHttps(lh.workspace, doc["metadata-location"]) : null,
    };
  }

  // ---------------------------------------------------------------------------
  // Iceberg metadata resolution — DFS-by-name fallback (no REST catalog / GUIDs).
  // ---------------------------------------------------------------------------
  // Fabric generates a table's Iceberg metadata lazily, on access. The first request
  // triggers generation and loses the race — you get an HTTP 400 for a metadata.json that
  // the directory listing just told us exists — and a moment later the same table reads
  // fine. So retry the WHOLE resolution rather than refetching the same URL: the second
  // pass re-lists metadata/, which may by then expose a newer version-hint and a different
  // metadata.json than the one that failed.
  async function resolveIcebergRetrying(ws, root, label) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await resolveIceberg(ws, root);
      } catch (e) {
        // 400/404 here means "not materialized yet", not "wrong". A missing metadata.json
        // in a directory that exists is the same story.
        const transient = e.status === 400 || e.status === 404 ||
                          /No \S*metadata\.json|No metadata\//.test(e.message);
        if (!transient || attempt >= RESOLVE_BACKOFF_MS.length) throw e;
        const waited = RESOLVE_BACKOFF_MS.slice(0, attempt + 1).reduce((a, b) => a + b, 0);
        onStatus(`Waiting for Fabric to generate Iceberg metadata for ${label}… ` +
                 `(${Math.round(waited / 1000)}s so far; conversion can take up to two minutes)`);
        await sleep(RESOLVE_BACKOFF_MS[attempt]);
      }
    }
  }

  async function resolveIceberg(ws, root) {
    const entries = await listPaths(ws, `${root}/metadata`, false);
    if (!entries.length) throw new Error(`No metadata/ under ${root}`);

    // Prefer the version-hint pointer; otherwise take the highest version NUMBER. Not the
    // newest lastModified: that has one-second resolution, so v9 and v10 written in the
    // same second tie and the older snapshot can win with nothing said about it.
    let hintText = null;
    const hint = entries.find(e => basename(e.name).toLowerCase() === "version-hint.text");
    if (hint) {
      try { hintText = await fetchText(dfsUrl(ws, hint.name)); }
      catch (_) { /* fall back to the highest version */ }
    }
    const current = pickMetadata(entries, hintText);
    if (!current) throw new Error(`No *.metadata.json under ${root}/metadata`);

    return {
      ...readMetadataDoc(await fetchJson(dfsUrl(ws, current.name)), basename(current.name)),
      metadataFile: basename(current.name),
      metadataUrl: dfsUrl(ws, current.name),
    };
  }

  // The parts of an Iceberg metadata document this reader needs. Shared, because the same
  // document arrives two ways: fetched from metadata/ over DFS, or handed over inline by
  // the REST catalog's Get table. The validation belongs in one place either way.
  function readMetadataDoc(meta, source) {
    // Guessing is worse than failing here. Falling back to the last element of the
    // snapshots array, as an earlier version did, opens the table against a snapshot that
    // is not defined to be the current one and says nothing about having done so.
    const curId = meta["current-snapshot-id"];
    if (curId == null)
      throw new Error(`${source} has no current-snapshot-id — the metadata is incomplete`);
    const snap = (meta.snapshots || []).find(s => String(s["snapshot-id"]) === String(curId));
    if (!snap)
      throw new Error(`${source} names snapshot ${curId}, which is not in its snapshot list`);
    if (!snap["manifest-list"]) throw new Error(`${source}: the current snapshot has no manifest-list`);

    const schema = (meta.schemas || []).find(s => s["schema-id"] === meta["current-schema-id"])
                || (meta.schemas || [])[0];

    return {
      manifestList: snap["manifest-list"],
      // Column names of the table's CURRENT schema, used below to spot a physical/logical
      // mismatch once the parquet files are unioned.
      schemaColumns: schema ? (schema.fields || []).map(f => f.name) : null,
      // Physical parquet name -> readable name, when the writer used column mapping.
      nameMapping: readNameMapping(meta, schema),
      // More than one schema in the log means the table evolved and its data files can
      // disagree — only then is union_by_name worth its price (see createView).
      evolved: (meta.schemas || []).length > 1,
      totalRecords: Number((snap.summary || {})["total-records"]) || null,
    };
  }

  // alias -> current column name, from the table's `schema.name-mapping.default`.
  //
  // Fabric Warehouse writes column-mapped Delta, so the field names in its parquet files
  // are GUIDs (`col-81f65814-…`) and the readable names live only in metadata. Nothing in
  // the footers bridges the two: field_id is absent on every column (probed on a real
  // Warehouse file — created_by "parquet-cpp-arrow Microsoft Fabric 14.0.2"). Iceberg's
  // answer for exactly that case is a name mapping, and Fabric publishes one: each entry
  // carries a field ID and every name that has meant it, physical GUID included.
  //
  // Returns null when the table has no mapping — every Lakehouse table, since delta-rs
  // writes readable names — which is the signal to leave the columns alone.
  function readNameMapping(meta, schema) {
    const raw = (meta.properties || {})["schema.name-mapping.default"];
    if (!raw) return null;
    let entries;
    // It is a JSON document inside a JSON string. Malformed means no mapping, not a
    // failure to open: a GUID header is bad, a table that won't open is worse.
    try { entries = typeof raw === "string" ? JSON.parse(raw) : raw; } catch (_) { return null; }
    if (!Array.isArray(entries)) return null;

    const byId = new Map(((schema || {}).fields || [])
      .filter(f => f.id != null).map(f => [String(f.id), f.name]));
    const out = new Map();
    for (const e of entries) {
      // The current schema decides what a field is called NOW; names[0] is only a
      // fallback for an ID the schema no longer lists.
      const current = byId.get(String(e["field-id"])) || (e.names || [])[0];
      if (!current) continue;
      for (const n of (e.names || []))
        // A name that maps to two different fields is not one worth trusting.
        out.set(n, out.has(n) && out.get(n) !== current ? null : current);
    }
    return out.size ? out : null;
  }

  // Where this table's directory actually is. A table found through the DFS walk already
  // knows; one found through the catalog does not, because OneLake reports a synthetic
  // "dbo" namespace for items that have no schemas of their own — so Tables/dbo/<t> may
  // not exist while Tables/<t> does. Two cheap listings settle it, and only on the paths
  // that need a directory at all (the fallback resolve, and the conversion log).
  async function dfsRootFor(ws, item, t) {
    if (t.root) return t.root;
    const candidates = [`${item}/Tables/${t.schema}/${t.table}`, `${item}/Tables/${t.table}`];
    for (const c of candidates) {
      try { if ((await listPaths(ws, c, false)).length) { t.root = c; return c; } }
      catch (_) { /* try the other shape */ }
    }
    t.root = candidates[0];
    return t.root;
  }

  // When conversion hasn't produced metadata/, Fabric leaves a log saying why. Reading it
  // turns "is this an Iceberg table?" into the actual reason.
  async function readConversionLog(ws, root) {
    for (const dir of [`${root}/metadata`, `${root}/_delta_log`]) {
      let entries;
      try { entries = await listPaths(ws, dir, false); } catch (_) { continue; }
      const log = entries.find(e => !e.isDir && /conversion.*log.*\.txt$/i.test(basename(e.name)));
      if (!log) continue;
      try {
        const text = (await fetchText(dfsUrl(ws, log.name))).trim();
        if (text) return text.length > 400 ? text.slice(0, 400) + "…" : text;
      } catch (_) { /* the log is best-effort; never let it mask the real error */ }
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Manifest layer — read Avro manifest-list + manifests with DuckDB's read_avro.
  // Manifests are fetched to local buffers (WASM httpfs truncates larger avro files)
  // and each live entry (status != 2 DELETED) with content = 0 yields a parquet path.
  // ---------------------------------------------------------------------------
  async function withAvroBuffer(bytes, run) {
    const name = `meta_${++_seq}.avro`;
    await db.registerFileBuffer(name, bytes);
    try {
      const t = await run(name);
      return t.toArray().map(r => r.toJSON());
    } finally { try { await db.dropFile(name); } catch (_) {} }
  }

  async function readAvroRows(ws, url, columnsSql) {
    return withAvroBuffer(await fetchAuthed(toHttps(ws, url)), name =>
      q(`SELECT ${columnsSql} FROM read_avro('${name}')`));
  }

  // Returns { dataFiles, posDeletes, eqDeletes } for one manifest.
  //
  // `content` distinguishes what a manifest entry points at: 0 = data, 1 = position
  // deletes, 2 = equality deletes. Filtering on it is not cosmetic — a delete file is a
  // parquet whose schema is nothing like the table's (position deletes are file_path +
  // pos), so feeding its path to read_parquet() alongside the data files either fails
  // schema unification or yields junk rows. Format-version 1 manifests have no `content`
  // field at all and are data-only, hence the fallback query.
  async function readManifest(bytes) {
    let rows;
    try {
      rows = await withAvroBuffer(bytes, name => q(
        `SELECT status, data_file.content AS content, data_file.file_path AS fp
         FROM read_avro('${name}')`));
    } catch (_) {
      rows = await withAvroBuffer(bytes, name => q(
        `SELECT status, 0 AS content, data_file.file_path AS fp
         FROM read_avro('${name}')`));
    }
    const live = rows.filter(r => Number(r.status) !== 2);   // drop DELETED entries
    // String() is defensive normalization: these paths become registerFileURL() keys that
    // have to compare equal to the SQL literals built from them, so don't let an Arrow
    // value type reach either side.
    const of = k => live.filter(r => Number(r.content || 0) === k).map(r => String(r.fp));
    return { dataFiles: of(0), posDeletes: of(1), eqDeletes: of(2) };
  }

  async function listDataFiles(ws, manifestList, check = () => {}) {
    const manifests = (await readAvroRows(ws, manifestList, "manifest_path"))
      .map(r => String(r.manifest_path));

    const files = [], posDeletes = [], eqDeletes = [];
    // Fetch a batch in parallel — the network is the slow half — then parse it serially,
    // because there is one connection. Batching rather than fetching everything up front
    // keeps at most MAX_PARALLEL manifest buffers alive at a time.
    for (let i = 0; i < manifests.length; i += MAX_PARALLEL) {
      // Per batch, not per manifest: a batch is already in flight together, and stopping
      // between batches bounds the wait at one round trip.
      check();
      const buffers = await mapPool(manifests.slice(i, i + MAX_PARALLEL),
                                    m => fetchAuthed(toHttps(ws, m)));
      for (const bytes of buffers) {
        const r = await readManifest(bytes);
        files.push(...r.dataFiles);
        posDeletes.push(...r.posDeletes);
        eqDeletes.push(...r.eqDeletes);
      }
    }
    return { files, posDeletes, eqDeletes };
  }

  // ---------------------------------------------------------------------------
  // Load a table -> read-only VIEW.
  // ---------------------------------------------------------------------------
  // One reader: walk the manifests, then let DuckDB range-read the parquet files. Nothing
  // is downloaded whole — waiting minutes for a table to transfer isn't a usable product,
  // so if range reads fail the app says so rather than quietly grinding.
  //
  // DuckDB's own `iceberg` extension DOES load in WASM (it is published for wasm_eh and
  // wasm_mvp), but it still cannot be used here. Fabric writes ABSOLUTE abfss:// URIs into
  // the metadata; resolving those needs the `azure` filesystem, and `azure` has no WASM
  // build — Microsoft's own DuckDB sample for OneLake Iceberg loads `azure` + `httpfs` for
  // exactly this reason. `allow_moved_paths` doesn't rescue it either; it refuses absolute
  // URIs. The only bridge is to pre-register every abfss:// path as a virtual file aliased
  // to its https URL, and enumerating those paths IS the manifest walk below — so the
  // extension would add a dependency without removing any work. (Measured against a real
  // Fabric table it also answered SELECT count(*) as 0, trusting a manifest record_count
  // of 0.) Revisit if OneLake ever writes relative paths, or `azure` ships for WASM.
  //
  // Delete files are handled here instead: position deletes via an anti-join in
  // createView(). Equality deletes are not applied, and say so.
  //
  // Idempotent: a table already loaded is returned from cache.
  // ---------------------------------------------------------------------------
  const labelFor = t => t.schema ? `${t.schema}.${t.table}` : t.table;

  // Every query that can be slow goes through here rather than conn.query().
  //
  // conn.query() is the worker's RUN_QUERY: it runs to completion inside the worker and
  // cancelSent() answers false. Measured on the pinned build — a 35s scan ignored the
  // cancel and ran the full 35s — and that is precisely what left a click on another
  // table queued behind the first table's preview with nothing able to interrupt it.
  // conn.send() is the pending-query path, polled in chunks, and cancelSent() kills it
  // mid-scan: same scan, dead 1.0s in, connection usable 8ms later, a new table's DDL
  // running 7ms after that.
  //
  // The reader carries no schema of its own (checked: reader.schema is undefined). The
  // first batch does, and an empty result still yields one batch, so the first batch is
  // always where the fields come from.
  async function stream(sql, onBatch = () => {}) {
    return serial(async () => {
      try {
        const reader = await conn.send(sql);
        let schema = null;
        for await (const batch of reader) {
          if (!schema) schema = batch.schema;
          onBatch(batch, schema);
        }
        return schema;
      } catch (e) {
        // DuckDB reports a cancelled query as an error. It is not one.
        if (/cancel/i.test(e.message || "")) throw cancelledError();
        throw e;
      }
    });
  }

  async function describe(ident) {
    const out = [];
    await stream(`DESCRIBE ${ident}`, batch => {
      for (const r of batch) {
        const j = r.toJSON();
        out.push({ name: j.column_name, type: j.column_type });
      }
    });
    return out;
  }

  // Data files are registered under generated `data_N.parquet` names, so read_parquet's
  // `filename` is that generated name — not the path an Iceberg delete file refers to.
  // `mapTable` bridges the two (reg -> normalized original path).
  //
  // Registering them under their original abfs:// path instead would remove the need for
  // that mapping, and DuckDB-WASM's file registry does resolve such aliases — but only
  // sometimes: it works in isolation and fails inside this engine's real sequence, after
  // the Avro manifests have been read through registered buffers. Generated names have no
  // such problem, so the mapping table is the cheap price of a reader that always works.
  //
  // union_by_name only when the metadata says the schema EVOLVED. It is what lets files
  // with added columns scan together (without it DuckDB errors on the first mismatched
  // file) — but it makes bind read the footer of EVERY file up front, and on a
  // many-hundred-file table that is hundreds of HTTPS range reads before a
  // `LIMIT 100` preview produces its first row. A never-evolved table (one schema in
  // the log, the overwhelmingly common case) binds off the first footer and touches
  // other files only when the scan actually reaches them.
  //
  // `aliases` (physical -> logical pairs, in table order) replaces the star with an
  // explicit projection. It arrives only for a column-mapped table, and only once every
  // column resolved — see aliasByFieldId().
  async function createView(ident, regs, delTable, mapTable, unionByName, aliases) {
    const list = regs.map(sqlStr).join(", ");
    const union = unionByName ? ", union_by_name = true" : "";
    const proj = aliases &&
      aliases.map(([phys, log]) => `${quoteIdent(phys)} AS ${quoteIdent(log)}`).join(", ");
    // stream(), not q(): under union_by_name this bind reads the footer of EVERY file —
    // hundreds of HTTPS round trips inside one statement — and a conn.query() cannot be
    // cancelled, so Stop (and everything queued behind, including reset()) hung on it.
    // conn.send() runs DDL fine (verified against the pinned build) and dies on
    // cancelSent().
    if (!delTable) {
      await stream(
        `CREATE OR REPLACE VIEW ${ident} AS
         SELECT ${proj || "*"} FROM read_parquet([${list}]${union})`);
      return;
    }
    // EXCLUDE keeps the two bookkeeping columns out of the table's visible schema. An
    // explicit projection already names only real columns, so it needs no EXCLUDE.
    await stream(
      `CREATE OR REPLACE VIEW ${ident} AS
       SELECT ${proj || "* EXCLUDE (filename, file_row_number)"}
       FROM read_parquet([${list}]${union},
                         filename = true, file_row_number = true) x
       WHERE NOT EXISTS (
         SELECT 1 FROM ${delTable} d JOIN ${mapTable} m ON m.pk = d.pk
         WHERE m.reg = x.filename AND d.pos = x.file_row_number)`);
  }

  // The projection that turns the scanned names into the readable ones, or null to leave
  // the view as it is.
  //
  // All or nothing. A partial mapping would leave a table half-readable and half-GUID
  // while implying both names are real, so a single unresolved column means no aliasing
  // at all — the physical names stand and the caller warns. Null also comes back when
  // nothing would change, which is every table whose names were already readable.
  function aliasFor(columns, mapping) {
    if (!mapping) return null;
    const pairs = [], used = new Set();
    let changed = false;
    for (const c of columns) {
      const name = mapping.get(c.name);
      if (!name || used.has(name)) return null;
      used.add(name);
      if (name !== c.name) changed = true;
      pairs.push([c.name, name]);
    }
    return changed ? pairs : null;
  }

  // reg name -> normalized original path, so the anti-join can match a delete file's
  // `file_path` against the data file it refers to. Both sides go through pathKey():
  // Iceberg does not promise the two strings are byte-identical — abfs vs abfss alone
  // differs between writers — and an exact match that finds nothing silently resurrects
  // every deleted row while still reporting the deletes as applied.
  async function createMap(key, pairs) {
    const name = `__map_${++_seq}`;
    const values = pairs.map(([reg, orig]) => `(${sqlStr(reg)}, ${sqlStr(pathKey(orig))})`).join(", ");
    await q(
      `CREATE OR REPLACE TABLE ${name} AS SELECT * FROM (VALUES ${values}) v(reg, pk)`);
    track(key).tables.push(name);
    return name;
  }

  // Materialize the position-delete files into one small table, keyed the same way.
  async function loadPositionDeletes(key, ws, paths) {
    const res = track(key);
    const regs = [];
    for (const p of paths) {
      const reg = `del_${++_seq}.parquet`;
      await db.registerFileURL(reg, toHttps(ws, p), duckdb.DuckDBDataProtocol.HTTP, false);
      res.regs.push(reg);
      regs.push(reg);
    }
    const name = `__del_${++_seq}`;
    // stream() for the same reason as createView: this reads the delete files over HTTP
    // inside one statement, and it must die on Stop.
    await stream(
      `CREATE OR REPLACE TABLE ${name} AS
       SELECT ${PATH_KEY_SQL("file_path")} AS pk, pos
       FROM read_parquet([${regs.map(sqlStr).join(", ")}], union_by_name = true)`);
    res.tables.push(name);
    return name;
  }

  // After a failure inside the multi-file scan, find out which file caused it. LIMIT 0
  // probes bind footers without reading data, and halving converges in log steps. If
  // even SELECT 1 fails, the engine itself trapped and nothing more can be learned.
  async function diagnoseOpenFailure(regs, pairs, unionByName, ws) {
    try { await q("SELECT 1"); }
    catch (_) { return " — the SQL engine crashed on this table; reload the page before opening another"; }

    let budget = 24;                    // probes, not files — log-bounded either way
    const union = unionByName ? ", union_by_name = true" : "";
    const probe = async subset => {
      if (budget-- <= 0) return [];     // give up quietly rather than probing forever
      try {
        // stream(): probes bind footers over HTTP too, and a diagnosis must not be the
        // thing that can't be stopped.
        await stream(`SELECT * FROM read_parquet([${subset.map(sqlStr).join(", ")}]${union}) LIMIT 0`);
        return [];
      } catch (e) {
        // A cancelled probe is not a bad file — stop diagnosing, report nothing.
        if (e && e.cancelled) throw e;
        if (subset.length === 1) return subset;
        const mid = subset.length >> 1;
        return [...await probe(subset.slice(0, mid)), ...await probe(subset.slice(mid))];
      }
    };
    onStatus("Narrowing down which data file fails…");
    const bad = await probe(regs);
    // The same list binding cleanly a moment later IS the diagnosis: the failure was
    // transient — a read that went out unsigned or against a just-expired token and
    // has since been retried with a live one. Nothing is wrong with the table.
    if (!bad.length)
      return " — yet the same file list binds cleanly when re-probed just now: the " +
             "failure was transient (most likely an unsigned or expired-token read), so try again";
    const orig = new Map(pairs);
    const names = bad.slice(0, 3).map(r => basename(orig.get(r) || r));
    const scope = regs.length < 2 ? "" :
      ` — narrowed to data file(s): ${names.join(", ")}` +
      (bad.length > 3 ? ` and ${bad.length - 3} more` : "");
    return scope + await diagnoseOneFile(bad[0], orig.get(bad[0]), ws);
  }

  // Two checks that tell apart the ways an open can fail with identical wording: a name
  // gone from DuckDB's file registry never touched the network (another load dropped
  // it), while a dead token or a deleted object answers a page-signed read with its
  // status. Both facts are reported; either alone can mislead.
  async function diagnoseOneFile(reg, path, ws) {
    const facts = [];
    try {
      const hits = await db.globFiles(reg);
      if (!hits || !hits.length) {
        const d = dropLog.get(reg), at = regLog.get(reg);
        facts.push(d
          ? `${reg} is missing from DuckDB's file registry — dropped ${Math.round((Date.now() - d.at) / 1000)}s ago by ${d.why}`
          : `${reg} is missing from DuckDB's file registry, yet no code path dropped it` +
            (at ? ` (registered ${Math.round((Date.now() - at) / 1000)}s ago)` : " (and no registration was recorded either)"));
      }
    } catch (_) { /* this duckdb-wasm has no globFiles — nothing to check */ }
    if (path && ws) {
      try {
        const r = await fetch(toHttps(ws, path), { headers: { ...auth.getHeaders(), Range: "bytes=0-7" } });
        facts.push(r.ok
          ? "a page-signed range read of the object succeeds, so the file and the page's token are fine"
          : `a page-signed range read of the object answers HTTP ${r.status}`);
      } catch (e) {
        facts.push(`a page-signed range read of the object failed outright (${e.message})`);
      }
    }
    return facts.length ? ` — ${facts.join("; ")}` : "";
  }

  // How many delete records point at a data file the map doesn't know about? Anything but
  // zero means the anti-join is removing fewer rows than the snapshot says it should, and
  // reporting "N delete file(s) applied" would be a lie.
  async function countUnmatchedDeletes(delTable, mapTable) {
    const r = await q(
      `SELECT count(*) AS n FROM ${delTable} d
       WHERE NOT EXISTS (SELECT 1 FROM ${mapTable} m WHERE m.pk = d.pk)`);
    return Number(r.toArray()[0].toJSON().n) || 0;
  }

  async function loadTable(lh, t) {
    // Keyed per lakehouse: the engine outlives the user's choice of one, and two
    // lakehouses can both hold a dbo.sales.
    const key = tableKey(lh, t);
    // Supersede whatever came before — even on a cache hit, because the click means
    // "show me THIS" and the in-flight load must stand down rather than repaint the
    // screen later. A previous load stands down at its next check(), and a previous
    // query dies in the worker — without this, picking a second table simply queued
    // behind the first one's preview and looked like a frozen app, which is the bug
    // 54229d3 claimed to fix and didn't: nothing ever bumped the counter except the
    // Stop button.
    await cancelLoad();
    if (loaded.has(key)) return loaded.get(key);
    const gen = loadGen;
    const check = () => { if (gen !== loadGen) throw cancelledError(); };
    const status = statusFor(gen);

    const ws = lh.workspace;
    const label = labelFor(t);
    const warnings = [];

    status(`Resolving ${label}…`);
    let resolved;
    try {
      // The catalog hands the metadata over inline, so when it's reachable this is one
      // request. If it fails for this table, the DFS walk is still there.
      if (t.irc) {
        try {
          resolved = await ircResolve(lh, t);
        } catch (e) {
          console.info(`[engine] catalog could not resolve ${label} (${e.message}); reading metadata/ directly`);
          resolved = await resolveIcebergRetrying(ws, await dfsRootFor(ws, lh.item, t), label);
        }
      } else {
        resolved = await resolveIcebergRetrying(ws, t.root, label);
      }
    } catch (e) {
      // "No metadata yet" is a state with three actionable causes, and Fabric records
      // which one applies in a conversion log next to the table.
      const log = await readConversionLog(ws, await dfsRootFor(ws, lh.item, t));
      if (log) throw new Error(`${label} has no Iceberg metadata yet. Fabric's conversion log says: ${log}`);
      throw new Error(
        `${label} has no Iceberg metadata. OneLake writes it on demand and conversion can take ` +
        `up to two minutes, but if it never appears then Delta-to-Iceberg conversion is probably ` +
        `not enabled for this tenant or workspace. (${e.message})`);
    }

    const ident = t.schema
      ? `${quoteIdent(t.schema)}.${quoteIdent(t.table)}`
      : quoteIdent(t.table);
    if (t.schema) await q(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(t.schema)}`);

    check();
    status(`Reading manifests for ${label}…`);
    const { files: paths, posDeletes, eqDeletes } =
      await listDataFiles(ws, resolved.manifestList, check);
    if (!paths.length) throw new Error(`${label}: current snapshot has no data files`);

    const res = track(key);
    res.gen = gen;          // whoever set this last owns the teardown; see releaseOwned()
    res.ident = ident;
    // Claimed only once there is a record for release() to guard: a claim made before
    // track() is state a concurrent release(key) sweeps with nothing to check against.
    viewNames.set(ident, key);
    let columns;
    status(`Opening ${label} — ${paths.length} file(s)…`);
    const regs = [], pairs = [];
    // Hoisted: the column-mapping pass below rebuilds the view and has to preserve the
    // delete anti-join it was first built with.
    let delTable = null, mapTable = null;
    let stage = "registering data files";
    try {
      // Map each data file to a generated name pointing at its https URL, so DuckDB
      // range-reads it instead of us downloading it whole.
      for (const p of paths) {
        // The hundreds-of-round-trips loop, and so the one that most needs a way out.
        check();
        const reg = `data_${++_seq}.parquet`;
        await db.registerFileURL(reg, toHttps(ws, p), duckdb.DuckDBDataProtocol.HTTP, false);
        regLog.set(reg, Date.now());
        res.regs.push(reg);
        regs.push(reg);
        pairs.push([reg, p]);
      }
      stage = "reading delete files";
      delTable = posDeletes.length ? await loadPositionDeletes(key, ws, posDeletes) : null;
      mapTable = delTable ? await createMap(key, pairs) : null;
      stage = "creating the view";
      await createView(ident, regs, delTable, mapTable, resolved.evolved);
      stage = "reading the parquet footers";
      columns = await describe(ident);   // forces a real footer read — this is the probe

      stage = "checking deletes";
      if (delTable) {
        const unmatched = await countUnmatchedDeletes(delTable, mapTable);
        if (unmatched)
          warnings.push(`${unmatched} delete record(s) point at data files that aren't in this ` +
                        `snapshot and could not be applied — some deleted rows may still appear`);
      }
    } catch (e) {
      // A stop is not a failure and has no culprit file to bisect for. Release what was
      // registered and report it as itself.
      if (e.cancelled) { await releaseOwned(key, regs, gen); throw e; }
      // Superseded while failing: the error belongs to a load nobody is waiting on, and
      // some of the ways it can fail here ARE the supersession — its files dropped out
      // from under it. The current load's own errors still have gen === loadGen.
      if (gen !== loadGen) { await releaseOwned(key, regs, gen); throw cancelledError(); }
      // Which FILE did it? An error like "table index is out of bounds" (a wasm trap on
      // some parquet feature this build mishandles) names nothing, and a several-hundred
      // file table gives the user nothing to report. Bisect with LIMIT 0 binds — the
      // object cache makes re-binds cheap — before the registrations are released.
      let detail = "";
      try { detail = await diagnoseOpenFailure(regs, pairs, resolved.evolved, ws); } catch (_) {}
      // Ownership-aware for the same reason a cancel is: a superseded load that fails must
      // not take the load that replaced it down with it.
      await releaseOwned(key, regs, gen);
      // Deliberately no whole-file download tier: on a big table that means minutes of
      // waiting and the table in browser memory. Report the cause — and only the cause.
      // This used to append a guess about the service worker to every failure here,
      // including schema mismatches and expired tokens, and sent people off reloading.
      throw new Error(`Could not open ${label} while ${stage}: ${e.message}${detail}`);
    }

    // read_parquet matches columns by NAME, and a column the current schema doesn't have
    // means one of two very different things. Either the writer is column-mapped and the
    // name is physical (a Warehouse GUID) — the name mapping fixes that, below. Or the
    // table was renamed: an Iceberg rename is metadata-only, so the old name survives in
    // older files and there is nothing to map it to. Only the second is worth warning
    // about, and this used to report every Warehouse column as the second.
    if (resolved.schemaColumns) {
      const known = new Set(resolved.schemaColumns);
      let extra = columns.map(c => c.name).filter(n => !known.has(n));
      // Best-effort throughout: a table that opened is not worth losing over a cosmetic
      // rename, and CREATE OR REPLACE leaves the working view standing if it fails.
      if (extra.length) try {
        const aliases = aliasFor(columns, resolved.nameMapping);
        if (aliases) {
          await createView(ident, regs, delTable, mapTable, resolved.evolved, aliases);
          columns = await describe(ident);
          extra = columns.map(c => c.name).filter(n => !known.has(n));
        }
      } catch (_) { /* keep the physical names and warn below */ }
      if (extra.length)
        warnings.push(`column(s) ${extra.join(", ")} are in the data files but not in the table's ` +
                      `current schema — it was renamed or had columns dropped, so values may be ` +
                      `split across the old and new names`);
    }
    if (eqDeletes.length)
      warnings.push(`${eqDeletes.length} equality-delete file(s) are NOT applied — deleted rows may still appear`);

    const info = { label, ident, columns, fileCount: paths.length,
                   posDeletes: posDeletes.length, eqDeletes: eqDeletes.length,
                   totalRecords: resolved.totalRecords, warnings };

    loaded.set(key, info);
    status(describeLoad(info));
    return info;
  }

  // One sentence about how the table was opened. Position deletes that applied cleanly are
  // not news — that is just correctness. Anything in `warnings` is a correctness caveat,
  // and rendering it as a warning rather than as success is the caller's job.
  function describeLoad({ label, fileCount, posDeletes, file, ext, bytes, totalRecords,
                          db, dbAlias, dbTables, dbEngine, zip, zipViews }) {
    if (zip) {
      const n = (zipViews || []).length;
      const list = n ? `: ${zipViews.slice(0, 5).join(", ")}${n > 5 ? ", …" : ""}` : "";
      return `${label} — zip archive (${fmtBytes(bytes)}), ${fileCount} entr${fileCount === 1 ? "y" : "ies"}, ` +
             `${n} opened as view${n === 1 ? "" : "s"}${list}` +
             (n ? `. Entries decompress on demand` : "");
    }
    if (db) {
      const n = (dbTables || []).length;
      if (dbEngine === "SQLite") {
        return `${label} — SQLite (${fmtBytes(bytes)}) copied into DuckDB, ${n} table(s)` +
               (n ? `. Query them as ${dbAlias}.<table>` : "");
      }
      return `${label} — DuckDB attached read-only as ${dbAlias}, ${n} table(s)/view(s), read on demand` +
             (n ? `. Query them as ${dbAlias}.<schema>.<table>` : "");
    }
    if (file) {
      if (PARQUET_EXTS.has(ext)) return `${label} — read on demand`;
      if (isTextExt(ext)) return `${label} — read in full as text (${fmtBytes(bytes)}), one row per line`;
      return `${label} — ${ext.toUpperCase()} is read in full (${fmtBytes(bytes)}); no range reads for this format`;
    }
    let s = `${label} — ${fileCount} file(s), read on demand`;
    if (totalRecords != null) s += `, ${totalRecords.toLocaleString("en")} row(s)`;
    if (posDeletes) s += `, ${posDeletes} delete file(s) applied`;
    return s;
  }

  // ---------------------------------------------------------------------------
  // Read-only SQL. One statement, must start with a read keyword.
  // ---------------------------------------------------------------------------
  // The parsing and the guard live in paths.js, where they are tested: doing this with a
  // pair of regexes used to eat a /* */ that was part of a string value — changing the
  // result set with no error at all — and reject a perfectly legal SELECT 'a;b'.
  async function runSql(sql) {
    const clean = prepareReadOnlySql(sql);
    let fields = null, types = null;
    const rows = [];
    let numRows = 0, truncated = false;

    // Cap what gets turned into JS objects. Everything downstream — the DOM table, the CSV
    // — works off this array, so an uncapped SELECT * on a large table takes the tab out.
    // The batches keep being drained past the cap: numRows is the size of the whole
    // result, and the message that says "stopped at N of M" needs a truthful M.
    await stream(clean, (batch, schema) => {
      if (!fields) {
        fields = schema.fields.map(f => f.name);
        types = schema.fields.map(f => arrowTypeName(f.type));
      }
      numRows += batch.numRows;
      for (const r of batch) {
        if (rows.length >= MAX_ROWS) { truncated = true; break; }
        rows.push(normalizeRow(r.toJSON(), fields));
      }
    });
    return { fields: fields || [], types: types || [], rows, numRows, truncated, limit: MAX_ROWS };
  }

  function normalizeRow(obj, fields) {
    const out = {};
    for (const f of fields) out[f] = normalizeValue(obj[f]);
    return out;
  }

  // The file itself, byte for byte, straight off OneLake. Not reassembled from the query
  // result: the reader splits on line endings and drops the CR of a CRLF, so a rebuilt
  // copy is a plausible file rather than the one that is stored. Compressed text comes
  // back compressed, which is also what "download this file" means.
  async function readFileBytes(lh, file) {
    return fetchAuthed(dfsUrl(lh.workspace, file.path));
  }

  return { init, reset, parseLakehouse, listWorkspaces, listItems, listTables, loadTable,
           listFiles, loadFile, readFileBytes, runSql, describeLoad, fmtBytes, cancelLoad };
}

// -----------------------------------------------------------------------------
// Results come back as Arrow, so the column types are Arrow's, not DuckDB's. Name them
// the way DuckDB does — those are the names the user wrote the query against, and the
// ones DESCRIBE would have shown. Module-scope and exported: it is pure, and the
// integration harness uses it to prove real Arrow types reach isDocResult.
// -----------------------------------------------------------------------------
const ARROW_NAME = { 1: "NULL", 4: "BLOB", 5: "VARCHAR", 6: "BOOLEAN", 8: "DATE",
                     11: "INTERVAL", 13: "STRUCT", 14: "UNION", 15: "BLOB",
                     17: "MAP", 19: "BLOB", 20: "VARCHAR" };
const INT_NAME = { 8: "TINYINT", 16: "SMALLINT", 32: "INTEGER", 64: "BIGINT", 128: "HUGEINT" };

export function arrowTypeName(t) {
  if (!t) return "";
  switch (t.typeId) {
    case 2: {   // Int — width and signedness live on the type
      const n = INT_NAME[t.bitWidth] || "INTEGER";
      return t.isSigned === false ? "U" + n : n;
    }
    case 3: return t.precision === 2 ? "DOUBLE" : "FLOAT";   // Precision: HALF/SINGLE/DOUBLE
    case 7: return `DECIMAL(${t.precision},${t.scale})`;
    case 9: return "TIME";
    case 10: return t.timezone ? "TIMESTAMPTZ" : "TIMESTAMP";
    case 12: case 16: return arrowTypeName(t.children && t.children[0] && t.children[0].type) + "[]";
    case 18: return "INTERVAL";
    default: return ARROW_NAME[t.typeId] || String(t).toUpperCase();
  }
}
