'use strict';
// =============================================================================
// cache.js — the proxy's copy of sw.js's data cache
// =============================================================================
// In the browser, sw.js keeps up to half a gigabyte of Iceberg data files and Avro
// manifests on disk, so opening the same table twice reads the second time from the
// machine rather than from OneLake. The webview has no service worker and had no
// equivalent, which is most of why the panel felt slower than the website on anything
// already looked at once.
//
// The rules are not re-decided here, they are copied: only objects that are IMMUTABLE BY
// DESIGN are stored — data files and Avro manifests under Tables/, where a new snapshot
// always means new files, so a hit can never be stale. Listings (they carry a query
// string), metadata.json (rewritten by conversion) and everything under Files/ (users
// overwrite those) are never cached, and there is therefore no invalidation problem to
// solve. If sw.js's predicate changes, this one has to change with it.
//
// A range is part of the key, because the same file is read at many offsets and the
// answers are different bytes.
//
// No `vscode` import: the directory is injected, which is what lets test/run-proxy.mjs
// drive it. Caching is an optimisation — every failure in this file is swallowed, and the
// read goes to the network instead.
// =============================================================================

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const { createHash } = require('node:crypto');
const { join } = require('node:path');

// sw.js caps its cache at half a gigabyte, and that number is not a policy — it is what
// a browser's storage quota will tolerate before it starts evicting on its own. None of
// that applies to a directory on the user's disk, and inheriting the limit would mean
// throwing away bytes that cost seconds of network to fetch in order to save space that
// costs nothing. Default 20GB, and settable; the cache is pure optimisation, so the worst
// a large one can do is occupy disk that `Clear Cached OneLake Data` hands straight back.
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024 * 1024;

// Written straight to disk as it streams past, never held in memory. The first version of
// this buffered the response so it could enforce a per-entry size cap — and that cap was
// invented here, not copied: sw.js has none. duckdb-wasm often reads a data file WHOLE
// rather than by range, and a Fabric Iceberg data file is routinely bigger than any cap
// worth setting, so the effect was that nothing got cached on precisely the tables where
// caching decides whether the second look is instant.

// Immutable OneLake objects, and nothing else. `search` excludes every DFS listing call.
function cacheable(urlStr) {
  let u;
  try { u = new URL(urlStr); } catch (_) { return false; }
  if (u.search) return false;
  return /\/Tables\/[^?]*\.parquet$/i.test(u.pathname) ||
         /\/Tables\/[^?]*\/metadata\/[^?]*\.avro$/i.test(u.pathname);
}

const keyOf = (url, range) =>
  createHash('sha256').update(`${url}\n${range || 'full'}`).digest('hex');

function createCache(dir, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  if (!dir) return null;
  let tmpSeq = 0;

  // Pruning means stat-ing every entry, and at twenty gigabytes that is a lot of files to
  // walk for the common case of being nowhere near the limit. So the total is carried in
  // memory: measured once in the background at start-up, added to on every write, and
  // re-established by the prune itself. Wrong only in the safe direction — a total that
  // drifts high prunes early, and the scan corrects it.
  let total = 0;
  let sized = measure().catch(() => {});

  // Made once, synchronously, at proxy start: a write stream has to be openable the
  // instant a response starts arriving, and an async mkdir would mean buffering the head
  // of every body while waiting for it — the thing this file exists not to do.
  let usable = true;
  try { fsSync.mkdirSync(dir, { recursive: true }); } catch (_) { usable = false; }

  const ensure = async () => { if (!usable) throw new Error('no cache directory'); };

  // Returns { body, length, contentRange } or null. The body is a Buffer: these are the
  // sizes DuckDB range-reads in, and streaming a local file adds machinery for nothing.
  //
  // A HEAD is asking for a length, not for bytes, and DuckDB issues one before every open.
  // An immutable file's length is as immutable as its contents, so it is answered from the
  // sidecar alone — no body is read off disk to satisfy a question about a number.
  async function get(url, range, method = 'GET') {
    if (!cacheable(url)) return null;
    try {
      await ensure();
      if (method === 'HEAD') {
        const meta = JSON.parse(await fs.readFile(join(dir, `${keyOf(url, 'HEAD')}.json`), 'utf8'));
        return { body: null, length: Number(meta.bytes) || 0, contentRange: '' };
      }
      const k = keyOf(url, range);
      const [body, meta] = await Promise.all([
        fs.readFile(join(dir, `${k}.bin`)),
        fs.readFile(join(dir, `${k}.json`), 'utf8'),
      ]);
      return { body, length: body.length, contentRange: JSON.parse(meta).contentRange || '' };
    } catch (_) { return null; }
  }

  // A length, with no .bin beside it. prune() reads .json files and would see a zero-byte
  // entry, which is what it should see: this costs nothing to keep and nothing to lose.
  async function putHead(url, contentLength) {
    const bytes = Number(contentLength);
    if (!cacheable(url) || !Number.isFinite(bytes) || bytes <= 0) return;
    try {
      await ensure();
      await fs.writeFile(join(dir, `${keyOf(url, 'HEAD')}.json`),
        JSON.stringify({ contentRange: '', bytes, at: Date.now(), head: true }));
    } catch (_) {}
  }

  // Returns a writable to tee the response into, or null when this is not worth storing.
  // The caller pipes the body to it alongside the client; nothing waits on it.
  //
  // Written under a temp name and renamed on completion, so a half-written entry can never
  // be served: rename is atomic, whereas reading a .bin that is still being appended to
  // returns a truncated file and DuckDB blames the data.
  function beginPut(url, range, status, contentRange) {
    if (!usable || !cacheable(url)) return null;
    if (status !== 200 && status !== 206) return null;
    const k = keyOf(url, range);
    const tmp = join(dir, `${k}.${process.pid}.${++tmpSeq}.tmp`);
    let stream;
    try { stream = fsSync.createWriteStream(tmp); } catch (_) { return null; }

    let broken = false;
    const scrap = () => { broken = true; fs.rm(tmp, { force: true }).catch(() => {}); };
    stream.on('error', scrap);
    stream.on('finish', async () => {
      if (broken) return;
      try {
        const bytes = stream.bytesWritten;
        if (!bytes) { await fs.rm(tmp, { force: true }); return; }
        await fs.rename(tmp, join(dir, `${k}.bin`));
        await fs.writeFile(join(dir, `${k}.json`),
          JSON.stringify({ contentRange: contentRange || '', bytes, at: Date.now() }));
        total += bytes;
        if (total > maxBytes) await prune();
      } catch (_) { /* an optimisation, never a failure */ }
    });
    // A read that dies part way through must not leave a plausible-looking entry behind.
    return { stream, abort: () => { scrap(); stream.destroy(); } };
  }

  // Every entry, with its size and age. The one walk both measuring and pruning need.
  async function scan() {
    const names = (await fs.readdir(dir)).filter(n => n.endsWith('.json'));
    const entries = [];
    for (const n of names) {
      try {
        const m = JSON.parse(await fs.readFile(join(dir, n), 'utf8'));
        // A HEAD entry is a number, not bytes on disk. Counting the file's length here
        // would evict real entries to make room for something occupying nothing.
        entries.push({ k: n.slice(0, -5), bytes: m.head ? 0 : Number(m.bytes) || 0,
                       at: Number(m.at) || 0 });
      } catch (_) { /* a torn entry is worth nothing and prunes itself below */ }
    }
    return entries;
  }

  async function measure() {
    if (!usable) return 0;
    const entries = await scan();
    total = entries.reduce((n, e) => n + e.bytes, 0);
    return total;
  }

  // Oldest-first eviction once the cap is passed, down to 80% so it does not run again on
  // the next write.
  async function prune() {
    try {
      const entries = await scan();
      let live = entries.reduce((n, e) => n + e.bytes, 0);
      total = live;                                   // the scan is the authority
      if (live <= maxBytes) return;
      entries.sort((a, b) => a.at - b.at);
      // The newest entry is never evicted, whatever the arithmetic says. A single object
      // larger than the whole cap would otherwise be deleted the instant it was written,
      // every time, so a cap set below one file's size would mean caching nothing while
      // still paying to write it. Better to keep one thing and sit over the limit than to
      // be reliably useless.
      for (const e of entries.slice(0, -1)) {
        if (live <= maxBytes * 0.8) break;
        await fs.rm(join(dir, `${e.k}.bin`), { force: true });
        await fs.rm(join(dir, `${e.k}.json`), { force: true });
        live -= e.bytes;
      }
      total = live;
    } catch (_) {}
  }

  // What this is costing on disk, for the command that offers to hand it back.
  async function size() {
    try { await sized; return await measure(); } catch (_) { return 0; }
  }

  // Signing out, or switching account, is the one moment these bytes should not survive —
  // they were read with the identity being left behind. sw.js does the same on sign-out.
  async function clear() {
    try {
      await fs.rm(dir, { recursive: true, force: true });
      fsSync.mkdirSync(dir, { recursive: true });   // still usable straight afterwards
      total = 0;
    } catch (_) { usable = false; }
  }

  return { get, beginPut, putHead, clear, size, dir, maxBytes };
}

module.exports = { createCache, cacheable, DEFAULT_MAX_BYTES };
