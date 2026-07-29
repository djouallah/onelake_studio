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

// A .tmp file younger than this may be another VS Code window's write in progress —
// globalStorage is shared between windows — so age, not existence, is what convicts it.
const TMP_MAX_AGE_MS = 60 * 60 * 1000;

function createCache(dir, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  if (!dir) return null;
  let tmpSeq = 0;

  // Made once, synchronously, at proxy start: a write stream has to be openable the
  // instant a response starts arriving, and an async mkdir would mean buffering the head
  // of every body while waiting for it — the thing this file exists not to do.
  //
  // The failure is kept rather than swallowed. A cache that cannot make its directory is
  // indistinguishable from one that is working and never hitting — both are just "slow" —
  // and that is not a thing to find out by reasoning about it.
  //
  // Declared before anything that runs — sweepAndMeasure() below reads `usable`, and a
  // `let` further down the file is not initialised yet when an earlier line calls it.
  let usable = true;
  let problem = '';
  try {
    fsSync.mkdirSync(dir, { recursive: true });
  } catch (e) {
    usable = false;
    problem = (e && e.message) || String(e);
  }

  // Pruning means stat-ing every entry, and at twenty gigabytes that is a lot of files to
  // walk for the common case of being nowhere near the limit. So the total is carried in
  // memory: measured once in the background at start-up, added to on every write, and
  // re-established by the prune itself. Wrong only in the safe direction — a total that
  // drifts high prunes early, and the scan corrects it.
  let total = 0;
  let sized = sweepAndMeasure().catch(() => {});

  // Every write the cache has promised but not finished. idle() is the tests' answer to
  // "has everything landed?", replacing sleeps that guessed.
  const pending = new Set();
  const track = p => { pending.add(p); p.finally(() => pending.delete(p)); return p; };

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
  function putHead(url, contentLength) {
    const bytes = Number(contentLength);
    if (!usable || !cacheable(url) || !Number.isFinite(bytes) || bytes <= 0) return false;
    track(fs.writeFile(join(dir, `${keyOf(url, 'HEAD')}.json`),
      JSON.stringify({ contentRange: '', bytes, at: Date.now(), head: true })).catch(() => {}));
    return true;
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
    // 'close', not 'finish': close means the file descriptor has been released, and
    // renaming a file Windows still holds a handle on is an EPERM waiting for load. The
    // outcome is a promise so a caller (and idle()) can know whether the entry landed,
    // instead of inferring it from time passing.
    const done = track(new Promise(resolve => {
      stream.on('close', async () => {
        if (broken) return resolve({ stored: false, bytes: 0 });
        try {
          const bytes = stream.bytesWritten;
          if (!bytes) { await fs.rm(tmp, { force: true }); return resolve({ stored: false, bytes: 0 }); }
          await fs.rename(tmp, join(dir, `${k}.bin`));
          await fs.writeFile(join(dir, `${k}.json`),
            JSON.stringify({ contentRange: contentRange || '', bytes, at: Date.now() }));
          total += bytes;
          if (total > maxBytes) await prune();
          resolve({ stored: true, bytes });
        } catch (_) {
          // An optimisation, never a failure — but the tmp must not outlive the attempt.
          fs.rm(tmp, { force: true }).catch(() => {});
          resolve({ stored: false, bytes: 0 });
        }
      });
    }));
    // A read that dies part way through must not leave a plausible-looking entry behind.
    return { stream, abort: () => { scrap(); stream.destroy(); }, done };
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

  // The start-up walk: count what is here, and remove what should never have survived.
  // A crash between the rename and the sidecar leaves a .bin no read can use — scan()
  // lists only .json, so it is never counted and never pruned, a leak with no expiry. A
  // data .json with no .bin is the same tear seen from the other side, and would serve a
  // promise with no bytes behind it. An abandoned .tmp is an interrupted write; a fresh
  // one may be another window's write still in flight, so only old ones go.
  async function sweepAndMeasure() {
    if (!usable) return 0;
    const names = await fs.readdir(dir);
    const jsons = new Set(), bins = new Set();
    for (const n of names) {
      if (n.endsWith('.json')) jsons.add(n.slice(0, -5));
      else if (n.endsWith('.bin')) bins.add(n.slice(0, -4));
    }
    for (const n of names) {
      if (!n.endsWith('.tmp')) continue;
      try {
        const st = await fs.stat(join(dir, n));
        if (Date.now() - st.mtimeMs > TMP_MAX_AGE_MS) await fs.rm(join(dir, n), { force: true });
      } catch (_) {}
    }
    for (const k of bins) {
      if (!jsons.has(k)) await fs.rm(join(dir, `${k}.bin`), { force: true }).catch(() => {});
    }
    let sum = 0;
    for (const k of jsons) {
      try {
        const m = JSON.parse(await fs.readFile(join(dir, `${k}.json`), 'utf8'));
        if (!m.head && !bins.has(k)) { await fs.rm(join(dir, `${k}.json`), { force: true }); continue; }
        sum += m.head ? 0 : Number(m.bytes) || 0;
      } catch (_) { await fs.rm(join(dir, `${k}.json`), { force: true }).catch(() => {}); }
    }
    total = sum;
    return total;
  }

  // The sweep has run and nothing the cache promised to write is still in flight. New
  // writes can start while old ones settle, hence the loop rather than one snapshot.
  async function idle() {
    await sized;
    while (pending.size) await Promise.allSettled([...pending]);
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

  // What this is costing on disk, for the command that offers to hand it back. Walks every
  // entry, so it is for a one-off question, not for anything on a timer.
  async function size() {
    try { await sized; return await measure(); } catch (_) { return 0; }
  }

  // The same number without the walk — the running total, good enough for a status line
  // and cheap enough to ask for on every update.
  const storedBytes = () => total;

  // Signing out, or switching account, is the one moment these bytes should not survive —
  // they were read with the identity being left behind. sw.js does the same on sign-out.
  //
  // Per-file, and the directory itself is kept: removing the whole tree and remaking it
  // is EPERM-prone on Windows the moment any entry is open in a read, and one stubborn
  // file is no reason to declare the cache dead for the rest of the session. Whatever
  // refuses to go is re-counted, stays subject to eviction, and the next clear gets
  // another chance at it.
  async function clear() {
    try {
      const names = await fs.readdir(dir);
      await Promise.all(names.map(n => fs.rm(join(dir, n), { force: true }).catch(() => {})));
    } catch (_) {
      // The directory itself is missing or unreadable — remake it; only a directory that
      // cannot exist makes the cache unusable.
      try { fsSync.mkdirSync(dir, { recursive: true }); }
      catch (e) { usable = false; problem = (e && e.message) || String(e); }
    }
    try { total = await measure(); } catch (_) { total = 0; }
  }

  return { get, beginPut, putHead, clear, size, storedBytes, idle, dir, maxBytes,
           status: () => ({ usable, problem, dir, maxBytes, storedBytes: total }) };
}

module.exports = { createCache, cacheable, DEFAULT_MAX_BYTES };
