'use strict';
// =============================================================================
// engine-host.js — real DuckDB, and a window's way to it
// =============================================================================
// DuckDB runs natively in the server's process (engine-server.js, `serve` below), on every core, and
// a window's engine is this same code joined to it (`remote`). It reads OneLake itself through its `azure` extension, a Delta table with `delta` and an Iceberg table
// with `iceberg`: snapshot resolution, file filtering, deletes, schema evolution and column mapping are
// all DuckDB's.
//
// WHAT THE PAGE MAY CALL (call(), from host.js), and nothing else:
//
//   query(sql)    the whole result: { fields: [{ name, type }], rows, numRows }
//   stream(sql)   the same, as batches of ~10k rows, then { numRows }
//   cancel()      interrupt the page's running statements
//   info()        { capabilities } — which optional formats loaded
//   fileView(name, source)      a Files/ object as a view of this tab's, over a read
//   attachFile({ path, alias, sqlite })  a database file, READ_ONLY
//   releaseFiles({ views, attached })    what this tab made and is done with
//
// query() and stream() take one read and nothing else (sql.js). The other three are how a tab sets
// up what it reads, so a statement can't reach another tab's views.
//
// The rest is the HOST's: copyToTemp(), a file the host fetched written where the lockdown
// lets DuckDB open it, and exportTo(), a query's whole result written there. Neither takes a
// path or a location from the page. query() and stream() make the view of every table a statement
// names by its SQL name (ws.lakehouse.schema.table) before running it.
// =============================================================================

const { DuckDBInstance } = require('@duckdb/node-api');

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { join } = require('node:path');
const os = require('node:os');
const { randomBytes, createHash } = require('node:crypto');
const { sqlStr, quoteIdent, ONELAKE_SCOPES, scopeOfUrl, oneLakeScopes, assertReads, checkedRead, readsOnly, writeOf, withTableProperties, checkPlan, checkPhysical,
        isUnserialized, ICE_PREFIX, DELTA_PREFIX, isWriteCatalog,
        tableRefs, oldTableName, fileRefs, filesReadBy, namedError, catalogStatement, readsCatalog, withoutComments, COLUMNS_NOT_READ,
        useOf, namespaceName, bareNames, withNamespace, writeWithNamespace, DUCK_NAMES, duckNamesOf } = require('../sql');
const { sqlName, sqlPart, itemPart, displayName, abfssUrl, MODEL_KIND, modelSqlName, ENGINE_DB } = require('../names');
const { revalidate, sameAnswer } = require('../onelake/store');
const { mapPool } = require('../onelake/http');
const { readDelta, readIceberg, syncTable, attachLake, syncedOf, syncedBrief, syncedAll } = require('../lake/onelaketable');
const { createTableService, httpsDownload, openedSince, heldOn } = require('../lake/tableservice');
const { tableReadCopies, TABLE_READ_FOLDER } = require('../lake/tableread');


// Rows are read in chunks so no single postMessage carries a whole 200k-row grid, and so a tab
// can say how far a large result has got before it has all arrived.
const BATCH_ROWS = 10_000;

// BigInt does not survive the trip to the webview: VS Code serialises panel messages as
// JSON and BigInt throws there. paths.js normalizeValue() already defines the contract
// for the app — exact when it fits in a double, a decimal string when it does not — so
// apply it here, at the boundary, rather than shipping a value that cannot be sent.
function jsonSafe(v) {
  // JSON has no word for these, and would say null.
  if (typeof v === 'number') return Number.isFinite(v) ? v : String(v);
  if (typeof v === 'bigint')
    return (v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER))
      ? Number(v) : v.toString();
  if (v == null) return v;
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Uint8Array) return Array.from(v);
  if (Array.isArray(v)) return v.map(jsonSafe);
  if (typeof v === 'object') {
    if (typeof v.toString === 'function' && v.constructor && v.constructor.name !== 'Object') {
      // DuckDBDecimalValue, DuckDBIntervalValue and friends: their own toString is the
      // faithful rendering, and the alternative is a structurally-cloned husk.
      return v.toString();
    }
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = jsonSafe(val);
    return out;
  }
  return v;
}

// The most rows of one result the host turns into JS and posts to the page, unless the
// `maxRows` option says otherwise. The page is told the same number (panel.js) and stops
// keeping rows there; past it the host only COUNTS, so "stopped at N of M" still has a
// truthful M without M rows crossing postMessage into a shared process.
const DEFAULT_MAX_ROWS = 200_000;

// A bearer token has no business in an error message the page displays, a log line, or a
// bug report pasted from either. DuckDB echoes the statement it failed on, and two of ours
// carry a token by value.
const JWT = /eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g;
function scrub(e, token) {
  if (!e || typeof e.message !== 'string') return e;
  let m = e.message.replace(JWT, '<token>');
  if (token) m = m.split(token).join('<token>');
  if (m !== e.message) {
    try { e.message = m; } catch (_) { const c = new Error(m); c.cancelled = e.cancelled; return c; }
  }
  return e;
}

// DuckDB says what went wrong only in words, so these are matched by text. A test holds each one it
// can provoke to DuckDB's real message, so a new DuckDB that words it differently fails there.
//
// A token that expired mid-session shows up as a storage failure, never as anything structured.
// Retried ONCE and only after the token actually changed — a 403 is a permission answer and a fresh
// token will not change its mind, which is the same bargain catalog.js makes.
const AUTH_FAILURE = /AuthenticationFailed|\b401\b|Unauthorized|token.*expired|ExpiredAuthenticationToken/i;
// A read that fails is how DuckDB says a kept metadata location no longer holds, at the view or at
// the statement. A statement's own mistake is a Binder or Catalog Error, which asks OneLake nothing.
const READ_FAILURE = /^\s*IO Error\b/;
// Offline, a lake table's file that hasn't come here yet: a read of its OneLake path that failed.
const NOT_CACHED = /abfss?:\/\//;
// OneLake refusing this user a table's files, as a table with OneLake security does to someone its rules
// restrict: the azure extension's words for a 403, and delta's. Not a bare 403: an error can quote the statement.
const FORBIDDEN = /\b(?:HTTP|status|code)[ :]*403\b|\b403 Forbidden\b|AuthorizationPermissionMismatch|AuthorizationFailure|\bForbidden\b|not authorized to perform/i;

// This string came from the catalog (via the host's store) and is spliced into SQL, so
// only the one shape the catalog actually returns is accepted: a OneLake abfss URI ending
// in a metadata.json. Spaces are allowed — a workspace named "ANZ Retail Demo" gets name-based
// paths with them, and DuckDB reads those fine; sqlStr quotes the string either way. Line
// breaks and NULs are not.
// abfs:// too: OneLake's Iceberg catalog names the tables it makes so (SQL's writes).
const ONELAKE_METADATA = /^abfss?:\/\/[^@/\r\n\0]+@onelake\.dfs\.fabric\.microsoft\.com\/[^\r\n\0]+\.metadata\.json$/i;
const isOneLakeMetadata = s => typeof s === 'string' && ONELAKE_METADATA.test(s);
// A Delta table's folder, whose log is read into the lake as it is named: only this shape may pass.
const ONELAKE_TABLE = /^abfss:\/\/[^@/\r\n\0]+@onelake\.dfs\.fabric\.microsoft\.com\/[^\r\n\0]*[^/\r\n\0]$/i;
const isOneLakeTable = s => typeof s === 'string' && ONELAKE_TABLE.test(s);
// A local folder as the lockdown knows it. DuckDB keeps allowed_directories with a capital drive letter and
// compares as written, and VS Code hands paths over with a small one, so a read through a mount was refused.
const duckdbPath = p => String(p).replace(/\\/g, '/').replace(/^[a-z]:/, d => d.toUpperCase());


// The certificate authorities DuckDB's HTTP client may trust, as one PEM file. Needed by the
// lockdown below: with file access restricted, httpfs refuses to go looking for the
// system's CA bundle (it says so, and names Linux paths a Windows or macOS machine does not
// have). Node's own list plus — where this Node can read it — the operating system's store,
// so a corporate TLS-inspecting proxy whose root is installed on the machine still works,
// plus NODE_EXTRA_CA_CERTS for the setups that use that instead.
async function writeCaBundle(dir) {
  const tls = require('node:tls');
  const certs = new Set(tls.rootCertificates);
  try { if (tls.getCACertificates) for (const c of tls.getCACertificates('system')) certs.add(c); } catch (_) {}
  try {
    if (process.env.NODE_EXTRA_CA_CERTS) certs.add(await fsp.readFile(process.env.NODE_EXTRA_CA_CERTS, 'utf8'));
  } catch (_) {}
  const file = join(dir, 'ca-bundle.pem');
  await fsp.writeFile(file, [...certs].join('\n'));
  return file.replace(/\\/g, '/');
}

// What VS Code's own HTTP proxy setting says, in the form DuckDB's http_proxy wants
// (host:port, credentials apart). DuckDB ignores the editor's proxy otherwise, so behind a
// corporate proxy every read failed while VS Code itself worked.
function proxySettings(proxyUrl) {
  if (!proxyUrl) return null;
  try {
    const u = new URL(proxyUrl);
    return {
      host: `${u.hostname}${u.port ? `:${u.port}` : ''}`,
      user: decodeURIComponent(u.username || ''),
      password: decodeURIComponent(u.password || ''),
    };
  } catch (_) { return null; }
}

const FILE_CACHE_TRIM_MS = 60 * 60 * 1000;
const TABLES_AT_ONCE = 4;
// The community extensions the vsix ships, loaded by path.
const COMMUNITY = ['h3', 'zipfs', 'nanoarrow'];
// In front of a statement that keeps a table in use: what Logs shows, and how the server tells it from
// anyone's own. No % or _, as it goes in a LIKE.
const KEEP_MARK = '/* OneLake Studio keeps this table on this machine */ ';
const LIST_BATCH = 200;

// Whether a statement's tables read the same as they did: when they were read from OneLake isn't that.
const sameSources = (a, b) => sameAnswer(a.map(({ at, ...t }) => t), b.map(({ at, ...t }) => t));

// What the table read API answered (tableread.js) held under its budget: oldest first, down to 80%. A table
// read that way is one unit, its copy's folder. The files of OneLake tables are the table service's
// (tableservice.js), which holds them to the same budget. Nothing waits for this.
async function trimFileCache(dir, maxBytes, onWarn) {
  try {
    if (!(maxBytes > 0)) return;
    const copies = await tableReadCopies(join(dir, TABLE_READ_FOLDER));
    let total = copies.reduce((n, f) => n + f.bytes, 0);
    if (total <= maxBytes) return;
    copies.sort((a, b) => a.at - b.at);
    for (const f of copies) {
      if (total <= maxBytes * 0.8) break;
      await fsp.rm(f.p, { force: true, recursive: true }).catch(() => {});
      total -= f.bytes;
    }
  } catch (e) {
    onWarn(`could not trim the disk cache in ${dir} — ${e.message}`);
  }
}

// `resolveTable` turns a table's SQL name (names.js sqlName) into what it reads: given
// { kind, workspace, item, schema, table } as SQL wrote them (and `dir`, the item's directory
// name, when the tree already knows it), it answers the same five spelled as OneLake spells
// them, plus { metadataLocation } — or { emptySql }, the typed empty SELECT of a table nothing
// was ever written to. Its second argument is { fresh }: past the cache, once a read has failed.
//
// `resolveFile` does the same for a file's SQL name (sql.js fileRefs): given { workspace, item } as
// SQL wrote them, it answers them as OneLake spells them, the item as its directory.
//
// `catalogTables` lists, from the host's cache alone, every table it knows: { kind, workspace,
// item, schema, table } with { columns: [{ name, type }] } (DuckDB types) or { emptySql } — and
// every semantic model, { kind: 'semanticmodel', workspace, model }.
// Each becomes a view DuckDB lists (syncCatalog), so SHOW ALL TABLES and information_schema see
// what the tree has seen without a single request to OneLake.
//
// `resolveLakehouse` finds a lakehouse a write names: { workspace, item, warehouse, scopes }, the warehouse its
// Iceberg catalog answers to and the storage scopes its files are written under. `onWritten` hears what a write
// changed: { kind: 'tables' | 'files', workspace, item, dir }, for the listings to be read again.
//
// `checkConnectivity` asks whether the internet is still there, once a read has failed. `onRowsRead`
// gets a table's metadata location when a statement has read its rows, and `onFileRead` a file's
// abfss:// URL when a statement has read that. `onTablesUsed` gets the tables each such statement
// read, as listings name them, however many times.
//
// The shared engine splits this in two. `serve: { token }` is the
// server's side (engine-server.js): the boot below, then Quack listening with that token. `remote`
// is a window's (engine-client.js): a function that joins the server and answers something shaped
// like an instance, so a window boots nothing and keeps everything from sourcesOf down.
function createEngineHost({ extensionDir, onLog = () => {}, onCatalog = () => {}, onWarn = () => {}, getToken = null,
                            memoryLimit = '', threads = 0, spillMaxGB = 0, maxRows = DEFAULT_MAX_ROWS,
                            allowedPaths = [], lockdown = true,
                            httpProxy = '', bundledExtensions = null,
                            fileCacheDir = null, fileCacheMaxBytes = 0, lakeFolder = 'lake', resolveTable = null, resolveFile = null,
                            resolveLakehouse = null, onWritten = () => {},
                            catalogTables = null, offlineReason = () => null, checkConnectivity = null, tableWritesAllowed = () => true, dropAllowed = () => false,
                            copyAllowed = () => true,
                            onRowsRead = () => {}, onFileRead = () => {}, onTablesUsed = () => {}, serve = null, remote = null } = {}) {
  let instance = null;
  let served = null;            // serve: the address Quack answers on
  // The connection for the host's OWN statements — the secret, extension loading. Page
  // queries never run on it: each gets a connection of its own (see withConn), so a cancel
  // aimed at the page's query cannot land on the host's work.
  let conn = null;
  let ready = null;
  // Set by close(), and final: a late call must not quietly rebuild a DuckDB that nobody
  // owns, holding the token of the account that was just signed out of.
  let closed = false;
  // The engine's own timers (the lake's look at what was read, its tidying, the file cache's trim), stopped
  // by close(); and its statements still running, which close() waits for before it lets go of DuckDB.
  const timers = [];
  const every = (fn, ms) => { const t = setInterval(fn, ms); t.unref(); timers.push(t); };
  const inFlight = new Set();

  // The token the storage secret was built from. A DuckDB secret holds its token BY
  // VALUE, so when VS Code hands back a different one the secret is reissued.
  let authToken = null;
  // Where the storage secret goes (sql.js ONELAKE_SCOPES): every OneLake place this engine was handed a URL in.
  // `secretToken` is the token of the secret this engine's own DuckDB holds, to issue it again when a place is new.
  const storageScopes = new Set(ONELAKE_SCOPES);
  let secretToken = null;

  // The host's own statements run one at a time: two CREATE SECRETs racing is not a race
  // worth having.
  let adminChain = Promise.resolve();
  function admin(fn) {
    const run = adminChain.then(fn, fn);
    adminChain = run.catch(() => {});
    return run;
  }

  // Connections running a page query right now, so cancel() interrupts exactly those.
  const live = new Set();
  // ...and the command line's (agent.js), which a click in the panel must not stop.
  const agentLive = new Set();
  // Connections cancel() reached. Their failure is a stop, not an error, and says so with
  // a flag the page reads — DuckDB's text for it ("Interrupted!") never said "cancel".
  const interrupted = new WeakSet();
  function withConn(fn, owner = live) {
    const run = (async () => {
      if (closed || !instance) throw new Error('the engine was closed');
      const c = await instance.connect();
      owner.add(c);
      try { return await fn(c); }
      catch (e) {
        if (interrupted.has(c) && e && typeof e === 'object') { try { e.cancelled = true; } catch (_) {} }
        throw e;
      }
      finally {
        owner.delete(c);
        try { c.closeSync(); } catch (_) {}
      }
    })();
    inFlight.add(run);
    const done = () => inFlight.delete(run);
    run.then(done, done);
    return run;
  }

  let tmpDir = null;
  // Every window's temp files are in the server's one folder.
  const tmpName = () => randomBytes(8).toString('hex');

  let unsignedAllowed = false;
  async function init() {
    if (closed) throw new Error('the engine was closed');
    if (ready) return ready;
    ready = (async () => {
      const stages = [];
      let at = Date.now();
      const mark = name => { stages.push({ stage: name, ms: Date.now() - at }); at = Date.now(); };

      // A window of the shared engine: the server has done all of the below.
      if (remote) {
        instance = await remote();
        mark('joined the shared engine');
        if (closed) throw new Error('the engine was closed');
        conn = await instance.connect();
        Object.assign(capabilities, instance.capabilities);
        tmpDir = instance.tmpDir;
        onLog({ stages, totalMs: stages.reduce((n, s) => n + s.ms, 0), capabilities: { ...capabilities } });
        return true;
      }

      tmpDir = await fsp.mkdtemp(join(os.tmpdir(), 'onelake-engine-'));

      // extension_directory is pointed at the extension's own storage so the four
      // extensions are downloaded ONCE per install rather than per session, and so the
      // download never lands in the user's ~/.duckdb where it would outlive the extension.
      const config = {
        // Hermetic secrets. This machine — and any user who has ever pointed DuckDB at
        // OneLake — has secrets in ~/.duckdb/stored_secrets, and one of them is very
        // likely called `onelake`. Loading those means a stale, unrelated credential can
        // out-match ours and decide what the extension reads; measured, it fails as
        // `AuthenticationFailed` from a filesystem we thought we had configured.
        allow_persistent_secrets: 'false',
      };
      // DuckDB's own default unless told otherwise, 80% of RAM: it runs in a process of its own, not the extension host.
      if (memoryLimit) config.memory_limit = memoryLimit;
      if (threads > 0) config.threads = String(threads);
      if (extensionDir) config.extension_directory = extensionDir;
      // The community extensions (h3, zipfs, nanoarrow) ship in the vsix and load by path, and a LOAD by
      // path knows only the core signing keys: so unsigned extensions are allowed when they are there.
      // Each is held to its hash when the vsix is built (scripts/pinned-downloads.mjs); the lockdown
      // below then refuses every LOAD, so nothing the page sends can load anything else.
      if (bundledExtensions && COMMUNITY.some(e => fs.existsSync(join(bundledExtensions, `${e}.duckdb_extension`)))) {
        config.allow_unsigned_extensions = 'true'; unsignedAllowed = true;
      }
      if (fileCacheDir) {
        await fsp.mkdir(fileCacheDir, { recursive: true })
          .catch(e => onWarn(`could not make the disk cache's folder ${fileCacheDir} — ${e.message}`));
        trimFileCache(fileCacheDir, fileCacheMaxBytes, onWarn);
        // A server can run for days.
        if (serve) every(() => trimFileCache(fileCacheDir, fileCacheMaxBytes, onWarn), FILE_CACHE_TRIM_MS);
      }
      mark('temp+disk cache');
      // The engine's database is `onelake`, every OneLake name's: DuckDB names a database after its file, and
      // the default database is every connection's, the shared server's own included, which a USE on each could
      // never reach. Nothing in it outlives the engine: it is views over the lake, in this session's temp folder.
      instance = await DuckDBInstance.create(join(tmpDir, `${ENGINE_DB}.duckdb`), config);
      mark('instance');
      conn = await instance.connect();
      mark('connect');
      // close() may have run while DuckDB was starting. The instance is torn down by the
      // catch below, which is the same path a failed boot takes.
      if (closed) throw new Error('the engine was closed');

      // preserve_insertion_order is left ON. Turning it off buys a little scan speed and
      // costs a preview of a CSV or a sheet that shows its rows in a scrambled order.
      //
      // The editor's proxy, before anything is downloaded. GLOBAL: a plain SET of an extension's setting holds for
      // this connection only, and every statement runs on one of its own.
      const proxy = proxySettings(httpProxy);
      if (proxy) {
        await conn.run(`SET GLOBAL http_proxy = ${sqlStr(proxy.host)};`);
        if (proxy.user) await conn.run(`SET GLOBAL http_proxy_username = ${sqlStr(proxy.user)};`);
        if (proxy.password) await conn.run(`SET GLOBAL http_proxy_password = ${sqlStr(proxy.password)};`);
      }
      //
      // REQUIRED, and treated differently from the rest: `azure` is how anything is read from OneLake
      // (abfss://), `iceberg` is an Iceberg table and the catalog's own reads, and `httpfs` is the https the
      // Iceberg catalog and public URLs need. An optional extension that will not load costs one kind of thing,
      // and says so when it is wanted: `delta` when an INSERT goes to a Delta table (deltaAttach);
      // these three failing means the extension cannot do its job, and saying so beats
      // a later "Failed to open file" that names nothing.
      for (const ext of ['iceberg', 'azure', 'httpfs']) await load(ext, '', true);
      for (const ext of ['avro', 'excel', 'sqlite_scanner', 'delta']) await load(ext, '');
      // nanoarrow's read_arrow is how a table with OneLake security is read: what the table read API answered.
      for (const ext of COMMUNITY) await load(ext, 'community');
      // A OneLake table is read through DuckLake, its files brought here as they are read (openLake). A cache
      // folder is there whenever an account is; without one, no OneLake table is read (sourceOf).
      if (fileCacheDir) { await load('ducklake', '', true); await openLake(); }
      mark('extensions');
      // azure has an HTTP client of its own, with its own proxy settings.
      if (proxy) {
        try {
          await conn.run(`SET GLOBAL azure_http_proxy = ${sqlStr(proxy.host)};`);
          if (proxy.user) await conn.run(`SET GLOBAL azure_proxy_user_name = ${sqlStr(proxy.user)};`);
          if (proxy.password) await conn.run(`SET GLOBAL azure_proxy_password = ${sqlStr(proxy.password)};`);
        } catch (e) { onWarn(`could not hand the proxy to DuckDB's azure extension — ${e.message}`); }
      }

      // An :memory: database has no spill path unless one is named, so a query bigger
      // than RAM was an extension-host OOM — and this process is shared with every other
      // extension. The temp dir is this session's own and is deleted on close.
      const tmp = tmpDir.replace(/\\/g, '/');
      await conn.run(`SET temp_directory = ${sqlStr(tmp)};`);
      if (spillMaxGB > 0) await conn.run(`SET max_temp_directory_size = ${sqlStr(`${spillMaxGB}GB`)};`);

      // OneLake's timestamps are UTC, and DAX has no time zones. In this machine's zone a DATE is
      // its local midnight, so a date table's timestamp never equals a fact table's date, and a
      // model joining the two reads blank everywhere east or west of Greenwich.
      try { await conn.run(`SET GLOBAL TimeZone = 'UTC';`); }
      catch (e) { onWarn(`could not set DuckDB's time zone to UTC, so dates may not join — ${e.message}`); }

      // A table's SQL name (ws.lakehouse.schema.t) is nested schemas in the engine's database,
      // `onelake`, made as a statement names them (withTables); a semantic model's
      // (ws.model_semanticmodel) is a view in its workspace's schema there, listed (listCatalog)
      // and queried through the page's semantic step, which compiles it before DuckDB sees it.

      // Parquet footers, kept between queries: a Data tab, a Preview and the user's own
      // SELECT over one table each re-read every footer otherwise. Entries are checked
      // against the file's last-modified time, so a Files/ parquet rewritten in place is
      // read again. Set before the lockdown, which freezes the configuration.
      try { await conn.run('SET parquet_metadata_cache = true;'); }
      catch (e) { onWarn(`could not enable DuckDB's parquet metadata cache — ${e.message}`); }

      // The bytes DuckDB reads from OneLake (data files, manifests) are kept in memory by
      // its external file cache, and dropped when memory runs short. Spilled instead, to
      // this session's temp directory: a block evicted is read back from local disk rather
      // than fetched from OneLake again. What outlives the process is a table's files, whole (openLake).
      try { await conn.run('SET external_file_cache_spill = true;'); }
      catch (e) { onWarn(`could not let DuckDB's file cache spill to disk — ${e.message}`); }

      // The shared engine's server: the blocks every client reads stay in this process's memory.
      // Quack starts before the lockdown, which leaves nothing to start with.
      if (serve) {
        await load('quack', '', true);
        await conn.run('SET enable_external_file_cache = true;');
        // A table's files here are local files, and DuckDB leaves a local file to the system's file
        // cache unless told otherwise.
        try { await conn.run('SET cache_local_files = true;'); }
        catch (e) { onWarn(`a Delta table's data isn't held in memory between queries — ${e.message}`); }
        // A window's own guard (sql.js assertReads) refuses these already. This is one more wall, and
        // a text match, so not the only one: the session token is what keeps others out.
        // DuckLake's own functions write: one deletes files from a SELECT, and here the files are OneLake's.
        await conn.run(`CREATE MACRO ${ENGINE_DB}.main.studio_authorize(token, query) AS
          CASE WHEN regexp_matches(lower(query), '(?s)quack_(serve|stop)|ducklake_[a-z0-9_]+"?([[:space:]]|/[*].*?[*]/|--[^\\n]*\\n)*[(]') THEN NULL ELSE query END;`);
        await conn.run(`SET GLOBAL quack_authorization_function = 'studio_authorize';`);
        // Port 0: the system picks a free one. A port already taken raises no error on Windows.
        const r = await conn.runAndReadAll(`SELECT listen_uri FROM quack_serve('quack:127.0.0.1:0', token = ${sqlStr(serve.token)})`);
        served = r.getRowObjectsJson()[0].listen_uri;
        // DuckDB's own log of what Quack is asked: one row a statement, with its time and any error,
        // in memory. engine-server.js moves it into the log file, so it outlives this process.
        // Writing it to a file isn't an option: on Windows DuckDB then can't read its own file back.
        // And the files statements open, which is how the table service hears what to bring here.
        await conn.run(`CALL enable_logging(${capabilities.lake ? "['Quack', 'FileSystem']" : "['Quack']"}, storage = 'memory');`);
        mark('quack');
      }

      // THE LOCKDOWN. This engine runs SQL that a webview sends it, with the user's files
      // and the user's OneLake token within reach — so whatever the page says, DuckDB may
      // touch the local disk only in its own temp directory, its extension directory, and
      // the few files named here (the packaged README the landing query reads, the CA
      // bundle). The network stays open over https and abfss — public URLs and OneLake —
      // but plain http, `read_text('~/.ssh/id_rsa')` and `COPY … TO`
      // anywhere outside the temp directory are refused, and the configuration is locked so
      // no statement can turn this back off. Verified against DuckDB 2.0: allowed paths
      // still read, others raise Permission Error, `..` cannot climb out, abfss and the
      // Iceberg catalog still work once ca_cert_file names an allowed bundle.
      if (lockdown) {
        const ca = await writeCaBundle(tmpDir);
        // GLOBAL, for every connection: a write's Iceberg catalog is asked over https on a statement's own, and with
        // no bundle named there it looks for the system's, which the lockdown refuses.
        await conn.run(`SET GLOBAL ca_cert_file = ${sqlStr(ca)};`);
        // zip:// only over a remote archive: an entry of a Files/ zip is read as
        // zip://abfss://…, and a bare 'zip://' would open any local archive. Checked
        // against DuckDB 2.0: zip://abfss:// reads, zip://C:/… is refused, and a `..`
        // after abfss:// stays on the azure filesystem.
        const dirs = [`${tmp}/`, 'https://', 'abfss://', 'abfs://', 'az://', 'azure://',
                      'zip://abfss://', 'zip://https://'];
        if (extensionDir) dirs.push(`${extensionDir.replace(/\\/g, '/')}/`);
        // The lake's metadata, a table's files and deletion vectors, and what the table read API answered.
        if (fileCacheDir) dirs.push(`${fileCacheDir.replace(/\\/g, '/')}/`);
        const paths = [ca, ...allowedPaths.filter(Boolean).map(p => String(p).replace(/\\/g, '/'))];
        await conn.run(`SET allowed_directories = [${dirs.map(sqlStr).join(', ')}];`);
        await conn.run(`SET allowed_paths = [${paths.map(sqlStr).join(', ')}];`);
        // What is needed loaded above, and an extension loaded later could only be one planted in a
        // folder allowed here, with unsigned ones allowed for ours.
        await conn.run('SET autoload_known_extensions = false; SET autoinstall_known_extensions = false;');
        await conn.run('SET enable_external_access = false;');
        await conn.run('SET lock_configuration = true;');
      }

      const totalMs = stages.reduce((n, s) => n + s.ms, 0);
      // capabilities rides along so the boot line can say which optional formats this
      // session actually has — the answer to "why is .xlsx greyed out" belongs in the log.
      onLog({ stages, totalMs, capabilities: { ...capabilities } });
      return true;
    })();
    // A FAILED init must not be the answer forever: the commonest causes — offline for
    // the first INSTALL, a corporate proxy — are transient, and the retry is the next
    // call. Only success is cached, and whatever the attempt half-built is torn down so
    // the retry starts clean instead of stacking a second instance on the first.
    ready.catch(() => {
      ready = null;
      made.clear();
      listed.clear();
      catalogStale = true;
      try { if (conn) conn.closeSync(); } catch (_) {}
      try { if (instance) instance.closeSync(); } catch (_) {}
      conn = instance = null;
      if (tmpDir) {
        const d = tmpDir;
        tmpDir = null;
        if (!remote) fsp.rm(d, { recursive: true, force: true }).catch(() => {});
      }
    });
    return ready;
  }

  const capabilities = {
    excel: false, zipfs: false, h3: false, avro: false, httpfs: false, sqlite_scanner: false,
    iceberg: false, azure: false, delta: false, ducklake: false, lake: false, quack: false, nanoarrow: false,
  };

  // An optional extension that will not load costs one file format, which is not a
  // reason to refuse to start — the same judgement data.js makes. A required one is a
  // different thing entirely, so it throws, naming the platform: that is the message a
  // user on an architecture we have no binary for needs to see.
  //
  // A binary shipped inside the vsix (bundledExtensions, fetched per platform at package
  // time) is loaded first and by path: no download, so a first run offline or behind a
  // proxy DuckDB cannot use still has its extensions.
  async function load(ext, repo, required = false) {
    try {
      // A community extension by path loads only as unsigned. With that not allowed (the disk cache
      // off) it comes from its repository, signature checked, with nothing to say about it.
      const shipped = bundledExtensions && (!repo || unsignedAllowed) && join(bundledExtensions, `${ext}.duckdb_extension`);
      let loaded = false;
      if (shipped && fs.existsSync(shipped)) {
        try { await conn.run(`LOAD ${sqlStr(shipped.replace(/\\/g, '/'))};`); loaded = true; }
        catch (e) { onWarn(`bundled '${ext}' would not load (${e.message}); trying the repository`); }
      }
      if (!loaded) try { await conn.run(`LOAD ${ext};`); }
      catch (_) {
        // INSTALL has no timeout, and every statement waits for the boot.
        if (offlineReason() === 'no internet') throw new Error('there is no internet to install it');
        await conn.run(`INSTALL ${ext}${repo ? ` FROM ${repo}` : ''};`);
        await conn.run(`LOAD ${ext};`);
      }
      capabilities[ext] = true;
    } catch (e) {
      if (required) {
        throw new Error(
          `DuckDB could not load its '${ext}' extension on ${process.platform}-${process.arch}, ` +
          `so OneLake tables cannot be read: ${e.message}`);
      }
      // Through onWarn, not console.warn: the extension-host devtools console is where
      // nobody looks, and "why can't I open this .xlsx" deserves a findable answer.
      onWarn(`DuckDB extension '${ext}' unavailable — ${e.message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // OneLake tables, through DuckLake
  // ---------------------------------------------------------------------------
  // A Delta or Iceberg table is a DuckLake table in `lake`, kept from its own metadata (onelaketable.js): its
  // files are named on OneLake until they come down whole, then by their copy in the cache folder
  // (tableservice.js). What a statement opens is what comes down: DuckDB's own FileSystem log says which.
  // The lake is the engine's that holds DuckDB, the server's on the shared engine: a window asks it over
  // the control pipe (lakeTable). Without a cache folder there is no lake, and no OneLake table is read (sourceOf).
  const LAKE_POLL_MS = 1000, LAKE_TIDY_MS = 60 * 1000;
  let lakeService = null, lakeToken = null, lakeDirs = null;
  async function openLake() {
    const root = join(fileCacheDir, lakeFolder);
    lakeDirs = { meta: join(root, 'meta.ducklake'), files: join(root, 'files'), deletes: join(root, 'deletes') };
    await fsp.mkdir(root, { recursive: true });
    // One engine holds the lake: its metadata file can be open in one process only. Without it no OneLake
    // table can be read, so the engine doesn't start.
    try { await attachLake(conn, duckdbPath(lakeDirs.meta)); }
    catch (e) { throw new Error(`the lake could not be opened, so no OneLake table can be read: ${e.message}`); }
    capabilities.lake = true;
    // The places its tables were synced from in an earlier run: their files are read with no sync to say so.
    try {
      const kept = await conn.runAndReadAll(`SELECT DISTINCT regexp_extract(p, '^(abfss?://[^/]*/)', 1) AS scope FROM (
        SELECT path AS p FROM system_internal.ducklake_table
        UNION ALL SELECT path FROM system_internal.ducklake_data_file WHERE NOT path_is_relative
        UNION ALL SELECT path FROM system_internal.ducklake_delete_file WHERE NOT path_is_relative) WHERE p LIKE 'abfs%'`);
      for (const { scope } of kept.getRowObjects()) if (scope && scopeOfUrl(scope) === scope) storageScopes.add(scope);
    } catch (e) { onWarn(`the lake's places could not be read, so each is known again when its table syncs — ${e.message}`); }
    lakeService = createTableService({
      withConn: fn => admin(() => fn(conn)),
      filesDir: duckdbPath(lakeDirs.files),
      download: httpsDownload({ getToken: async () => { if (!lakeToken) throw new Error('not signed in'); return lakeToken; } }),
      // 0 (the disk cache set to nothing): a table is read from OneLake, and nothing comes here.
      maxBytes: Math.max(0, Number(fileCacheMaxBytes) || 0),
      log: onWarn,
    });
    // Off the boot: a window's statements never wait for these.
    let lastUs = 0;
    const poll = async () => {
      if (closed) return;
      try {
        const got = await withConn(c => openedSince(c, lastUs), agentLive);
        lastUs = got.lastUs;
        // In a window's own engine nothing else reads the log, so what was read goes.
        if (!serve && got.paths.length) await withConn(c => c.run('CALL truncate_duckdb_logs();'), agentLive);
        if (got.paths.length && !offlineReason()) await lakeService.noteOpened(got.paths);
      } catch (e) { if (!closed) onWarn(`the table service missed what was read — ${e.message}`); }
    };
    every(poll, LAKE_POLL_MS);
    every(() => { if (!closed) lakeService.tidy().catch(e => onWarn(`the table service could not tidy — ${e.message}`)); }, LAKE_TIDY_MS);
    if (!serve) await conn.run(`CALL enable_logging(['FileSystem'], storage = 'memory');`);
  }

  // A table's name in the lake: by its folder, so a new snapshot of it is the same table.
  const lakeNameOf = folder => `t_${createHash('sha256').update(String(folder).toLowerCase()).digest('hex').slice(0, 24)}`;
  const folderOf = ({ deltaTable, metadataLocation }) => deltaTable || String(metadataLocation).replace(/\/metadata\/[^/]+$/, '');
  // Whether the lake has the table at all, synced by a version that kept no studio_synced.
  const inLake = async name => (await withConn(c => c.runAndReadAll(
    `SELECT count(*)::INTEGER AS n FROM duckdb_tables() WHERE database_name = 'lake' AND table_name = ${sqlStr(name)}`), agentLive)).getRowObjects()[0].n > 0;
  /**
   * The lake table that reads a table: its name in `lake`, as it was last synced, with nothing asked of OneLake.
   * Finding out that the table moved is the sync service's (syncworker.js, lakeSync). Only a table the lake has no
   * record of is synced first, which reads its log once; `fresh` syncs it whatever. Offline, a table never synced
   * here has no name, and so does any with `check`, which also says when and from where it was synced.
   */
  async function lakeTable(which) {
    if (!capabilities.lake) throw new Error('this engine has no lake');
    const name = lakeNameOf(folderOf(which));
    // Asked before every statement that names the table: without its log.
    const was = await withConn(c => syncedBrief(c, name), agentLive);
    if (lakeWrong.has(name) && !which.check && !which.fresh) throw new Error(`${which.metadataLocation || which.deltaTable}: ${lakeWrong.get(name)}`);
    if (which.check) return was ? { name, location: was.location, at: was.syncedAt } : { name: null };
    if (which.offline) return { name: was || await inLake(name) ? name : null };
    if (was && !which.fresh) return { name };
    return lakeSync(which);
  }

  // One sync of a table at a time: another asked for meanwhile waits for it, and goes on from where it got to.
  const lakeSyncs = new Map();
  // Lake tables whose rows didn't come to what their snapshot holds, and why: refused until synced right.
  const lakeWrong = new Map();
  function lakeSync(which) {
    if (!capabilities.lake) return Promise.reject(new Error('this engine has no lake'));
    const name = lakeNameOf(folderOf(which));
    const run = (lakeSyncs.get(name) || Promise.resolve()).catch(() => {}).then(() => syncOnce(name, which));
    lakeSyncs.set(name, run);
    run.catch(() => {}).finally(() => { if (lakeSyncs.get(name) === run) lakeSyncs.delete(name); });
    return run;
  }
  // The log is read on a connection of its own, so a statement's view isn't held up by it: only the lake's own
  // writes go in turn with the host's statements (admin). A Delta table goes on from the version last synced, the
  // same table's: one dropped and made again at its path has another id.
  async function syncOnce(name, which) {
    const folder = folderOf(which);
    return withConn(async c => {
      const was = await syncedOf(c, name);
      const same = was && was.log && (!was.uuid || !which.uuid || was.uuid === String(which.uuid));
      // Before anything of it is read: where the table is, and for an Iceberg table where its manifests say its
      // files are. A Delta table's files are under its folder, but for a deletion vector kept by its full path.
      const allow = urls => allowStorage(urls.map(scopeOfUrl));
      await allow([which.deltaTable || which.metadataLocation]);
      const state = which.deltaTable
        ? await readDelta(c, which.deltaTable, { ...(same ? { from: Number(was.version), base: was.log } : {}), withConn: fn => withConn(fn, agentLive) })
        : await readIceberg(c, which.metadataLocation, { allow });
      await allow(state.files.filter(f => f.deletes && f.deletes.dv && f.deletes.dv.storageType === 'p').map(f => f.deletes.dv.pathOrInlineDv));
      const synced = { folder, location: which.metadataLocation || null, listed: which.listed || null, uuid: which.uuid || null };
      const r = await admin(async () => syncTable(conn, name, state, { dvDir: duckdbPath(lakeDirs.deletes), held: await heldNow(), synced }));
      // Held to what the snapshot says it holds: a lake table that reads other rows is never read (lakeTable), and
      // says why, until a sync reads it right. Wrong rows are worse than none.
      if (state.liveRows != null) {
        const got = await withConn(k => k.runAndReadAll(`SELECT count(*)::BIGINT AS n FROM lake.main.${quoteIdent(name)}`), agentLive);
        const n = Number(got.getRowObjectsJson()[0].n);
        if (n !== state.liveRows) {
          const why = `its copy in the lake reads ${n.toLocaleString('en')} rows, where its snapshot holds ${state.liveRows.toLocaleString('en')}, so it isn't read`;
          lakeWrong.set(name, why);
          throw new Error(`${which.metadataLocation}: ${why}`);
        }
      }
      lakeWrong.delete(name);
      return { name, version: String(state.version), added: r.added, ended: r.ended, commitsRead: state.commitsRead == null ? null : state.commitsRead };
    }, agentLive);
  }
  // Every lake table and what it was last synced from: what the sync service watches.
  const lakeTablesHere = () => withConn(c => syncedAll(c), agentLive);
  const lakeOf = which => (remote ? instance.lakeTable(which) : lakeTable(which));
  // The lake's name for a table it holds, or null: asks nothing of OneLake (health.js reads its files by it).
  const lakeName = async w => {
    await init();
    if (!capabilities.lake) return null;
    return (await lakeOf({ deltaTable: w.deltaTable || null, metadataLocation: w.metadataLocation, check: true })).name || null;
  };
  // The service's own connection is the admin one: inside admin() already, so asked of it directly. None
  // before the service's first look has made its table.
  const heldNow = () => heldOn(conn).catch(() => new Map());

  // ---------------------------------------------------------------------------
  // OneLake, spoken by DuckDB itself
  // ---------------------------------------------------------------------------
  // DuckDB reads OneLake with one azure secret holding the VS Code token: tables through the lake, Files/
  // objects by their abfss:// names. No catalog is ever asked at query time — the host's store already holds where each
  // table is.

  // Reissues the storage secret when the token has changed. Returns null rather
  // than throwing when there is no credential to be had, because
  // most statements never touch OneLake: `SELECT 42` must not need a Microsoft account,
  // and the harnesses build this engine with no token source at all.
  //
  // `fresh` reaches the token source. Without it the retry below asked the same
  // 60-second cache that had just handed out the expired token, got the identical
  // string back, and concluded — wrongly — that no better token existed.
  async function ensureAuth(fresh = false) {
    if (!getToken) return null;
    const token = await getToken(fresh ? { fresh: true } : {});
    if (!token) return null;
    if (token === authToken) return token;
    await admin(async () => {
      if (token === authToken) return;
      // On the shared engine, over the control pipe: a statement sent over Quack is in its log.
      if (remote) await instance.setStorageToken(token, [...storageScopes]);
      else await issueSecret(token);
      authToken = token;
    });
    return token;
  }
  // A parameter, so the token is in no statement's text, whatever logs them. Scoped to the OneLake places this
  // engine knows (storageScopes): a URL anywhere else, whoever wrote it, is read with no token.
  async function issueSecret(token) {
    const p = await conn.prepare(`CREATE OR REPLACE SECRET onelake_storage (TYPE azure, PROVIDER access_token, ACCESS_TOKEN ?,
      SCOPE [${[...storageScopes].map(sqlStr).join(', ')}])`);
    p.bindVarchar(1, token);
    await p.run();
    secretToken = token;
    // And the table service's downloads: the one place the token is kept outside DuckDB's secret.
    lakeToken = token;
  }

  // OneLake places about to be read (their scopes, sql.js): the secret is issued again when one is new. On the
  // shared engine the server holds the secret, and is told. Anything that is not a OneLake scope is dropped.
  async function allowStorage(scopes) {
    const fresh = [...new Set(scopes)].filter(s => s && scopeOfUrl(s) === s && !storageScopes.has(s));
    if (!fresh.length) return;
    for (const s of fresh) storageScopes.add(s);
    await admin(async () => {
      if (remote) await instance.allowStorage(fresh);
      else if (secretToken) await issueSecret(secretToken);
    });
  }

  async function withAuthRetry(run, canRetry = () => true) {
    await ensureAuth();
    try {
      return await run();
    } catch (e) {
      if (!AUTH_FAILURE.test(String(e && e.message)) || !canRetry()) throw e;
      const stale = authToken;
      const fresh = await ensureAuth(true);   // PAST the caller's token cache
      if (!fresh) throw e;
      // The same token: a file handle opened with an older one may still be what was refused, put
      // back by a read that was using it when the token moved on. Issued again, which lets those go,
      // and tried once more; a second refusal is the token's own, and is said.
      if (fresh === stale) await admin(() => (remote ? instance.setStorageToken(fresh, [...storageScopes]) : issueSecret(fresh)));
      return run();
    }
  }

  // A table, ready to be selected from by its SQL name. A Delta or Iceberg table is a view over its lake table,
  // kept from the table's own log or metadata file (lakeTable): Fabric's Iceberg conversion of a Delta table
  // isn't to be read, as its column ids can disagree with the ones in the files, and DuckDB then gives one
  // column another's values. Where each is
  // comes from what the host's store holds (the catalog's loadTable answer, cached on disk). The
  // catalog is not asked at query time when the store has the answer — it answered a loadTable in 5s,
  // 12s and 114s on a real tenant.
  //
  // `made` is what each view reads now (by its lower-cased name, as DuckDB matches names): a
  // view is made again only when its table moved to a new snapshot.
  const made = new Map();
  // Tables OneLake refused this window the files of, by their lower-cased name: read through the table
  // read API from now on (sqltables.js), with no refusal first.
  const refusedHere = new Set();
  // What the table read API answered for a table, in this engine's disk cache, where the lockdown lets
  // DuckDB read it. Only there, and only a name that SQL can't be broken out of.
  const inCache = p => !!fileCacheDir && !/[\r\n\0]/.test(p)
    && duckdbPath(p).toLowerCase().startsWith(`${duckdbPath(fileCacheDir).toLowerCase()}/${TABLE_READ_FOLDER}/`);
  // A table's name as the statement wrote it: by its names, or by its GUIDs.
  const nameOf = ref => (ref.byGuid ? [ref.workspace, ref.item, ref.schema || 'dbo', ref.table].map(sqlPart).join('.') : sqlName(ref));
  // Where its view goes: the nested schemas of that name, in the engine's database.
  const pathOf = ref => [ENGINE_DB, ref.workspace, ref.byGuid ? ref.item : itemPart(ref.item, ref.kind), ref.schema || 'dbo'];
  // A catalog's name is found before a schema's: a workspace named like one of the engine's catalogs, or a database
  // file attached here, can't be reached by name, and nothing of the catalog is read in its place. Nor can one named
  // like a schema DuckDB keeps in every catalog (tried: main.x.dbo.t is not found).
  const ENGINE_NAMES = new Set([ENGINE_DB, 'system', 'temp', 'lake', 'system_internal', 'main', 'pg_catalog', 'information_schema']);
  // The database files every tab has attached, by their lower-cased names.
  const attachedFiles = new Set();
  // Whether the name's first part is one of those. A bare lakehouse name (sql.js tableRefs) that starts with one is
  // DuckDB's, a table of an attached database file say, and is left to it; any other name says why it can't be read.
  function reachable(ref) {
    if (ref.byGuid) return true;
    const ws = String(ref.workspace).toLowerCase();
    if (!ENGINE_NAMES.has(ws) && !attachedFiles.has(ws) && !isWriteCatalog(ws)) return true;
    if (ref.bare) return false;
    throw new Error(`${sqlName(ref)}: ${ref.workspace} is also the name of a database or schema of this engine, which SQL finds ` +
      'first. Name the table by its GUIDs instead: "<workspace id>"."<item id>".<schema>.<table>');
  }
  // What a table reads: its view's name, where that goes, and the view's source. Null for a bare name that isn't
  // OneLake's, which DuckDB reads as it is.
  async function sourceOf(ref, o) {
    if (!resolveTable) throw new Error('this engine cannot name OneLake tables');
    if (!reachable(ref)) return null;
    // `held`: what the lake holds of a table, so one it holds is named from what the catalog keeps alone (sqltables.js).
    const held = capabilities.lake ? w => lakeOf({ deltaTable: w.deltaTable || null, metadataLocation: w.metadataLocation, check: true }) : null;
    const r = await resolveTable(ref, { ...o, secured: refusedHere.has(nameOf(ref).toLowerCase()), held });
    if (r == null) return null;
    let source;
    if (r.emptySql != null) source = String(r.emptySql);
    else if (Array.isArray(r.arrowFiles)) {
      const bad = r.arrowFiles.find(f => !inCache(String(f)));
      if (!r.arrowFiles.length || bad !== undefined) {
        throw new Error(`${sqlName(r)}: its rows from the table read API aren't where this engine reads (${String(bad).slice(0, 120)})`);
      }
      source = `SELECT * FROM read_arrow([${r.arrowFiles.map(f => sqlStr(duckdbPath(f))).join(', ')}])`;
    }
    else if (r.deltaTable != null || isOneLakeMetadata(r.metadataLocation)) {
      if (r.deltaTable != null && !isOneLakeTable(r.deltaTable)) throw new Error(`OneLake gave ${sqlName(r)} no readable folder (${String(r.deltaTable).slice(0, 120)})`);
      // `sync`: a Refresh covered the table since it was last synced, which asks OneLake again.
      const which = { deltaTable: r.deltaTable || null, metadataLocation: r.metadataLocation || null, at: r.at,
                      listed: r.listed || null, uuid: r.tableUuid || null,
                      fresh: !!(o && o.fresh) || !!r.sync, offline: !!offlineReason() };
      if (capabilities.lake) {
        let name = r.lake || null;
        try { if (!name) ({ name } = await lakeOf(which)); }
        catch (e) {
          // OneLake refused this user the table's log: a table with OneLake security, read through the table read API.
          if (!FORBIDDEN.test(String(e && e.message)) || refusedHere.has(nameOf(ref).toLowerCase())) throw e;
          refusedHere.add(nameOf(ref).toLowerCase());
          return sourceOf(ref, o);
        }
        if (!name) {
          const why = offlineReason();
          throw Object.assign(new Error(`${sqlName(r)}: this table isn't cached on this machine, and ${why === 'no internet' ? 'there is no internet' : 'you are not signed in'}. ` +
            'What this machine has cached still works: tables, columns, stats and first rows.'), { offline: true });
        }
        source = `SELECT * FROM lake.main.${quoteIdent(name)}`;
      } else {
        // Only through the lake: never past it, read from OneLake by another way that keeps nothing here.
        throw new Error(`${sqlName(r)}: a OneLake table is read through the lake, and this engine has none` +
          (fileCacheDir ? '.' : ': it has no cache folder, as no account is signed in.'));
      }
    } else {
      throw new Error(`OneLake gave ${sqlName(r)} no readable metadata location` +
        (r.metadataLocation ? ` (${String(r.metadataLocation).slice(0, 120)})` : ''));
    }
    // A table named by its GUIDs has its view there: the names they stand for are another view's. So has a lakehouse
    // written with _lakehouse after its name, as ws.data_lakehouse.dbo.t, which DuckDB looks for at that path.
    const at = ref.byGuid ? ref : ref.kind === 'lakehouse' && r.kind === 'lakehouse' &&
      String(ref.item).toLowerCase() !== String(r.item).toLowerCase() ? { ...r, item: ref.item } : r;
    return { name: nameOf(at), path: pathOf(at), source, location: r.emptySql == null ? r.metadataLocation : null, at: r.at, listed: r.listed, secured: !!r.secured };
  }
  async function makeView({ name, path: parts, source }) {
    if (/\bread_arrow\(/.test(source) && !capabilities.nanoarrow) {
      throw new Error(`${name} has OneLake security, and DuckDB's nanoarrow extension, which reads what OneLake's table read API answers, isn't available.`);
    }
    const key = name.toLowerCase();
    // On a shared engine another window may have changed the view since, so what this window
    // remembers making says nothing. A statement costs little there, sent in one call.
    if (!remote && made.get(key) === source) return;
    await admin(async () => {
      if (!remote && made.get(key) === source) return;
      const path = parts.map(quoteIdent);
      const schemas = [];
      for (let k = 2; k <= path.length; k++) schemas.push(`CREATE SCHEMA IF NOT EXISTS ${path.slice(0, k).join('.')};`);
      await conn.run([...schemas, `CREATE OR REPLACE VIEW ${ENGINE_DB}.${name} AS ${source};`].join('\n'));
      made.set(key, source);
      listed.delete(key);
    });
  }

  // Every table the host's cache knows, in DuckDB's catalog before it is ever read: a view
  // with the table's columns that FAILS if it is selected from. A statement that names the
  // table replaces it with the real one first (withTables), so only a name that check
  // cannot see — one inside a string — reaches it, and that is an error, never zero rows.
  // `listed` holds the views made this way, by key -> name: only those are replaced or
  // dropped when the cache moves; a view a statement made is never touched.
  const listed = new Map();
  let catalogStale = true;
  const DUCK_TYPE = /^[A-Z_]+( [A-Z_]+)*(\(\d+,\d+\))?$/;
  // Where an entry goes: its view's SQL name, and the schemas it sits in. A semantic model is
  // { kind: 'semanticmodel', workspace, model }; anything else is a table.
  function placeOf(t) {
    if (t.kind === MODEL_KIND) {
      return { name: modelSqlName(t.workspace, t.model), path: [ENGINE_DB, t.workspace] };
    }
    return { name: sqlName(t), path: pathOf(t) };
  }
  function listedSource(t, name) {
    // A model has no columns to list, and is never read as a view: its one column says what
    // it is, and selecting from it says why it cannot be.
    if (t.kind === MODEL_KIND) {
      return `SELECT NULL::VARCHAR AS model WHERE error(${sqlStr(`${name} is a semantic model that is not open`)}) IS NULL`;
    }
    if (t.emptySql != null) return String(t.emptySql);
    const cols = (t.columns || []).map(c =>
      `CAST(NULL AS ${DUCK_TYPE.test(String(c.type)) ? c.type : 'VARCHAR'}) AS ${quoteIdent(c.name)}`);
    // A list needs a name and nothing more, so a table is listed before its columns are known.
    if (!cols.length) cols.push(`NULL::VARCHAR AS ${quoteIdent(COLUMNS_NOT_READ)}`);
    return `SELECT ${cols.join(', ')} WHERE error(${sqlStr(`${name} is not open: name it in a query to read it`)}) IS NULL`;
  }
  // One listing at a time: a second statement waits for the one under way, not past it.
  let syncing = null;
  function syncCatalog() {
    if (!syncing) syncing = listCatalog().finally(() => { syncing = null; });
    return syncing;
  }
  async function listCatalog() {
    if (!catalogTables || !catalogStale) return;
    catalogStale = false;
    const t0 = Date.now();
    let list;
    try { list = await catalogTables(); }
    catch (e) { catalogStale = true; onWarn(`the cached tables could not be listed in DuckDB — ${e.message}`); return; }
    const want = new Map();
    for (const t of list || []) {
      const { name, path } = placeOf(t);
      const key = name.toLowerCase();
      if (!want.has(key)) want.set(key, { t, name, path });
    }
    // A few at a time, each its own turn: a whole tenant is seconds, and a statement's view shouldn't
    // wait behind that for a turn of its own.
    const entries = [...want];
    for (let at = 0; at < entries.length; at += LIST_BATCH) await admin(async () => {
      const todo = [];
      for (const [key, { t, name, path: parts }] of entries.slice(at, at + LIST_BATCH)) {
        if (made.has(key) && !listed.has(key)) continue;
        const source = listedSource(t, name);
        if (source == null || made.get(key) === source) continue;
        const path = parts.map(quoteIdent);
        const schemas = [];
        for (let k = 2; k <= path.length; k++) schemas.push(`CREATE SCHEMA IF NOT EXISTS ${path.slice(0, k).join('.')};`);
        // On a shared engine this name may be another window's real view: a listing never replaces it.
        // Unless this window listed it with no columns and now has them. Any window's statement that
        // names the table makes its view again first, so this can't leave one reading the wrong thing.
        const filling = String(made.get(key)).includes(COLUMNS_NOT_READ);
        todo.push({ key, name, source, schemas, view: `CREATE ${remote && !filling ? 'VIEW IF NOT EXISTS' : 'OR REPLACE VIEW'} ${ENGINE_DB}.${name} AS ${source};` });
      }
      const listedAs = x => { made.set(x.key, x.source); listed.set(x.key, x.name); };
      // In one call: a call per statement cost over a second at 300 entries. Run again one by
      // one if that fails, so a bad entry costs only itself; both kinds of statement can repeat.
      try {
        // One transaction: the database is a file, and each commit is a write to disk (3,000 views took 7.4 s
        // one commit each, 2.8 s in one).
        if (todo.length) await conn.run(['BEGIN;', ...new Set(todo.flatMap(x => x.schemas)), ...todo.map(x => x.view), 'COMMIT;'].join('\n'));
        todo.forEach(listedAs);
      } catch (_) {
        // A statement that failed left the transaction aborted: nothing more runs on this connection until it goes.
        try { await conn.run('ROLLBACK;'); } catch (_) { /* none open */ }
        for (const x of todo) {
          try {
            for (const s of x.schemas) await conn.run(s);
            await conn.run(x.view);
            listedAs(x);
          } catch (e) { onWarn(`${x.name} could not be listed in DuckDB — ${e.message}`); }
        }
      }
    });
    await admin(async () => {
      for (const [key, name] of [...listed]) {
        if (want.has(key)) continue;
        if (!remote) try { await conn.run(`DROP VIEW IF EXISTS ${ENGINE_DB}.${name};`); } catch (_) {}
        listed.delete(key);
        made.delete(key);
      }
    });
    onCatalog({ count: (list || []).length, ms: Date.now() - t0 });
  }
  // The host's cache moved: the next statement that reads the catalog lists it again.
  function catalogChanged() { catalogStale = true; }
  // Everything a first SHOW ALL TABLES would otherwise wait for, done ahead of it. Not a page
  // method. Reads only the host's cache: no token, no request to OneLake.
  async function warm() {
    await init();
    await syncCatalog();
  }

  // Every table a statement names by its SQL name, so a saved query, or one typed from scratch,
  // reads what it names with nothing opened first.
  async function sourcesOf(sql, o) {
    // A table named the old way would only be "catalog not found": said with its name now.
    const old = oldTableName(sql);
    if (old) throw new Error(old);
    const seen = new Set();
    const refs = [];
    for (const ref of tableRefs(sql)) {
      const key = [ref.kind, ref.workspace, ref.item, ref.schema, ref.table].join('\0').toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push(ref);
    }
    // A model's query names many, and past its age each can ask OneLake for its log.
    return (await mapPool(refs, ref => sourceOf(ref, o), TABLES_AT_ONCE)).filter(Boolean);
  }

  // The statement with each file it names as DuckDB reads it: its abfss:// URL. `written` is how to
  // say those URLs as the statement wrote them, in what DuckDB answers.
  async function withFileUrls(sql, fresh) {
    const refs = fileRefs(sql);
    if (!refs.length) return { statement: sql, written: [] };
    if (!resolveFile) throw new Error('this engine cannot name OneLake files');
    let statement = '', at = 0;
    const written = [];
    for (const ref of refs) {
      const { workspace, item } = await resolveFile(ref, { fresh });
      const url = abfssUrl(workspace, `${item}/Files`);
      const inQuotes = s => s.split(ref.quote).join(ref.quote + ref.quote);
      statement += `${sql.slice(at, ref.start)}${ref.quote}${inQuotes(ref.zip + url + ref.path.slice('/Files'.length))}${ref.quote}`;
      at = ref.end;
      written.push({ url: inQuotes(url), name: inQuotes(ref.written) });
    }
    return { statement: statement + sql.slice(at), written };
  }

  // Offline, a statement that reads a lake table reads the files here and fails on one that isn't (what an
  // offline read of OneLake answers is said as that, below). One that reads OneLake past the lake is refused
  // here, rather than left to time out. A table nothing was ever written to reads no file, and needs no network.
  // A OneLake URL it reads: after FROM or JOIN, or as a function's argument. Not one that is only a
  // value, as a model's path is in what SHOW SEMANTIC VIEWS compiles to.
  const READS_ONELAKE = /(?:\b(?:from|join)\s+\(?\s*'|\b(?!values\b)\w+\s*\(\s*\[?\s*')(?:zip:\/\/)?(?:abfss?|az|azure):\/\//i;
  function refuseOffline(sql) {
    const why = offlineReason();
    if (!why || !READS_ONELAKE.test(sql)) return;
    throw Object.assign(new Error(`This statement: reading rows needs OneLake, and ${why === 'no internet' ? 'there is no internet' : 'you are not signed in'}. ` +
      'What this machine has cached still works: tables, columns, stats and first rows.'), { offline: true });
  }

  // A statement that names a table without reading its rows.
  const READS_NO_ROWS = /^(?:\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)*(?:describe|desc|explain(?!\s*(?:\(\s*)?analy[sz]e))\b/i;
  // Said once per location: every statement passes here.
  const rowsSaid = new Set();
  function rowsRead(sql, tables, statement, used) {
    if (READS_NO_ROWS.test(sql)) return;
    if (used) {
      const list = tables.map(t => t.listed).filter(Boolean);
      if (list.length) { try { onTablesUsed(list); } catch (_) {} }
    }
    for (const { location } of tables) {
      if (!location || rowsSaid.has(location)) continue;
      rowsSaid.add(location);
      try { onRowsRead(location); } catch (_) {}
    }
    // Not kept in rowsSaid: a file can be rewritten under one URL, and its version is what is noted.
    for (const url of filesReadBy(statement)) { try { onFileRead(url); } catch (_) {} }
  }

  // A statement run with what it needs: the catalog when it reads the catalog, the views of the
  // tables it names — and then `run` gets the statement itself, or its whole-path twin (sql.js
  // catalogStatement). Its tables come from the cache, and are read again if it fails on them
  // (store.js revalidate). `canRetry`: false once running it again would repeat what it sent.
  // `fresh` asks OneLake for them first. `seen` hears when the oldest of them was read from OneLake,
  // which is how old the answer may be: a table's metadata is trusted for a day by default. `used`:
  // whether this is someone reading these tables, which is what says they are in use.
  // `signal`: the statement was stopped, so a table still being read through the table read API isn't waited for.
  async function withTables(sql, run, canRetry = () => true, { fresh = false, seen = () => {}, used = true, signal, refusedOnce = false } = {}) {
    if (readsCatalog(sql)) await syncCatalog();
    let named = [], files = [];
    try {
      return await revalidate(o => sourcesOf(sql, { ...o, fresh: fresh || !!o.fresh, signal }), async tables => {
        named = tables;
        const read = tables.map(t => t.at).filter(Number.isFinite);
        seen(read.length ? Math.min(...read) : null);
        const { statement, written } = await withFileUrls(sql, fresh);
        files = written;
        refuseOffline(statement);
        // Every OneLake URL the statement reads by name: a file it names, a URL written in it, a view's source.
        await allowStorage(oneLakeScopes([statement, ...tables.map(t => t.source || '')].join('\n')));
        for (const t of tables) await makeView(t);
        const result = await run(catalogStatement(sql) || statement);
        rowsRead(sql, tables, statement, used);
        return result;
      }, e => READ_FAILURE.test(String(e && e.message)) && canRetry(), sameSources);
    } catch (e) {
      if (files.length) { try { e.message = namedError(e.message, files); } catch (_) {} }
      const message = String(e && e.message);
      // OneLake refused a table's files, its metadata having been given: a table with OneLake security. Which
      // one, of a statement's several, is asked of each, and those are read through the table read API.
      if (FORBIDDEN.test(message) && !refusedOnce && canRetry() && !(signal && signal.aborted)) {
        const direct = named.filter(t => !t.secured && /\bFROM lake\./.test(t.source));
        // Asked even of one: the API costs the user, and the refusal has to be OneLake's, not words in the statement.
        const found = [];
        for (const t of direct) {
          try { await withConn(c => c.run(`SELECT 1 FROM ${t.name} LIMIT 1`), agentLive); }
          catch (p) { if (FORBIDDEN.test(String(p && p.message))) found.push(t); }
        }
        if (found.length) {
          for (const t of found) refusedHere.add(t.name.toLowerCase());
          return withTables(sql, run, canRetry, { fresh, seen, used, signal, refusedOnce: true });
        }
      }
      if (offlineReason() && READ_FAILURE.test(message) && NOT_CACHED.test(message)) {
        const what = named.filter(t => t.location);
        throw Object.assign(new Error(`${what.length === 1 ? what[0].name : 'This statement'}: this part isn't cached on this machine. Read it once online.`), { offline: true });
      }
      if (READ_FAILURE.test(message)) {
        // The internet went while this was reading, and nothing has said so yet. Run it again from
        // what is kept. The statement isn't asked twice: the retry finds this window offline.
        if (!offlineReason() && capabilities.lake && checkConnectivity && canRetry()) {
          await checkConnectivity();
          if (offlineReason()) return withTables(sql, run, canRetry, { fresh, seen, used, signal, refusedOnce });
        }
        // A read the check above could not see, and the reason it failed.
        const why = offlineReason();
        if (why) { try { e.message += `\n(OneLake Studio is offline: ${why}.)`; } catch (_) {} }
      }
      throw e;
    }
  }

  // What DuckDB's parser says `sql` is (sql.js checkedRead), in a DuckDB that holds nothing where
  // there is one: this window's client, so it costs no Quack request and leaves no line in Logs.
  async function serialize(sql) {
    const c = await (instance.connectLocal ? instance.connectLocal() : instance.connect());
    try {
      const r = await c.runAndReadAll(`SELECT json_serialize_sql(${sqlStr(sql)}) AS parsed`);
      const { parsed } = r.getRowObjectsJson()[0];
      return typeof parsed === 'string' ? JSON.parse(parsed) : parsed;
    } finally { try { c.closeSync(); } catch (_) {} }
  }

  // A USE (sql.js useOf): the schema it names, its item found in OneLake and spelled as OneLake spells it. null
  // for USE onelake. The schema itself is not looked for: a lakehouse's empty one has nothing to list.
  async function namespaceOf(asked) {
    if (asked.clear) return null;
    if (!resolveFile) throw new Error('this engine cannot name OneLake tables');
    const find = (item, kind) => resolveFile({ workspace: asked.workspace, item, kind,
      written: `USE ${[asked.workspace, itemPart(item, kind), asked.schema].map(sqlPart).join('.')}` });
    let kind = asked.kind, item = asked.item, at;
    try { at = await find(item, kind); }
    catch (e) {
      if (kind === 'lakehouse' || !e || !e.notListed) throw e;
      // ws.gold_warehouse.dbo: the lakehouse named gold_warehouse, when that is what the workspace has.
      item = itemPart(asked.item, kind);
      kind = 'lakehouse';
      at = await find(item, kind).catch(() => { throw e; });
    }
    return { workspace: at.workspace, item: displayName(at.item), kind, schema: asked.schema };
  }
  // What a USE answers: the schema bare names are in now.
  const useAnswer = ns => `SELECT ${sqlStr(ns ? namespaceName(ns) : ENGINE_DB)} AS schema`;
  // A statement under a USE's schema `ns`, its bare names given their whole names (sql.js withNamespace). The
  // engine's own names are asked where the statement runs: a file's view is the shared engine's.
  async function namespaced(sql, ns, owner, { write = false } = {}) {
    if (!ns) return sql;
    const r = await withConn(c => c.runAndReadAll(DUCK_NAMES), owner);
    const duck = duckNamesOf(r.getRowObjectsJson());
    const isListed = name => listed.has(name.toLowerCase()) || made.has(name.toLowerCase());
    if (write) return writeWithNamespace(sql, ns, serialize, duck, isListed);
    return withNamespace(sql, await bareNames(sql, serialize), ns, duck, isListed);
  }

  // ---------------------------------------------------------------------------
  // Writes: a lakehouse's Tables, Iceberg through its catalog and Delta by folder, and its Files/
  // ---------------------------------------------------------------------------
  // Each table is written in its own format, and a new one is made as Iceberg (deltaTarget, below).
  // DuckDB writes Iceberg only through a catalog, so a write to a table attaches the lakehouse's Iceberg REST
  // catalog for that one statement, under a name of its own, and detaches it after. Nothing stays attached for a
  // listing to find, two statements never share one, and each is attached with the token of its time. The
  // options are the ones OneLake's catalog takes: it vends no credentials (DuckDB writes the files with the
  // storage secret) and has no staged create. The token is a secret's, as an ATTACH's TOKEN shows in
  // duckdb_databases().
  const ICEBERG_URI = 'https://onelake.table.fabric.microsoft.com/iceberg';
  const iceAttached = new Set();
  let iceSecretToken = null;
  async function iceAttach(warehouse) {
    if (remote) return instance.icebergAttach({ warehouse: String(warehouse) });
    await init();
    if (!capabilities.iceberg) throw new Error("Not run: DuckDB's iceberg extension isn't loaded, so nothing is written to a lakehouse's tables.");
    const name = `${ICE_PREFIX}${randomBytes(8).toString('hex')}`;
    await admin(async () => {
      if (!secretToken) throw new Error('Not run: a write to OneLake needs a sign-in.');
      if (iceSecretToken !== secretToken) {
        const p = await conn.prepare('CREATE OR REPLACE SECRET onelake_iceberg (TYPE iceberg, TOKEN ?)');
        p.bindVarchar(1, secretToken);
        await p.run();
        iceSecretToken = secretToken;
      }
      await conn.run(`ATTACH ${sqlStr(warehouse)} AS ${quoteIdent(name)} (TYPE iceberg, URI ${sqlStr(ICEBERG_URI)}, SECRET onelake_iceberg,
        ACCESS_DELEGATION_MODE 'none', STAGE_CREATE_TABLES false, SKIP_CREATE_TABLE_METADATA_UPDATES true, DEFAULT_SCHEMA 'dbo')`);
      iceAttached.add(name);
    });
    return name;
  }
  async function iceDetach(name) {
    if (remote) return instance.icebergDetach({ name: String(name) });
    if (!iceAttached.delete(String(name))) return false;
    await admin(() => conn.run(`DETACH ${quoteIdent(name)}`));
    return true;
  }

  // A Delta table is written by DuckDB's delta extension, attached by its folder for that one statement, the same
  // way: a name of its own, detached after. The attach is the table, and its name is the table's in the statement.
  // Its rows' files are written with the storage secret, and its commit to _delta_log by the extension's own
  // storage client, with the same secret's token.
  const deltaAttached = new Set();
  async function deltaAttach(folder) {
    if (remote) return instance.deltaAttach({ folder: String(folder) });
    await init();
    if (!capabilities.delta) throw new Error("Not run: DuckDB's delta extension isn't loaded, so nothing is written to a Delta table.");
    if (!isOneLakeTable(folder)) throw new Error(`Not run: ${String(folder).slice(0, 120)} is not a OneLake table's folder.`);
    const name = `${DELTA_PREFIX}${randomBytes(8).toString('hex')}`;
    await admin(async () => {
      if (!secretToken) throw new Error('Not run: a write to OneLake needs a sign-in.');
      await conn.run(`ATTACH ${sqlStr(folder)} AS ${quoteIdent(name)} (TYPE delta)`);
      deltaAttached.add(name);
    });
    return name;
  }
  async function deltaDetach(name) {
    if (remote) return instance.deltaDetach({ name: String(name) });
    if (!deltaAttached.delete(String(name))) return false;
    await admin(() => conn.run(`DETACH ${quoteIdent(name)}`));
    return true;
  }

  // DuckDB's plan of a statement, bound where it runs (the server, on the shared engine), as checkPlan reads it.
  async function planOf(statement, owner) {
    const r = await withConn(c => c.runAndReadAll(`SELECT json_serialize_plan(${sqlStr(statement)}) AS plan`), owner);
    const { plan } = r.getRowObjectsJson()[0];
    return typeof plan === 'string' ? JSON.parse(plan) : plan;
  }

  // DuckDB's physical plan of a statement, EXPLAIN (FORMAT json), parsed: what it will run, which runs nothing.
  async function physicalOf(statement, owner) {
    const r = await withConn(c => c.runAndReadAll(`EXPLAIN (FORMAT json) ${statement}`), owner);
    const row = r.getRowObjectsJson()[0] || {};
    const text = row.explain_value != null ? row.explain_value : Object.values(row).pop();
    return JSON.parse(String(text));
  }

  // The Delta table a write goes to, by its folder, or null for one written through the Iceberg catalog: an Iceberg
  // table, or a new one made as Iceberg. A Delta table's Iceberg face in OneLake is read only, so it is written by
  // the delta extension instead, which adds rows only: anything else to it is refused here, a DROP included.
  // What the store holds says it first. A Delta table is asked of OneLake again: one dropped and made again as
  // Iceberg has a Delta log beside it that is OneLake's conversion, which is never to be written.
  async function deltaTarget(w) {
    const ref = { kind: 'lakehouse', ...w.ref };
    let r = null;
    try {
      r = await resolveTable(ref, {});
      if (r && r.deltaTable) r = await resolveTable(ref, { fresh: true });
    } catch (e) {
      // Not there: a CREATE makes it, as Iceberg; a DROP is DuckDB's to answer, or IF EXISTS does nothing.
      if (w.what === 'create table' || w.what === 'drop table') return null;
      throw e;
    }
    if (!r || !r.deltaTable) return null;
    const name = sqlName(r);
    if (w.what === 'drop table') notRunError(`${name} is a Delta table, and DuckDB can't drop one`);
    if (w.what === 'create table') notRunError(`${name} is already there, as a Delta table`);
    if (w.what !== 'insert') notRunError(`${name} is a Delta table, and DuckDB's only write to a Delta table is INSERT`);
    return { folder: r.deltaTable };
  }
  const notRunError = why => { throw new Error(`Not run: ${why}.`); };

  /**
   * One statement that writes (sql.js writeOf), run: refused unless DuckDB's own plan of it writes what its text
   * says, where it says. Never sent twice: a failure is said, not tried again. `emit` streams its answer in batches.
   */
  async function runWrite(sql, { owner, begin = () => {}, signal, emit = null }) {
    // A new table's Parquet, as Direct Lake reads it best, with nothing asked of whoever wrote it (sql.js TABLE_PROPERTIES).
    sql = withTableProperties(sql);
    const w = writeOf(sql);
    // The Writes settings (onelakeStudio.allowTableWrites, allowDropTable, allowCopyToFiles): nothing is sent while the
    // one a statement needs is off, whoever sends it. A COPY to Files/ needs only its own; a DROP TABLE needs both of
    // the tables' ones.
    if (w.target === 'file' ? !copyAllowed() : !tableWritesAllowed()) {
      throw Object.assign(new Error(w.target === 'file'
        ? "Not run: COPY to Files/ is off. Turn on Allow Copy to Files in OneLake Studio's settings."
        : "Not run: writing to a lakehouse's tables is off. Turn on Allow Table Writes in OneLake Studio's settings."), { writesOff: true });
    }
    if (w.what === 'drop table' && !dropAllowed()) {
      throw Object.assign(new Error("Not run: DROP TABLE is off. Turn on Allow Drop Table in OneLake Studio's settings."), { writesOff: true });
    }
    const why = offlineReason();
    if (why) {
      throw Object.assign(new Error(`Not run: a write needs OneLake, and ${why === 'no internet' ? 'there is no internet' : 'you are not signed in'}.`), { offline: true });
    }
    if (!resolveLakehouse) throw new Error('Not run: this engine writes to no lakehouse.');
    // The token first: the write's catalog is attached with it.
    await ensureAuth();
    const lh = await resolveLakehouse({ workspace: w.ref.workspace, item: w.ref.item, name: sql.slice(w.start, w.end) });
    let attached = null, delta = null, sent = false;
    const place = text => sql.slice(0, w.start) + text + sql.slice(w.end);
    try {
      let statement, expect;
      if (w.target === 'file') {
        const url = abfssUrl(lh.workspace, `${lh.item}/Files`) + w.ref.path.slice('/Files'.length);
        statement = place(sqlStr(url));
        expect = { plan: w.plan, file: url };
      } else {
        const target = w.target === 'table' ? await deltaTarget(w) : null;
        const folder = target && target.folder;
        await allowStorage([...(lh.scopes || []), ...(folder ? [scopeOfUrl(folder)] : [])]);
        if (folder) {
          delta = await deltaAttach(folder);
          // The table is the attached folder's own, as the delta extension names it: <alias>.main.<alias>.
          statement = place([delta, 'main', delta].map(quoteIdent).join('.'));
          expect = { plan: w.plan, catalog: delta };
        } else {
          attached = await iceAttach(lh.warehouse);
          statement = place([attached, w.ref.schema, ...(w.target === 'table' ? [w.ref.table] : [])].map(quoteIdent).join('.'));
          expect = { plan: w.plan, catalog: attached };
        }
      }
      const never = () => false;
      const res = await withAuthRetry(() => withTables(statement, async run => {
        // DuckDB's bound plan; an UPDATE, DELETE or MERGE on an Iceberg table has none it can write as JSON, and is
        // held to its physical plan instead (sql.js checkPhysical).
        const bound = await planOf(run, owner);
        try { checkPlan(bound, expect); }
        catch (e) {
          if (!isUnserialized(e) || !['update', 'delete', 'merge'].includes(w.what)) throw e;
          checkPhysical(await physicalOf(run, owner), w.what);
        }
        begin();
        sent = true;
        if (!emit) return runAll(run, owner);
        return { done: true, numRows: await withConn(c => runStreaming(c, run, emit), owner) };
      }, never, { signal }), never);
      return res;
    } finally {
      if (attached) await iceDetach(attached).catch(e => onWarn(`a write's Iceberg catalog was not detached — ${e.message}`));
      if (delta) await deltaDetach(delta).catch(e => onWarn(`a write's Delta table was not detached — ${e.message}`));
      // What it wrote, read again: the listing, and a table's new snapshot into the lake, so the next read is of it.
      // Waited for, so a SELECT right after reads what was written; once it was sent, whatever happened: a statement
      // that failed may still have committed.
      if (sent) await written(w, lh);
    }
  }
  async function written(w, lh) {
    const item = { workspace: lh.workspace, item: lh.item };
    if (w.target === 'file') {
      const dir = w.ref.path.replace(/^\/Files\/?/, '').split('/').slice(0, -1).join('/');
      try { onWritten({ kind: 'files', ...item, dir }); } catch (_) {}
      return;
    }
    try { onWritten({ kind: 'tables', ...item }); } catch (_) {}
    if (w.target === 'table') {
      // The view a statement made of the table reads its old snapshot: made again on its next read.
      made.delete(sqlName({ kind: 'lakehouse', ...w.ref }).toLowerCase());
      // A dropped table has nothing to read again: the listing above no longer has it.
      if (w.what === 'drop table') return;
      await sourceOf({ kind: 'lakehouse', ...w.ref }, { fresh: true })
        .catch(e => onWarn(`${w.ref.workspace}.${w.ref.item}.${w.ref.schema}.${w.ref.table} was written, and its new snapshot isn't read yet — ${e.message}`));
    }
  }

  // Every statement, streamed chunk by chunk off its own connection. `onBatch` gets one
  // batch per ~BATCH_ROWS rows: the columns (DuckDB's own type names) on every batch, and
  // rows as plain JSON-safe objects.
  //
  // Past maxRows the chunks are only COUNTED — sent as row-less batches carrying numRows —
  // so the page still learns the true total without the host converting, holding or
  // posting rows nobody will see. streamAndRead() used to keep every chunk it had read,
  // which made `SELECT *` on a big table an out-of-memory in the shared extension host.
  async function runStreaming(c, sql, onBatch) {
    const result = await c.stream(sql);
    const names = result.deduplicatedColumnNames();
    const fields = names.map((n, i) => ({ name: n, type: String(result.columnType(i)) }));
    let rows = [], kept = 0, counted = 0, total = 0;
    const flush = () => {
      if (!rows.length && !counted) return;
      onBatch({ fields, rows, numRows: rows.length + counted });
      rows = []; counted = 0;
    };
    let sentAny = false;
    for (;;) {
      const chunk = await result.fetchChunk();
      if (!chunk || chunk.rowCount === 0) break;
      const n = chunk.rowCount;
      total += n;
      const room = Math.max(0, maxRows - kept);
      if (room > 0) {
        const objs = chunk.getRowObjects(names);
        const take = Math.min(room, n);
        for (let i = 0; i < take; i++) {
          const o = objs[i];
          for (const k of names) o[k] = jsonSafe(o[k]);
          rows.push(o);
        }
        kept += take;
        counted += n - take;
      } else {
        counted += n;
      }
      if (rows.length + counted >= BATCH_ROWS) { flush(); sentAny = true; }
    }
    if (rows.length || counted) { flush(); sentAny = true; }
    // An empty result must still yield one batch — data.js reads the schema off the first.
    if (!sentAny) onBatch({ fields, rows: [], numRows: 0 });
    return total;
  }

  async function runAll(sql, owner) {
    const batches = [];
    await withConn(c => runStreaming(c, sql, b => batches.push(b)), owner);
    if (batches.length === 1) return batches[0];
    return {
      fields: batches[0].fields,
      rows: batches.flatMap(b => b.rows),
      numRows: batches.reduce((n, b) => n + b.numRows, 0),
    };
  }

  // What the page may call, and nothing else. call() appends `emit` after the caller's
  // arguments; only stream() reads it. `owner` is whose connections these are: a tab's Stop
  // reaches that tab's statements and no other's.
  const methodsOf = owner => {
    // A statement has no connection to interrupt until it is prepared, which can mean minutes on
    // the Iceberg catalog. A Stop in that time answers it at once, and it never runs. `begin` is
    // where it would start to, and each try passes through it: one going again after a failure too.
    // `signal` goes with it all the way: a table being read through the table read API, before a try or
    // between two, stops being waited for.
    let stops = 0;
    const preparing = new Set();
    const aborts = new Set();
    const stopped = () => Object.assign(new Error('INTERRUPT Error: Interrupted!'), { cancelled: true });
    const stoppable = go => new Promise((resolve, reject) => {
      const at = stops;
      const ac = new AbortController();
      preparing.add(reject);
      aborts.add(ac);
      const begin = () => {
        if (stops !== at) throw stopped();
        preparing.delete(reject);
      };
      go(begin, ac.signal).then(resolve, reject).finally(() => { preparing.delete(reject); aborts.delete(ac); });
    });
    // A statement of this tab's, in batches. Run again only before its first batch: a late failure
    // comes after batches went out, and running it again would deliver them twice.
    async function streamed(statement, emit, begin, signal) {
      let sent = false, asOf = null;
      const canRetry = () => !sent;
      const numRows = await withAuthRetry(() => withTables(statement, run => {
        begin();
        return withConn(c => runStreaming(c, run, b => { sent = true; emit(b); }), owner);
      }, canRetry, { seen: at => { asOf = at; }, signal }), canRetry);
      return { done: true, numRows, asOf };
    }
    // This tab's USE: the schema its bare table names are in (namespaceOf), or null.
    let ns = null;
    const use = (asked, run) => stoppable(async begin => {
      await init();
      const next = await namespaceOf(asked);
      begin();
      ns = next;
      return run(useAnswer(next));
    });
    // A write, its bare names under this tab's USE first.
    const write = (sql, o) => {
      if (!ns) writeOf(sql);
      return stoppable(async (begin, signal) => {
        await init();
        const run = await namespaced(sql, ns, owner, { write: true });
        writeOf(run);
        return runWrite(run, { owner, begin, signal, ...o });
      });
    };
    // What this tab made, the only things it may take away.
    const views = new Set(), attached = new Set();
    async function release({ views: goingViews = [], attached: goingAttached = [] } = {}) {
      const drop = async (kept, name, statement) => {
        if (!kept.delete(String(name))) return;
        await withConn(c => c.run(statement), owner).catch(() => {});
      };
      for (const v of goingViews) await drop(views, v, `DROP VIEW IF EXISTS ${quoteIdent(v)};`);
      for (const a of goingAttached) {
        await drop(attached, a, `DETACH ${quoteIdent(a)};`);
        attachedFiles.delete(String(a).toLowerCase());
      }
      return true;
    }
    return {
      // The page's SQL reads, or writes to a lakehouse (runWrite). A read is checked here at once, then asked of
      // DuckDB's parser; a write is held to DuckDB's own plan of it.
      async query(sql) {
        const asked = useOf(sql);
        if (asked) return use(asked, run => runAll(run, owner));
        if (!readsOnly(sql)) return write(sql);
        assertReads(sql);
        return stoppable(async (begin, signal) => {
          await init();
          const statement = await namespaced(await checkedRead(sql, serialize), ns, owner);
          let asOf = null;
          const res = await withAuthRetry(() => withTables(statement, run => {
            begin();
            return runAll(run, owner);
          }, undefined, { seen: at => { asOf = at; }, signal }));
          return { ...res, asOf };
        });
      },

      async stream(sql, emit) {
        const asked = useOf(sql);
        if (asked) return use(asked, run => withConn(c => runStreaming(c, run, emit), owner).then(numRows => ({ done: true, numRows })));
        if (!readsOnly(sql)) return write(sql, { emit });
        assertReads(sql);
        return stoppable(async (begin, signal) => {
          await init();
          return streamed(await namespaced(await checkedRead(sql, serialize), ns, owner), emit, begin, signal);
        });
      },

      // A Files/ object as a view: `source` is one read of it. In batches, since a reader that has
      // no block structure pulls the file whole in here, and Stop must be able to kill that.
      async fileView(name, source, emit) {
        const view = String(name);
        if (!view) throw new Error('a view has a name');
        assertReads(source);
        return stoppable(async (begin, signal) => {
          await init();
          const read = await checkedRead(source, serialize, { strict: true });
          const done = await streamed(`CREATE OR REPLACE VIEW ${quoteIdent(view)} AS ${read}`, emit, begin, signal);
          views.add(view);
          return done;
        });
      },

      // A database file, read only: one in OneLake, or a copy the host made (copyToTemp).
      // Answers the name it was attached as: `alias`, or that with _file after it, as many times as it takes for the
      // name not to be a workspace's, whose tables SQL could otherwise not name (assertReachable).
      async attachFile({ path, alias, sqlite = false }) {
        const where = String(path);
        let as = String(alias);
        if (!as) throw new Error('a database has an alias');
        const workspaces = new Set(((catalogTables && await catalogTables().catch(() => [])) || []).map(t => String(t.workspace).toLowerCase()));
        while (workspaces.has(as.toLowerCase())) as = `${as}_file`;
        // OneLake's own host: the token goes with any abfss:// URL, and with no disk cache nothing else stops it.
        if (!isOneLakeTable(where) && ![...copies.values()].includes(where)) {
          throw new Error(`${where}: a database is attached from OneLake`);
        }
        return stoppable(async (begin, signal) => {
          await init();
          const statement = `ATTACH ${sqlStr(where)} AS ${quoteIdent(as)} (${sqlite ? 'TYPE sqlite, ' : ''}READ_ONLY)`;
          await withAuthRetry(() => withTables(statement, run => {
            begin();
            return runAll(run, owner);
          }, undefined, { signal }));
          attached.add(as);
          attachedFiles.add(as.toLowerCase());
          return as;
        });
      },

      async releaseFiles(what) {
        if (!instance) return true;
        return release(what || {});
      },
      // The tab is closing: whatever it made goes with it.
      releaseAll: () => (instance ? release({ views: [...views], attached: [...attached] }) : Promise.resolve(true)),

      async cancel() {
        stops++;
        for (const reject of preparing) reject(stopped());
        preparing.clear();
        for (const ac of aborts) ac.abort(stopped());
        aborts.clear();
        // A native interrupt. Only the PAGE's queries are interrupted: a secret being
        // issued on the host's own connection is left to finish.
        for (const c of owner) { interrupted.add(c); try { c.interrupt(); } catch (_) {} }
        return true;
      },

      // Which optional formats this session has — the page greys out what it cannot read.
      async info() { await init(); return { capabilities: { ...capabilities } }; },
    };
  };
  const methods = methodsOf(live);

  async function callOn(table, method, args = [], emit = () => {}) {
    // hasOwn, not a bare lookup: 'constructor' and friends resolve on any object literal,
    // and the method name arrives from the webview. Same for args — spread throws on
    // anything that is not an array, with a worse message than this one.
    if (!Object.hasOwn(table, method)) throw new Error(`unknown engine method: ${method}`);
    if (!Array.isArray(args)) throw new Error(`engine method ${method}: args must be an array`);
    const token = authToken;
    try { return await table[method](...args, emit); }
    catch (e) { throw scrub(e, authToken || token); }
  }
  const call = (method, args, emit) => callOn(methods, method, args, emit);

  // One tab's view of this engine: the same engine, with a Stop of its own.
  const tabs = new Set();
  function forTab() {
    const mine = new Set();
    tabs.add(mine);
    const table = methodsOf(mine);
    return {
      ...api,
      call: (method, args, emit) => callOn(table, method, args, emit),
      dispose() {
        tabs.delete(mine);
        return table.releaseAll().catch(() => {});
      },
    };
  }
  const running = () => [...live, ...agentLive, ...[...tabs].flatMap(t => [...t])];

  // What the Performance tab shows, as it is now (performance.js). Nothing is kept. Not a page method.
  async function stats() {
    await init();
    // The server answers, on its own connections: over Quack this would fill the log it reads.
    if (remote) return instance.stats();
    const read = sql => withConn(async c => (await c.runAndReadAll(sql)).getRowObjectsJson(), agentLive);
    const [[limits], [used]] = await Promise.all([
      read(`SELECT current_setting('memory_limit') AS memory_limit, current_setting('threads') AS threads`),
      read(`SELECT coalesce(sum(memory_usage_bytes), 0)::BIGINT AS bytes FROM duckdb_memory()`),
    ]);
    const u = process.cpuUsage();
    return { pid: process.pid, cpuUs: u.user + u.system, memoryBytes: Number(used.bytes),
             memoryLimit: limits.memory_limit, threads: limits.threads };
  }

  // serve: DuckDB's log since `sinceUs` (enginelog.js moves it to the log file), and its emptying.
  const readLog = sinceUs => withConn(async c => (await c.runAndReadAll(
    `SELECT epoch_us(timestamp) AS us, message FROM duckdb_logs WHERE type = 'Quack' AND epoch_us(timestamp) > ${BigInt(sinceUs)} ORDER BY timestamp`)).getRowObjectsJson(), agentLive);
  const emptyLog = () => withConn(c => c.run('CALL truncate_duckdb_logs();'), agentLive);
  // serve: Quack listening again, on the same port, with its listener gone or going.
  const relisten = () => admin(() => restartListener(conn, served, serve.token));
  // What the table service holds and has done: for Performance, and the tests.
  const lakeStats = () => init().then(() => (remote ? instance.lakeStats() : lakeService ? lakeService.stats() : null));
  // The sync service's (syncworker.js): the lake's tables, and one synced now.
  const lakeTables = () => init().then(() => (remote ? instance.lakeTables() : capabilities.lake ? lakeTablesHere() : []));
  // On this window's token, as a statement is: the server's secret may hold one that expired since its last statement.
  const syncLakeTable = which => init().then(() => withAuthRetry(() => (remote ? instance.lakeSync(which) : lakeSync(which))));
  // serve: the OneLake token a window sends, over the control pipe.
  // With it, the OneLake places that window reads: a server started since has none of them.
  const setStorageToken = (token, scopes = []) => init().then(() => admin(() => {
    for (const s of scopes) if (scopeOfUrl(s) === s) storageScopes.add(s);
    return issueSecret(token);
  }));
  const allowStorageHere = scopes => init().then(() => allowStorage(scopes));
  // What the Logs tab shows.
  const logs = limit => init().then(() => (remote ? instance.logs(limit) : []));
  const clearLogs = () => init().then(() => (remote ? instance.clearLogs() : undefined));

  // serve: once Quack is listening, what a window needs to know of this engine.
  async function boot() {
    await init();
    return { uri: served, tmpDir: tmpDir.replace(/\\/g, '/'), capabilities: { ...capabilities } };
  }

  // The command line's query (agent.js): the same engine as the page's, on connections the
  // page's Stop does not reach. It reads, or writes to a lakehouse as a tab does (runWrite); the page's setup
  // statements are the page's. Not a page method. `signal`: the command line went away, so its query
  // stops (only its own: another agent's goes on). `mark` goes in front of what runs, for Logs to show.
  // `namespace` holds the USE of the statements it runs in turn, { value }, as a tab's does.
  async function agentQuery(sql, { signal, fresh = false, used = true, mark = '', namespace = null } = {}) {
    const token = authToken;
    const mine = new Set();
    const owner = {
      add(c) { agentLive.add(c); mine.add(c); },
      delete(c) { agentLive.delete(c); mine.delete(c); },
    };
    const stop = () => { for (const c of mine) { try { c.interrupt(); } catch (_) {} } };
    if (signal) signal.addEventListener('abort', stop, { once: true });
    try {
      const asked = useOf(sql);
      if (asked) {
        await init();
        const next = await namespaceOf(asked);
        if (namespace) namespace.value = next;
        return await runAll(useAnswer(next), owner);
      }
      const ns = namespace ? namespace.value : null;
      if (!readsOnly(sql)) {
        if (!ns) writeOf(sql);
        await init();
        if (signal && signal.aborted) throw new Error('nobody is waiting for this any more');
        const run = await namespaced(sql, ns, owner, { write: true });
        writeOf(run);
        return await runWrite(run, { owner });
      }
      assertReads(sql);
      await init();
      const statement = mark + await namespaced(await checkedRead(sql, serialize), ns, owner);
      let asOf = null;
      const res = await withAuthRetry(() => withTables(statement, run => {
        if (signal && signal.aborted) throw new Error('nobody is waiting for this any more');
        return runAll(run, owner);
      }, undefined, { fresh, used, seen: at => { asOf = at; }, signal }));
      return { ...res, asOf };
    } catch (e) { throw scrub(e, authToken || token); }
    finally {
      if (signal) signal.removeEventListener('abort', stop);
    }
  }

  // A table kept, behind everything (syncworker.js, modeldata.js): its DuckLake table synced now, which naming it
  // with `fresh` does (sourceOf, lakeSync). Nothing of it is read: which files come here is the table service's, the
  // ones statements open, and the sync keeps a copy of every file still live. Not a page method, and nobody reading
  // it, so it doesn't count as use.
  const keepTable = (name, { signal } = {}) => agentQuery(`DESCRIBE ${name}`, { signal, fresh: true, used: false, mark: KEEP_MARK });

  // Every file of a lake table brought here whole by the table service, where the lake is: this process, or the
  // shared server. `lakeStop` lets the files not started yet stay on OneLake.
  const lakeFetch = name => init().then(() => (remote ? instance.lakeFetch(name) : lakeService ? lakeService.fetchTable(name) : null));
  const lakeStop = name => init().then(() => (remote ? instance.lakeStop(name) : lakeService ? lakeService.stopTable(name) : null));
  /**
   * A table on this machine, whole (Keep offline, Download for offline): synced as keepTable does, then each of its
   * files still on OneLake downloaded. `name` is its SQL name. Answers { files, bytes, left }, or null for a table
   * with no files (nothing was ever written to it). A stop leaves what came down here.
   */
  async function keepWhole(name, { signal } = {}) {
    await keepTable(name, { signal });
    await init();
    if (!capabilities.lake) throw new Error('this engine has no lake to keep tables in');
    const [ref] = tableRefs(`SELECT * FROM ${name}`);
    if (!ref || !resolveTable) throw new Error(`${name} does not name a OneLake table`);
    const r = await resolveTable(ref, {});
    if (!r) throw new Error(`${name} does not name a OneLake table`);
    if (r.emptySql != null || (!r.deltaTable && !r.metadataLocation)) return null;
    const { name: lake } = await lakeOf({ deltaTable: r.deltaTable || null, metadataLocation: r.metadataLocation || null, check: true });
    if (!lake) throw new Error(`${name} is not in the lake yet`);
    const stop = () => { lakeStop(lake).catch(() => {}); };
    if (signal) signal.addEventListener('abort', stop, { once: true });
    try {
      const got = await lakeFetch(lake);
      if (signal && signal.aborted) throw Object.assign(new Error('stopped'), { cancelled: true });
      // Its rows are on this machine now, as a statement reading them would have said: the tree draws it so at once.
      const location = r.metadataLocation;
      if (!(got && got.left) && location && !rowsSaid.has(location)) {
        rowsSaid.add(location);
        try { onRowsRead(location); } catch (_) {}
      }
      return got;
    } finally { if (signal) signal.removeEventListener('abort', stop); }
  }

  // Whether anyone has a statement running on this server, a table being kept aside. Over the control
  // pipe: over Quack, this would be a line in Logs every few seconds. Not a page method.
  async function othersRunning() {
    await init();
    if (remote) return instance.othersRunning();
    const [{ n }] = await withConn(async c => (await c.runAndReadAll(
      `SELECT count(*)::INTEGER AS n FROM quack_active_connections()
       WHERE state = 'active' AND query LIKE '%onelake:%' AND query NOT LIKE ${sqlStr(`%${KEEP_MARK.trim()}%`)}`)).getRowObjectsJson(), agentLive);
    return n > 0;
  }

  // `stop`: on a shared engine, stop the server too, for every window. Without it this window
  // only leaves, and the server stays for the others and for a reload.
  async function close({ stop = false } = {}) {
    closed = true;
    for (const t of timers.splice(0)) clearInterval(t);
    // Whatever is running is stopped first, and waited for: closing an instance under a live query is
    // the native binding's problem to survive, and it did not always (the lake's look at what was read,
    // every second, was still on a thread of DuckDB's when the instance went: the process died with no
    // word, in CI, on Windows and on Linux). A statement that will not stop in ten seconds is left.
    for (const c of running()) { try { c.interrupt(); } catch (_) {} }
    await Promise.race([Promise.allSettled([...inFlight]), new Promise(r => { const t = setTimeout(r, 10_000); t.unref(); })]);
    // A boot still in flight finishes (or fails) before its handles are released.
    if (ready) await ready.catch(() => {});
    if (instance && instance.leave) await instance.leave({ stop }).catch(() => {});
    await adminChain.catch(() => {});
    for (const c of running()) { try { c.closeSync(); } catch (_) {} }
    live.clear();
    agentLive.clear();
    tabs.clear();
    try { if (conn) conn.closeSync(); } catch (_) {}
    try { if (instance) instance.closeSync(); } catch (_) {}
    conn = instance = null; ready = null;
    copies.clear();
    made.clear();
    listed.clear();
    authToken = null;
    if (tmpDir && !remote) await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }

  // A file the HOST fetched (a SQLite database from Files/), written into this engine's
  // temp directory — the one place the lockdown lets DuckDB open a local file — and its
  // path handed back. Not a page method: the page names a OneLake path, the host reads
  // it, and the bytes never cross the message channel. One copy per key per session.
  const copies = new Map();
  async function copyToTemp(key, bytes) {
    await init();
    if (copies.has(key)) return copies.get(key);
    if (typeof bytes === 'function') bytes = await bytes();
    const file = join(tmpDir, `copy_${tmpName()}_${String(key).replace(/[^\w.-]/g, '_').slice(-80)}`);
    await fsp.writeFile(file, bytes);
    const path = file.replace(/\\/g, '/');
    copies.set(key, path);
    return path;
  }

  // A query's whole result, every row (no page cap), written by DuckDB into the temp
  // directory, the one place the lockdown lets it write, as parquet, csv or xlsx; the path is
  // handed back and the host moves the file where the user asked. Not a page method: the host
  // builds the COPY around a statement the read-only guard has passed, so the page's own SQL
  // still cannot COPY.
  const EXPORTS = { parquet: 'FORMAT parquet', csv: 'FORMAT csv, HEADER true', xlsx: 'FORMAT xlsx, HEADER true' };
  async function exportTo(sql, format) {
    const token = authToken;
    try {
      assertReads(sql);
      if (!EXPORTS[format]) throw new Error(`no export format ${format}`);
      await init();
      if (format === 'xlsx' && !capabilities.excel) throw new Error('the excel extension is not loaded in this session');
      // Strict: it goes inside a COPY of ours, so a read that closes the parenthesis isn't one.
      const read = await checkedRead(sql, serialize, { strict: true });
      const file = join(tmpDir, `export_${tmpName()}.${format}`).replace(/\\/g, '/');
      await withAuthRetry(() => withTables(read, statement => {
        // With its comments gone: `SELECT 1; -- note` ends with no ';' to cut, inside the COPY's
        // parenthesis. The paren on a line of its own all the same.
        const run = withoutComments(statement);
        return withConn(c => c.run(`COPY (${run}\n) TO ${sqlStr(file)} (${EXPORTS[format]})`), agentLive);
      }));
      return file;
    } catch (e) { throw scrub(e, authToken || token); }
  }

  const api = { call, close, copyToTemp, exportTo, agentQuery, keepTable, othersRunning, catalogChanged, warm, maxRows, forTab, boot, stats,
                readLog, emptyLog, relisten, setStorageToken, allowStorage: allowStorageHere, lakeTable, lakeName, lakeSync: syncLakeTable, lakeTables, lakeStats, lakeFetch, lakeStop, keepWhole, logs, clearLogs,
                icebergAttach: ({ warehouse }) => iceAttach(warehouse), icebergDetach: ({ name }) => iceDetach(name),
                deltaAttach: ({ folder }) => deltaAttach(folder), deltaDetach: ({ name }) => deltaDetach(name) };
  return api;
}

// Stopping one that has already gone is fine: Quack answers that it found none.
async function restartListener(conn, uri, token) {
  await conn.run(`SELECT * FROM quack_stop(${sqlStr(uri)});`);
  await conn.run(`SELECT * FROM quack_serve(${sqlStr(uri)}, token = ${sqlStr(token)});`);
}

module.exports = { createEngineHost, KEEP_MARK, jsonSafe, sameSources, isOneLakeMetadata, isOneLakeTable, duckdbPath, restartListener, AUTH_FAILURE, READ_FAILURE, NOT_CACHED, FORBIDDEN };
