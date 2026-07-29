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
// WHAT THIS FILE IS NOT. It is not a port of data.js. data.js is 1935 lines of
// hard-won Iceberg logic — the manifest walk, position deletes, Warehouse name-mapping,
// the three read tiers — and rewriting it against a new API would put every one of those
// behaviours back at risk to gain nothing. Its ENTIRE dependency on DuckDB is eight
// methods:
//
//   conn.query / conn.send / conn.cancelSent
//   db.registerFileURL / db.registerFileBuffer / db.dropFile / db.globFiles / db.getVersion
//
// So that is what this implements. data.js keeps running in the webview, unchanged, and
// these eight calls cross to here instead of to a worker.
//
// THE ONE PIECE OF SLEIGHT OF HAND — registered names. duckdb-wasm has a virtual file
// registry: registerFileURL('data_7.parquet', 'https://…') makes that name readable from
// SQL. Native DuckDB has no such registry; it reads the URL directly. So a registered name
// is resolved here, in resolveNames(), by substituting the quoted literal in the SQL text
// just before execution.
//
// That is safe for a specific, checked reason: every registered name is synthetic and
// generated from a monotonic counter in data.js — `data_<n>.parquet`, `del_<n>.parquet`,
// `file_<n>.<ext>` — and always reaches SQL through paths.js `sqlStr()`, i.e. as a
// complete single-quoted literal. A name is never a substring of a user's identifier and
// never appears unquoted. Only exact whole-literal matches are replaced.
// =============================================================================

const { DuckDBInstance } = require('@duckdb/node-api');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { join } = require('node:path');
const os = require('node:os');

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

function createEngineHost({ extensionDir, onLog = () => {} } = {}) {
  let instance = null;
  let conn = null;
  let ready = null;

  // Registered name -> what native DuckDB should read instead. A URL for registerFileURL,
  // a temp file path for registerFileBuffer.
  const registry = new Map();
  // Registered name -> temp file on disk, so dropFile can delete it rather than leaking
  // one manifest-sized file per Iceberg table opened this session.
  const temps = new Map();
  let tmpDir = null;

  // Substitute whole quoted literals only. Matching the literal rather than scanning for
  // the bare name is what makes this safe against a name that happens to be a substring
  // of something else — and DuckDB escapes an embedded quote by doubling it, while a
  // registered name never contains one, so the naive literal pattern cannot mis-parse.
  function resolveNames(sql) {
    if (!registry.size) return sql;
    return sql.replace(/'([^']*)'/g, (whole, inner) => {
      const target = registry.get(inner);
      return target ? `'${target.replace(/'/g, "''")}'` : whole;
    });
  }

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
      const config = {};
      if (extensionDir) config.extension_directory = extensionDir;
      instance = await DuckDBInstance.create(':memory:', config);
      conn = await instance.connect();
      mark('instance+connect');

      await conn.run('SET preserve_insertion_order = false;');
      // httpfs is what reads the loopback proxy. Native DuckDB DOES issue Range requests
      // where the wasm build never did, and the proxy's cache already serves ranges as 206
      // slices — so this makes the disk cache more useful, not less.
      for (const ext of ['httpfs', 'avro', 'excel']) await load(ext, '');
      for (const ext of ['h3', 'zipfs']) await load(ext, 'community');
      mark('extensions');

      const totalMs = stages.reduce((n, s) => n + s.ms, 0);
      onLog({ stages, totalMs });
      return true;
    })();
    return ready;
  }

  const capabilities = { excel: false, zipfs: false, h3: false, avro: false, httpfs: false };

  // Never throws. An optional extension that will not load costs one file format, which
  // is not a reason to refuse to start — the same judgement data.js makes.
  async function load(ext, repo) {
    try {
      try { await conn.run(`LOAD ${ext};`); }
      catch (_) {
        await conn.run(`INSTALL ${ext}${repo ? ` FROM ${repo}` : ''};`);
        await conn.run(`LOAD ${ext};`);
      }
      capabilities[ext] = true;
    } catch (e) {
      console.warn(`[engine-host] ${ext} unavailable: ${e.message}`);
    }
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
    const reader = await conn.streamAndRead(resolveNames(sql));
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

  // The eight calls data.js makes, and nothing else.
  const methods = {
    async query(sql) { await init(); return runAll(sql); },

    // `emit` is appended by call() after the caller's own arguments, so it lands here as
    // the second parameter — this method takes exactly one argument of its own.
    async stream(sql, emit) {
      await init();
      const numRows = await runStreaming(sql, b => emit(b));
      return { done: true, numRows };
    },

    async cancel() {
      // Native interrupt, not a worker terminate. The wasm build could only be stopped by
      // killing the worker (it blocked in synchronous XHR and processed no messages), and
      // rebuilding it cost ~10 seconds.
      try { if (conn) conn.interrupt(); } catch (_) {}
      return true;
    },

    async registerFileURL(name, url) { registry.set(name, url); return true; },

    // The wasm build kept these in its virtual filesystem. Native DuckDB reads a real one,
    // so the bytes land in a temp file — which is also why dropFile below deletes it.
    async registerFileBuffer(name, bytes) {
      await init();
      const file = join(tmpDir, `buf_${registry.size}_${name.replace(/[^\w.-]/g, '_')}`);
      await fsp.writeFile(file, Buffer.from(bytes));
      registry.set(name, file.replace(/\\/g, '/'));
      temps.set(name, file);
      return true;
    },

    async dropFile(name) {
      registry.delete(name);
      const f = temps.get(name);
      if (f) { temps.delete(name); await fsp.rm(f, { force: true }).catch(() => {}); }
      return true;
    },

    // data.js uses this as a registry probe when an open fails, to tell "the file was
    // dropped under me" apart from "the read failed". The answer here is exact.
    async globFiles(name) {
      return registry.has(name) ? [{ fileName: name }] : [];
    },

    async getVersion() { await init(); return 'native'; },

    async capabilities() { await init(); return capabilities; },
  };

  async function call(method, args = [], emit = () => {}) {
    const fn = methods[method];
    if (!fn) throw new Error(`unknown engine method: ${method}`);
    return fn(...args, emit);
  }

  async function close() {
    try { if (conn) conn.closeSync(); } catch (_) {}
    try { if (instance) instance.closeSync(); } catch (_) {}
    conn = instance = null; ready = null;
    registry.clear(); temps.clear();
    if (tmpDir) await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }

  return { init, call, close, get capabilities() { return capabilities; } };
}

module.exports = { createEngineHost, jsonSafe };
