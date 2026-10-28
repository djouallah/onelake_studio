// =============================================================================
// data.js — what the panel does with tables and files, on DuckDB in the extension host
// =============================================================================
// Given a lakehouse the tree named, this module:
//   1. shows a table's statistics from its Iceberg metadata — no data read,
//   2. shows its first rows (kept by the host per snapshot),
//   3. opens it as a read-only VIEW to run SQL against, read with iceberg_scan,
//   4. opens a Files/ object — parquet, CSV, JSON, avro, xlsx, text, a zip's entries, a
//      DuckDB or SQLite database — as views the same way.
//
// Every statement and every OneLake read is a call to the host (host.js); DuckDB runs
// there, natively, and reads OneLake itself. This file decides WHAT to ask; the pure half
// — paths, SQL text, cache keys — lives in paths.js, where it is tested.
//
// DOM-free: progress is reported through the injected `onStatus` callback.
// =============================================================================

// The page reads nothing from OneLake itself. Listings and bytes come from the extension
// host (its cache-first store, its signed reads); DuckDB, also in the host, reads tables
// and Files/ objects by their abfss:// names with the host's own credential.
import {
  strip, basename, abfssUrl,
  fileExt, readerFor, PARQUET_EXTS, DB_EXTS, ZIP_EXTS, isSqliteHeader, isTextExt,
  sqlStr, quoteIdent, prepareReadOnlySql,
  tableKey, fileKey, sanitizeIdent, emptyTableSql,
  normalizeValue, fmtBytes,
} from "./paths.js";

// Materialising a result costs one JS object per row, so an unbounded SELECT * is how you
// take the tab down. Cap it and say so (the host caps at the same number).
const MAX_ROWS = 200_000;

// The first rows of a table, painted while the view is still being opened.
const QUICK_PEEK_ROWS = 100;

export function createEngine({
  onStatus = () => {},
  // Called once per boot with a per-stage millisecond breakdown, printed beside the
  // engine host's own in the read log.
  onBoot = () => {},
} = {}) {
  let host = null;                  // the channel to the extension host, set by init()
  let _seq = 0;
  let canXlsx = false;              // which optional formats the host's DuckDB loaded
  let canZip = false;

  const loaded = new Map();         // cache key -> info
  const resources = new Map();      // cache key -> { ident, views[], tables[], ... }, for release()
  const viewNames = new Map();      // view identifier -> the cache key that owns it
  // A table is read in tiers and each one's answer is kept: statTable (metadata only) ->
  // peekTable (first rows) -> loadTable (a real view). These hold no DuckDB state, so
  // only a refresh clears them (see reset()).
  const resolvedC = new Map();      // cache key -> the table's metadata summary
  const peekC = new Map();          // cache key -> the first rows, once per snapshot

  // A click supersedes whatever was loading. cancelLoad() bumps the generation — a load
  // checks it between steps and stands down — and interrupts the host's running
  // statements, so a previous table's scan stops spending.
  let loadGen = 0;
  function cancelLoad() {
    loadGen++;
    if (host) host.call("cancel").catch(() => {});
  }
  // Distinguishable so the UI can say "stopped" rather than reporting a failure.
  function cancelledError() {
    const e = new Error("load stopped");
    e.cancelled = true;
    return e;
  }
  // A superseded load says nothing: its progress must not land on top of the successor's.
  const statusFor = gen => m => { if (gen === loadGen) onStatus(m); };

  // ---------------------------------------------------------------------------
  // The host
  // ---------------------------------------------------------------------------
  // init() is also the ready barrier: every call waits for it, so the app's engineReady
  // and the engine's own gate are one promise.
  let initPromise = null;
  function init() {
    initPromise = _init();
    return initPromise;
  }

  async function _init() {
    const t0 = Date.now();
    onStatus("Starting DuckDB…");
    const { connectHost } = await import("./host.js");
    host = connectHost();
    // The host owns extension loading, so it owns the answer to what can be opened. A
    // probe that fails must not stop the engine coming up — a missing 'excel' costs .xlsx.
    try {
      const { capabilities: caps } = await host.call("info");
      canXlsx = !!(caps && caps.excel);
      canZip = !!(caps && caps.zipfs);
    } catch (e) { console.warn("[engine] capability probe failed:", e.message); }
    const ms = Date.now() - t0;
    console.log(`[engine] DuckDB ready — native (extension host), ${ms}ms`);
    try { onBoot({ stages: [{ stage: "native engine", ms }], totalMs: ms, native: true }); } catch (_) {}
  }

  // One call to the host. A Stop comes back as e.cancelled and is re-raised as one.
  async function callHost(method, args = [], onBatch) {
    if (initPromise) await initPromise;
    try { return await host.call(method, args, onBatch); }
    catch (e) { if (e && e.cancelled) throw cancelledError(); throw e; }
  }

  // The whole result of a statement: { fields: [{ name, type }], rows, numRows }.
  const q = sql => callHost("query", [sql]);

  // A statement whose rows arrive in batches — anything that can be slow, because Stop
  // must be able to interrupt it mid-scan.
  const stream = (sql, onBatch = () => {}) => callHost("stream", [sql], onBatch);

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
    const r = await callHost("onelake.readBytes", [{ workspace: ws, path, range }]);
    return fromBase64(r && r.base64);
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
         WHERE NOT is_directory ORDER BY file_name`)).rows;
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
        const local = await callHost("onelake.localCopy", [{ workspace: lh.workspace, path: file.path }]);
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
         ORDER BY 1, 2`)).rows;
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

  // ---------------------------------------------------------------------------
  // Load a table -> read-only VIEW.
  // ---------------------------------------------------------------------------
  // The host names the table (iceberg_scan over its metadata file, from the host's own
  // cache) and DuckDB does the rest — snapshot resolution, manifests, position AND
  // equality deletes, the Warehouse column mapping. Nothing is downloaded whole: a query
  // range-reads only the row groups and columns it touches.
  //
  // Idempotent: a table already loaded is returned from cache.
  // ---------------------------------------------------------------------------
  const labelFor = t => t.schema ? `${t.schema}.${t.table}` : t.table;

  async function describe(ident) {
    const r = await q(`DESCRIBE ${ident}`);
    return r.rows.map(j => ({ name: j.column_name, type: j.column_type }));
  }

  // The view exists so the editor can say `dbo.sales` rather than an iceberg_scan(…), and
  // so release() has a single name to drop.
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
      const r = await callHost("onelake.table", [{
        workspace: lh.workspace, item: lh.item, schema: t.schema || "", table: t.table,
      }]);
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
  // A LIMIT 100 that DuckDB pushes down into the Iceberg scan, deletes applied, run by the
  // host and kept there per snapshot — a table opened before shows its rows without a
  // request to OneLake. Kept here too, so coming back to a table renders instantly.
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
    const res = await callHost("onelake.peek", [{
      workspace: lh.workspace, item: lh.item, schema: t.schema || "", table: t.table,
    }]);
    check();
    const fields = (res.fields || []).map(f => f.name);
    const types = (res.fields || []).map(f => f.type);
    const rows = (res.rows || []).slice(0, MAX_ROWS).map(r => normalizeRow(r, fields));
    return { fields, types, rows, numRows: res.numRows || rows.length, truncated: false,
             limit: MAX_ROWS, fileCount: (resolved.stats || {}).totalDataFiles };
  }

  // The table, as DuckDB can select from it — iceberg_scan over the metadata file the
  // host's store holds. The page names the table; the location never comes from here.
  async function attachedIdent(lh, t) {
    const { ident } = await callHost("onelake.openTable", [{
      workspace: lh.workspace, item: lh.item, schema: t.schema || "", table: t.table,
    }]);
    return ident;
  }

  // ---------------------------------------------------------------------------
  // Tier 3: a real queryable view.
  // ---------------------------------------------------------------------------
  // `viewSchema` puts the view in a schema other than the table's own: a semantic model's
  // tables come from whichever items it names, and their views must not take the name of
  // the selected lakehouse's own dbo.sales (semantic.js).
  // A model's tables are opened by its QUERIES, several of which can be running at once (an
  // Explore pivot and a filter's value list). Those loads supersede nothing — a cancelLoad()
  // here interrupted every query on the host, so opening a filter during a long pivot
  // stopped the pivot — and two queries needing the same table share one open.
  const modelLoads = new Map();     // cache key -> Promise<info>
  function loadTable(lh, t, opts = {}) {
    if (!opts.viewSchema) return openTableView(lh, t, opts);
    const key = tableKey(lh, t) + `@${opts.viewSchema}`;
    if (loaded.has(key)) return Promise.resolve(loaded.get(key));
    if (!modelLoads.has(key)) {
      modelLoads.set(key, openTableView(lh, t, opts).finally(() => modelLoads.delete(key)));
    }
    return modelLoads.get(key);
  }

  async function openTableView(lh, t, { onPeek, viewSchema = null } = {}) {
    // Keyed per lakehouse: the engine outlives the user's choice of one, and two
    // lakehouses can both hold a dbo.sales.
    const key = tableKey(lh, t) + (viewSchema ? `@${viewSchema}` : "");
    // A selection supersedes whatever came before — even on a cache hit, because the click
    // means "show me THIS" and the in-flight load must stand down rather than repaint the
    // screen later. A model's query does not (loadTable, above).
    if (!viewSchema) await cancelLoad();
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
        // The catalog lists it, it has a schema, nothing has ever been written to it:
        // the view is real, typed from the metadata, and simply empty.
        await q(`CREATE OR REPLACE VIEW ${ident} AS ${emptyTableSql(resolved.schemaFields)}`);
      } else {
        status(`Opening ${label}…`);
        const source = await attachedIdent(lh, t);
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
    await stream(clean, batch => {
      if (!fields) {
        fields = batch.fields.map(f => f.name);
        types = batch.fields.map(f => f.type);
      }
      numRows += batch.numRows;
      for (const r of batch.rows) {
        if (rows.length >= MAX_ROWS) { truncated = true; break; }
        rows.push(normalizeRow(r, fields));
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

  // Saving goes through VS Code's save dialog, in the host. Each answers the path written,
  // or null when the dialog was dismissed.
  const saveText = (name, text) => callHost("host.saveFile", [{ name: basename(name), text }]);
  const saveOneLakeFile = (lh, file) =>
    callHost("host.saveFile", [{ name: file.name, workspace: lh.workspace, path: file.path }]);

  // Semantic views, kept by the host (src/semviews.js): every one with its .bim text, and
  // CREATE / DROP carried out there. `lh` resolves a Files/… path.
  const semanticViews = () => callHost("semantic.views", [{}]);
  const semanticCreate = (name, path, lh) =>
    callHost("semantic.create", [{ name, path, workspace: lh && lh.workspace, item: lh && lh.item }]);
  const semanticDrop = name => callHost("semantic.drop", [{ name }]);
  // Export to Fabric: the model's text and the Explore shelves to the host, which writes the
  // app's folder and publishes it (src/exportapp.js); answers what to tell the user.
  const exportExplore = x => callHost("fabric.exportExplore", [x]);

  return { init, reset, statTable, peekTable, loadTable,
           loadFile, readFileBytes, saveText, saveOneLakeFile, runSql, describeLoad, fmtBytes, cancelLoad,
           semanticViews, semanticCreate, semanticDrop, exportExplore };
}
