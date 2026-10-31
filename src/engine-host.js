'use strict';
// =============================================================================
// engine-host.js — real DuckDB, in the extension host
// =============================================================================
// A VS Code extension host is Node, so DuckDB runs here natively, on every core, and reads
// OneLake itself through its `iceberg` and `azure` extensions: snapshot resolution, manifest
// filtering, position and equality deletes, schema evolution and the Warehouse column mapping
// are all DuckDB's.
//
// WHAT THE PAGE MAY CALL (call(), from host.js), and nothing else:
//
//   query(sql)    the whole result: { fields: [{ name, type }], rows, numRows }
//   stream(sql)   the same, as batches of ~10k rows, then { numRows }
//   cancel()      interrupt the page's running statements
//   info()        { capabilities } — which optional formats loaded
//
// The rest is the HOST's: copyToTemp(), a file the host fetched written where the lockdown
// lets DuckDB open it, and exportTo(), a query's whole result written there. Neither takes a
// path or a location from the page. query() and stream() make the view of every table a statement
// names by its SQL name (lakehouse.ws.item.schema.table) before running it.
// =============================================================================

const { DuckDBInstance } = require('@duckdb/node-api');

// The metrics Explore's profile reads (app/explore/profile.js keeps the same list).
const PROFILE_METRICS = ['LATENCY', 'OPERATOR_TIMING', 'OPERATOR_CARDINALITY', 'OPERATOR_ROWS_SCANNED', 'OPERATOR_TYPE',
  'OPERATOR_NAME', 'EXTRA_INFO', 'CUMULATIVE_ROWS_SCANNED', 'PLANNER', 'PHYSICAL_PLANNER', 'ALL_OPTIMIZERS',
  'SYSTEM_PEAK_BUFFER_MEMORY'];
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { join } = require('node:path');
const os = require('node:os');
const { sqlStr, quoteIdent, assertReadOnly, tableRefs, catalogStatement, readsCatalog } = require('./sql');
const { SQL_KINDS, sqlName, MODEL_CATALOG, modelSqlName } = require('./names');
const { revalidate } = require('./store');


// Rows are read in chunks so a large result starts painting before it has all arrived,
// and so no single postMessage carries a whole 200k-row grid.
const BATCH_ROWS = 10_000;

// BigInt does not survive the trip to the webview: VS Code serialises panel messages as
// JSON and BigInt throws there. paths.js normalizeValue() already defines the contract
// for the app — exact when it fits in a double, a decimal string when it does not — so
// apply it here, at the boundary, rather than shipping a value that cannot be sent.
function jsonSafe(v) {
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

// This string came from the catalog (via the host's store) and is spliced into SQL, so
// only the one shape the catalog actually returns is accepted: a OneLake abfss URI ending
// in a metadata.json. Spaces are allowed — a workspace named "ANZ Retail Demo" gets name-based
// paths with them, and DuckDB reads those fine; sqlStr quotes the string either way. Line
// breaks and NULs are not.
const ONELAKE_METADATA = /^abfss:\/\/[^@/\r\n\0]+@onelake\.dfs\.fabric\.microsoft\.com\/[^\r\n\0]+\.metadata\.json$/i;
const isOneLakeMetadata = s => typeof s === 'string' && ONELAKE_METADATA.test(s);

// 25% of RAM unless told otherwise. DuckDB's own default is 80%, which is a fine answer
// for a process that owns the machine and a bad one for the extension host, which every
// other extension in the window shares.
function defaultMemoryLimit() {
  return `${Math.max(512, Math.floor(os.totalmem() / 4 / 2 ** 20))}MB`;
}

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

// The disk cache held under its budget: oldest first — cache_httpfs touches a file each time
// it serves it, so the oldest is the least recently used — down to 80%. Nothing waits for it:
// one stat per file was over a second of a boot at 14,000 files, and a file removed under a
// read is only a cache miss.
async function trimFileCache(dir, maxBytes, onWarn) {
  try {
    if (!(maxBytes > 0)) return;
    const files = [];
    for (const name of await fsp.readdir(dir)) {
      try {
        const st = await fsp.stat(join(dir, name));
        if (st.isFile()) files.push({ p: join(dir, name), bytes: st.size, at: st.mtimeMs });
      } catch (_) {}
    }
    let total = files.reduce((n, f) => n + f.bytes, 0);
    if (total <= maxBytes) return;
    files.sort((a, b) => a.at - b.at);
    for (const f of files) {
      if (total <= maxBytes * 0.8) break;
      await fsp.rm(f.p, { force: true }).catch(() => {});
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
// `catalogTables` lists, from the host's cache alone, every table it knows: { kind, workspace,
// item, schema, table } with { columns: [{ name, type }] } (DuckDB types) or { emptySql } — and
// every semantic model, { kind: 'semanticmodel', workspace, model }.
// Each becomes a view DuckDB lists (syncCatalog), so SHOW ALL TABLES and information_schema see
// what the tree has seen without a single request to OneLake.
//
// `checkConnectivity` asks whether the internet is still there, once a read has failed. `onRowsRead`
// gets a table's metadata location when a statement has read its rows.
//
// The shared engine (onelakeStudio.sharedEngine) splits this in two. `serve: { token }` is the
// server's side (engine-server.js): the boot below, then Quack listening with that token. `remote`
// is a window's (engine-client.js): a function that joins the server and answers something shaped
// like an instance, so a window boots nothing and keeps everything from sourcesOf down.
function createEngineHost({ extensionDir, onLog = () => {}, onCatalog = () => {}, onWarn = () => {}, getToken = null,
                            memoryLimit = '', threads = 0, spillMaxGB = 0, maxRows = DEFAULT_MAX_ROWS,
                            allowedPaths = [], lockdown = true,
                            httpProxy = '', bundledExtensions = null,
                            fileCacheDir = null, fileCacheMaxBytes = 0, resolveTable = null,
                            catalogTables = null, offlineReason = () => null, checkConnectivity = null,
                            onRowsRead = () => {}, serve = null, remote = null } = {}) {
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

  // The token the storage secret was built from. A DuckDB secret holds its token BY
  // VALUE, so when VS Code hands back a different one the secret is reissued.
  let authToken = null;

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
  async function withConn(fn, owner = live) {
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
  }

  let tmpSeq = 0;
  let tmpDir = null;

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
        memory_limit: memoryLimit || defaultMemoryLimit(),
      };
      if (threads > 0) config.threads = String(threads);
      if (extensionDir) config.extension_directory = extensionDir;
      // The disk cache (cache_httpfs) ships in the vsix as our own build of it, with the
      // Windows fix that is not released upstream yet — and our build is not signed by
      // DuckDB. Loading it needs unsigned extensions allowed; the lockdown below then
      // refuses every LOAD, so nothing the page sends can load anything else.
      const cacheBuild = fileCacheDir && bundledExtensions && join(bundledExtensions, 'cache_httpfs.duckdb_extension');
      if (cacheBuild && fs.existsSync(cacheBuild)) config.allow_unsigned_extensions = 'true';
      if (fileCacheDir) {
        await fsp.mkdir(fileCacheDir, { recursive: true })
          .catch(e => onWarn(`could not make the disk cache's folder ${fileCacheDir} — ${e.message}`));
        trimFileCache(fileCacheDir, fileCacheMaxBytes, onWarn);
      }
      mark('temp+disk cache');
      instance = await DuckDBInstance.create(':memory:', config);
      mark('instance');
      conn = await instance.connect();
      mark('connect');
      // close() may have run while DuckDB was starting. The instance is torn down by the
      // catch below, which is the same path a failed boot takes.
      if (closed) throw new Error('the engine was closed');

      // preserve_insertion_order is left ON. Turning it off buys a little scan speed and
      // costs a preview of a CSV or a sheet that shows its rows in a scrambled order.
      //
      // The editor's proxy, before anything is downloaded.
      const proxy = proxySettings(httpProxy);
      if (proxy) {
        await conn.run(`SET http_proxy = ${sqlStr(proxy.host)};`);
        if (proxy.user) await conn.run(`SET http_proxy_username = ${sqlStr(proxy.user)};`);
        if (proxy.password) await conn.run(`SET http_proxy_password = ${sqlStr(proxy.password)};`);
      }
      //
      // REQUIRED, and treated differently from the rest: `iceberg` and `azure` are how a
      // table or a Files/ object is read at all (abfss://), and `httpfs` is the https the
      // Iceberg catalog and public URLs need. An optional extension that will not load costs one file format;
      // these three failing means the extension cannot do its job, and saying so beats
      // a later "Failed to open file" that names nothing.
      for (const ext of ['iceberg', 'azure', 'httpfs']) await load(ext, '', true);
      for (const ext of ['avro', 'excel', 'sqlite_scanner']) await load(ext, '');
      for (const ext of ['h3', 'zipfs']) await load(ext, 'community');
      if (fileCacheDir) await enableFileCache(fileCacheDir);
      mark('extensions');
      // azure has an HTTP client of its own, with its own proxy settings.
      if (proxy) {
        try {
          await conn.run(`SET azure_http_proxy = ${sqlStr(proxy.host)};`);
          if (proxy.user) await conn.run(`SET azure_proxy_user_name = ${sqlStr(proxy.user)};`);
          if (proxy.password) await conn.run(`SET azure_proxy_password = ${sqlStr(proxy.password)};`);
        } catch (e) { onWarn(`could not hand the proxy to DuckDB's azure extension — ${e.message}`); }
      }

      // An :memory: database has no spill path unless one is named, so a query bigger
      // than RAM was an extension-host OOM — and this process is shared with every other
      // extension. The temp dir is this session's own and is deleted on close.
      const tmp = tmpDir.replace(/\\/g, '/');
      await conn.run(`SET temp_directory = ${sqlStr(tmp)};`);
      if (spillMaxGB > 0) await conn.run(`SET max_temp_directory_size = ${sqlStr(`${spillMaxGB}GB`)};`);

      // One catalog per kind of item, for the tables' SQL names (lakehouse.ws.item.schema.t):
      // the workspace, item and schema are nested schemas in it, made as a statement names
      // them (withTables). Before the lockdown, which leaves nothing to attach with.
      for (const k of SQL_KINDS) await conn.run(`ATTACH ':memory:' AS ${quoteIdent(k)};`);
      // And one for semantic models (semanticmodel.ws.model): listed there (listCatalog), and
      // queried through the page's semantic step, which compiles them before DuckDB sees them.
      await conn.run(`ATTACH ':memory:' AS ${quoteIdent(MODEL_CATALOG)};`);

      // Parquet footers, kept between queries: a Data tab, a Preview and the user's own
      // SELECT over one table each re-read every footer otherwise. Entries are checked
      // against the file's last-modified time, so a Files/ parquet rewritten in place is
      // read again. Set before the lockdown, which freezes the configuration.
      try { await conn.run('SET parquet_metadata_cache = true;'); }
      catch (e) { onWarn(`could not enable DuckDB's parquet metadata cache — ${e.message}`); }

      // The bytes DuckDB reads from OneLake (data files, manifests) are kept in memory by
      // its external file cache, and dropped when memory runs short. Spilled instead, to
      // this session's temp directory: a block evicted is read back from local disk rather
      // than fetched from OneLake again. This is the in-session layer; the disk cache
      // (cache_httpfs, enableFileCache below) is the one that outlives the process.
      try { await conn.run('SET external_file_cache_spill = true;'); }
      catch (e) { onWarn(`could not let DuckDB's file cache spill to disk — ${e.message}`); }

      // What Explore's Show plan measures (app/explore/profile.js, PROFILE_METRICS): set
      // here, for every connection, because the lockdown below freezes the configuration and
      // the page's EXPLAIN (ANALYZE, FORMAT json) cannot set it itself.
      try { await conn.run(`SET GLOBAL custom_profiling_settings = ${sqlStr(JSON.stringify(Object.fromEntries(PROFILE_METRICS.map(m => [m, 'true']))))};`); }
      catch (e) { onWarn(`could not set the profile's metrics — ${e.message}`); }

      // The shared engine's server. Loading cache_httpfs turns DuckDB's external file cache off, so
      // it is turned back on here: the blocks every client reads stay in this process's memory,
      // over the disk cache. Quack starts before the lockdown, which leaves nothing to start with.
      if (serve) {
        await load('quack', '', true);
        await conn.run('SET enable_external_file_cache = true;');
        // A window's own guard (assertReadOnly) refuses these already. This is one more wall, and
        // a text match, so not the only one: the session token is what keeps others out.
        await conn.run(`CREATE MACRO memory.main.studio_authorize(token, query) AS
          CASE WHEN regexp_matches(lower(query), 'quack_(serve|stop)') THEN NULL ELSE query END;`);
        await conn.run(`SET GLOBAL quack_authorization_function = 'studio_authorize';`);
        // Port 0: the system picks a free one. A port already taken raises no error on Windows.
        const r = await conn.runAndReadAll(`SELECT listen_uri FROM quack_serve('quack:127.0.0.1:0', token = ${sqlStr(serve.token)})`);
        served = r.getRowObjectsJson()[0].listen_uri;
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
        await conn.run(`SET ca_cert_file = ${sqlStr(ca)};`);
        // zip:// only over a remote archive: an entry of a Files/ zip is read as
        // zip://abfss://…, and a bare 'zip://' would open any local archive. Checked
        // against DuckDB 2.0: zip://abfss:// reads, zip://C:/… is refused, and a `..`
        // after abfss:// stays on the azure filesystem.
        const dirs = [`${tmp}/`, 'https://', 'abfss://', 'abfs://', 'az://', 'azure://',
                      'zip://abfss://', 'zip://https://'];
        if (extensionDir) dirs.push(`${extensionDir.replace(/\\/g, '/')}/`);
        // cache_httpfs checks each cache file against these before it reads or writes it.
        if (capabilities.fileCache) dirs.push(`${fileCacheDir.replace(/\\/g, '/')}/`);
        const paths = [ca, ...allowedPaths.filter(Boolean).map(p => String(p).replace(/\\/g, '/'))];
        await conn.run(`SET allowed_directories = [${dirs.map(sqlStr).join(', ')}];`);
        await conn.run(`SET allowed_paths = [${paths.map(sqlStr).join(', ')}];`);
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
    iceberg: false, azure: false, cache_httpfs: false, fileCache: false, quack: false,
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
      const shipped = bundledExtensions && join(bundledExtensions, `${ext}.duckdb_extension`);
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

  // The bytes DuckDB reads from OneLake — data files, manifests, metadata.json — kept on
  // disk across sessions by cache_httpfs, around the azure filesystem: read once, read from
  // here after, restart or not. An Iceberg table's files are never rewritten under the same
  // name, but a Files/ object can be, so a kept copy is validated before it is served.
  // Optional: without it, reads go to OneLake as they always did.
  async function enableFileCache(dir) {
    await load('cache_httpfs', 'community');
    if (!capabilities.cache_httpfs) return;
    try {
      await conn.run(`SET cache_httpfs_type = 'on_disk';`);
      await conn.run(`SET cache_httpfs_cache_directory = ${sqlStr(dir.replace(/\\/g, '/'))};`);
      // Its default spawns a private thread pool per read, fanning one read out into up to
      // 1000 threads. In the extension host a cold full-table scan crashed the process that
      // way (a terminate inside cache_httpfs). DuckDB's own scheduler and a bounded fan-out
      // keep its parallelism inside DuckDB's.
      await conn.run(`SET cache_httpfs_parallel_read_mode = 'duckdb_task_scheduler';`);
      await conn.run('SET cache_httpfs_max_fanout_subrequest = 16;');
      // A Files/ object can be rewritten in place, so what is kept is checked against the
      // file's version tag and modification time before it is served. Before the wrap: a
      // build without this setting fails here, with nothing cached, not serving stale files.
      await conn.run('SET cache_httpfs_enable_cache_validation = true;');
      for (const name of ['AzureDfsStorageFileSystem', 'AzureBlobStorageFileSystem']) {
        // Released builds run a constant call twice and throw on the second although the
        // wrap worked: what is registered afterwards is the answer, not the error.
        try { await conn.run(`SELECT cache_httpfs_wrap_cache_filesystem(${sqlStr(name)});`); } catch (_) {}
      }
      const r = await conn.runAndReadAll(`SELECT count(*)::INTEGER AS n FROM cache_httpfs_list_registered_filesystems()
        WHERE registered_filesystems = 'cache_httpfs_AzureDfsStorageFileSystem'`);
      capabilities.fileCache = r.getRowObjects()[0].n === 1;
      if (!capabilities.fileCache) onWarn('cache_httpfs could not wrap the azure filesystem — OneLake reads are not cached on disk');
    } catch (e) {
      onWarn(`disk cache unavailable — ${e.message}`);
    }
    if (!capabilities.fileCache) return;
    // Any call starts keeping what opening a file answers, which an offline open needs. A build
    // without this function reads nothing offline, and refuseOffline says so.
    try {
      await conn.run('SELECT cache_httpfs_set_offline(false);');
      servingOffline = false;
      capabilities.offlineRead = true;
    } catch (e) {
      onWarn(`reading kept data offline is unavailable — ${e.message}`);
    }
  }

  // The disk cache serves what it keeps with no call to OneLake while this window is offline. A
  // function, since the lockdown freezes the settings.
  let servingOffline = false;
  async function syncOffline() {
    if (!capabilities.offlineRead || servingOffline === !!offlineReason()) return;
    await admin(async () => {
      const now = !!offlineReason();
      if (servingOffline === now) return;
      await conn.run(`SELECT cache_httpfs_set_offline(${now});`);
      servingOffline = now;
    });
  }

  // ---------------------------------------------------------------------------
  // OneLake, spoken by DuckDB itself
  // ---------------------------------------------------------------------------
  // DuckDB reads OneLake with one azure secret holding the VS Code token: tables with
  // iceberg_scan on their metadata file, Files/ objects by their abfss:// names. No
  // catalog is ever asked at query time — the host's store already holds each table's
  // metadata location.

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
      await conn.run(
        `CREATE OR REPLACE SECRET onelake_storage (
           TYPE azure, PROVIDER access_token, ACCESS_TOKEN ${sqlStr(token)})`);
      authToken = token;
    });
    return token;
  }

  // A token that expired mid-session shows up as a storage failure, never as
  // anything structured, so it is recognised by text. Retried ONCE and only after the
  // token actually changed — a 403 is a permission answer and a fresh token will not
  // change its mind, which is the same bargain catalog.js makes.
  const AUTH_FAILURE = /AuthenticationFailed|401|Unauthorized|token.*expired|ExpiredAuthenticationToken/i;

  async function withAuthRetry(run, canRetry = () => true) {
    await ensureAuth();
    try {
      return await run();
    } catch (e) {
      if (!AUTH_FAILURE.test(String(e && e.message)) || !canRetry()) throw e;
      const stale = authToken;
      const fresh = await ensureAuth(true);   // PAST the caller's token cache
      if (!fresh || fresh === stale) throw e;  // same token, same answer — do not loop
      return run();
    }
  }

  // A table, ready to be selected from by its SQL name: a view over iceberg_scan on its
  // metadata file, whose location the host's store holds (the catalog's loadTable answer,
  // cached on disk). The catalog is not asked at query time when the store has the answer —
  // it answered a loadTable in 5s, 12s and 114s on a real tenant. DuckDB applies deletes and
  // the Warehouse field-id mapping, and the snapshot is the one the Stats card showed.
  //
  // `made` is what each view reads now (by its lower-cased name, as DuckDB matches names): a
  // view is made again only when its table moved to a new snapshot.
  const made = new Map();
  // What a table reads: its view's name, where that goes, and the view's source.
  async function sourceOf(ref, o) {
    if (!resolveTable) throw new Error('this engine cannot name OneLake tables');
    const r = await resolveTable(ref, o);
    let source;
    if (r.emptySql != null) source = String(r.emptySql);
    else if (isOneLakeMetadata(r.metadataLocation)) source = `SELECT * FROM iceberg_scan(${sqlStr(r.metadataLocation)})`;
    else {
      throw new Error(`OneLake gave ${sqlName(r)} no readable metadata location` +
        (r.metadataLocation ? ` (${String(r.metadataLocation).slice(0, 120)})` : ''));
    }
    return { name: sqlName(r), path: [r.kind, r.workspace, r.item, r.schema || 'dbo'], source, location: r.emptySql == null ? r.metadataLocation : null };
  }
  async function makeView({ name, path: parts, source }) {
    const key = name.toLowerCase();
    // On a shared engine another window may have changed the view since, so what this window
    // remembers making says nothing. A statement costs little there, sent in one call.
    if (!remote && made.get(key) === source) return;
    await admin(async () => {
      if (!remote && made.get(key) === source) return;
      const path = parts.map(quoteIdent);
      const schemas = [];
      for (let k = 2; k <= path.length; k++) schemas.push(`CREATE SCHEMA IF NOT EXISTS ${path.slice(0, k).join('.')};`);
      await conn.run([...schemas, `CREATE OR REPLACE VIEW ${name} AS ${source};`].join('\n'));
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
    if (t.kind === MODEL_CATALOG) {
      return { name: modelSqlName(t.workspace, t.model), path: [t.kind, t.workspace] };
    }
    return { name: sqlName(t), path: [t.kind, t.workspace, t.item, t.schema || 'dbo'] };
  }
  function listedSource(t, name) {
    // A model has no columns to list, and is never read as a view: its one column says what
    // it is, and selecting from it says why it cannot be.
    if (t.kind === MODEL_CATALOG) {
      return `SELECT NULL::VARCHAR AS model WHERE error(${sqlStr(`${name} is a semantic model that is not open`)}) IS NULL`;
    }
    if (t.emptySql != null) return String(t.emptySql);
    const cols = (t.columns || []).map(c =>
      `CAST(NULL AS ${DUCK_TYPE.test(String(c.type)) ? c.type : 'VARCHAR'}) AS ${quoteIdent(c.name)}`);
    if (!cols.length) return null;
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
    await admin(async () => {
      const want = new Map();
      for (const t of list || []) {
        const { name, path } = placeOf(t);
        const key = name.toLowerCase();
        if (!want.has(key)) want.set(key, { t, name, path });
      }
      const todo = [];
      for (const [key, { t, name, path: parts }] of want) {
        if (made.has(key) && !listed.has(key)) continue;
        const source = listedSource(t, name);
        if (source == null || made.get(key) === source) continue;
        const path = parts.map(quoteIdent);
        const schemas = [];
        for (let k = 2; k <= path.length; k++) schemas.push(`CREATE SCHEMA IF NOT EXISTS ${path.slice(0, k).join('.')};`);
        // On a shared engine this name may be another window's real view: a listing never replaces it.
        todo.push({ key, name, source, schemas, view: `CREATE ${remote ? 'VIEW IF NOT EXISTS' : 'OR REPLACE VIEW'} ${name} AS ${source};` });
      }
      const listedAs = x => { made.set(x.key, x.source); listed.set(x.key, x.name); };
      // In one call: a call per statement cost over a second at 300 entries. Run again one by
      // one if that fails, so a bad entry costs only itself; both kinds of statement can repeat.
      try {
        if (todo.length) await conn.run([...new Set(todo.flatMap(x => x.schemas)), ...todo.map(x => x.view)].join('\n'));
        todo.forEach(listedAs);
      } catch (_) {
        for (const x of todo) {
          try {
            for (const s of x.schemas) await conn.run(s);
            await conn.run(x.view);
            listedAs(x);
          } catch (e) { onWarn(`${x.name} could not be listed in DuckDB — ${e.message}`); }
        }
      }
      for (const [key, name] of [...listed]) {
        if (want.has(key)) continue;
        if (!remote) try { await conn.run(`DROP VIEW IF EXISTS ${name};`); } catch (_) {}
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
  // A DROP (sql.js lets views, tables and schemas go) may have taken views `made` still
  // counts as there: every one is made again when next named, and the catalog listed again.
  function afterStatement(sql) {
    if (/^\s*drop\s/i.test(sql)) { made.clear(); catalogStale = true; }
  }

  // Every table a statement names by its SQL name, so a saved query, or one typed from scratch,
  // reads what it names with nothing opened first.
  async function sourcesOf(sql, o) {
    const seen = new Set();
    const out = [];
    for (const ref of tableRefs(sql, SQL_KINDS)) {
      const key = [ref.kind, ref.workspace, ref.item, ref.schema, ref.table].join('\0').toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(await sourceOf(ref, o));
    }
    return out;
  }

  // A read that fails is how DuckDB says a kept metadata location no longer holds, at the view
  // or at the statement. A statement's own mistake is a Binder or Catalog Error, which asks
  // OneLake nothing.
  const READ_FAILURE = /^\s*IO Error\b/;

  // Offline, a statement that reads OneLake is served from the disk cache. Only with no such cache
  // (turned off, or a build that can't) is it refused here, rather than left to time out.
  // A table nothing was ever written to reads no file, and needs no network.
  // A OneLake URL it reads: after FROM or JOIN, or as a function's argument. Not one that is only a
  // value, as a model's path is in what SHOW SEMANTIC VIEWS compiles to.
  const READS_ONELAKE = /(?:\b(?:from|join)\s+\(?\s*'|\b(?!values\b)\w+\s*\(\s*\[?\s*')(?:zip:\/\/)?(?:abfss?|az|azure):\/\//i;
  function refuseOffline(sql, tables) {
    const why = offlineReason();
    if (!why || capabilities.offlineRead) return;
    const reading = tables.find(t => /\biceberg_scan\(/.test(t.source));
    if (!reading && !READS_ONELAKE.test(sql)) return;
    const what = reading ? reading.name : 'This statement';
    throw Object.assign(new Error(`${what}: reading rows needs OneLake, and ${why === 'no internet' ? 'there is no internet' : 'you are not signed in'}. ` +
      'What this machine has cached still works: tables, columns, stats and first rows.'), { offline: true });
  }

  // What the disk cache says of a file, or a part of one, that it doesn't keep.
  const NOT_CACHED = /is not cached on this machine/;
  // A statement that names a table without reading its rows.
  const READS_NO_ROWS = /^(?:\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)*(?:describe|desc|explain(?!\s*(?:\(\s*)?analy[sz]e))\b/i;
  // Said once per location: every statement passes here.
  const rowsSaid = new Set();
  function rowsRead(sql, tables) {
    if (READS_NO_ROWS.test(sql)) return;
    for (const { location } of tables) {
      if (!location || rowsSaid.has(location)) continue;
      rowsSaid.add(location);
      try { onRowsRead(location); } catch (_) {}
    }
  }

  // A statement run with what it needs: the catalog when it reads the catalog, the views of the
  // tables it names — and then `run` gets the statement itself, or its whole-path twin (sql.js
  // catalogStatement). Its tables come from the cache, and are read again if it fails on them
  // (store.js revalidate). `canRetry`: false once running it again would repeat what it sent.
  async function withTables(sql, run, canRetry = () => true) {
    if (readsCatalog(sql)) await syncCatalog();
    await syncOffline();
    let named = [];
    try {
      return await revalidate(o => sourcesOf(sql, o), async tables => {
        named = tables;
        refuseOffline(sql, tables);
        for (const t of tables) await makeView(t);
        const result = await run(catalogStatement(sql) || sql);
        rowsRead(sql, tables);
        return result;
      }, e => READ_FAILURE.test(String(e && e.message)) && canRetry());
    } catch (e) {
      const message = String(e && e.message);
      if (NOT_CACHED.test(message)) {
        const what = named.filter(t => t.location);
        throw Object.assign(new Error(`${what.length === 1 ? what[0].name : 'This statement'}: this part isn't cached on this machine. Read it once online.`), { offline: true });
      }
      if (READ_FAILURE.test(message)) {
        // The internet went while this was reading, and nothing has said so yet. Run it again from
        // what is kept. The statement isn't asked twice: the retry finds this window offline.
        if (!offlineReason() && capabilities.offlineRead && checkConnectivity && canRetry()) {
          await checkConnectivity();
          if (offlineReason()) return withTables(sql, run, canRetry);
        }
        // A read the check above could not see, and the reason it failed.
        const why = offlineReason();
        if (why) { try { e.message += `\n(OneLake Studio is offline: ${why}.)`; } catch (_) {} }
      }
      throw e;
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
  const methodsOf = owner => ({
    // Both check the statement first: the page's SQL may read, never write (sql.js).
    async query(sql) {
      assertReadOnly(sql);
      await init();
      try { return await withAuthRetry(() => withTables(sql, run => runAll(run, owner))); }
      finally { afterStatement(sql); }
    },

    async stream(sql, emit) {
      assertReadOnly(sql);
      await init();
      // Run again only before its first batch: a late failure comes after batches went out,
      // and running it again would deliver them twice.
      let sent = false;
      const canRetry = () => !sent;
      try {
        const numRows = await withAuthRetry(() => withTables(sql, run =>
          withConn(c => runStreaming(c, run, b => { sent = true; emit(b); }), owner), canRetry), canRetry);
        return { done: true, numRows };
      } finally { afterStatement(sql); }
    },

    async cancel() {
      // A native interrupt. Only the PAGE's queries are interrupted: a secret being
      // issued on the host's own connection is left to finish.
      for (const c of owner) { interrupted.add(c); try { c.interrupt(); } catch (_) {} }
      return true;
    },

    // Which optional formats this session has — the page greys out what it cannot read.
    async info() { await init(); return { capabilities: { ...capabilities } }; },
  });
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
    return { ...api, call: (method, args, emit) => callOn(table, method, args, emit), dispose: () => tabs.delete(mine) };
  }
  const running = () => [...live, ...agentLive, ...[...tabs].flatMap(t => [...t])];

  // What the Performance tab shows, as it is now (performance.js). Nothing is kept. Not a page method.
  async function stats() {
    await init();
    // Marked, so another window's Running list leaves these out.
    const read = sql => withConn(async c => (await c.runAndReadAll(`/*stats*/ ${sql}`)).getRowObjectsJson(), agentLive);
    const [[settings], memory, files, [temp]] = await Promise.all([
      read(`SELECT current_setting('memory_limit') AS memory_limit, current_setting('threads') AS threads, version() AS version`),
      read(`SELECT tag, memory_usage_bytes AS bytes, temporary_storage_bytes AS spilled FROM duckdb_memory()
            WHERE memory_usage_bytes > 0 OR temporary_storage_bytes > 0 ORDER BY bytes DESC`),
      read(`SELECT path, count(*)::INT AS blocks, sum(nr_bytes)::BIGINT AS bytes,
                   (count(*) FILTER (loaded))::INT AS in_memory, (count(*) FILTER (spilled))::INT AS spilled
            FROM duckdb_external_file_cache() GROUP BY path ORDER BY bytes DESC`),
      read(`SELECT count(*)::INT AS files, coalesce(sum(size), 0)::BIGINT AS bytes FROM duckdb_temporary_files()`),
    ]);
    const u = process.cpuUsage();
    return {
      shared: !!remote, settings, memory, files, temp,
      // A window's engine has no process of its own: this is the extension host's, shared.
      process: instance.status ? await instance.status()
        : { pid: process.pid, uptimeMs: process.uptime() * 1000, cpuUs: u.user + u.system, rss: process.memoryUsage().rss },
      running: instance.running ? await instance.running() : null,
    };
  }
  // Stops a statement the Running list named, whichever window sent it.
  const stopStatement = id => (instance && instance.cancelStatement ? instance.cancelStatement(id) : Promise.resolve());

  // serve: once Quack is listening, what a window needs to know of this engine.
  async function boot() {
    await init();
    return { uri: served, tmpDir: tmpDir.replace(/\\/g, '/'), capabilities: { ...capabilities } };
  }

  // The command line's query (agent.js): the same guard and the same engine as the page's,
  // on connections the page's Stop does not reach. Not a page method. `signal`: the command
  // line went away, so its query stops (only its own: another agent's goes on).
  async function agentQuery(sql, { signal } = {}) {
    const token = authToken;
    const mine = new Set();
    const owner = {
      add(c) { agentLive.add(c); mine.add(c); },
      delete(c) { agentLive.delete(c); mine.delete(c); },
    };
    const stop = () => { for (const c of mine) { try { c.interrupt(); } catch (_) {} } };
    if (signal) signal.addEventListener('abort', stop, { once: true });
    try {
      assertReadOnly(sql);
      await init();
      return await withAuthRetry(() => withTables(sql, run => {
        if (signal && signal.aborted) throw new Error('the command line went away');
        return runAll(run, owner);
      }));
    } catch (e) { throw scrub(e, authToken || token); }
    finally {
      if (signal) signal.removeEventListener('abort', stop);
      afterStatement(sql);
    }
  }

  // `stop`: on a shared engine, stop the server too, for every window. Without it this window
  // only leaves, and the server stays for the others and for a reload.
  async function close({ stop = false } = {}) {
    closed = true;
    // Whatever is running is stopped first: closing an instance under a live query is
    // the native binding's problem to survive, and there is no reason to make it one.
    for (const c of running()) { try { c.interrupt(); } catch (_) {} }
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
    const file = join(tmpDir, `copy_${++tmpSeq}_${String(key).replace(/[^\w.-]/g, '_').slice(-80)}`);
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
      assertReadOnly(sql);
      if (!EXPORTS[format]) throw new Error(`no export format ${format}`);
      await init();
      if (format === 'xlsx' && !capabilities.excel) throw new Error('the excel extension is not loaded in this session');
      const file = join(tmpDir, `export_${++tmpSeq}.${format}`).replace(/\\/g, '/');
      await ensureAuth();
      await withAuthRetry(() => withTables(sql, statement => {
        const run = String(statement).trim().replace(/;+\s*$/, '');
        // The paren on a line of its own: a statement may end with a -- comment.
        return withConn(c => c.run(`COPY (${run}\n) TO ${sqlStr(file)} (${EXPORTS[format]})`), agentLive);
      }));
      return file;
    } catch (e) { throw scrub(e, authToken || token); }
  }

  const api = { call, close, copyToTemp, exportTo, agentQuery, catalogChanged, warm, maxRows, forTab, boot, stats, stopStatement };
  return api;
}

module.exports = { createEngineHost, jsonSafe, isOneLakeMetadata, PROFILE_METRICS };
