// =============================================================================
// sw.js — service worker: COOP/COEP shim + OneLake bearer-token injection
// =============================================================================
// Two jobs, one worker (a scope can only have one):
//
// 1. COOP/COEP headers, so the page is crossOriginIsolated and DuckDB-WASM can
//    use SharedArrayBuffer / multiple threads. This half is the coi-serviceworker
//    logic (v0.1.7, Guido Zuidhof, MIT), reimplemented here rather than vendored
//    minified, because job 2 has to live in the same fetch handler.
//
// 2. Attach `Authorization: Bearer <OneLake token>` to requests for
//    onelake.dfs.fabric.microsoft.com that don't already carry one.
//
//    That second job is what makes lazy parquet reads possible. DuckDB-WASM can
//    range-read a parquet file straight from a URL (registerFileURL + HTTP
//    protocol) — reading just the footer and the row groups a query actually
//    touches, instead of us downloading whole files up front. But its API has no
//    way to set request headers, so its reads would 401 against OneLake. Since
//    every request already passes through here to be re-issued for COEP, this is
//    the natural place to authorize them.
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
// One cache PER IDENTITY: a hit is answered with no token at all, so a single shared cache
// served the last account's table bytes to whoever signed in next. auth.js names the
// identity (a hash, `cacheId`) alongside the token; with no live identity there is no
// cache to read or write. The v1 cache, shared by everyone, is deleted on activation.
const DATA_CACHE_PREFIX = 'onelake-data-v2-';
const LEGACY_DATA_CACHE = 'onelake-data-v1';
const DATA_CACHE_MAX_BYTES = 512 * 1024 * 1024;
const PRUNE_EVERY_PUTS = 32;
let putsSincePrune = 0;

let coepCredentialless = false;
let cacheId = '';            // whose data cache — set with the token, cleared with it
let token = null;
let tokenExpiresAt = 0;      // 0 = unknown; a known-expired token is never used
let waiting = null;          // { promise, resolve } while asking clients for a token

const dataCacheName = () => (cacheId ? DATA_CACHE_PREFIX + cacheId : '');

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(Promise.all([
  self.clients.claim(),
  caches.delete(LEGACY_DATA_CACHE).catch(() => {}),
])));

self.addEventListener('message', e => {
  const d = e.data || {};
  if (d.type === 'coepCredentialless') {
    coepCredentialless = d.value;
  } else if (d.type === 'onelake-token') {
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
// case the 401 retry below exists for. Comparing the returned request's identity, as this
// used to, silently excluded it: an unsigned request is `=== request`, so the one failure a
// fresh token would have fixed was the one failure that never got retried.
async function authorize(request) {
  // A no-cors request has a guarded header list — Authorization can't be set on it,
  // and OneLake would reject an opaque request anyway.
  if (request.mode === 'no-cors') return { request, ours: false };
  // fetchAuthed already signed it, and owns its own refresh-and-retry.
  if (request.headers.has('Authorization')) return { request, ours: false };
  let host;
  try { host = new URL(request.url).host; } catch (_) { return { request, ours: false }; }
  if (host !== ONELAKE_HOST) return { request, ours: false };

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

// The Cache API keys by URL only — the Range header is invisible to it — so the range
// becomes part of the key. The URL has no query string (checked above), so this cannot
// collide with a real request.
const dataKey = (href, range) => href + '?__range=' + encodeURIComponent(range || 'full');

async function fromDataCache(request, url) {
  try {
    const name = dataCacheName();
    if (!name) return null;
    const c = await caches.open(name);
    const hit = await c.match(dataKey(url.href, request.headers.get('Range')));
    if (!hit) return null;
    // Cache.put refuses 206s, so entries are stored as 200 + the original Content-Range
    // in a private header; rebuild the partial response DuckDB expects.
    const cr = hit.headers.get('x-content-range');
    const headers = new Headers({ 'Content-Type': 'application/octet-stream' });
    if (cr) headers.set('Content-Range', cr);
    return new Response(hit.body, { status: cr ? 206 : 200, headers });
  } catch (_) { return null; }
}

async function toDataCache(request, url, res) {
  try {
    if (res.status !== 200 && res.status !== 206) return;
    // Too big to hold in a worker's memory, and bigger than the whole cap anyway.
    const len = Number(res.headers.get('Content-Length')) || 0;
    if (len > DATA_CACHE_MAX_BYTES / 8) return;
    const name = dataCacheName();
    if (!name) return;
    const buf = await res.clone().arrayBuffer();
    const c = await caches.open(name);
    await c.put(dataKey(url.href, request.headers.get('Range')), new Response(buf, {
      status: 200,
      headers: {
        'x-content-range': res.headers.get('Content-Range') || '',
        'x-bytes': String(buf.byteLength),
        'x-at': String(Date.now()),
      },
    }));
    if (++putsSincePrune >= PRUNE_EVERY_PUTS) { putsSincePrune = 0; await pruneDataCache(c); }
  } catch (_) { /* caching is an optimisation, never a failure */ }
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
// are already local), and a successful read is stored via event.waitUntil so the
// response streams to DuckDB while the copy lands in the background.
async function signedFetch(request, event) {
  let url = null;
  try { url = new URL(request.url); } catch (_) {}

  // Same-origin app files REVALIDATE instead of trusting the HTTP cache. Pages caches
  // every file for 10 minutes on its own clock, so a page opened minutes after a deploy
  // came up as a MIX of builds — new app.js over old data.js — and a just-shipped fix
  // was provably absent from the very page reporting on it. An ETag 304 costs one round
  // trip and buys a page that is one build. CDN assets are version-pinned and immutable;
  // they keep the plain cache.
  if (url && url.origin === self.location.origin && request.method === 'GET') {
    if (request.mode === 'navigate') return fetch(url.href, { cache: 'no-cache' });
    return fetch(request, { cache: 'no-cache' });
  }
  const cacheable = url && request.method === 'GET' && cacheableDataUrl(url);
  if (cacheable) {
    const hit = await fromDataCache(request, url);
    if (hit) return hit;
  }

  const { request: signed, ours } = await authorize(request);
  let res;
  try {
    res = await fetch(signed);
  } catch (e) {
    if (ours && url && !url.search) reportReadFailure(url, 0, signed !== request);
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
  if (ours && url && !url.search && !res.ok) reportReadFailure(url, res.status, signed !== request);

  if (cacheable && event) event.waitUntil(toDataCache(request, url, res));
  return res;
}

// Re-stamp the isolation headers coi-serviceworker exists to add.
function isolate(response) {
  if (response.status === 0) return response;                 // opaque — nothing to rewrite
  const headers = new Headers(response.headers);
  headers.set('Cross-Origin-Embedder-Policy', coepCredentialless ? 'credentialless' : 'require-corp');
  if (!coepCredentialless) headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  // These statuses must not carry a body.
  const body = [101, 103, 204, 205, 304].includes(response.status) ? null : response.body;
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

// The VS Code bridge (auth.js): OneLake reads addressed to the extension on loopback. They
// carry no token and need none from here, and they are left entirely to the browser — a
// worker re-issuing them would be a second requester for Chrome's local-network permission,
// which a service worker cannot ask for itself. The extension sends CORS and CORP headers,
// so the page's isolation is unaffected.
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])$/;

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;
  try {
    const u = new URL(req.url);
    if (LOOPBACK.test(u.hostname) && u.origin !== self.location.origin) return;
  } catch (_) { /* unparseable — let the normal path deal with it */ }
  const base = coepCredentialless && req.mode === 'no-cors'
    ? new Request(req, { credentials: 'omit' })
    : req;
  event.respondWith(
    signedFetch(base, event)
      .then(res => {
        // A rebuilt Response cannot carry `url` or `redirected`, and for a NAVIGATION that
        // matters: the browser would render the redirect target's body under the original
        // URL, so the address bar and every relative URL resolve against the wrong base.
        // Hand back a real redirect and let the browser ask again for the final URL.
        if (req.mode === 'navigate' && res.redirected) return Response.redirect(res.url, 302);
        return isolate(res);
      })
      .catch(e => { console.error('[sw]', e); throw e; })
  );
});
