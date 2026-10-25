// =============================================================================
// sw.js — service worker: OneLake bearer-token injection + an immutable-object cache
// =============================================================================
// Attach `Authorization: Bearer <OneLake token>` to requests for
// onelake.dfs.fabric.microsoft.com that don't already carry one.
//
// That is what makes lazy parquet reads possible. DuckDB-WASM can range-read a parquet
// file straight from a URL (registerFileURL + HTTP protocol) — reading just the footer and
// the row groups a query actually touches, instead of us downloading whole files up front.
// But its API has no way to set request headers, so its reads would 401 against OneLake.
// This worker sits in front of them and signs them.
//
// It used to have a second job: re-stamping COOP/COEP onto every response so the page was
// crossOriginIsolated and DuckDB could run threaded. The engine runs the single-threaded
// `base` bundle by choice (see data.js), so that bought nothing — and it cost a rewrap of
// every cross-origin response including the 35MB wasm, a forced reload on first visit,
// broken README badge images, and popup sign-in (COOP severs the popup's way back). Gone.
// Only OneLake requests and the app's own files are intercepted now; everything else goes
// straight to the network as if no worker were installed.
//
// auth.js publishes the token two ways: a postMessage (fast) and a Cache Storage entry
// (durable). The cache is what actually matters — the browser terminates an idle service
// worker freely, and it was doing so during DuckDB's multi-MB WASM download, so a purely
// in-memory token was gone by the time the parquet reads started and they 401'd. Asking
// the page for it is the last resort, and only works because auth.js calls
// startMessages(); a ServiceWorkerContainer queues message events until it does.
// =============================================================================

const ONELAKE_HOST = 'onelake.dfs.fabric.microsoft.com';
const TOKEN_WAIT_MS = 3000;
const TOKEN_RENEW_WAIT_MS = 15000;
const TOKEN_CACHE = 'onelake-token';
const TOKEN_KEY = '/__onelake_token';

// Local data cache. Browsers refuse to HTTP-cache 206 Partial Content, so without this
// every query re-fetches the same parquet footers and row groups. Only objects that are
// IMMUTABLE BY DESIGN are cached — Iceberg data files and Avro manifests under Tables/,
// where new data always means new files — so there is no invalidation problem to solve.
// Listings, version-hint, metadata.json (rewritten by conversion) and anything under
// Files/ (users overwrite those) are never cached. Cleared on sign-out, alongside the
// token; pruned oldest-first past the cap.
//
// WHOLE OBJECTS, sliced per range. The first design stored each range under its own key,
// and DuckDB almost never asks for the same byte range twice — so it rarely hit. Now a
// ranged miss is answered from the network as asked, and the whole object is fetched ONCE
// behind it; from then on every range of that file is a local slice. (The extension's
// proxy cache measured the same lesson first.)
//
// One cache PER IDENTITY: a hit is answered with no token at all, so a single shared cache
// served the last account's table bytes to whoever signed in next. auth.js names the
// identity (a hash, `cacheId`) alongside the token; with no live identity there is no
// cache to read or write.
const DATA_CACHE_PREFIX = 'onelake-data-v3-';
const DATA_CACHE_MAX_BYTES = 512 * 1024 * 1024;
// One object bigger than this is never cached whole: fetching it to answer a 4KB footer
// read would be the opposite of lazy.
const OBJECT_MAX_BYTES = 64 * 1024 * 1024;
const PRUNE_EVERY_PUTS = 16;
let putsSincePrune = 0;

let cacheId = '';            // whose data cache — set with the token, cleared with it
let token = null;
let tokenExpiresAt = 0;      // 0 = unknown; a known-expired token is never used
let waiting = null;          // { promise, resolve } while asking clients for a token
const filling = new Map();   // url -> in-flight whole-object fetch, single-flight

const dataCacheName = () => (cacheId ? DATA_CACHE_PREFIX + cacheId : '');

self.addEventListener('install', () => self.skipWaiting());
// Older builds' caches — range-keyed, or shared by every account — are never read again.
self.addEventListener('activate', e => e.waitUntil(Promise.all([
  self.clients.claim(),
  caches.keys().then(ks => Promise.all(ks
    .filter(k => k.startsWith('onelake-data-') && !k.startsWith(DATA_CACHE_PREFIX))
    .map(k => caches.delete(k)))).catch(() => {}),
])));

self.addEventListener('message', e => {
  const d = e.data || {};
  if (d.type === 'onelake-token') {
    token = d.token || null;
    tokenExpiresAt = Number(d.expiresAt) || 0;
    cacheId = token ? String(d.cacheId || '') : '';
    if (waiting) { waiting.resolve(token); waiting = null; }
  } else if (d.type === 'clear-data-cache') {
    caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('onelake-data-'))
      .map(k => caches.delete(k)))).catch(() => {});
  } else if (d.type === 'deregister') {
    self.registration.unregister()
      .then(() => self.clients.matchAll())
      .then(cs => cs.forEach(c => c.navigate(c.url)));
  }
});

const expired = () => tokenExpiresAt > 0 && Date.now() >= tokenExpiresAt;

// Survives worker restarts, unlike the in-memory copy. The expiry rides along in a header
// so a worker that starts up an hour later can tell a live token from a dead one, instead
// of signing every read with a corpse and reporting the 401 as a range-read failure.
async function readTokenFromCache() {
  try {
    const c = await caches.open(TOKEN_CACHE);
    const r = await c.match(TOKEN_KEY);
    if (!r) return null;
    const t = (await r.text()) || null;
    if (!t) return null;
    const exp = Number(r.headers.get('x-onelake-expires-at')) || 0;
    if (exp > 0 && Date.now() >= exp) return null;
    tokenExpiresAt = exp;
    cacheId = r.headers.get('x-onelake-cache-id') || '';
    return t;
  } catch (_) { return null; }
}

// Last resort: ask every open page. Coalesced, so concurrent misses share one round
// trip, and it resolves null on timeout so a request never hangs.
//
// `rejected` is the token OneLake just refused. The page renews PAST it (MSAL's cache would
// otherwise return the very same string), which is a network round trip — so that case
// waits longer.
function askClientsForToken(rejected = null) {
  if (waiting) return waiting.promise;
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  const mine = { promise, resolve };
  waiting = mine;
  self.clients.matchAll({ includeUncontrolled: true })
    .then(cs => cs.forEach(c => c.postMessage({ type: 'need-token', ...(rejected ? { rejected } : {}) })));
  // Compare identity, not truthiness. This timer belongs to `mine`; if `mine` was already
  // answered and a LATER waiter is now in the slot, firing here would resolve that one
  // with null after a fraction of its own wait, and its request would go out unsigned.
  setTimeout(() => { if (waiting === mine) { mine.resolve(null); waiting = null; } },
             rejected ? TOKEN_RENEW_WAIT_MS : TOKEN_WAIT_MS);
  return promise;
}

// The current best token, re-reading the durable copy whenever the in-memory one is
// missing or known stale. The old `token || (token = await read())` never looked again
// once it had anything at all, so a worker holding a dead token held it until reload.
async function currentToken() {
  if (token && !expired()) return token;
  token = await readTokenFromCache();
  if (token) return token;
  token = await askClientsForToken();
  return token;
}

// Returns { request, ours }. `ours` means THIS worker is responsible for the credential on
// this request — and it stays true when no token was found, because that is precisely the
// case the 401 retry below exists for.
async function authorize(request) {
  // A no-cors request has a guarded header list — Authorization can't be set on it,
  // and OneLake would reject an opaque request anyway.
  if (request.mode === 'no-cors') return { request, ours: false };
  // fetchAuthed already signed it, and owns its own refresh-and-retry.
  if (request.headers.has('Authorization')) return { request, ours: false };
  const t = await currentToken();
  if (!t) return { request, ours: true };                     // unsigned, and still ours to retry
  const headers = new Headers(request.headers);
  headers.set('Authorization', 'Bearer ' + t);
  return { request: new Request(request, { headers }), ours: true };
}

// DuckDB reads OneLake through this worker and reports every failure as
// "Failed to open file: <registered name>" — no status, no URL. The page cannot see these
// requests at all, so tell it what actually came back; app.js pins the answer onto that
// error message. Fire-and-forget: diagnostics must never delay or fail a read.
function reportReadFailure(url, status, signed) {
  self.clients.matchAll({ includeUncontrolled: true })
    .then(cs => cs.forEach(c => c.postMessage({
      type: 'onelake-read-failed', status, pathname: url.pathname, signed,
    })))
    .catch(() => {});
}

// Is this an immutable OneLake object worth caching? Only data files and Avro manifests
// under Tables/ — a new snapshot writes NEW files, so a cached one can never be stale.
// The !search guard excludes every DFS listing call.
function cacheableDataUrl(u) {
  if (!cacheId || u.host !== ONELAKE_HOST || u.search) return false;
  return /\/Tables\/[^?]*\.parquet$/i.test(u.pathname) ||
         /\/Tables\/[^?]*\/metadata\/[^?]*\.avro$/i.test(u.pathname);
}

// `bytes=a-b`, `bytes=a-`, `bytes=-n` against an object of `size` bytes ->
// { start, end } (inclusive), 'unsatisfiable', or null for "no usable range: whole object".
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start, end;
  if (m[1] === '') {                       // suffix: the last n bytes
    const n = Number(m[2]);
    if (!n) return 'unsatisfiable';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || end < start) return 'unsatisfiable';
  return { start, end };
}

// A stored object, answered the way the request asked: whole, a slice, or just its length.
// A cached Response's blob is disk-backed, so slicing it reads only the slice.
async function fromDataCache(request, url) {
  try {
    const name = dataCacheName();
    if (!name) return null;
    const hit = await (await caches.open(name)).match(url.href);
    if (!hit) return null;
    const blob = await hit.blob();
    const size = blob.size;
    const base = { 'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes' };
    const r = parseRange(request.headers.get('Range'), size);
    if (r === 'unsatisfiable') {
      return new Response(null, { status: 416, headers: { ...base, 'Content-Range': `bytes */${size}` } });
    }
    if (!r) {
      return new Response(request.method === 'HEAD' ? null : blob,
        { status: 200, headers: { ...base, 'Content-Length': String(size) } });
    }
    const part = blob.slice(r.start, r.end + 1);
    return new Response(request.method === 'HEAD' ? null : part, {
      status: 206,
      headers: { ...base, 'Content-Length': String(part.size),
                 'Content-Range': `bytes ${r.start}-${r.end}/${size}` },
    });
  } catch (_) { return null; }
}

// The total size an answer reveals: Content-Range's denominator for a 206, Content-Length
// for a whole 200.
function objectSize(res) {
  const m = /\/(\d+)\s*$/.exec(res.headers.get('Content-Range') || '');
  if (m) return Number(m[1]);
  return res.status === 200 ? Number(res.headers.get('Content-Length')) || 0 : 0;
}

// Store a complete body. Streamed into Cache Storage, never buffered in the worker.
async function store(url, res, size) {
  const name = dataCacheName();
  if (!name) return;
  const c = await caches.open(name);
  await c.put(url.href, new Response(res.body, {
    status: 200,
    headers: { 'Content-Type': 'application/octet-stream', 'x-bytes': String(size), 'x-at': String(Date.now()) },
  }));
  if (++putsSincePrune >= PRUNE_EVERY_PUTS) { putsSincePrune = 0; await pruneDataCache(c); }
}

// The whole object, fetched once behind a ranged read — single-flight per URL, because
// DuckDB fires its ranges for one file in a burst.
function fillWhole(url, size) {
  if (filling.has(url.href)) return filling.get(url.href);
  const p = (async () => {
    const t = await currentToken();
    if (!t) return;
    const res = await fetch(url.href, { headers: { Authorization: 'Bearer ' + t } });
    if (res.status !== 200 || objectSize(res) !== size) { if (res.body) res.body.cancel(); return; }
    await store(url, res, size);
  })().catch(() => {}).finally(() => filling.delete(url.href));
  filling.set(url.href, p);
  return p;
}

// Oldest-first eviction once the cap is passed, down to 80% so it doesn't run every put.
async function pruneDataCache(c) {
  const entries = [];
  let total = 0;
  for (const k of await c.keys()) {
    const r = await c.match(k);
    const bytes = Number(r && r.headers.get('x-bytes')) || 0;
    const at = Number(r && r.headers.get('x-at')) || 0;
    total += bytes;
    entries.push({ k, bytes, at });
  }
  if (total <= DATA_CACHE_MAX_BYTES) return;
  entries.sort((a, b) => a.at - b.at);
  for (const e of entries) {
    if (total <= DATA_CACHE_MAX_BYTES * 0.8) break;
    await c.delete(e.k);
    total -= e.bytes;
  }
}

// One retry for DuckDB's own reads. They never pass through data.js, so this is the only
// place that can notice their token died — and without it a session that outlived its
// token failed every query with no way back short of reloading the page.
//
// The data cache brackets the network: a hit answers without a token at all (the bytes
// are already local); a complete answer is stored as it streams by; a ranged one starts
// the whole-object fill behind it.
async function oneLakeFetch(request, url, event) {
  const cacheable = (request.method === 'GET' || request.method === 'HEAD') && cacheableDataUrl(url);
  if (cacheable) {
    const hit = await fromDataCache(request, url);
    if (hit) return hit;
  }

  const { request: signed, ours } = await authorize(request);
  let res;
  try {
    res = await fetch(signed);
  } catch (e) {
    if (ours && !url.search) reportReadFailure(url, 0, signed !== request);
    throw e;
  }
  if (res.status === 401 && ours) {
    // Forget what we used and ask the PAGE, naming the token that failed. Asking
    // currentToken() read the same dead token straight back out of Cache Storage, so
    // `fresh === used` and this retry never ran.
    const used = token;
    token = null;
    tokenExpiresAt = 0;
    const fresh = await askClientsForToken(used);
    if (fresh && fresh !== used) {
      const headers = new Headers(request.headers);
      headers.set('Authorization', 'Bearer ' + fresh);
      res = await fetch(new Request(request, { headers }));
    }
  }
  // `!url.search` keeps DFS listing calls out of it: every one of those carries a query
  // string and is issued BY data.js, which reports its own failures with the directory it
  // was reading. Only the bare object reads — DuckDB's — are unexplained without this.
  if (ours && !url.search && !res.ok) reportReadFailure(url, res.status, signed !== request);

  if (cacheable && request.method === 'GET' && event) {
    const size = objectSize(res);
    const whole = res.status === 200 ||
      (res.status === 206 && (res.headers.get('Content-Range') || '').trim() === `bytes 0-${size - 1}/${size}`);
    if (size > 0 && size <= OBJECT_MAX_BYTES) {
      if (whole) event.waitUntil(store(url, res.clone(), size).catch(() => {}));
      else if (res.status === 206) event.waitUntil(fillWhole(url, size));
    }
  }
  return res;
}

// The VS Code bridge (auth.js): OneLake reads addressed to the extension on loopback. They
// carry no token and need none from here, and they are left entirely to the browser — a
// worker re-issuing them would be a second requester for Chrome's local-network permission,
// which a service worker cannot ask for itself. Like every other request this worker has
// no business with, they are simply not intercepted.
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;
  let url;
  try { url = new URL(req.url); } catch (_) { return; }

  // Same-origin app files REVALIDATE instead of trusting the HTTP cache. Pages caches
  // every file for 10 minutes on its own clock, so a page opened minutes after a deploy
  // came up as a MIX of builds — new app.js over old data.js — and a just-shipped fix
  // was provably absent from the very page reporting on it. An ETag 304 costs one round
  // trip and buys a page that is one build. Vendored packages carry their version in the
  // path, so they are immutable and keep the plain cache.
  if (url.origin === self.location.origin) {
    if (req.method !== 'GET' || /\/npm\/|\/duckdb-extensions\//.test(url.pathname)) return;
    // A navigation answered with a REDIRECTED response renders the target's body under the
    // original URL, so every relative URL resolves against the wrong base. Hand back a real
    // redirect and let the browser ask again for the final URL.
    event.respondWith(req.mode === 'navigate'
      ? fetch(url.href, { cache: 'no-cache' })
          .then(res => (res.redirected ? Response.redirect(res.url, 302) : res))
      : fetch(req, { cache: 'no-cache' }));
    return;
  }

  if (url.host !== ONELAKE_HOST) return;
  event.respondWith(oneLakeFetch(req, url, event).catch(e => { console.error('[sw]', e); throw e; }));
});
