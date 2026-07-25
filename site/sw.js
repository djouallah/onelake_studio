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
// The token is pushed in by auth.js (`onelake-token` messages) and held in memory
// only. If this worker is restarted by the browser it loses the token, so a
// request that arrives without one asks the page for it (`need-token`) and waits
// briefly for the reply.
// =============================================================================

const ONELAKE_HOST = 'onelake.dfs.fabric.microsoft.com';
const TOKEN_WAIT_MS = 3000;

let coepCredentialless = false;
let token = null;
let waiting = null;          // { promise, resolve } while asking clients for a token

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('message', e => {
  const d = e.data || {};
  if (d.type === 'coepCredentialless') {
    coepCredentialless = d.value;
  } else if (d.type === 'onelake-token') {
    token = d.token || null;
    if (waiting) { waiting.resolve(token); waiting = null; }
  } else if (d.type === 'deregister') {
    self.registration.unregister()
      .then(() => self.clients.matchAll())
      .then(cs => cs.forEach(c => c.navigate(c.url)));
  }
});

// Ask every open page for the current token. Coalesced: concurrent misses share
// one round trip, and it resolves null on timeout so a request never hangs.
function askClientsForToken() {
  if (waiting) return waiting.promise;
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  waiting = { promise, resolve };
  self.clients.matchAll({ includeUncontrolled: true })
    .then(cs => cs.forEach(c => c.postMessage({ type: 'need-token' })));
  setTimeout(() => { if (waiting) { waiting.resolve(null); waiting = null; } }, TOKEN_WAIT_MS);
  return promise;
}

async function authorize(request) {
  // A no-cors request has a guarded header list — Authorization can't be set on it,
  // and OneLake would reject an opaque request anyway.
  if (request.mode === 'no-cors') return request;
  if (request.headers.has('Authorization')) return request;   // fetchAuthed already signed it
  let host;
  try { host = new URL(request.url).host; } catch (_) { return request; }
  if (host !== ONELAKE_HOST) return request;

  const t = token || await askClientsForToken();
  if (!t) return request;                                     // let it 401 and surface honestly
  const headers = new Headers(request.headers);
  headers.set('Authorization', 'Bearer ' + t);
  return new Request(request, { headers });
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

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;
  const base = coepCredentialless && req.mode === 'no-cors'
    ? new Request(req, { credentials: 'omit' })
    : req;
  event.respondWith(
    authorize(base)
      .then(r => fetch(r))
      .then(isolate)
      .catch(e => { console.error('[sw]', e); throw e; })
  );
});
