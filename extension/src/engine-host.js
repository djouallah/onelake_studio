'use strict';
// =============================================================================
// engine-host.js — real DuckDB, in the extension host, behind the wasm's surface
// =============================================================================
// A VS Code extension host is Node, so there is no reason to run a WebAssembly build of
// DuckDB in a webview. Measured on this machine, boot to a usable engine:
//
//                        duckdb-wasm            @duckdb/node-api
//   engine + connect     ~760ms                 17ms
//   four extensions      ~1187ms (warm)         263ms (warm)
//   engine ready         ~2000ms warm, 6.6s cold   284ms
//   threads              1                      8
//
// And the wasm numbers do not improve with caching. Chromium attaches a compiled module
// to a real HTTP cache entry; duckdb-wasm hands instantiateStreaming a SYNTHETIC Response
// built from a TransformStream (it wants progress events), which has no such entry — so
// the 35MB compile is paid on every single panel open and no proxy header can change it.
// The four extensions are four more wasm modules, compiled fresh every session.
//
// WHAT IT IMPLEMENTS. data.js's dependency on DuckDB is this surface:
//
//   conn.query / conn.send / conn.cancelSent
//   db.openTable / db.registerFileBuffer / db.dropFile / db.getVersion / db.capabilities
//
// `openTable` is the one that matters: DuckDB reads OneLake tables itself, through its
// `iceberg` and `azure` extensions, and the manifest walk data.js used to perform in the
// page is gone. The reason it could not before was that `azure` had no WASM build —
// which stopped being true the moment the engine moved into this process. What DuckDB
// does for free, and what the page used to hand-roll: snapshot resolution, manifest
// filtering, position AND equality deletes, schema evolution, and the Warehouse column
// mapping that turned a grid of GUIDs into readable names.
//
// duckdb-wasm's virtual file registry (registerFileURL and friends) is gone with it:
// native DuckDB reads a URL or a path spliced directly into the SQL, so data.js now says
// what it means instead of registering a synthetic name for the host to substitute back.
// The one shape that still needs help is a BUFFER — bytes with no URL, which the wasm
// build kept in its virtual filesystem. Those land in a temp file here, and
// registerFileBuffer answers with the path to put in the SQL; dropFile deletes it.
// =============================================================================

const { DuckDBInstance } = require('@duckdb/node-api');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { join } = require('node:path');
const os = require('node:os');
const { sqlStr, quoteIdent } = require('./sql');

const IRC_ENDPOINT = 'https://onelake.table.fabric.microsoft.com/iceberg';

// Rows are read in chunks so a large result starts painting before it has all arrived,
// and so no single postMessage carries a whole 200k-row grid. data.js already treats a
// result as a sequence of batches — that is what conn.send() gave it — so this is the
// shape it wants anyway.
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

// The most rows of one result the host turns into JS and posts to the page. data.js stops
// keeping rows at the same number; past it the host only COUNTS, so "stopped at N of M"
// still has a truthful M without M rows crossing postMessage into a shared process.
const MAX_ROWS = 200_000;

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

// The page sends this string and it is spliced into SQL, so only the one shape the
// catalog actually returns is accepted: a OneLake abfss URI ending in a metadata.json.
// Anything else falls back to the ATTACH, which never takes a path from the page.
const ONELAKE_METADATA = /^abfss:\/\/[^@/\s]+@onelake\.dfs\.fabric\.microsoft\.com\/[^\s]+\.metadata\.json$/i;
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

function createEngineHost({ extensionDir, onLog = () => {}, onWarn = () => {}, getToken = null,
                            memoryLimit = '', allowedPaths = [], lockdown = true,
                            httpProxy = '', bundledExtensions = null } = {}) {
  let instance = null;
  // The connection for the host's OWN statements — secrets, ATTACH, extension loading.
  // Page queries never run on it: each gets a connection of its own (see withConn), so a
  // cancel aimed at the page's query cannot land on an ATTACH half way through, and an
  // ATTACH cannot interleave with a stream that is still draining.
  let conn = null;
  let ready = null;
  // Set by close(), and final: a late call must not quietly rebuild a DuckDB that nobody
  // owns, holding the token of the account that was just signed out of.
  let closed = false;

  // The token the storage secret and every ATTACH were built from. Both hold a token
  // BY VALUE — a DuckDB secret is a stored string, and ATTACH copies the catalog token
  // into the attachment — so when VS Code hands back a different one, both have to be
  // reissued. The proxy never had this problem because it signed each request as it
  // went; this is the price of DuckDB talking to OneLake itself.
  let authToken = null;
  // "workspace/item" -> the alias it is ATTACHed as. Never cleared while the engine lives:
  // the page's views name the alias, so re-attaching under a NEW one after a token change
  // left every view already open pointing at an attachment that still held the old token.
  const aliases = new Map();
  // "workspace/item" -> the token its current ATTACH was made with.
  const attachedWith = new Map();
  // "workspace/item" -> the ATTACH in flight, so two opens of one lakehouse pay ~5s once.
  const attaching = new Map();
  let aliasSeq = 0;

  // The host's own statements run one at a time: CREATE SECRET racing an ATTACH that
  // reads it is not a race worth having.
  let adminChain = Promise.resolve();
  function admin(fn) {
    const run = adminChain.then(fn, fn);
    adminChain = run.catch(() => {});
    return run;
  }

  // Connections running a page query right now, so cancel() interrupts exactly those.
  const live = new Set();
  // Connections cancel() reached. Their failure is a stop, not an error, and says so with
  // a flag the page reads — DuckDB's text for it ("Interrupted!") never said "cancel".
  const interrupted = new WeakSet();
  async function withConn(fn) {
    const c = await instance.connect();
    live.add(c);
    try { return await fn(c); }
    catch (e) {
      if (interrupted.has(c) && e && typeof e === 'object') { try { e.cancelled = true; } catch (_) {} }
      throw e;
    }
    finally {
      live.delete(c);
      try { c.closeSync(); } catch (_) {}
    }
  }

  // Buffer name -> temp file on disk, so dropFile can delete it rather than leaking one
  // buffer-sized file per document opened this session.
  const temps = new Map();
  let tmpSeq = 0;
  let tmpDir = null;

  async function init() {
    if (closed) throw new Error('the engine was closed');
    if (ready) return ready;
    ready = (async () => {
      const stages = [];
      let at = Date.now();
      const mark = name => { stages.push({ stage: name, ms: Date.now() - at }); at = Date.now(); };

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
      if (extensionDir) config.extension_directory = extensionDir;
      instance = await DuckDBInstance.create(':memory:', config);
      conn = await instance.connect();
      mark('instance+connect');
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
      for (const ext of ['avro', 'excel']) await load(ext, '');
      for (const ext of ['h3', 'zipfs']) await load(ext, 'community');
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

      // Parquet footers, kept between queries: a Data tab, a Preview and the user's own
      // SELECT over one table each re-read every footer otherwise. Entries are checked
      // against the file's last-modified time, so a Files/ parquet rewritten in place is
      // read again. Set before the lockdown, which freezes the configuration.
      try { await conn.run('SET parquet_metadata_cache = true;'); }
      catch (e) { onWarn(`could not enable DuckDB's parquet metadata cache — ${e.message}`); }

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
      try { if (conn) conn.closeSync(); } catch (_) {}
      try { if (instance) instance.closeSync(); } catch (_) {}
      conn = instance = null;
      if (tmpDir) {
        const d = tmpDir;
        tmpDir = null;
        fsp.rm(d, { recursive: true, force: true }).catch(() => {});
      }
    });
    return ready;
  }

  const capabilities = {
    excel: false, zipfs: false, h3: false, avro: false, httpfs: false,
    iceberg: false, azure: false,
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
  // OneLake, spoken by DuckDB itself
  // ---------------------------------------------------------------------------
  // The recipe is the owner's, from djouallah/testing-iceberg-rest-catalog catalogs.py,
  // and every part of it is load-bearing:
  //
  //   ACCESS_DELEGATION_MODE 'none'   DuckDB defaults to 'vended_credentials', and
  //     against Fabric that FAILS every read with AuthenticationFailed. OneLake does
  //     vend a real SAS, but scoped to the GUID spelling of the path
  //     (https://onelake.dfs…/<ws-guid>/<item-guid>/Tables/…) while the metadata in the
  //     same response points at the friendly spelling
  //     (abfss://<ws>@onelake.dfs…/<item>/Tables/…). The credential matches nothing that
  //     is read. 'none' falls back to our own secret, which does match.
  //   TOKEN on the ATTACH authenticates the CATALOG API only — the storage secret below
  //     is separate and not optional.
  //   STAGE_CREATE_TABLES / SKIP_CREATE_TABLE_METADATA_UPDATES keep DuckDB from ever
  //     trying to write catalog metadata. This extension is a reader.
  //
  // Measured: ATTACH ~4.8-5.2s per item, so it is cached per item and not per table.

  // Strict: for the paths that cannot do anything useful without a credential.
  async function currentToken() {
    if (!getToken) throw new Error('the engine was created without a token source');
    const token = await getToken();
    if (!token) {
      const e = new Error('Not signed in to a Microsoft account.');
      e.status = 401;
      throw e;
    }
    return token;
  }

  // Lenient: reissues the storage secret when the token has changed, and drops the
  // attachment cache with it — an ATTACH copied the old token in, so it is stale too.
  // Returns null rather than throwing when there is no credential to be had, because
  // most statements never touch OneLake: `SELECT 42` must not need a Microsoft account,
  // and the harnesses build this engine with no token source at all.
  //
  // `fresh` reaches the token source. Without it the retry below asked the same
  // 60-second cache that had just handed out the expired token, got the identical
  // string back, and concluded — wrongly — that no better token existed.
  //
  // A changed token also re-ATTACHes every item already open, under the SAME alias: the
  // catalog token was copied into each attachment, and the views the page holds name those
  // aliases. Without this every table opened before the hourly rotation started failing
  // the moment it came — the retry only ever refreshed the storage secret.
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
    const stale = [...aliases.keys()].filter(k => attachedWith.get(k) !== token);
    // Each failure is the item's own: one lakehouse the account lost access to must not
    // stop the others from coming back, and its next open will say what is wrong.
    await Promise.all(stale.map(k => attachKey(k).catch(e =>
      onWarn(`re-attach of ${k} after token change failed — ${scrub(e, token).message}`))));
    return token;
  }

  // Single-flight per item, and keyed to the token: an attachment made with the current
  // token is reused, one made with an older token is replaced in place.
  function attachKey(key) {
    if (aliases.has(key) && attachedWith.get(key) === authToken) return Promise.resolve(aliases.get(key));
    const inflight = attaching.get(key);
    if (inflight && inflight.token === authToken) return inflight.promise;
    const token = authToken;
    if (!aliases.has(key)) aliases.set(key, `ol_${++aliasSeq}`);
    const alias = aliases.get(key);
    const promise = admin(() => conn.run(
      `ATTACH OR REPLACE ${sqlStr(key)} AS ${alias} (
         TYPE iceberg,
         URI ${sqlStr(IRC_ENDPOINT)},
         TOKEN ${sqlStr(token)},
         ACCESS_DELEGATION_MODE 'none',
         STAGE_CREATE_TABLES false,
         SKIP_CREATE_TABLE_METADATA_UPDATES true,
         DEFAULT_SCHEMA dbo)`))
      .then(() => { attachedWith.set(key, token); return alias; })
      .finally(() => { if (attaching.get(key) && attaching.get(key).promise === promise) attaching.delete(key); });
    attaching.set(key, { token, promise });
    return promise;
  }

  // A token that expired mid-session shows up as a storage or catalog failure, never as
  // anything structured, so it is recognised by text. Retried ONCE and only after the
  // token actually changed — a 403 is a permission answer and a fresh token will not
  // change its mind, which is the same bargain proxy.js makes.
  const AUTH_FAILURE = /AuthenticationFailed|401|Unauthorized|token.*expired|ExpiredAuthenticationToken/i;

  async function withAuthRetry(run) {
    await ensureAuth();
    try {
      return await run();
    } catch (e) {
      if (!AUTH_FAILURE.test(String(e && e.message))) throw e;
      const stale = authToken;
      const fresh = await ensureAuth(true);   // PAST the caller's token cache
      if (!fresh || fresh === stale) throw e;  // same token, same answer — do not loop
      // `run` reads the engine's state when it runs, never a token captured before the
      // failure — the retry used to ATTACH again with the very token that had just expired.
      return run();
    }
  }

  // A table, ready to be selected from.
  //
  // With the metadata location the page already holds (the catalog's loadTable answer,
  // disk-cached by the proxy), the table is read with iceberg_scan and the catalog is not
  // asked again. That matters more than it looks: an ATTACHed table goes back to the REST
  // catalog on EVERY query that names it, and measured against a real tenant that catalog
  // answered a loadTable in 5s, 12s and 114s. The scan path reads the same metadata.json
  // and manifests from storage, applies the same deletes and the Warehouse field-id
  // mapping (checked on a Warehouse table: readable names), and pins the snapshot the
  // Stats card showed.
  //
  // Without one — an older page, a missing field — it falls back to the ATTACH, whose
  // alias is per ITEM because that is what an ATTACH costs (~5s) and what it covers.
  async function openTable({ workspace, item, schema, table, metadataLocation }) {
    await init();
    await currentToken();
    if (isOneLakeMetadata(metadataLocation)) {
      await ensureAuth();
      return { ident: `iceberg_scan(${sqlStr(metadataLocation)})`, alias: null };
    }
    const alias = await withAuthRetry(() => attachKey(`${workspace}/${item}`));
    // DEFAULT_SCHEMA is dbo, but naming the schema explicitly is right for every other
    // one — and OneLake gives schema-less items a synthetic "dbo" anyway.
    const ident = schema
      ? `${alias}.${quoteIdent(schema)}.${quoteIdent(table)}`
      : `${alias}.${quoteIdent(table)}`;
    return { ident, alias };
  }

  // Every statement, streamed chunk by chunk off its own connection. `onBatch` gets one
  // batch per ~BATCH_ROWS rows in the shape data.js reads off conn.send(): a schema carried
  // on the batch itself and rows as plain objects. `type` is the DuckDB type NAME, which
  // data.js's arrowTypeName() passes through verbatim.
  //
  // Past MAX_ROWS the chunks are only COUNTED — sent as row-less batches carrying numRows —
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
      const room = Math.max(0, MAX_ROWS - kept);
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

  async function runAll(sql) {
    const batches = [];
    await withConn(c => runStreaming(c, sql, b => batches.push(b)));
    if (batches.length === 1) return batches[0];
    return {
      fields: batches[0].fields,
      rows: batches.flatMap(b => b.rows),
      numRows: batches.reduce((n, b) => n + b.numRows, 0),
    };
  }

  // What data.js calls, and nothing else. call() appends `emit` after the caller's
  // arguments; only stream() reads it, the rest simply never look at the extra argument.
  const methods = {
    async query(sql) {
      await init();
      return withAuthRetry(() => runAll(sql));
    },

    async stream(sql, emit) {
      await init();
      // Not through withAuthRetry: a stream has already emitted batches by the time a
      // late failure arrives, and running it again would deliver them twice. The token
      // is still refreshed up front, which is what covers the ordinary expiry case.
      await ensureAuth();
      const numRows = await withConn(c => runStreaming(c, sql, b => emit(b)));
      return { done: true, numRows };
    },

    // Attach the item this table lives in and hand back the identifier to select from.
    async openTable(target) { return openTable(target); },

    async cancel() {
      // Native interrupt, not a worker terminate. The wasm build could only be stopped by
      // killing the worker (it blocked in synchronous XHR and processed no messages), and
      // rebuilding it cost ~10 seconds. Only the PAGE's queries are interrupted: an ATTACH
      // or a secret being issued on the host's own connection is left to finish.
      for (const c of live) { interrupted.add(c); try { c.interrupt(); } catch (_) {} }
      return true;
    },

    // Bytes with no URL — the one shape the wasm registry still had a point for. They
    // land in a temp file and the PATH comes back, ready for sqlStr() on the other side;
    // dropFile is how the caller gives the disk back. The counter is monotonic, never a
    // live count: a count shrinks on drop, and two live buffers then collide on a name.
    async registerFileBuffer(name, bytes) {
      await init();
      const file = join(tmpDir, `buf_${++tmpSeq}_${name.replace(/[^\w.-]/g, '_')}`);
      // { base64 } from the panel (duckdb-native.js); a plain array from older callers and
      // the harnesses.
      const buf = bytes && typeof bytes.base64 === 'string' ? Buffer.from(bytes.base64, 'base64')
                                                             : Buffer.from(bytes);
      await fsp.writeFile(file, buf);
      const path = file.replace(/\\/g, '/');
      temps.set(name, file);
      return path;
    },

    async dropFile(name) {
      const f = temps.get(name);
      if (f) { temps.delete(name); await fsp.rm(f, { force: true }).catch(() => {}); }
      return true;
    },

    async getVersion() { await init(); return 'native'; },

    async capabilities() { await init(); return capabilities; },
  };

  async function call(method, args = [], emit = () => {}) {
    // hasOwn, not a bare lookup: 'constructor' and friends resolve on any object literal,
    // and the method name arrives from the webview. Same for args — spread throws on
    // anything that is not an array, with a worse message than this one.
    if (!Object.hasOwn(methods, method)) throw new Error(`unknown engine method: ${method}`);
    if (!Array.isArray(args)) throw new Error(`engine method ${method}: args must be an array`);
    const token = authToken;
    try { return await methods[method](...args, emit); }
    catch (e) { throw scrub(e, authToken || token); }
  }

  async function close() {
    closed = true;
    // Whatever is running is stopped first: closing an instance under a live query is
    // the native binding's problem to survive, and there is no reason to make it one.
    for (const c of live) { try { c.interrupt(); } catch (_) {} }
    // A boot still in flight finishes (or fails) before its handles are released.
    if (ready) await ready.catch(() => {});
    await adminChain.catch(() => {});
    for (const c of live) { try { c.closeSync(); } catch (_) {} }
    live.clear();
    try { if (conn) conn.closeSync(); } catch (_) {}
    try { if (instance) instance.closeSync(); } catch (_) {}
    conn = instance = null; ready = null;
    temps.clear(); aliases.clear(); attachedWith.clear(); attaching.clear();
    authToken = null;
    if (tmpDir) await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }

  return { init, call, close, get capabilities() { return capabilities; } };
}

module.exports = { createEngineHost, jsonSafe, isOneLakeMetadata };
