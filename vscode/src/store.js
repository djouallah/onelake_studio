'use strict';
// =============================================================================
// store.js — what the extension remembers about OneLake, on disk
// =============================================================================
// OneLake is the slow part of everything this extension does. Measured on a real tenant,
// one Iceberg catalog answer took 5s, 12s and 114s for three small tables. So nothing on
// screen waits for it when there is any answer at all to show: get() returns what is on
// disk at once, and when that answer is older than the TTL it is fetched again behind the
// caller, with a 'changed' event if, and only if, it really changed.
//
// One JSON file per key, written to a temp name and renamed into place, so a reader never
// sees half an entry and two VS Code windows sharing the directory cannot corrupt each
// other — the last write wins, and both writes were whole. The directory is per account
// (the caller picks it), so one identity is never served another's listings.
//
// No `vscode` import: the store is driven from tests with a temp directory and a clock.
// =============================================================================

const fs = require('node:fs/promises');
const { join } = require('node:path');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
const MEMO_MAX = 2000;       // hot entries kept in memory, so a re-render reads no disk

/**
 * @param {object} o
 * @param {string|null} o.dir    where entries live; null keeps everything in memory only
 * @param {number} [o.ttlMs]     how old an answer may be before it is refreshed behind
 * @param {number} [o.maxBytes]  disk budget; the oldest entries go first past it
 * @param {() => number} [o.now]
 */
function createStore({ dir, ttlMs = DEFAULT_TTL_MS, maxBytes = DEFAULT_MAX_BYTES, now = Date.now } = {}) {
  const events = new EventEmitter();
  // 'error' is special to EventEmitter — emitted with no listener it throws. Background
  // refresh failures are reported under their own name so nobody has to remember that.
  const inflight = new Map();   // key -> Promise<entry>
  const memo = new Map();       // key -> { value, at, json }   (insertion order = LRU)
  let tmpSeq = 0;
  let total = 0;                // bytes on disk, from the sweep plus writes since

  const usable = dir
    ? fs.mkdir(dir, { recursive: true }).then(() => sweep()).then(() => true, () => false)
    : Promise.resolve(false);

  const fileOf = key => join(dir, createHash('sha256').update(key).digest('hex') + '.json');

  function remember(key, ent) {
    memo.delete(key);
    memo.set(key, ent);
    if (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value);
    return ent;
  }

  async function read(key) {
    const hot = memo.get(key);
    if (hot) return remember(key, hot);
    if (!await usable) return null;
    try {
      const e = JSON.parse(await fs.readFile(fileOf(key), 'utf8'));
      // A hash collision is not going to happen, but a file that names another key is a
      // file this read must not serve.
      if (!e || e.key !== key) return null;
      return remember(key, { value: e.value, at: e.at, json: JSON.stringify(e.value) });
    } catch (_) {
      return null;   // absent, or unreadable: either way, not an answer
    }
  }

  async function write(key, value) {
    const json = JSON.stringify(value);
    const ent = remember(key, { value, at: now(), json });
    if (!await usable) return ent;
    const file = fileOf(key);
    const tmp = `${file}.${process.pid}.${++tmpSeq}.tmp`;
    const body = JSON.stringify({ key, at: ent.at, value });
    try {
      await fs.writeFile(tmp, body);
      // Windows refuses a rename over a file another reader holds for a moment; the
      // window is a read, not a lock, so a few short retries cover it.
      for (let attempt = 0; ; attempt++) {
        try { await fs.rename(tmp, file); break; }
        catch (e) {
          if (attempt >= 4) throw e;
          await new Promise(r => setTimeout(r, 25 * (attempt + 1)));
        }
      }
      total += body.length;
      if (total > maxBytes) await prune();
    } catch (_) {
      // Memory still holds it; the disk copy is an optimisation, never a failure.
      fs.rm(tmp, { force: true }).catch(() => {});
    }
    return ent;
  }

  // Single-flight per key: a tree that draws three nodes off one listing, a prefetch and
  // a click on the same table — each asks once and they share the answer.
  function fetchOnce(key, fetcher) {
    let p = inflight.get(key);
    if (!p) {
      p = (async () => {
        try {
          const before = await read(key);
          const ent = await write(key, await fetcher());
          if (before && before.json !== ent.json) events.emit('changed', key, ent.value);
          return ent;
        } finally {
          inflight.delete(key);
        }
      })();
      inflight.set(key, p);
    }
    return p;
  }

  /**
   * The answer for `key`: from disk at once when there is one (refreshed behind the caller
   * once older than the TTL), otherwise fetched now. `fresh` skips the disk — that is what
   * a Refresh button means. A failed fetch with nothing cached throws; a failed background
   * refresh keeps the cached answer and says so through 'refresh-failed'.
   */
  async function get(key, fetcher, { fresh = false, ttl = ttlMs } = {}) {
    if (!fresh) {
      const hit = await read(key);
      if (hit) {
        const age = now() - hit.at;
        if (age > ttl) {
          fetchOnce(key, fetcher).catch(e => events.emit('refresh-failed', key, e));
        }
        return { value: hit.value, at: hit.at, cached: true, stale: age > ttl };
      }
    }
    const ent = await fetchOnce(key, fetcher);
    return { value: ent.value, at: ent.at, cached: false, stale: false };
  }

  // A value the caller computed itself (a table's first rows), and its read-back.
  const put = (key, value) => write(key, value).then(() => {});
  const peek = async key => { const e = await read(key); return e ? e.value : undefined; };

  // ---------------------------------------------------------------------------
  // Disk budget
  // ---------------------------------------------------------------------------
  async function entries() {
    const out = [];
    let names = [];
    try { names = await fs.readdir(dir); } catch (_) { return out; }
    for (const n of names) {
      const p = join(dir, n);
      try {
        const st = await fs.stat(p);
        // A tmp left by a crashed write is garbage once it is a minute old.
        if (n.endsWith('.tmp')) {
          if (now() - st.mtimeMs > 60_000) await fs.rm(p, { force: true }).catch(() => {});
          continue;
        }
        if (n.endsWith('.json')) out.push({ p, bytes: st.size, at: st.mtimeMs });
      } catch (_) {}
    }
    return out;
  }

  async function sweep() {
    const list = await entries();
    total = list.reduce((n, e) => n + e.bytes, 0);
    if (total > maxBytes) await prune(list);
  }

  // Oldest first, down to 80% — so the next write does not land straight back here.
  async function prune(list) {
    list = list || await entries();
    list.sort((a, b) => a.at - b.at);
    total = list.reduce((n, e) => n + e.bytes, 0);
    for (const e of list) {
      if (total <= maxBytes * 0.8) break;
      await fs.rm(e.p, { force: true }).catch(() => {});
      total -= e.bytes;
    }
  }

  async function clear() {
    memo.clear();
    if (!await usable) return 0;
    const list = await entries();
    for (const e of list) await fs.rm(e.p, { force: true }).catch(() => {});
    total = 0;
    return list.reduce((n, e) => n + e.bytes, 0);
  }

  async function size() {
    if (!await usable) return 0;
    return (await entries()).reduce((n, e) => n + e.bytes, 0);
  }

  return {
    get, put, peek, clear, size,
    on: (ev, fn) => { events.on(ev, fn); return () => events.off(ev, fn); },
    ready: () => usable,
  };
}

module.exports = { createStore, DEFAULT_TTL_MS };
