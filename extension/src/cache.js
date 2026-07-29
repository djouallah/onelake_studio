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
// Two tiers, one directory. Objects that are IMMUTABLE BY DESIGN — data files and Avro
// manifests under Tables/, where a new snapshot always means new files — are kept until
// evicted, and a hit can never be stale. EVERYTHING ELSE the proxy carries (Iceberg
// catalog answers, listings, metadata.json, Files/) is kept for a short TTL: mutable,
// so it can be briefly stale, and that trade was made deliberately — the catalog was
// measured charging 2–10 seconds per 3KB answer on every single table open.
//
// ONE entry per URL, holding the whole object; any byte range is answered by slicing it.
// The first version keyed entries by (url, range) instead, and that is what made the
// cache useless in practice: a HEAD hit advertises accept-ranges, which invites
// duckdb-wasm to range-read, and no stored range ever matched the next request's range —
// the cache steered the engine into the one read pattern it could not serve. An immutable
// object's bytes are the same however they are sliced, so the object is the unit of
// storage and the range is only a way of serving it.
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

// The sidecar format version. Entries written by the range-keyed design carry no `v` at
// all, and their keys can never be asked for again — the start-up sweep deletes them on
// sight, which is the whole migration.
const SIDE_V = 2;

// A .tmp file younger than this may be another VS Code window's write in progress —
// globalStorage is shared between windows — so age, not existence, is what convicts it.
const TMP_MAX_AGE_MS = 60 * 60 * 1000;

// What may be kept, and for how long.
//   'immutable' — data files and Avro manifests under Tables/: a new snapshot always
//                 means new files, so these are kept until evicted and can never be stale.
//   'ttl'       — everything else the proxy carries: catalog answers, listings,
//                 metadata.json, Files/. Mutable, so kept briefly — measured in the
//                 field, the second ask for the same 3KB catalog answer lands seconds
//                 after the first and OneLake charges 2–10 seconds each time. Five
//                 minutes of possible staleness was chosen, explicitly, over that.
const DEFAULT_TTL_MS = 5 * 60 * 1000;

// The hosts the engine boots from. Their URLs are version-pinned (a jsDelivr path
// carries its @version, an extension path its duckdb version), so like the data files
// they are immutable — kept forever, with their response headers, because an ESM module
// served without its content-type is not a faster answer but a SyntaxError.
const CDN_HOSTS = new Set(['cdn.jsdelivr.net', 'extensions.duckdb.org',
                           'community-extensions.duckdb.org']);

//   'cdn'       — boot bytes from the allowlisted CDN hosts: immutable, headers kept.
//                 Recognised by hostname, or by first path segment for the proxy's
//                 /cdn/<host>/… test seam where the real host rides in the path.
//   'immutable' — data files and manifests under Tables/: kept until evicted.
//   'ttl'       — everything else: kept briefly (see above).
function tierOf(urlStr) {
  let u;
  try { u = new URL(urlStr); } catch (_) { return false; }
  const seg = (u.pathname.split('/')[1] || '').toLowerCase();
  if (CDN_HOSTS.has(u.hostname.toLowerCase()) || CDN_HOSTS.has(seg)) return 'cdn';
  const immutable = !u.search &&
    (/\/Tables\/[^?]*\.parquet$/i.test(u.pathname) ||
     /\/Tables\/[^?]*\/metadata\/[^?]*\.avro$/i.test(u.pathname));
  return immutable ? 'immutable' : 'ttl';
}
const cacheable = urlStr => tierOf(urlStr) === 'immutable';

const keyOf = url => createHash('sha256').update(url).digest('hex');

// `bytes=a-b`, `bytes=a-` and `bytes=-n` — the shapes an HTTP reader actually sends.
// null when there is no header at all; 'unsatisfiable' when the object cannot answer
// (416); 'invalid' for anything else, including multi-range, which the caller forwards
// upstream verbatim rather than guessing at.
function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m || (!m[1] && !m[2])) return 'invalid';
  if (!m[1]) {                                   // bytes=-n : the last n bytes
    const n = Number(m[2]);
    if (!n) return 'unsatisfiable';
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  if (start >= size) return 'unsatisfiable';
  const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  if (end < start) return 'invalid';
  return { start, end };
}

function createCache(dir, { maxBytes = DEFAULT_MAX_BYTES, ttlMs = DEFAULT_TTL_MS } = {}) {
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

  // One fill per URL at a time, whoever started it. The map is what stops a tee and a
  // background download — or two of either — writing the same object twice.
  const fills = new Map();

  const ensure = async () => { if (!usable) throw new Error('no cache directory'); };

  // The read side. Resolves null on a miss (or anything unservable, which is the same
  // answer); otherwise { status, length, contentRange, stream } where stream is null for
  // HEAD and 416. A HEAD is answered from the sidecar alone — a stored object knows its
  // own length even if no HEAD was ever proxied for it — and a range is a
  // createReadStream slice of the one stored .bin.
  async function open(url, rangeHeader, method = 'GET') {
    if (!tierOf(url)) return null;
    try {
      await ensure();
      const k = keyOf(url);
      // Read synchronously, deliberately: fs/promises rides libuv's 4-thread pool, the
      // same pool dns.lookup uses, and a hit was measured waiting NINE SECONDS behind
      // wedged lookups for a 40-byte file. A sync read of a tiny local file costs
      // microseconds and can never queue behind the network's problems.
      const meta = JSON.parse(fsSync.readFileSync(join(dir, `${k}.json`), 'utf8'));
      if (meta.v !== SIDE_V) return null;          // a pre-slicing entry; the sweep owns it
      // A TTL entry past its time is a miss, not an error: the refetch replaces it.
      if (meta.exp && Date.now() > meta.exp) return null;
      const size = Number(meta.bytes) || 0;
      const hdr = meta.hdr || null;
      if (method === 'HEAD') return { status: 200, length: size, contentRange: '', stream: null, headers: hdr };
      if (meta.head) return null;                  // a length only; the bytes are not here
      const bin = join(dir, `${k}.bin`);
      const r = parseRange(rangeHeader, size);
      if (r === 'invalid') return null;
      if (r === 'unsatisfiable') {
        return { status: 416, length: 0, contentRange: `bytes */${size}`, stream: null, headers: hdr };
      }
      if (!r) {
        return { status: 200, length: size, contentRange: '', stream: fsSync.createReadStream(bin),
                 headers: hdr };
      }
      return {
        status: 206, length: r.end - r.start + 1,
        contentRange: `bytes ${r.start}-${r.end}/${size}`,
        stream: fsSync.createReadStream(bin, { start: r.start, end: r.end }),
        headers: hdr,
      };
    } catch (_) { return null; }
  }

  // A length, with no .bin beside it. Never written over a full entry's sidecar — that
  // would orphan its bytes — and not while a fill is landing: the length arrives with
  // the body.
  function putHead(url, contentLength) {
    const bytes = Number(contentLength);
    if (!usable || !cacheable(url) || !Number.isFinite(bytes) || bytes <= 0) return false;
    const k = keyOf(url);
    if (fills.has(k) || fsSync.existsSync(join(dir, `${k}.json`))) return false;
    track(fs.writeFile(join(dir, `${k}.json`),
      JSON.stringify({ bytes, at: Date.now(), v: SIDE_V, head: true })).catch(() => {}));
    return true;
  }

  // The raw write machinery, shared by the tee and the background fill. Written under a
  // temp name and renamed on completion, so a half-written entry can never be served:
  // rename is atomic, whereas reading a .bin that is still being appended to returns a
  // truncated file and DuckDB blames the data.
  function startFill(k, extra = {}) {
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
            JSON.stringify({ bytes, at: Date.now(), v: SIDE_V, ...extra }));
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

  // Returns a writable to tee a COMPLETE 200 body into, or null when this is not worth
  // storing — including when the object is already stored or already being stored. The
  // caller pipes the body to it alongside the client; nothing waits on it.
  //
  // `headers` are kept for TTL entries and replayed on a hit: a listing's
  // x-ms-continuation or a catalog answer's content-type is part of the answer, and a
  // hit that dropped them would be a different response, not a faster one.
  function beginPutFull(url, { headers } = {}) {
    const tier = tierOf(url);
    if (!usable || !tier) return null;
    // A zero TTL means "ask OneLake every time" — storing an entry that is born expired
    // would be disk spent on nothing.
    if (tier === 'ttl' && ttlMs <= 0) return null;
    const k = keyOf(url);
    if (fills.has(k)) return null;
    if (fsSync.existsSync(join(dir, `${k}.bin`))) {
      // An immutable entry never needs rewriting. A TTL entry does, once it has expired
      // — the rename at the end replaces the old bytes atomically.
      if (tier === 'immutable') return null;
      try {
        const m = JSON.parse(fsSync.readFileSync(join(dir, `${k}.json`), 'utf8'));
        if (!m.exp || Date.now() <= m.exp) return null;
      } catch (_) {}
    }
    const extra = tier === 'ttl' ? { exp: Date.now() + ttlMs, hdr: headers || {} }
                : tier === 'cdn' ? { hdr: headers || {} }
                : {};
    const entry = startFill(k, extra);
    if (!entry) return null;
    fills.set(k, entry.done);
    entry.done.finally(() => fills.delete(k));
    return entry;
  }

  // A ranged miss means the engine wants pieces of an object this cache does not hold.
  // The pieces asked for change with every query shape and every session; the object
  // never changes at all. So the miss is served as asked, and the WHOLE object is
  // fetched once in the background — spend disk, not network. From then on every range
  // is a local slice.
  //
  // Single-flight per URL: however many ranged misses arrive while a fill runs, there is
  // one download, shared with the tee path through the same map. A failure is remembered
  // for a minute so a persistent 403 cannot become a fetch storm, and an object that
  // could never fit under the cap is not downloaded at all — it would be spend with no
  // possible payoff. (Merely over the REMAINING budget is different: prune makes room.)
  //
  // fetchFull is provided by the caller and owns tokens and retries; it resolves to a
  // WHATWG Response. Returns { started, done } — started says whether THIS call began a
  // download, which is what lets the caller log one outcome per fill rather than one per
  // request that happened to overlap it.
  const failedAt = new Map();
  const FAIL_TTL_MS = 60 * 1000;
  function ensureFull(url, fetchFull, { totalBytes } = {}) {
    const skip = reason => ({ started: false, done: Promise.resolve({ stored: false, bytes: 0, reason }) });
    // Immutable objects only: a background download of something mutable would spend
    // network on bytes that may be wrong by the time they are asked for.
    if (!usable || !cacheable(url)) return skip('not cacheable');
    const k = keyOf(url);
    if (fills.has(k)) return { started: false, done: fills.get(k) };
    if (fsSync.existsSync(join(dir, `${k}.bin`))) return skip('already stored');
    const failed = failedAt.get(k);
    if (failed && Date.now() - failed < FAIL_TTL_MS) return skip('failed recently');
    if (Number.isFinite(totalBytes) && totalBytes > maxBytes) return skip('larger than the whole cache');

    const job = (async () => {
      let entry = null;
      try {
        const resp = await fetchFull();
        if (!resp || resp.status !== 200 || !resp.stream) {
          if (resp && resp.stream) resp.stream.resume();   // free the keep-alive socket
          failedAt.set(k, Date.now());
          return { stored: false, bytes: 0, reason: `upstream ${resp ? resp.status : 'unreachable'}` };
        }
        entry = startFill(k);
        if (!entry) { resp.stream.resume(); return { stored: false, bytes: 0, reason: 'no write stream' }; }
        const body = resp.stream;
        body.on('error', () => entry.abort());
        body.pipe(entry.stream);
        const out = await entry.done;
        if (!out.stored) failedAt.set(k, Date.now());
        return out;
      } catch (e) {
        if (entry) entry.abort();
        failedAt.set(k, Date.now());
        return { stored: false, bytes: 0, reason: (e && e.message) || String(e) };
      }
    })();
    fills.set(k, job);
    track(job);
    job.finally(() => fills.delete(k));
    return { started: true, done: job };
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
  // one may be another window's write still in flight, so only old ones go. And a sidecar
  // without `v: 2` is from the range-keyed era — a key nothing will ever ask for again.
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
        const torn = !m.head && !bins.has(k);
        const expired = m.exp && Date.now() > m.exp;
        if (m.v !== SIDE_V || torn || expired) {
          await fs.rm(join(dir, `${k}.json`), { force: true });
          await fs.rm(join(dir, `${k}.bin`), { force: true }).catch(() => {});
          continue;
        }
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

  return { open, beginPutFull, ensureFull, putHead, clear, size, storedBytes, idle, dir, maxBytes,
           status: () => ({ usable, problem, dir, maxBytes, storedBytes: total }) };
}

module.exports = { createCache, cacheable, tierOf, parseRange, CDN_HOSTS, DEFAULT_MAX_BYTES };
