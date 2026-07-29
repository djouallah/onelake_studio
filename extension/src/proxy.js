'use strict';
// =============================================================================
// proxy.js — a loopback HTTP proxy that signs OneLake reads
// =============================================================================
// In the browser, sw.js attaches the bearer token to DuckDB's range reads, because
// DuckDB's file API cannot set a header itself. A VS Code webview has no service
// worker to do that with — `navigator.serviceWorker` is undefined there, since VS
// Code runs its own for resource loading and extensions cannot register another.
//
// So the extension host signs them instead. The engine is handed
//   dfsOrigin   = http://127.0.0.1:<port>/<secret>/dfs
//   tableOrigin = http://127.0.0.1:<port>/<secret>/irc
// and everything through them is forwarded upstream with an Authorization header.
// The token never enters the webview at all, which is strictly better than the
// browser build, where the page holds it.
//
// The other half of sw.js — COOP/COEP for crossOriginIsolated — is not replaced and
// is not missed: the engine runs the single-threaded `eh` bundle either way, because
// the wasm_threads build of the avro extension is broken and read_avro is the Iceberg
// manifest reader.
//
// No `vscode` import anywhere in this file: the token arrives as an injected async
// function, `getToken({ fresh })`. That is what lets test/run-proxy.mjs drive it against
// a fake OneLake with no editor running. The caller is expected to cache what it returns
// — see extension.js — and `fresh` is how this file says "that one just 401'd".
// =============================================================================

const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const { join } = require('node:path');
const { createCache, CDN_HOSTS } = require('./cache');

const DFS_UPSTREAM = 'https://onelake.dfs.fabric.microsoft.com';
const TABLE_UPSTREAM = 'https://onelake.table.fabric.microsoft.com';

// Response headers something downstream actually reads:
//   content-length  — how DuckDB sizes a file, including from a HEAD
//   accept-ranges   — without it DuckDB stops issuing ranges and pulls whole files
//   content-range   — the 206 itself
//   x-ms-continuation — how listPaths pages a large directory
// A cross-origin reader sees NONE of these unless they are named in expose-headers,
// so this list is also the CORS allowlist below. Dropping a name here fails quietly:
// the read still succeeds, it just gets slow or truncated.
const PASS_THROUGH = [
  'content-type', 'content-length', 'content-range', 'accept-ranges',
  'etag', 'last-modified', 'x-ms-continuation',
];

function cors(res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET, HEAD, OPTIONS');
  // Range is not a CORS-safelisted request header, so the webview sends a preflight
  // ahead of every ranged read and this has to answer it.
  res.setHeader('access-control-allow-headers',
    'range, accept, content-type, if-none-match, if-modified-since');
  res.setHeader('access-control-expose-headers', PASS_THROUGH.join(', '));
  res.setHeader('access-control-max-age', '86400');
}

// -----------------------------------------------------------------------------
// Making the engine cacheable to Chromium
// -----------------------------------------------------------------------------
// Chromium stores a COMPILED WebAssembly module beside the resource's HTTP cache entry.
// A response it declines to cache therefore has no code cache entry either, and 35MB of
// duckdb-eh.wasm is recompiled from scratch on every panel open — seconds, after the
// bytes have already arrived, which is why the read log could show `1ms hit packaged`
// on a boot that still felt broken.
//
// That was the entire difference from the website: jsDelivr sends
// `cache-control: immutable` plus an ETag, so Chrome caches the bytes AND the compiled
// module, and every later visit compiles nothing. Serving the same bytes from here with
// only content-type/content-length/accept-ranges opted us out of both.
//
// `immutable` is honest for these: engine bytes ship inside the extension and change
// only when the extension itself is replaced. The validator is derived from size+mtime,
// so a re-vendored file invalidates its own entry without anyone remembering to.
const IMMUTABLE = 'public, max-age=31536000, immutable';

function immutableFor(st) {
  return {
    'cache-control': IMMUTABLE,
    etag: `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`,
    'last-modified': new Date(st.mtime).toUTCString(),
  };
}

// A 304 is how Chromium KEEPS an entry it already has instead of dropping it — which
// for the wasm means keeping the compiled module too. An if-none-match match wins
// outright when present: RFC 9110 makes the validator the stronger signal, and the
// date has one-second resolution that a freshly vendored file can land inside.
function isFresh(req, hdr) {
  const inm = req.headers['if-none-match'];
  if (inm) return inm.split(',').some(t => t.trim() === hdr.etag);
  const ims = req.headers['if-modified-since'];
  if (!ims) return false;
  const since = Date.parse(ims);
  const mod = Date.parse(hdr['last-modified']);
  return Number.isFinite(since) && Number.isFinite(mod) && mod <= since;
}

// Constant-time, because the secret is the only thing standing between a local
// process — or a page the user visits, which can also reach loopback — and the whole
// of their OneLake.
function sameSecret(given, secret) {
  const a = Buffer.from(String(given));
  const b = Buffer.from(secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// /<secret>/dfs/<rest>?<query>  ->  { kind: 'dfs', rest: '/<rest>', query: '?<query>' }
// Distinct prefixes rather than one so a workspace name can never be mistaken for a route.
function route(reqUrl, secret) {
  const q = reqUrl.indexOf('?');
  const path = q === -1 ? reqUrl : reqUrl.slice(0, q);
  const query = q === -1 ? '' : reqUrl.slice(q);
  // jsDelivr's +esm bundles import their dependencies by ABSOLUTE path — /npm/… — which
  // the browser resolves against this proxy's ROOT, below any secret. Mapping /npm/ and
  // /gh/ straight to jsDelivr is what keeps those nested imports working. No secret on
  // purpose: it exposes nothing but public, allowlisted CDN content, read-only — unlike
  // every other route, there is no user data behind it to protect.
  if (/^\/(npm|gh)\//.test(path)) {
    return { kind: 'cdn', rest: `/cdn.jsdelivr.net${path}`, query };
  }
  const m = /^\/([^/]+)\/(dfs|irc|cdn)(\/.*)?$/.exec(path);
  if (!m || !sameSecret(m[1], secret)) return null;
  return { kind: m[2], rest: m[3] || '/', query };
}

// The hosts DuckDB-WASM boots from (defined beside the cache tiers — cache.js is the
// single source). A webview has no persistent HTTP cache, so without this route every
// panel open re-downloaded the wasm, the worker and four extensions — measured at 25-30
// seconds that the first click of every session sat behind. Proxied, the bytes are teed
// into the same disk cache as the data files (the URLs are version-pinned, so they are
// immutable), and every boot after the first is local. An allowlist, not a general
// proxy: this port must never become a way to reach arbitrary hosts from a page.

// Upstream connections are kept alive and reused. Measured in the field: catalog calls
// and first reads cost a suspiciously uniform 3–11 seconds for a few KB — the signature
// of a FRESH CONNECTION being stood up each time (a slow resolver, or IPv6 tried first
// and left to time out), not of a slow server. fetch() gave no control over any of it.
// Plain node http(s) with a keep-alive agent does: one lookup, then warm sockets —
// autoSelectFamily settles the v4/v6 race in 300ms instead of a protocol timeout, and
// fewer dns.lookup calls also stops the 4-thread libuv pool from wedging, which is what
// once made a CACHE HIT take nine seconds. accept-encoding is pinned to identity because
// unlike fetch, nothing here decompresses — the bytes are passed through and teed as-is.
const AGENT_OPTS = {
  keepAlive: true, maxSockets: 16, scheduling: 'lifo',
  autoSelectFamily: true, autoSelectFamilyAttemptTimeout: 300,
};
const agents = { 'https:': new https.Agent(AGENT_OPTS), 'http:': new http.Agent(AGENT_OPTS) };

// GET/HEAD only, redirects followed. Resolves { status, headers, stream } — node shapes,
// lowercase header keys, stream is the response Readable.
function nodeFetch(urlStr, method, headers, hops = 3) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(e); }
    const req = (u.protocol === 'https:' ? https : http).request(u, {
      method, headers: { ...headers, 'accept-encoding': 'identity' }, agent: agents[u.protocol],
    }, res => {
      const loc = res.headers.location;
      if (loc && [301, 302, 303, 307, 308].includes(res.statusCode) && hops > 0) {
        res.resume();   // drain, so the keep-alive socket is reusable
        return resolve(nodeFetch(new URL(loc, u).href, method, headers, hops - 1));
      }
      resolve({ status: res.statusCode, headers: res.headers, stream: res });
    });
    req.on('error', reject);
    req.end();
  });
}

// The engine, from inside the extension. vendor.mjs mirrors the CDN's file layout into
// extension/vendor/<host>/<path> at package time, and this serves those files before the
// cache and before any network — an installed extension boots with no CDN at all, and
// the network exists only for whatever a future duckdb asks for that the package
// predates. Path segments of '.' and '..' are dropped outright, so a request can name
// nothing outside the vendor directory.
async function serveVendor(req, res, vendorDir, rest, log) {
  const file = join(vendorDir, ...rest.split('/').filter(s => s && s !== '.' && s !== '..'));
  let st;
  try { st = await fs.stat(file); } catch (_) { return false; }
  if (!st.isFile()) return false;
  // jsDelivr's '+esm' files have no extension but are ES modules; a module served as
  // octet-stream is a refused import, not a slower one.
  const low = file.toLowerCase();
  const type = low.endsWith('.wasm') ? 'application/wasm'
    : low.endsWith('.json') ? 'application/json'
    : 'text/javascript';
  // Without these Chromium refuses to cache the response, and without a cache entry it
  // throws away the compiled wasm too — see immutableFor() above.
  const fresh = immutableFor(st);
  if (isFresh(req, fresh)) {
    res.writeHead(304, fresh);
    log({ cache: 'hit', vendor: true, status: 304, bytes: 0 });
    res.end();
    return true;
  }
  res.writeHead(200, {
    'content-type': type,
    'content-length': String(st.size),
    'accept-ranges': 'bytes',
    ...fresh,
  });
  log({ cache: 'hit', vendor: true, status: 200, bytes: st.size });
  if (req.method === 'HEAD') { res.end(); return true; }
  const stream = fsSync.createReadStream(file);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
  return true;
}

// One authenticated upstream round trip, with the 401-retry a cached token makes
// necessary: the caller caches what getToken returns, so an expiry is discovered here as
// a 401, and asking for a fresh token and retrying is the only thing that could help.
// Only 401 — a 403 means this identity may not read that path, and a new token will not
// change its mind. Never throws: an unreachable upstream comes back as { resp: null }
// with the error and whatever timings were measured, because the foreground path and the
// background fill want different things done about it.
async function fetchUpstream(upstream, getToken, { method = 'GET', range = '', accept = '' } = {}) {
  const out = { resp: null, tokenMs: 0, netMs: 0, error: '' };
  try {
    const tokenAt = Date.now();
    const token = await getToken();
    out.tokenMs = Date.now() - tokenAt;
    if (!token) { out.error = 'no session'; return out; }
    const headers = { authorization: 'Bearer ' + token };
    if (range) headers.range = range;
    if (accept) headers.accept = accept;
    const netAt = Date.now();
    let resp = await nodeFetch(upstream, method, headers);
    if (resp.status === 401) {
      const fresh = await getToken({ fresh: true });
      if (fresh && fresh !== token) {
        resp.stream.resume();   // drain the 401 so its socket goes back in the pool
        headers.authorization = 'Bearer ' + fresh;
        resp = await nodeFetch(upstream, method, headers);
      }
    }
    out.netMs = Date.now() - netAt;
    out.resp = resp;
  } catch (e) { out.error = (e && e.message) || String(e); }
  return out;
}

async function handle(req, res, opts) {
  cors(res);
  // Answered before anything else and never logged: a preflight touches no token, no
  // cache and no network, and one per file would bury the reads that do.
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405); return res.end('proxy serves GET and HEAD only');
  }

  const r = route(req.url, opts.secret);
  // Same answer for a bad secret and a bad path: nothing here confirms a guess.
  if (!r) { res.writeHead(404); return res.end('not a proxied path'); }

  // /cdn/<host>/<path> carries its destination in the path; the other routes carry
  // theirs in configuration. Only allowlisted hosts resolve — everything else 404s the
  // same way a bad secret does.
  let upstream;
  if (r.kind === 'cdn') {
    const host = (r.rest.split('/')[1] || '').toLowerCase();
    if (!CDN_HOSTS.has(host)) { res.writeHead(404); return res.end('not a proxied path'); }
    // cdnUpstream is a test seam: the fake CDN still sees the host as its first path
    // segment, so the allowlist is exercised either way.
    upstream = (opts.cdnUpstream ? opts.cdnUpstream + r.rest : `https://${r.rest.slice(1)}`) + r.query;
  } else {
    upstream = (r.kind === 'dfs' ? opts.dfsUpstream : opts.tableUpstream) + r.rest + r.query;
  }
  const range = req.headers.range || '';

  // "Slow" is not a diagnosis, and none of this is observable from the webview — DuckDB's
  // reads never pass through the page, and the page cannot see how long the network took
  // or whether anything was served locally. Every read reports where its time went:
  // waiting for the account provider, waiting for OneLake, or not waiting at all.
  const t0 = Date.now();
  const log = extra => {
    if (!opts.onLog) return;
    opts.onLog({
      method: req.method, kind: r.kind, path: r.rest, range,
      ms: Date.now() - t0, ...extra,
    });
  };

  // Packaged engine bytes first — shipped inside the extension, no cache entry and no
  // network involved.
  if (r.kind === 'cdn' && opts.vendorDir) {
    if (await serveVendor(req, res, opts.vendorDir, r.rest, log)) return;
  }

  // A hit answers without a token and without touching the network — the bytes are
  // already on this machine, and they belong to an object that cannot change. The cache
  // stores whole objects and slices them per request, so any range of a stored file is a
  // hit — including a 416, which is the stored length answering, not the network.
  if (opts.cache) {
    // Timed, because a hit's total has been seen at nine seconds in the field with no
    // column saying where they went. lookupMs isolates the disk lookup itself — if the
    // total is large and lookupMs is not, the stall happened before the proxy was asked.
    const askAt = Date.now();
    const hit = await opts.cache.open(upstream, range, req.method);
    const lookupMs = Date.now() - askAt;
    if (hit) {
      // Stale is served, never waited on: the last answer OneLake gave goes out now,
      // and the fresh one is fetched behind it — the catalog was measured charging
      // 3-9 seconds per 3KB, and that wait belongs in the background, not in front of
      // a click. Single-flight through the same fills map as every write, so a burst
      // of stale hits buys exactly one refresh; its outcome is a STORE line.
      if (hit.stale && req.method === 'GET' && !opts.refreshing.has(upstream)) {
        // Claimed BEFORE the fetch: the cache's own single-flight map only engages once
        // a write begins, and the upstream round trip happens first — without this, a
        // burst of stale hits bought a fetch each.
        opts.refreshing.add(upstream);
        const t1 = Date.now();
        (async () => {
          const g = await fetchUpstream(upstream, opts.getToken, {});
          if (!g.resp || g.resp.status !== 200) { if (g.resp) g.resp.stream.resume(); return; }
          const freshHdr = {};
          for (const h of PASS_THROUGH) {
            const v = g.resp.headers[h];
            if (v != null) freshHdr[h] = v;
          }
          const entry = opts.cache.beginPutFull(upstream, { headers: freshHdr });
          if (!entry) { g.resp.stream.resume(); return; }
          g.resp.stream.on('error', () => entry.abort());
          g.resp.stream.pipe(entry.stream);
          const o = await entry.done;
          if (opts.onLog) opts.onLog({
            method: 'STORE', kind: r.kind, path: r.rest, range: '',
            ms: Date.now() - t1, status: 0,
            cache: o.stored ? 'store' : 'store-failed', bytes: o.bytes || 0,
            ...(o.stored ? {} : { error: o.reason || 'refresh failed' }),
          });
        })().catch(() => {}).finally(() => opts.refreshing.delete(upstream));
      }
      if (hit.status === 416) {
        res.writeHead(416, { 'content-range': hit.contentRange });
        log({ cache: 'hit', status: 416, bytes: 0, lookupMs });
        return res.end();
      }
      // Stored headers (TTL entries keep them) replay first: a listing's
      // x-ms-continuation or a catalog answer's content-type is part of the answer.
      // Length and range are ours — the slice being served decides them, not upstream.
      res.writeHead(hit.status, {
        'content-type': 'application/octet-stream',
        ...(hit.headers || {}),
        'content-length': String(hit.length),
        'accept-ranges': 'bytes',
        // Same reasoning as serveVendor: a cdn object is addressed by a versioned URL and
        // cannot change under it, so letting Chromium keep it — and the module it compiled
        // from it — is both safe and the difference between booting and recompiling. Data
        // reads deliberately get nothing: their freshness is this cache's business, decided
        // by the TTL and serve-stale logic above, not the webview's.
        ...(r.kind === 'cdn' ? { 'cache-control': IMMUTABLE } : {}),
        ...(hit.contentRange ? { 'content-range': hit.contentRange } : {}),
      });
      log({ cache: 'hit', status: hit.status, bytes: hit.length, lookupMs });
      if (req.method === 'HEAD' || !hit.stream) return res.end();
      // Eviction can win a race against a read that just opened: the sidecar answered,
      // the .bin is gone. Killing the response makes DuckDB retry — and the retry misses
      // and goes upstream — where a hung socket would just be a hang.
      hit.stream.on('error', () => res.destroy());
      return hit.stream.pipe(res);
    }
  }

  // Built fresh rather than forwarded: whatever the page sent, the token is ours — and
  // for the cdn route there is NO token at all: those are public hosts, and the bearer
  // that reads the user's OneLake has no business appearing in a CDN's access log.
  const got = r.kind === 'cdn'
    ? await (async () => {
        const out = { resp: null, tokenMs: 0, netMs: 0, error: '' };
        const headers = {};
        if (range) headers.range = range;
        if (req.headers.accept) headers.accept = req.headers.accept;
        const netAt = Date.now();
        try { out.resp = await nodeFetch(upstream, req.method, headers); }
        catch (e) { out.error = (e && e.message) || String(e); }
        out.netMs = Date.now() - netAt;
        return out;
      })()
    : await fetchUpstream(upstream, opts.getToken,
        { method: req.method, range, accept: req.headers.accept || '' });
  const { tokenMs, netMs } = got;
  if (!got.resp) {
    if (got.error === 'no session') {
      res.writeHead(401);
      log({ cache: 'miss', status: 401, tokenMs });
      return res.end('no Microsoft account session');
    }
    res.writeHead(502);
    log({ cache: 'miss', status: 502, tokenMs, netMs, error: got.error });
    return res.end(`proxy could not reach OneLake: ${got.error}`);
  }
  const up = got.resp;

  const out = {};
  for (const h of PASS_THROUGH) {
    const v = up.headers[h];
    if (v != null) out[h] = v;
  }
  // Upstream's status is passed through untouched — 206, and 401/403/404, all of which
  // the engine reads and turns into its own diagnosis.
  // The cdn route adds the caching contract on the way past, so a FIRST boot — the one
  // that has no vendor file and no cache entry yet — still leaves Chromium holding the
  // compiled wasm. Without it the very install that pays to download 35MB gets nothing
  // back for it.
  if (r.kind === 'cdn' && up.status === 200) out['cache-control'] = IMMUTABLE;
  res.writeHead(up.status, out);
  if (req.method === 'HEAD') {
    up.stream.resume();   // no body is coming, but the socket must go back to the pool
    // An immutable file's length is as immutable as its bytes, and DuckDB asks for it
    // before every open. Storing it turns a round trip to OneLake into a local read.
    let stored = false;
    if (up.status === 200 && opts.cache) {
      stored = opts.cache.putHead(upstream, out['content-length']);
    }
    log({ cache: stored ? 'miss' : 'skip', status: up.status, tokenMs, netMs,
          bytes: Number(out['content-length']) || 0 });
    return res.end();
  }

  // A ranged miss is served exactly as asked — and the whole object is fetched ONCE in
  // the background, because the next range will be different and the object never will
  // be. Spend disk, not network: from the moment the fill lands, every range of this
  // file is a local slice. The fill is fire-and-forget on this request's path; its
  // outcome surfaces as its own STORE log line, once per download, not once per read
  // that overlapped it.
  if (opts.cache && req.method === 'GET' && up.status === 206) {
    const m = /\/(\d+)\s*$/.exec(out['content-range'] || '');
    const fillAt = Date.now();
    const fill = opts.cache.ensureFull(upstream, async () => {
      const g = await fetchUpstream(upstream, opts.getToken, {});
      if (!g.resp) throw new Error(g.error || 'unreachable');
      return g.resp;
    }, { totalBytes: m ? Number(m[1]) : undefined });
    if (fill.started && opts.onLog) {
      fill.done.then(o => opts.onLog({
        method: 'STORE', kind: r.kind, path: r.rest, range: '',
        ms: Date.now() - fillAt, status: 0,
        cache: o.stored ? 'store' : 'store-failed', bytes: o.bytes || 0,
        ...(o.stored ? {} : { error: o.reason || 'unknown' }),
      })).catch(() => {});
    }
  }

  // Streamed to DuckDB, and — when it is worth keeping — teed to disk on the way past.
  // Nothing is held in memory and nothing waits on the write: a file too big to buffer is
  // exactly the one most worth having next time.
  //
  // Only a COMPLETE 200 body is teed: it is the object itself. A 206 is a slice, and
  // storing slices keyed by range was the old design's disease — nothing ever asked for
  // the same slice twice.
  const body = up.stream;
  const entry = (opts.cache && up.status === 200 && !out['content-range'])
    ? opts.cache.beginPutFull(upstream, { headers: out }) : null;

  let size = 0;
  body.on('data', c => { size += c.length; });
  body.on('error', () => entry && entry.abort());
  body.on('end', () => {
    // "miss" and "skip" are different answers and were being reported as one. A miss will
    // be there next time; a skip never will, because this object is not one the cache is
    // allowed to hold. If every line says skip, the rule about which paths are immutable
    // is wrong for this tenant — which is not something to guess at from the outside.
    log({ cache: entry ? 'miss' : 'skip', status: up.status, tokenMs, netMs, bytes: size });
  });
  if (entry) body.pipe(entry.stream);
  body.pipe(res);
}

// Resolves to { port, secret, dfsOrigin, tableOrigin, close() }.
function startProxy({ getToken, cacheDir, cacheMaxBytes, cacheTtlMs, onLog, cdnUpstream, vendorDir,
                      dfsUpstream = DFS_UPSTREAM, tableUpstream = TABLE_UPSTREAM } = {}) {
  if (typeof getToken !== 'function') throw new TypeError('startProxy needs a getToken() function');

  const secret = crypto.randomBytes(24).toString('hex');
  // Absent cacheDir means no cache — every read goes upstream, which is what the proxy
  // did before and is still a correct proxy.
  const cache = createCache(cacheDir, {
    ...(cacheMaxBytes ? { maxBytes: cacheMaxBytes } : {}),
    // != null, not truthiness: zero is a real answer ("ask OneLake every time").
    ...(cacheTtlMs != null ? { ttlMs: cacheTtlMs } : {}),
  });
  const opts = { getToken, dfsUpstream, tableUpstream, secret, cache, onLog, cdnUpstream, vendorDir,
                 refreshing: new Set() };

  const server = http.createServer((req, res) => {
    handle(req, res, opts).catch(e => {
      if (!res.headersSent) res.writeHead(500);
      res.end(String((e && e.message) || e));
    });
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    // 127.0.0.1 explicitly, never 0.0.0.0 — this port hands out the user's OneLake to
    // anything that can reach it, and the secret is the only other lock.
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const base = `http://127.0.0.1:${port}/${secret}`;
      resolve({
        port,
        secret,
        dfsOrigin: `${base}/dfs`,
        tableOrigin: `${base}/irc`,
        // The engine's boot bytes — wasm, worker, extensions — proxied and disk-cached
        // like everything else, so a panel open after the first needs no CDN at all.
        cdnOrigin: `${base}/cdn`,
        // The bytes were read with the identity being left behind, so switching account
        // or signing out throws them away.
        clearCache: () => (cache ? cache.clear() : Promise.resolve()),
        cacheSize: () => (cache ? cache.size() : Promise.resolve(0)),
        // Settled when the start-up sweep is done and no write is in flight — what a
        // test awaits instead of guessing a duration.
        cacheIdle: () => (cache ? cache.idle() : Promise.resolve()),
        cacheStatus: () => (cache ? cache.status()
          : { usable: false, problem: 'caching is off', dir: null, maxBytes: 0, storedBytes: 0 }),
        close: () => new Promise(done => server.close(done)),
      });
    });
  });
}

module.exports = { startProxy, PASS_THROUGH };
