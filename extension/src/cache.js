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
const { createHash } = require('node:crypto');
const { join } = require('node:path');

const MAX_BYTES = 512 * 1024 * 1024;
const PRUNE_EVERY_PUTS = 32;
// One response is held in memory to be written. A whole-file GET of a large parquet is
// the one shape that could hurt, and it is also the one least worth storing, so it is
// skipped rather than buffered.
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;

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

function createCache(dir) {
  if (!dir) return null;
  let ready = null;
  let putsSincePrune = 0;

  const ensure = () => (ready || (ready = fs.mkdir(dir, { recursive: true })));

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

  async function put(url, range, status, contentRange, body) {
    if (!cacheable(url)) return;
    if (status !== 200 && status !== 206) return;
    if (!body || body.length === 0 || body.length > MAX_ENTRY_BYTES) return;
    try {
      await ensure();
      const k = keyOf(url, range);
      // Written to a temp name and renamed, so a half-written file is never a hit: rename
      // is atomic, readFile of the .bin would otherwise happily return a truncated read
      // and DuckDB would blame the file.
      const tmp = join(dir, `${k}.${process.pid}.tmp`);
      await fs.writeFile(tmp, body);
      await fs.rename(tmp, join(dir, `${k}.bin`));
      await fs.writeFile(join(dir, `${k}.json`),
        JSON.stringify({ contentRange: contentRange || '', bytes: body.length, at: Date.now() }));
      if (++putsSincePrune >= PRUNE_EVERY_PUTS) { putsSincePrune = 0; await prune(); }
    } catch (_) { /* an optimisation, never a failure */ }
  }

  // Oldest-first eviction once the cap is passed, down to 80% so it does not run on
  // every put.
  async function prune() {
    try {
      const names = (await fs.readdir(dir)).filter(n => n.endsWith('.json'));
      const entries = [];
      let total = 0;
      for (const n of names) {
        try {
          const m = JSON.parse(await fs.readFile(join(dir, n), 'utf8'));
          // A HEAD entry is a number, not bytes on disk. Counting its file's length here
          // would evict real entries to make room for something occupying nothing.
          const bytes = m.head ? 0 : Number(m.bytes) || 0;
          total += bytes;
          entries.push({ k: n.slice(0, -5), bytes, at: Number(m.at) || 0 });
        } catch (_) { /* a torn entry prunes itself below */ }
      }
      if (total <= MAX_BYTES) return;
      entries.sort((a, b) => a.at - b.at);
      for (const e of entries) {
        if (total <= MAX_BYTES * 0.8) break;
        await fs.rm(join(dir, `${e.k}.bin`), { force: true });
        await fs.rm(join(dir, `${e.k}.json`), { force: true });
        total -= e.bytes;
      }
    } catch (_) {}
  }

  // Signing out, or switching account, is the one moment these bytes should not survive —
  // they were read with the identity being left behind. sw.js does the same on sign-out.
  async function clear() {
    try { await fs.rm(dir, { recursive: true, force: true }); } catch (_) {}
    ready = null;
  }

  return { get, put, putHead, clear, dir };
}

module.exports = { createCache, cacheable, MAX_ENTRY_BYTES };
