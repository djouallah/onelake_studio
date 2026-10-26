// =============================================================================
// data.js — OneLake data engine, on native DuckDB in the extension host
// =============================================================================
// Given a lakehouse path, this module:
//   1. connects to the native engine over the panel's message bridge (duckdb-native.js),
//   2. lists the lakehouse's tables through OneLake's Iceberg REST catalog by friendly
//      name (workspace/lakehouse.Lakehouse) — no GUIDs, storage token only. DFS is still
//      how Files/ and the workspace/item pickers are listed; table LISTING is the
//      catalog's alone,
//   3. for a chosen table, asks the catalog for its metadata document — that is the
//      Stats card and the lazy-conversion wait — and has the host ATTACH the item as an
//      Iceberg catalog (db.openTable), after which DuckDB itself does snapshot
//      resolution, manifest reading, deletes and column mapping,
//   4. exposes the table as a read-only VIEW you can run SQL against. Nothing is
//      downloaded whole: reads go through the extension's loopback proxy, which signs
//      them, so a query pulls only the row groups and columns it touches.
//
// The pure half — path and URI handling, SQL text, cache keys, version selection — lives
// in paths.js and is covered by test/paths.test.js. Anything here that can be written as
// a function of strings belongs there instead: that is where the mistakes that silently
// return the wrong rows were hiding, and clicking around does not find them.
//
// DOM-free: progress is reported through the injected `onStatus` callback.
// =============================================================================

// THE ENGINE IS NATIVE DuckDB, IN THE EXTENSION HOST — there is no WebAssembly in this
// page any more. A VS Code extension host is Node, so it runs the real thing. Measured,
// boot to a usable engine:
//
//                      duckdb-wasm                @duckdb/node-api
//   engine + connect   ~760ms                     17ms
//   four extensions    ~1187ms warm               263ms warm
//   engine ready       ~2000ms warm, 6.6s cold    284ms
//   threads            1                          8
//
// The wasm side never improved with caching, and could not: duckdb-wasm pipes the wasm
// response through a TransformStream (it wants progress events) and hands
// instantiateStreaming a SYNTHETIC Response, while Chromium can only attach a compiled
// module to a real HTTP cache entry. So the 35MB compile was paid on every panel open no
// matter what the proxy sent, and the four extensions were four more modules compiled
// fresh every session.
//
// Everything below this line is unchanged by that: this engine's whole dependency on
// DuckDB is a handful of calls, and duckdb-native.js answers them from the host. See
// extension/src/engine-host.js. Native DuckDB reads URLs and paths spliced directly into
// the SQL — the wasm build's virtual file registry (registerFileURL) is gone; only
// registerFileBuffer survives, for bytes that have no URL, and it answers with the temp
// path the host wrote so this side can say exactly what it means.


// The page reads nothing from OneLake itself. Listings and bytes come from the extension
// host (its cache-first store, its signed reads); DuckDB, also in the host, reads tables
// and Files/ objects by their abfss:// names with the host's own credential.
import {
  strip, basename, abfssUrl,
  parseLakehouse,
  fileExt, readerFor, PARQUET_EXTS, DB_EXTS, ZIP_EXTS, isSqliteHeader, isTextExt,
  sqlStr, quoteIdent, prepareReadOnlySql,
  tableKey, fileKey, sanitizeIdent,
  normalizeValue, fmtBytes,
} from "./paths.js";

// Materialising a result costs one JS object per row on top of DuckDB's Arrow batches, so
// an unbounded SELECT * is how you take the tab down. Cap it and say so.
const MAX_ROWS = 200_000;

// Quick peek during a table open: rows from the first data file, painted while the
// remaining registrations and the footer-heavy view bind still run. Fires for any file
// count — even a one-file table paints faster from a LIMIT than from the full bind,
// and a peek the real open outruns is repainted over harmlessly (FIFO on serial()).
const QUICK_PEEK_ROWS = 100;

export function createEngine(auth, {
  onStatus = () => {},
  // Called once per boot with a per-stage millisecond breakdown. It exists because the
  // read log measures the proxy — request in, response out — and the expensive part of
  // booting happens AFTER the last byte is delivered, inside the worker, where nothing
  // was watching. A boot that served 35MB of wasm in 1ms and still took half a minute
  // was indistinguishable from a fast one in the only instrument we had.
  onBoot = () => {},
} = {}) {
  let db = null, conn = null, worker = null;
  let _seq = 0;
  let canXlsx = false;              // set by init(); see the 'excel' preload there
  let canZip = false;               // set by init(); see the 'zipfs' preload there

  const loaded = new Map();         // cache key -> info
  const resources = new Map();      // cache key -> { ident, regs[], tables[] }, for release()
  const viewNames = new Map();      // view identifier -> the cache key that owns it
  // Reading a table is billed by the byte, so it happens in three deliberate tiers and
  // each one's answer is kept: statTable (metadata only) -> peekTable (ONE parquet) ->
  // loadTable (every file, a real view). These two caches are what stop a later tier
  // from paying again for what an earlier one already fetched. Neither holds DuckDB
  // state, so a worker restart keeps them — only a refresh clears them (see reset()).
  const resolvedC = new Map();      // cache key -> the resolved Iceberg metadata document
  const filesC = new Map();         // cache key -> { files[], posDeletes[], eqDeletes[] }
  const peekC = new Map();          // cache key -> the peek's rows, built once per snapshot

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
    const run = queue.then(() => guarded(fn), () => guarded(fn));
    queue = run.then(() => {}, () => {});
    return run;
  }
  const q = sql => serial(() => conn.query(sql));

  // cancelSent() only works while the worker is PROCESSING MESSAGES — the chunk-polled
  // execution phase. The bind phase of a statement over many registered HTTP files is one
  // long synchronous stretch (footer reads are sync XHR inside the worker), and a worker
  // blocked there processes nothing: not the cancel, not the successor load's first
  // registration, nothing. That is the whole failure mode this epoch machinery exists
  // for: the ONLY thing that can interrupt a worker stuck in sync XHR is terminate().
  //
  // A terminated worker's pending promises never settle, so every worker-bound call is
  // raced against the epoch's abort promise — otherwise whoever was awaiting the blocked
  // call would hang forever on a promise whose worker no longer exists.
  let workerEpoch = 0;          // bumped only by restart()
  let epochAbort, epochReject;  // rejects (e.workerRestart = true) when the worker dies
  let initPromise = null;       // the current epoch's init — the ready barrier
  let restarting = null;        // single-flight restart
  let engineAlive = false;      // set at the end of _init(); the watchdog no-ops until then
  function resetEpoch() {
    epochAbort = new Promise((_, rej) => { epochReject = rej; });
    epochAbort.catch(() => {}); // an epoch that ends with no racer must not log unhandled
  }
  resetEpoch();

  // Every worker-bound call goes through here. On a restart-abort, ownership decides the
  // outcome: a call belonging to a superseded load dies as a cancel, but a call belonging
  // to the CURRENT load — the one the user just clicked, parked behind the very statement
  // being killed — retries once against the fresh engine. That retry is provably safe:
  // worker messages are FIFO and the watchdog ping is posted synchronously inside
  // cancelLoad(), before the successor posts anything, so an unanswered ping means no
  // message after the cancel was ever processed — the parked call had zero side effects.
  // Every statement is also idempotent (CREATE OR REPLACE, IF NOT EXISTS,
  // register-overwrites), so running it again is running it for the first time.
  async function guarded(fn) {
    const myGen = loadGen, myEpoch = workerEpoch;
    if (initPromise) await initPromise;    // never run against a null or half-built conn
    // Chained before a restart AND no longer wanted: die before touching the new engine.
    // Chained before a restart but still current-gen (a successor's queued statement, a
    // teardown DROP): proceed — the new engine is exactly where it should run.
    if (myEpoch !== workerEpoch && myGen !== loadGen) throw cancelledError();
    try {
      return await Promise.race([fn(), epochAbort]);
    } catch (e) {
      if (!e || !e.workerRestart) throw e;             // fn's own failure, not the terminate
      if (myGen !== loadGen) throw cancelledError();   // the doomed load's own call
      await initPromise;                               // module-let: the NEW epoch's init
      return Promise.race([fn(), epochAbort]);         // once; a second restart rejects
    }
  }

  let loadGen = 0;
  // Fire-and-forget ON PURPOSE. Awaiting the acknowledgement here parked the NEXT load
  // behind the very statement being cancelled, before it could even write "Resolving…".
  // Message order does the correctness work: the cancel is queued ahead of anything
  // the successor sends, so it can only ever kill the predecessor's statement.
  //
  // The watchdog is the enforcement. A cancel the worker never processes (blocked in a
  // sync bind, see above) used to leave the app hung and the abandoned load burning
  // network until it finished on its own; now an unanswered ping terminates the worker.
  function cancelLoad() {
    loadGen++;
    try { if (conn) conn.cancelSent().catch(() => {}); } catch (_) { /* nothing was pending */ }
    armWatchdog();
  }

  // Did the worker actually hear the cancel? getVersion() is a pure message round trip —
  // it touches no connection state, so it cannot interleave with a draining stream. A
  // healthy worker answers in milliseconds even mid-query (execution is chunk-polled);
  // only a worker stuck in a synchronous stretch lets the timer win. The ping is posted
  // HERE, synchronously after the cancel, so it precedes anything the successor sends —
  // that FIFO ordering is what makes guarded()'s retry safe.
  const WATCHDOG_MS = 2000;
  let watchdogArmed = false;
  function armWatchdog() {
    if (watchdogArmed || restarting || !engineAlive || !db) return;
    watchdogArmed = true;
    const myEpoch = workerEpoch;
    // A ping that cannot be sent must not break the cancel it rides on.
    let ping;
    try { ping = db.getVersion(); } catch (_) { ping = new Promise(() => {}); }
    Promise.race([
      ping.then(() => "ok", () => "ok"),   // any settle = messages are flowing
      sleep(WATCHDOG_MS).then(() => "stuck"),
    ]).then(r => {
      watchdogArmed = false;
      if (r === "stuck" && myEpoch === workerEpoch && !restarting)
        restart(`cancel not honoured within ${WATCHDOG_MS}ms — worker blocked in a synchronous bind`);
    });
  }

  // The hard way out, for a worker no message can reach. Everything the worker held —
  // views, registered files, caches — dies with it, so the caches of what died are
  // cleared too; a table clicked again reloads from scratch, which is also the honest
  // answer. `queue` is deliberately NOT reset: a second chain running beside statements
  // already chained on the first is exactly the measured silent-truncation hazard the
  // hand-serialisation exists to prevent — the epoch rejection drains the one chain
  // instead. loadGen survives so ownership checks keep meaning what they meant.
  function restart(reason) {
    if (restarting) return restarting;
    restarting = (async () => {
      engineAlive = false;
      workerEpoch++;
      try { if (worker) worker.terminate(); } catch (_) {}
      worker = db = conn = null;      // synchronously: nothing can post to the old worker
      loaded.clear(); resources.clear(); viewNames.clear();
      const rej = epochReject;
      resetEpoch();                             // BEFORE rejecting: retriers race the new epoch
      initPromise = _init({ quiet: true });     // BEFORE rejecting: retriers await the NEW init
      const e = cancelledError();
      e.workerRestart = true;
      rej(e);                                   // releases every parked worker-bound promise
      console.info(`[engine] worker restarted: ${reason}`);
      await initPromise;
    })().finally(() => { restarting = null; });
    return restarting;
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
  // init() is also the ready barrier guarded() awaits, so the app's engineReady and the
  // engine's own gate are one promise — a statement can never run against a null conn.
  // restart() calls _init({quiet:true}) directly: the restart happens under a successor
  // load's own status line, and "Loading DuckDB-WASM…" stamped over "Resolving <table>…"
  // would report the mechanism instead of the work.
  function init(opts) {
    initPromise = _init(opts);
    return initPromise;
  }

  async function _init({ quiet = false } = {}) {
    // Stage clock: the page's half of the boot, reported beside the engine host's own.
    const stages = [];
    let markAt = (typeof performance !== "undefined" ? performance.now() : Date.now());
    const mark = name => {
      const now = (typeof performance !== "undefined" ? performance.now() : Date.now());
      stages.push({ stage: name, ms: Math.round(now - markAt) });
      markAt = now;
    };
    // The native engine already exists in the host — extensions and all — so there is no
    // bundle to select, no worker to start and no wasm to compile. It reports its own boot
    // stages through the same onBoot channel so the two engines are comparable in the
    // output channel rather than only in argument.
    if (!quiet) onStatus("Starting DuckDB…");
    const { connectNative } = await import("./duckdb-native.js");
    const nat = connectNative();
    db = nat.db;
    conn = nat.conn;
    // The host owns extension loading, so it owns the answer to what can be opened.
    // Guarded: a capability probe that fails must not stop the engine coming up — a
    // missing 'excel' costs .xlsx, not the session.
    try {
      const caps = await db.capabilities();
      canXlsx = !!(caps && caps.excel);
      canZip = !!(caps && caps.zipfs);
    } catch (e) { console.warn("[engine] capability probe failed:", e.message); }
    mark("native engine");
    const totalMs = stages.reduce((n, s) => n + s.ms, 0);
    console.log("[engine] DuckDB ready — native (extension host), " +
                stages.map(s => `${s.stage} ${s.ms}ms`).join(", "));
    try { onBoot({ stages, totalMs, quiet, native: true }); } catch (_) {}
    engineAlive = true;
    return { db, conn };
  }

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ---------------------------------------------------------------------------
  // OneLake, through the host
  // ---------------------------------------------------------------------------
  // The page holds no credential and makes no request to OneLake: the host lists (from
  // its cache-first store) and reads (signed there), and its answers arrive over the same
  // message channel as the engine's. Bytes cross as base64 — a webview message is JSON.
  function fromBase64(b64) {
    const bin = atob(b64 || "");
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function hostBytes(ws, path, range) {
    const r = await guarded(() => db.readBytes({ workspace: ws, path, range }));
    return fromBase64(r && r.base64);
  }

  // ---------------------------------------------------------------------------
  // Files/ browsing — the unmanaged half of a lakehouse.
  // ---------------------------------------------------------------------------
  // Nothing Iceberg here: Files/ is just a directory tree, so it is listed one level at a
  // time (lazily, on expand) and a recognised data file is opened as a view — its proxied
  // URL spliced straight into whichever reader the extension names. The reader table
  // itself lives in paths.js.
  const isQueryable = name => {
    const ext = fileExt(name);
    if (DB_EXTS.has(ext)) return true;      // ATTACHed read-only, not read through a reader
    if (ZIP_EXTS.has(ext)) return canZip;   // entries opened as views, not the archive itself
    if (!readerFor(ext)) return false;
    return ext === "xlsx" ? canXlsx : true;
  };

  // One level of Files/ (or a subdirectory of it). `dir` is relative to Files/. The same
  // cached listing the tree draws, so the pane and the tree never disagree.
  async function listFiles({ workspace, item }, dir = "") {
    const entries = await guarded(() => db.listFiles({ workspace, item, dir: strip(dir) }));
    return (entries || []).map(e => ({ ...e, queryable: !e.isDir && isQueryable(e.name) }));
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
    if (!r) { r = { ident: null, tables: [], attachments: [], schemas: [] }; resources.set(key, r); }
    return r;
  }

  // A load that is torn down must clean up after ITSELF and nothing else.
  //
  // resources are keyed by table and track(key) hands every load of that table the SAME
  // record, which was harmless while a load could only end by finishing or failing
  // outright. Cancellation broke it: open a table, open it again before the first
  // finishes, and the first load's release(key) pulled state out from under the second.
  // So: full teardown only while this load still owns the key; a superseded load walks
  // away and lets the successor's eventual full release reclaim everything.
  async function releaseOwned(key, gen) {
    const r = resources.get(key);
    if (!r || r.gen === gen) await release(key);
  }

  async function release(key) {
    const r = resources.get(key);
    if (r) {
      // Snapshots, taken before the first await. The record is shared per table key and
      // a successor load appends to these arrays while the drops below wait their turn
      // on the serial queue — iterating the live arrays here is how a superseded load
      // once dropped state its successor had just created.
      const gen = r.gen, ident = r.ident;
      const views = [...(r.views || [])], tables = [...r.tables];
      const schemas = [...(r.schemas || [])], attachments = [...(r.attachments || [])];
      if (ident) { try { await q(`DROP VIEW IF EXISTS ${ident}`); } catch (_) {} }
      // Zip archives create one view per readable entry; ident is just the first.
      for (const v of views) { try { await q(`DROP VIEW IF EXISTS ${v}`); } catch (_) {} }
      for (const t of tables) { try { await q(`DROP TABLE IF EXISTS ${t}`); } catch (_) {} }
      // Schemas holding copied-in database tables: CASCADE takes the tables with them.
      for (const s of schemas) { try { await q(`DROP SCHEMA IF EXISTS ${quoteIdent(s)} CASCADE`); } catch (_) {} }
      // Attached database files: DETACH releases the underlying URL handle.
      for (const a of attachments) { try { await q(`DETACH ${quoteIdent(a)}`); } catch (_) {} }
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
  //
  // `forget: false` is a plain switch: the metadata and peek caches hold no DuckDB state
  // and are keyed per lakehouse, so they are kept — going back to a lakehouse then costs
  // nothing, where clearing them meant another round of the catalog's seconds-per-call.
  // A refresh forgets them, because a refresh exists to ask OneLake again.
  async function reset({ forget = true } = {}) {
    // Switching lakehouse supersedes whatever is loading: the in-flight load stands
    // down at its next check() as a cancel instead of finding its files gone and
    // reporting "Failed to open file" against a table the user has already left.
    await cancelLoad();
    for (const key of [...resources.keys()]) await release(key);
    loaded.clear();
    resources.clear();
    viewNames.clear();
    filesC.clear();
    if (forget) { resolvedC.clear(); peekC.clear(); }
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
      throw new Error(`${file.name}: DuckDB's 'excel' extension is not available in this session, so .xlsx can't be read — OneLake Studio → Show Read Log says why.`);
    if (!reader)
      throw new Error(`${file.name}: unsupported file type — parquet, csv/tsv/txt, json/jsonl/ndjson, ` +
                      `avro, xlsx, zip, database files (.duckdb/.db/.sqlite) and plain text ` +
                      `(sql, yml, md, log, …) are readable; text formats also read as .gz/.zst.`);

    const res = track(key);
    res.gen = gen;
    // The abfss:// name goes straight into the SQL — DuckDB reads it itself, with the
    // host's credential. Nothing to register, nothing to drop.
    const url = abfssUrl(lh.workspace, file.path);

    const ident = quoteIdent(uniqueView(key, file.path.replace(/^.*?\/Files\//, "")));
    try {
      // stream(): a non-parquet reader pulls the file WHOLE inside this one statement,
      // and Stop must be able to kill it.
      await stream(`CREATE OR REPLACE VIEW ${ident} AS SELECT * FROM ${reader(sqlStr(url))}`);
      res.ident = ident;
      const columns = await describe(ident);
      const info = { label, ident, columns, fileCount: 1, posDeletes: 0, eqDeletes: 0,
                     file: true, bytes: file.bytes, ext, warnings: [] };
      loaded.set(key, info);
      status(describeLoad(info));
      return info;
    } catch (e) {
      await releaseOwned(key, gen);
      if (e.cancelled) throw e;
      throw new Error(`Could not read ${file.name}: ${e.message}`);
    }
  }

  // Zip archives: the abfss:// name goes into zip_contents() and zip:// directly — the
  // zipfs extension range-reads the central directory from the archive's tail and
  // inflates only the entries actually queried, so a large archive costs what you read
  // from it (checked against DuckDB 2.0 over abfss://). Each entry
  // with a known reader becomes its own view; the archive itself has no rows to show.
  const ZIP_MAX_VIEWS = 50;
  async function loadZipFile(lh, file, key, gen, check) {
    if (!canZip)
      throw new Error(`${file.name}: this DuckDB build couldn't load the 'zipfs' extension, so zip archives can't be read.`);
    const status = statusFor(gen);
    const res = track(key);
    res.gen = gen;
    res.views = [];
    const url = abfssUrl(lh.workspace, file.path);
    try {
      const entries = (await q(
        `SELECT file_name AS n FROM zip_contents(${sqlStr(url)})
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
          await stream(`CREATE OR REPLACE VIEW ${ident} AS SELECT * FROM ${reader(sqlStr(`zip://${url}/${e.n}`))}`);
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
      await releaseOwned(key, gen);
      if (e.cancelled) throw e;
      throw new Error(`Could not read ${file.name}: ${e.message}`);
    }
  }

  // A database file's ENGINE is decided by sniffing the first 16 bytes, never by
  // extension (people store DuckDB databases as .db, and .db is also SQLite's usual
  // name). Either way it is ATTACHed read-only and its tables are queryable as
  // alias.schema.table:
  //   - DuckDB file  -> attached by its abfss:// name, block-read on demand like parquet.
  //   - SQLite file  -> DuckDB's sqlite extension reads only local files, so the host
  //     copies it into the engine's temp directory first (capped: SQLite files are the
  //     xlsx of databases — page-based, usually small, meant to be local).
  async function loadDatabaseFile(lh, file, key, gen, check) {
    const status = statusFor(gen);
    const res = track(key);
    res.gen = gen;
    const ext = fileExt(file.name);
    const url = abfssUrl(lh.workspace, file.path);

    const head = await hostBytes(lh.workspace, file.path, "bytes=0-15");
    check();
    const sqlite = isSqliteHeader(head);

    // The alias is how the user names the database in SQL, so derive it from the file
    // name; uniqueView guards it against colliding with an existing view or alias.
    const alias = uniqueView(key, basename(file.name).replace(/\.[^.]+$/, ""));
    if (sqlite && file.bytes > SQLITE_MAX_BYTES)
      throw new Error(`${file.name} is ${fmtBytes(file.bytes)} — over the ${fmtBytes(SQLITE_MAX_BYTES)} ` +
                      `cap for copying a SQLite file to this machine.`);

    try {
      // READ_ONLY is not optional: the file lives in OneLake and the app never writes.
      if (sqlite) {
        statusFor(gen)(`Copying ${file.name} (${fmtBytes(file.bytes)}) — SQLite is read from a local copy…`);
        const local = await guarded(() => db.localCopy({ workspace: lh.workspace, path: file.path }));
        check();
        await q(`ATTACH ${sqlStr(local)} AS ${quoteIdent(alias)} (TYPE sqlite, READ_ONLY)`);
      } else {
        await q(`ATTACH ${sqlStr(url)} AS ${quoteIdent(alias)} (READ_ONLY)`);
      }
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
                     db: true, dbAlias: alias, dbTables: tables, dbEngine: sqlite ? "SQLite" : "DuckDB",
                     warnings: [] };
      if (!first)
        info.warnings.push(`${alias} attached but contains no tables or views`);
      loaded.set(key, info);
      status(describeLoad(info));
      return info;
    } catch (e) {
      await releaseOwned(key, gen);
      if (e.cancelled) throw e;
      throw new Error(`Could not attach ${file.name}: ${e.message}`);
    }
  }

  const SQLITE_MAX_BYTES = 200e6;

  // NOTE ON WHAT IS NOT HERE ANY MORE.
  //
  // This file used to carry the whole Iceberg read path: the manifest-list walk, the
  // per-manifest content 0/1/2 split, the position-delete anti-join, and the Warehouse
  // name mapping that turned a grid of GUID column headers into readable names. All of
  // it existed for one reason, stated in the comment that used to sit below: DuckDB's
  // own iceberg extension needs the azure filesystem to resolve the absolute abfss://
  // URIs Fabric writes, and azure had no WASM build.
  //
  // The engine is native now, so it does. openTable() hands the work to DuckDB, which
  // does snapshot resolution, manifest filtering, deletes and column mapping itself —
  // verified against a real Lakehouse, a column-mapped Warehouse and a merge-on-read
  // table. See extension/src/engine-host.js for the ATTACH, and note that
  // ACCESS_DELEGATION_MODE is the one part of it that cannot be left to a default.

  // ---------------------------------------------------------------------------
  // Load a table -> read-only VIEW.
  // ---------------------------------------------------------------------------
  // db.openTable() ATTACHes the item as an Iceberg REST catalog in the host and DuckDB
  // does the rest — snapshot resolution, manifests, position AND equality deletes, the
  // Warehouse column mapping. Nothing is downloaded whole: a query range-reads only the
  // row groups and columns it touches, through the signed proxy.
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
        // DuckDB reports a cancelled query as an error. It is not one. The host marks the
        // calls its cancel reached; matching "cancel" in the text instead turned a binder
        // error about a column called `cancellations` into a silent "stopped".
        if (e.cancelled) throw cancelledError();
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

  // Opening a table is now two steps: ATTACH the item as an Iceberg REST catalog in the
  // extension host, then point a view at the table inside it. Everything that used to sit
  // between those steps lives in DuckDB now — registering each data file under a
  // generated name, unioning them, `union_by_name` when the schema had evolved,
  // anti-joining position deletes on file_row_number, projecting a Warehouse's physical
  // GUID columns back to their logical names, and bisecting the file list with LIMIT 0
  // binds to name the culprit when one of them failed to open.
  //
  // The view exists so the editor can say `dbo.sales` rather than `ol_3."dbo"."sales"`,
  // and so release() still has a single name to drop.
  async function createView(ident, source) {
    await stream(`CREATE OR REPLACE VIEW ${ident} AS SELECT * FROM ${source}`);
  }

  // ---------------------------------------------------------------------------
  // Tier 1: the table's Iceberg metadata, and nothing else.
  // ---------------------------------------------------------------------------
  // One request through the catalog. No manifests, no parquet, no DuckDB. Everything the
  // Stats tab shows comes from here, which is why opening a table now costs kilobytes
  // instead of a scan: the rest is read only when the user asks to see rows.
  async function resolveTable(lh, t, label, status, check) {
    const key = tableKey(lh, t);
    if (resolvedC.has(key)) return resolvedC.get(key);
    let resolved;
    try {
      // The extension host holds the catalog's answers on disk and serves them first, so
      // a table opened before — in this session or any earlier one — resolves without a
      // request to OneLake. Its "waiting for conversion" progress arrives as a 'status'
      // message of its own.
      const r = await guarded(() => db.resolveTable({
        workspace: lh.workspace, item: lh.item, schema: t.schema || "", table: t.table,
      }));
      check();
      resolved = {
        empty: !!r.empty, schemaFields: r.schemaFields || [], totalRecords: r.totalRecords,
        stats: r.stats, metadataLocation: r.metadataLocation || null,
      };
    } catch (e) {
      // A load the user stopped is not a failure, and app.js tells the two apart by
      // e.cancelled alone — re-dressing a Stop as a metadata error would paint it red.
      if (e.cancelled) throw e;
      // The catalog is the only source now, so its own words ARE the diagnosis; the old
      // wrapper replaced them with a guess. Only "not there yet" earns the conversion
      // story appended, because that is the one cause a user can act on — and the catalog
      // cannot say it itself: its 404 body is a flat "The given table does not exist",
      // identical for a table mid-conversion and one that never existed.
      const notYet = e.status === 400 || e.status === 404;
      throw new Error(`Could not read ${label} from OneLake's Iceberg catalog: ${e.message}` +
        (notYet
          ? ". OneLake writes Iceberg metadata on demand and conversion can take up to two " +
            "minutes; if it never appears, Delta-to-Iceberg conversion is probably not " +
            "enabled for this tenant or workspace."
          : ""));
    }
    resolvedC.set(key, resolved);
    return resolved;
  }

  // What a table selection costs now. `columns` comes from the Iceberg schema rather than
  // a DESCRIBE, so the schema is on screen without a single footer read; `ident` is null
  // because no view exists yet, and that is what tells the caller this is tier 1.
  async function statTable(lh, t) {
    // A click means "show me THIS": stand down whatever was loading, exactly as an open
    // does — otherwise a previous table's open keeps spending on files nobody wants.
    await cancelLoad();
    const key = tableKey(lh, t);
    if (loaded.has(key)) return loaded.get(key);   // a fully opened table knows strictly more
    const label = labelFor(t);
    // Captured, not read live: the resolve can now sit in a retry loop, and a superseded
    // selection must not stamp "Waiting for Fabric… <old table>" over the new one.
    const gen = loadGen;
    const check = () => { if (gen !== loadGen) throw cancelledError(); };
    const status = statusFor(gen);
    status(`Reading ${label} metadata…`);
    const resolved = await resolveTable(lh, t, label, status, check);
    check();
    const stats = resolved.stats || {};
    const info = {
      label, ident: null, stage: "stats",
      columns: resolved.schemaFields || [],
      // From the snapshot summary. It is the file count DuckDB will read at tier 2/3, but
      // nothing here has read one.
      fileCount: stats.totalDataFiles,
      posDeletes: 0, eqDeletes: 0,
      totalRecords: resolved.totalRecords, stats, warnings: [],
    };
    status(describeLoad(info));
    return info;
  }

  // ---------------------------------------------------------------------------
  // Tier 2: the first hundred rows, and no view.
  // ---------------------------------------------------------------------------
  // One ATTACH (per ITEM, so a second table in the same lakehouse is free) and a
  // LIMIT 100 that DuckDB pushes down into the Iceberg scan. It used to be a manifest
  // walk plus a raw read of the first data file, which had to be SUPPRESSED on a
  // merge-on-read table: reading one file raw bypasses the delete anti-join, so deleted
  // rows showed as live and the only honest answer was to refuse. DuckDB applies the
  // deletes, so there is nothing left to suppress and every table can be peeked.
  //
  // Built once, then simply there. Plain JS rows, no DuckDB state, so a restart keeps
  // them — coming back to a table after a cancel renders instantly. reset() clears it.
  //
  // The memo holds the PROMISE, not the value, so it is also single-flight: the prefetch
  // that starts when a table is selected and the Data tab that asks a moment later share
  // one read — without this, the second call's cancelLoad() would kill the first
  // mid-read and start over. A peek that fails or is cancelled un-memoises itself.
  //
  // `quiet` is for the prefetch: its progress writing over the stats view's status read
  // as the app being stuck.
  function peekTable(lh, t, { quiet = false } = {}) {
    const key = tableKey(lh, t);
    if (peekC.has(key)) return peekC.get(key);
    const p = doPeek(lh, t, key, quiet);
    peekC.set(key, p);
    p.catch(() => { if (peekC.get(key) === p) peekC.delete(key); });
    return p;
  }

  async function doPeek(lh, t, key, quiet) {
    await cancelLoad();
    const gen = loadGen;
    const check = () => { if (gen !== loadGen) throw cancelledError(); };
    const status = quiet ? () => {} : statusFor(gen);
    const label = labelFor(t);

    const resolved = await resolveTable(lh, t, label, status, check);
    check();
    // An empty table has a schema and no rows. Reading it is not an error and not worth
    // an ATTACH — the metadata already said everything there is to say.
    // Same shape materialize() returns, because renderResults() reads `types` alongside
    // `fields` — here they come from the Iceberg schema rather than from a scan, which is
    // the only source there is when no data file exists to scan.
    if (resolved.empty) {
      const cols = resolved.schemaFields || [];
      return { fields: cols.map(f => f.name), types: cols.map(f => f.type), rows: [],
               numRows: 0, truncated: false, limit: MAX_ROWS, fileCount: 0 };
    }

    status(`Reading the first ${QUICK_PEEK_ROWS} rows of ${label}…`);
    // Kept by the host per snapshot: a snapshot never changes, so rows read from it once
    // are the rows, and a table opened before shows them without touching OneLake.
    const res = await guarded(() => db.peekTable({
      workspace: lh.workspace, item: lh.item, schema: t.schema || "", table: t.table,
    }));
    check();
    const fields = (res.fields || []).map(f => f.name);
    const types = (res.fields || []).map(f => arrowTypeName({ duckdbName: f.type }));
    const rows = (res.rows || []).slice(0, MAX_ROWS).map(r => normalizeRow(r, fields));
    return { fields, types, rows, numRows: res.numRows || rows.length, truncated: false,
             limit: MAX_ROWS, fileCount: (resolved.stats || {}).totalDataFiles };
  }

  // The table, as DuckDB can name it: `ol_<n>."schema"."table"` inside an ATTACHed
  // Iceberg catalog. Cached per item in the host, so this is one message and no I/O once
  // the item has been opened.
  async function attachedIdent(lh, t, resolved) {
    const { ident } = await guarded(() => db.openTable({
      workspace: lh.workspace, item: lh.item, schema: t.schema, table: t.table,
      metadataLocation: (resolved && resolved.metadataLocation) || null,
    }));
    return ident;
  }

  // ---------------------------------------------------------------------------
  // Tier 3: every data file registered, a real queryable view.
  // ---------------------------------------------------------------------------
  // `viewSchema` puts the view in a schema other than the table's own: a semantic model's
  // tables come from whichever items it names, and their views must not take the name of
  // the selected lakehouse's own dbo.sales (semantic.js).
  async function loadTable(lh, t, { onPeek, viewSchema = null } = {}) {
    // Keyed per lakehouse: the engine outlives the user's choice of one, and two
    // lakehouses can both hold a dbo.sales.
    const key = tableKey(lh, t) + (viewSchema ? `@${viewSchema}` : "");
    // Supersede whatever came before — even on a cache hit, because the click means
    // "show me THIS" and the in-flight load must stand down rather than repaint the
    // screen later.
    await cancelLoad();
    if (loaded.has(key)) return loaded.get(key);
    const gen = loadGen;
    const check = () => { if (gen !== loadGen) throw cancelledError(); };
    const status = statusFor(gen);

    const label = labelFor(t);
    const warnings = [];

    status(`Resolving ${label}…`);
    // Free on the normal path: the Stats tier already resolved and cached this.
    const resolved = await resolveTable(lh, t, label, status, check);
    check();

    const schema = viewSchema || t.schema;
    const ident = schema
      ? `${quoteIdent(schema)}.${quoteIdent(t.table)}`
      : quoteIdent(t.table);

    const res = track(key);
    res.gen = gen;          // whoever set this last owns the teardown; see releaseOwned()
    res.ident = ident;
    // Claimed only once there is a record for release() to guard: a claim made before
    // track() is state a concurrent release(key) sweeps with nothing to check against.
    viewNames.set(ident, key);

    let columns;
    try {
      if (schema) await q(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schema)}`);
      check();

      if (resolved.empty) {
        // The catalog lists it, it has a schema, nothing has ever been written to it.
        // DuckDB opens it and returns no rows, so the view is real and simply empty —
        // which beats the error this used to raise about snapshot -1.
        status(`Opening ${label}…`);
        await createView(ident, await attachedIdent(lh, t, resolved));
      } else {
        status(`Opening ${label}…`);
        const source = await attachedIdent(lh, t, resolved);
        check();

        // Rows on screen while the rest of the open runs. Cheap now: the same LIMIT 100
        // the Data tab would ask for, pushed down into the Iceberg scan. It used to be
        // suppressed on merge-on-read tables because a raw first-file read showed
        // deleted rows as live; DuckDB applies the deletes, so it fires for every table.
        // Best-effort by design — a superseded or failed peek says nothing, and the real
        // open reports its own errors.
        if (onPeek) {
          materialize(`SELECT * FROM ${source} LIMIT ${QUICK_PEEK_ROWS}`)
            .then(out => { if (gen === loadGen) onPeek(out, (resolved.stats || {}).totalDataFiles); })
            .catch(() => {});
        }

        await createView(ident, source);
      }
      check();
      columns = await describe(ident);
    } catch (e) {
      // A stop is not a failure. Superseded while failing is also not this load's
      // problem — and some of the ways it can fail here ARE the supersession.
      if (e.cancelled) { await releaseOwned(key, gen); throw e; }
      if (gen !== loadGen) { await releaseOwned(key, gen); throw cancelledError(); }
      await releaseOwned(key, gen);
      // No bisector any more, and none is needed: the old one existed because a failure
      // inside a several-hundred-file read_parquet() named nothing, and the file list was
      // ours to halve. DuckDB owns the file list now and its errors name the file.
      throw new Error(`Could not open ${label}: ${e.message}`);
    }

    const stats = resolved.stats || {};
    const info = { label, ident, columns, fileCount: stats.totalDataFiles, stage: "loaded",
                   posDeletes: stats.totalDeleteFiles || 0, eqDeletes: 0,
                   totalRecords: resolved.totalRecords, stats, warnings };

    loaded.set(key, info);
    status(describeLoad(info));
    return info;
  }

  // One sentence about how the table was opened. Position deletes that applied cleanly are
  // not news — that is just correctness. Anything in `warnings` is a correctness caveat,
  // and rendering it as a warning rather than as success is the caller's job.
  function describeLoad({ label, fileCount, posDeletes, file, ext, bytes, totalRecords,
                          db, dbAlias, dbTables, dbEngine, zip, zipViews, stage }) {
    // Tier 1. Say plainly that nothing has been read yet, because the whole point of
    // this state is that it cost nothing — and that the next click is what spends.
    if (stage === "stats") {
      let s = `${label} — statistics only, no data read`;
      if (totalRecords != null) s += `: ${totalRecords.toLocaleString("en")} row(s)`;
      if (fileCount != null) s += ` in ${fileCount} file(s)`;
      return s + ". Open Data for rows from one file";
    }
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
    return materialize(prepareReadOnlySql(sql));
  }

  // A statement's whole result as plain JS, in the shape the results grid renders.
  // Shared by user SQL (above, after the read-only guard) and the engine's own quick
  // peek, which builds its SQL itself.
  async function materialize(clean) {
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
    return hostBytes(lh.workspace, file.path);
  }

  return { init, reset, parseLakehouse,
           statTable, peekTable, loadTable,
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
  // The native engine sends DuckDB's own type name, which is what everything below is
  // trying to reconstruct from Arrow metadata. When it is already the answer, use it —
  // no DECIMAL precision to re-derive, no signedness to infer, no TIMESTAMPTZ to guess
  // from a timezone field.
  if (typeof t.duckdbName === "string") return t.duckdbName;
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
