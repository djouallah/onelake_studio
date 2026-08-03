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

function createEngineHost({ extensionDir, onLog = () => {}, onWarn = () => {}, getToken = null } = {}) {
  let instance = null;
  let conn = null;
  let ready = null;

  // The token the storage secret and every ATTACH were built from. Both hold a token
  // BY VALUE — a DuckDB secret is a stored string, and ATTACH copies the catalog token
  // into the attachment — so when VS Code hands back a different one, both have to be
  // reissued. The proxy never had this problem because it signed each request as it
  // went; this is the price of DuckDB talking to OneLake itself.
  let authToken = null;
  // "workspace/item" -> the alias it is ATTACHed as.
  const attached = new Map();
  let aliasSeq = 0;

  // Buffer name -> temp file on disk, so dropFile can delete it rather than leaking one
  // buffer-sized file per document opened this session.
  const temps = new Map();
  let tmpSeq = 0;
  let tmpDir = null;

  async function init() {
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
      };
      if (extensionDir) config.extension_directory = extensionDir;
      instance = await DuckDBInstance.create(':memory:', config);
      conn = await instance.connect();
      mark('instance+connect');

      await conn.run('SET preserve_insertion_order = false;');
      // REQUIRED, and treated differently from the rest: `iceberg` and `azure` are how a
      // table is read at all now, and `httpfs` is how the Files tab reads through the
      // loopback proxy. An optional extension that will not load costs one file format;
      // these three failing means the extension cannot do its job, and saying so beats
      // a later "Failed to open file" that names nothing.
      for (const ext of ['iceberg', 'azure', 'httpfs']) await load(ext, '', true);
      for (const ext of ['avro', 'excel']) await load(ext, '');
      for (const ext of ['h3', 'zipfs']) await load(ext, 'community');
      mark('extensions');

      // An :memory: database has no spill path unless one is named, so a query bigger
      // than RAM was an extension-host OOM — and this process is shared with every other
      // extension. The temp dir is this session's own and is deleted on close.
      await conn.run(`SET temp_directory = ${sqlStr(tmpDir.replace(/\\/g, '/'))};`);

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
  async function load(ext, repo, required = false) {
    try {
      try { await conn.run(`LOAD ${ext};`); }
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
  async function ensureAuth(fresh = false) {
    if (!getToken) return null;
    const token = await getToken(fresh ? { fresh: true } : {});
    if (!token) return null;
    if (token === authToken) return token;
    await conn.run(
      `CREATE OR REPLACE SECRET onelake_storage (
         TYPE azure, PROVIDER access_token, ACCESS_TOKEN ${sqlStr(token)})`);
    authToken = token;
    attached.clear();
    return token;
  }

  async function attachItem(workspace, item, token) {
    const key = `${workspace}/${item}`;
    if (attached.has(key)) return attached.get(key);
    const alias = `ol_${++aliasSeq}`;
    await conn.run(
      `ATTACH OR REPLACE ${sqlStr(key)} AS ${alias} (
         TYPE iceberg,
         ENDPOINT ${sqlStr(IRC_ENDPOINT)},
         TOKEN ${sqlStr(token)},
         ACCESS_DELEGATION_MODE 'none',
         STAGE_CREATE_TABLES false,
         SKIP_CREATE_TABLE_METADATA_UPDATES true,
         DEFAULT_SCHEMA dbo)`);
    attached.set(key, alias);
    return alias;
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
      authToken = null;                       // force a reissue rather than a cache hit
      const fresh = await ensureAuth(true);   // and PAST the caller's token cache too
      if (!fresh || fresh === stale) throw e;  // same token, same answer — do not loop
      return run();
    }
  }

  // A table, ready to be selected from. The alias is per ITEM because that is what an
  // ATTACH costs (~5s) and what it covers; a second table in the same lakehouse is free.
  async function openTable({ workspace, item, schema, table }) {
    await init();
    const token = await currentToken();
    await ensureAuth();
    const alias = await withAuthRetry(() => attachItem(workspace, item, token));
    // DEFAULT_SCHEMA is dbo, but naming the schema explicitly is right for every other
    // one — and OneLake gives schema-less items a synthetic "dbo" anyway.
    const ident = schema
      ? `${alias}.${quoteIdent(schema)}.${quoteIdent(table)}`
      : `${alias}.${quoteIdent(table)}`;
    return { ident, alias };
  }

  // One result batch, in the shape data.js reads off conn.send(): a schema carried on the
  // batch itself (the wasm reader had none) and rows as plain objects.
  function batchOf(reader, from, to) {
    const names = reader.deduplicatedColumnNames();
    const types = reader.columnTypes().map(t => String(t));
    const rows = [];
    for (let i = from; i < to; i++) {
      const row = {};
      for (let c = 0; c < names.length; c++) row[names[c]] = jsonSafe(reader.value(c, i));
      rows.push(row);
    }
    // `type` is the DuckDB type NAME, not an Arrow type object. data.js's arrowTypeName()
    // exists only to reconstruct that name from Arrow's metadata; here it is already the
    // real answer, so it is passed through as one.
    return { fields: names.map((n, i) => ({ name: n, type: types[i] })), rows, numRows: rows.length };
  }

  // Every statement, streamed. `onBatch` is called per chunk; the caller decides whether
  // to keep them. Cancellation is conn.interrupt(), which is real — no worker to terminate,
  // no watchdog, none of the machinery the single-threaded wasm build needed.
  async function runStreaming(sql, onBatch) {
    const reader = await conn.streamAndRead(sql);
    let sent = 0;
    for (;;) {
      const before = sent;
      await reader.readUntil(sent + BATCH_ROWS);
      const have = reader.currentRowCount;
      if (have > sent) { onBatch(batchOf(reader, sent, have)); sent = have; }
      if (reader.done) break;
      // No progress and not done: readUntil has nothing further to give, and looping
      // again would spin. Compared against the cursor as it was BEFORE this pass —
      // comparing it after the update is the same expression as `have === have`, which
      // ended every stream at the first chunk.
      if (have === before) break;
    }
    // An empty result must still yield one batch — data.js reads the schema off the first
    // one, and there is always exactly one in the wasm build.
    if (sent === 0) onBatch(batchOf(reader, 0, 0));
    return sent;
  }

  async function runAll(sql) {
    const batches = [];
    await runStreaming(sql, b => batches.push(b));
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
      const numRows = await runStreaming(sql, b => emit(b));
      return { done: true, numRows };
    },

    // Attach the item this table lives in and hand back the identifier to select from.
    async openTable(target) { return openTable(target); },

    async cancel() {
      // Native interrupt, not a worker terminate. The wasm build could only be stopped by
      // killing the worker (it blocked in synchronous XHR and processed no messages), and
      // rebuilding it cost ~10 seconds.
      try { if (conn) conn.interrupt(); } catch (_) {}
      return true;
    },

    // Bytes with no URL — the one shape the wasm registry still had a point for. They
    // land in a temp file and the PATH comes back, ready for sqlStr() on the other side;
    // dropFile is how the caller gives the disk back. The counter is monotonic, never a
    // live count: a count shrinks on drop, and two live buffers then collide on a name.
    async registerFileBuffer(name, bytes) {
      await init();
      const file = join(tmpDir, `buf_${++tmpSeq}_${name.replace(/[^\w.-]/g, '_')}`);
      await fsp.writeFile(file, Buffer.from(bytes));
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
    return methods[method](...args, emit);
  }

  async function close() {
    try { if (conn) conn.closeSync(); } catch (_) {}
    try { if (instance) instance.closeSync(); } catch (_) {}
    conn = instance = null; ready = null;
    temps.clear(); attached.clear();
    authToken = null;
    if (tmpDir) await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }

  return { init, call, close, get capabilities() { return capabilities; } };
}

module.exports = { createEngineHost, jsonSafe };
