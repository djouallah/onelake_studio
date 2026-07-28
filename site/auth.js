// =============================================================================
// auth.js — AuthProvider abstraction (presentation/data agnostic)
// =============================================================================
// One interface, three implementations selected by config:
//   'msal'   -> Entra ID SPA public client (PKCE), bearer token for OneLake
//   'none'   -> no auth at all (plain static hosting, same-origin/public data)
//   'error'  -> config is broken; every call fails with a message that says why,
//               instead of silently degrading to 'none' and 401-ing on every fetch
//
// DOM-free: progress is reported through the injected `onStatus` callback so this
// module never touches the page. app.js owns all UI, including the sign-in gate —
// it just calls ensureSession()/getHeaders() here.
//
//   const auth = createAuth(cfg, { onStatus, onExpired });
//   if (await auth.ensureSession(false)) { /* have what we need to fetch data */ }
//   fetch(url, { headers: auth.getHeaders() });
// =============================================================================

const MSAL_ESM = "https://cdn.jsdelivr.net/npm/@azure/msal-browser@3.28.1/+esm";
const OL_SCOPES = ['https://storage.azure.com/user_impersonation'];

// =============================================================================
// Where Microsoft sends the user back, and which registration signs them in.
// =============================================================================

// origin + path, NOT origin alone: on a GitHub project page the app lives at
// /<repo>/, and returning to the bare origin lands on someone else's page instead of
// this app. `index.html` is trimmed so an explicit link and the directory URL produce
// the same redirect URI — Entra matches these strings exactly.
export function appRedirectUri() {
  return window.location.origin + window.location.pathname.replace(/index\.html$/, '');
}

// --- Which registration signs the user in ------------------------------------
// This app has no registration of its own (config.js ships an empty clientId), so the
// user names one from their own tenant. That is the design, not a fallback: the app
// that reads your lakehouse should be one you control — your redirect URIs, your
// revocation — and an empty clientId is a claim anyone can check in one look.
//
//   ?clientId=<guid>&tenantId=<guid>   -> use that registration from now on
//
// Kept in localStorage because MSAL's redirect returns to the bare redirect URI and
// drops the query string — and because the choice should survive a later visit.
// A clientId in config.js (a private fork, an internal deploy) still works as the
// default, and this override still wins over it.
const BYO_KEY = 'onelake-studio-registration';
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isAuthority = v => GUID.test(v) || /^(organizations|common|consumers)$/i.test(v);

export function readOverride() {
  try {
    const o = JSON.parse(localStorage.getItem(BYO_KEY) || 'null');
    if (o && GUID.test(o.clientId || '') && isAuthority(o.authority || '')) return o;
  } catch (_) { /* corrupt entry — treated as absent */ }
  return null;
}

export function saveOverride(clientId, authority) {
  clientId = (clientId || '').trim();
  authority = (authority || '').trim() || 'organizations';
  if (!GUID.test(clientId)) throw new Error('Application (client) ID must be a GUID.');
  if (!isAuthority(authority)) throw new Error('Directory (tenant) ID must be a GUID, or "organizations".');
  localStorage.setItem(BYO_KEY, JSON.stringify({ clientId, authority }));
}

export function clearOverride() {
  localStorage.removeItem(BYO_KEY);
}

// Merge config.js with a ?clientId=… in the address bar and anything saved earlier.
// A URL parameter wins and is persisted; otherwise the saved override wins over whatever
// config.js set (normally nothing). Returns { ...cfg, byo } so the UI can say which is in use.
export function resolveConfig(base = {}) {
  const q = new URLSearchParams(window.location.search);
  const fromUrl = (q.get('clientId') || '').trim();
  if (fromUrl) {
    try {
      saveOverride(fromUrl, q.get('tenantId') || q.get('authority') || 'organizations');
    } catch (e) {
      // Bad GUID in the URL: ignore it rather than wedging the app on a typo.
      console.warn('Ignoring ?clientId=', e.message);
    }
  }
  const o = readOverride();
  return o ? { ...base, clientId: o.clientId, authority: o.authority, tenantId: null, byo: true }
           : { ...base, byo: false };
}

// Treat a token this close to expiry as already gone. Loading a table can mean dozens
// of parquet fetches over several minutes; renewing up front beats failing half way.
const EXPIRY_SKEW_MS = 5 * 60 * 1000;

// Where the durable copy of the token lives. sw.js reads the same two names — keep them
// in step, and keep the value opaque: it is a bearer token on disk.
const TOKEN_CACHE = 'onelake-token';
const TOKEN_KEY = '/__onelake_token';

// --- No-auth provider: everything is already accessible. ---
function createNoAuth() {
  return {
    mode: 'none',
    async ensureSession() { return true; },
    getHeaders() { return {}; },
    getUserId() { return 'anonymous'; },
    async refresh() { return true; },
    async signOut() {},
    async forgetDurableToken() {},
  };
}

// --- No registration named yet, or a broken one. ---
// Fails loudly and early. The alternative (falling back to no-auth) produces a UI that
// looks signed-in and then answers every OneLake request with a bare HTTP 401.
// `mode` separates the two cases: 'unconfigured' is the ordinary first run, which app.js
// answers with the registration form; 'error' is a deploy someone got wrong.
function createConfigErrorAuth(message, mode = 'error') {
  return {
    mode,
    // A silent restore on an app nobody has configured yet is not a failure: there is no
    // session to restore, and the signed-out button is already the right UI. Saying so
    // with `false` keeps boot quiet, exactly as a missing MSAL session does. A deliberate
    // attempt — or a genuinely broken deploy, which should be loud on sight — still throws.
    async ensureSession(interactive = false) {
      if (mode === 'unconfigured' && !interactive) return false;
      throw new Error(message);
    },
    getHeaders() { return {}; },
    getUserId() { return null; },
    async refresh() { return false; },
    async signOut() {},
    async forgetDurableToken() {},
  };
}

// --- MSAL provider: Entra SPA public client, OneLake bearer token. ---
// REDIRECT auth (not popup): the service worker sets COOP: same-origin to get
// crossOriginIsolated for DuckDB multi-threading, which severs the popup<->opener link once the
// popup bounces through login.microsoftonline.com — so loginPopup can't return the token after the
// session expires. A full-page redirect is COOP-safe. Redirect throws "redirect_in_iframe" inside
// the Fabric portal iframe, but we never auth there (app.js shows "open in tab" instead).
function createMsalAuth(cfg, { onExpired } = {}) {
  const MSAL_CONFIG = {
    auth: {
      clientId: cfg.clientId,
      // 'organizations' for a multi-tenant app (any work/school account signs in with
      // their own tenant); a tenant GUID pins it to one directory.
      authority: `https://login.microsoftonline.com/${cfg.authority || cfg.tenantId}`,
      redirectUri: appRedirectUri(),
    },
    cache: { cacheLocation: 'localStorage' },
  };

  let _msalApp = null;
  let _token = null;
  let _expiresAt = 0;
  let _inflight = null;     // single-flight guard around acquire()
  let _refreshing = null;   // single-flight guard around refresh()
  let _renewTimer = null;   // proactive renewal, so DuckDB's own reads never see a 401
  let _publishChain = Promise.resolve();   // serialises the Cache Storage writes

  // --- Token bridge to the service worker (sw.js) ---------------------------
  // DuckDB range-reads parquet straight from OneLake URLs, and its API can't set
  // headers, so sw.js signs those requests instead. It only ever holds the token in
  // memory, so push it on every change and answer 'need-token' if the worker was
  // restarted and lost it.
  // Cache Storage is the durable channel: the browser terminates an idle service worker
  // whenever it likes (reliably so during DuckDB's multi-MB WASM download), and a token
  // kept only in its memory is gone by the time the parquet reads start. postMessage is
  // kept as the fast path for the common case.
  // Returns a promise that settles once the DURABLE copy has landed. The two writes are
  // chained rather than fired independently: a put and a delete issued microtasks apart
  // (drop() immediately followed by keep(), which is exactly what refresh() does when MSAL
  // answers from its local cache) could otherwise land in the wrong order and leave the
  // worker with no token at all until the next page reload.
  function publishToken() {
    const token = _token, expiresAt = _expiresAt;
    try {
      const c = navigator.serviceWorker && navigator.serviceWorker.controller;
      if (c) c.postMessage({ type: 'onelake-token', token, expiresAt });
    } catch (_) { /* no service worker — reads will 401 and say so */ }

    _publishChain = _publishChain.then(async () => {
      try {
        const c = await caches.open(TOKEN_CACHE);
        if (token) {
          // The expiry rides along, so a worker that restarts and reads this back can tell
          // a live token from an hour-old one instead of signing requests with a corpse.
          await c.put(TOKEN_KEY, new Response(token, {
            headers: { 'x-onelake-expires-at': String(expiresAt) },
          }));
        } else {
          await c.delete(TOKEN_KEY);
        }
      } catch (_) { /* best effort; postMessage is the fast path */ }
    });
    return _publishChain;
  }

  // Erase the durable copy without touching the in-memory one. Closing the tab should not
  // leave a usable OneLake bearer token sitting in the profile directory on disk.
  function forgetDurableToken() {
    _publishChain = _publishChain
      .then(() => caches.open(TOKEN_CACHE).then(c => c.delete(TOKEN_KEY)))
      .catch(() => {});
    return _publishChain;
  }
  try {
    navigator.serviceWorker.addEventListener('message', e => {
      if (!e.data || e.data.type !== 'need-token') return;
      // The worker only asks when it has nothing usable, so republishing the same dead
      // token would leave its retry no better off. Renew first when ours is gone too;
      // acquire() is single-flight, so a burst of these costs one round trip.
      if (haveToken()) publishToken();
      else acquire(false).catch(() => publishToken());
    });
    // A ServiceWorkerContainer buffers message events until startMessages() is called when
    // you use addEventListener rather than .onmessage — without this the worker's
    // 'need-token' request is never answered and its reads go out unauthenticated.
    navigator.serviceWorker.startMessages();
    // A controller can arrive after we already hold a token (first load, or an update).
    navigator.serviceWorker.addEventListener('controllerchange', publishToken);
  } catch (_) { /* ditto */ }

  // Cache Storage is disk-backed and outlives the tab. The durable copy is only there to
  // survive a service-worker restart DURING a session, so drop it as the page goes away
  // rather than leaving a live bearer token in the profile directory until someone
  // happens to sign in again. 'pagehide' fires on close and on bfcache eviction, where
  // 'beforeunload' and 'unload' are unreliable.
  //
  // ...and put it back on the way in. 'pagehide' also fires when the page goes into the
  // bfcache, which it comes BACK from — with its in-memory token intact but the durable
  // copy deleted. A service worker restarted in that window (the browser kills idle ones
  // freely) then found Cache Storage empty and had nothing to sign DuckDB's reads with,
  // and DuckDB reports that as "Failed to open file", not as an auth problem. 'pageshow'
  // is the only event that fires on a bfcache restore.
  try {
    window.addEventListener('pagehide', () => { forgetDurableToken(); });
    const rearm = () => { if (haveToken()) publishToken(); };
    window.addEventListener('pageshow', rearm);
    // Belt and braces for the other way a worker can die under a live page: the tab sat in
    // the background long enough to be frozen. Cheap — publishToken is a no-op write when
    // the value hasn't changed, and nothing awaits it.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') rearm();
    });
  } catch (_) { /* no window (tests) — nothing to clean up */ }

  // MSAL hands back `expiresOn` as a Date; fall back to a conservative 50 minutes if a
  // response ever omits it (OneLake tokens are ~60-90 min).
  function keep(result) {
    _token = result.accessToken;
    _expiresAt = result.expiresOn ? result.expiresOn.getTime() : Date.now() + 50 * 60 * 1000;
    scheduleRenewal();
    return publishToken();
  }
  function haveToken() {
    return !!_token && Date.now() < _expiresAt - EXPIRY_SKEW_MS;
  }
  function drop() {
    _token = null;
    _expiresAt = 0;
    clearTimeout(_renewTimer);
    _renewTimer = null;
    return publishToken();   // stop the worker signing reads with a token we know is dead
  }

  // Renew BEFORE the token dies, rather than waiting to be told it has.
  //
  // Nothing else can do this. DuckDB's parquet range reads are signed by sw.js and never
  // pass through data.js's fetch wrapper, so the 401-and-retry path does not cover them:
  // once the token expired mid-session, every query failed, the gate never came back, and
  // only a page reload fixed it. A timer is the only thing that sees the whole session.
  function scheduleRenewal() {
    clearTimeout(_renewTimer);
    if (!_expiresAt) return;
    // Half the remaining skew window, so a renewal that itself fails still leaves time for
    // the 401 path to try again before anything actually expires.
    const delay = Math.max(30_000, _expiresAt - EXPIRY_SKEW_MS - Date.now() - EXPIRY_SKEW_MS / 2);
    _renewTimer = setTimeout(() => {
      // Not through refresh(): a silent renewal that fails here is not proof the session
      // is over (the tab may just be offline), and re-gating the UI on that would be rude.
      // The 401 path will re-gate if it turns out to matter.
      acquire(false).catch(() => {});
    }, delay);
  }

  // Lazy-load msal-browser only when this provider is actually used, so a no-auth
  // deploy never fetches it.
  async function initMsal() {
    if (_msalApp) return;
    const msal = await import(MSAL_ESM);
    _msalApp = new msal.PublicClientApplication(MSAL_CONFIG);
    await _msalApp.initialize();
    // Process a redirect response if we're returning from acquireTokenRedirect.
    const resp = await _msalApp.handleRedirectPromise();
    if (resp && resp.account) {
      _msalApp.setActiveAccount(resp.account);
      keep(resp);
    }
    const acct = _msalApp.getActiveAccount() || _msalApp.getAllAccounts()[0];
    if (acct) _msalApp.setActiveAccount(acct);
  }

  // Acquire a OneLake token. interactive=true navigates the whole tab to Microsoft and back.
  // Returns true if we now hold a usable token, false if interactive sign-in is still needed (or
  // has been kicked off — acquireTokenRedirect navigates away and never resolves).
  //
  // SINGLE-FLIGHT. Loading a table fires many requests at once, so they expire together and
  // call in together. Without this, the second caller's drop() runs after the first caller
  // has already stored a fresh token — publishing a null to the worker and deleting the
  // durable copy, so any DuckDB read in that window went out unauthenticated and failed
  // with no retry path. Concurrent callers now share one attempt and one answer.
  function acquire(interactive) {
    if (_inflight) return _inflight;
    _inflight = acquireOnce(interactive).finally(() => { _inflight = null; });
    return _inflight;
  }

  // NOTE: keep()/drop() return the durable-write promise, but nothing on this path awaits
  // it. The ORDER of Cache Storage writes is guaranteed by the serialised _publishChain
  // either way; awaiting would additionally make sign-in block on storage I/O, and a
  // browser whose Cache API stalls (storage pressure, policy, private mode) would then
  // hang the whole boot at "Loading…". The postMessage fast path has already delivered
  // the token by the time these return.
  async function acquireOnce(interactive) {
    await initMsal();
    if (haveToken()) return true;
    drop();                          // expired or explicitly invalidated — never reuse it
    const account = _msalApp.getActiveAccount();
    if (account) {
      try {
        // Uses MSAL's cached refresh token: silent, no redirect, no user interaction.
        keep(await _msalApp.acquireTokenSilent({ scopes: OL_SCOPES, account }));
        return true;
      } catch (e) { /* fall through */ }
    }
    try {
      const r = await _msalApp.ssoSilent({ scopes: OL_SCOPES });
      _msalApp.setActiveAccount(r.account);
      keep(r);
      return true;
    } catch (e) { /* no usable session -> need interaction */ }
    if (!interactive) return false;
    await _msalApp.acquireTokenRedirect({ scopes: OL_SCOPES });   // navigates away
    return false;
  }

  return {
    mode: 'msal',
    ensureSession(interactive) { return acquire(interactive); },
    getHeaders() { return _token ? { Authorization: 'Bearer ' + _token } : {}; },
    // Signed-in identity for telemetry/logging — UPN (e.g. user@tenant), falling back to the
    // stable homeAccountId, or null before sign-in.
    getUserId() {
      const a = _msalApp && _msalApp.getActiveAccount();
      return (a && (a.username || a.homeAccountId)) || null;
    },
    // Called by the data layer when OneLake answers 401. The token the caller used is known
    // bad, so drop it before re-acquiring — otherwise acquire() would hand the same dead
    // token straight back and the retry would fail identically.
    //
    // `staleToken` is what the failed request actually sent. Pass it: with requests in
    // flight in parallel, a 401 raised against the OLD token can arrive after someone else
    // has already renewed, and dropping the good token because of it starts the whole cycle
    // again. If the token has already moved on, the caller just needs to retry.
    refresh(staleToken) {
      if (staleToken && _token && staleToken !== 'Bearer ' + _token) return Promise.resolve(true);
      if (_refreshing) return _refreshing;
      _refreshing = (async () => {
        drop();   // not awaited — see the note above acquireOnce()
        // An acquire() that was already in flight when we dropped may have decided
        // "haveToken() → true" BEFORE the drop, so its answer is about a token that no
        // longer exists. Let it settle, then start a fresh attempt of our own — the
        // single-flight slot is free again once it resolves.
        if (_inflight) { try { await _inflight; } catch (_) {} }
        let ok = false;
        try { ok = await acquire(false); } catch (e) { ok = false; }
        // Silent renewal failed (refresh token expired / account removed): the session is over
        // and only a full interactive sign-in can fix it. Let the UI re-gate rather than letting
        // the caller surface an opaque HTTP error.
        if (!ok && onExpired) { try { onExpired(); } catch (e) { /* UI callback must not throw here */ } }
        return ok;
      })().finally(() => { _refreshing = null; });
      return _refreshing;
    },

    // Forget the session. Without this there was no way, from inside the app, to get rid of
    // a bearer token that Cache Storage had already written to disk. The one place the
    // durable delete IS worth waiting for — but bounded, so a stalled Cache API degrades
    // to "the token ages out on disk" instead of a sign-out button that hangs forever.
    // The locally cached table data goes with it: signing out means leaving neither the
    // credential nor the data it fetched behind on this machine.
    async signOut() {
      const bound = p => Promise.race([p, new Promise(r => setTimeout(r, 2000))]);
      await bound(drop());
      await bound(forgetDurableToken());
      await bound(caches.delete('onelake-data-v1').catch(() => {}));
      try { if (_msalApp) await _msalApp.logoutRedirect(); } catch (_) { /* navigates away */ }
    },

    // The durable copy exists so a restarted service worker can keep signing DuckDB's
    // reads mid-session. Once the page is going away nothing needs it, and leaving a live
    // OneLake token in the profile directory is not a trade worth making.
    forgetDurableToken,
  };
}

// Does this failure mean "nobody has consented to this registration's Azure Storage
// permission"? That case gets an actionable block on the gate (the registration form)
// rather than a sentence, so app.js needs to recognise it.
export function isConsentError(e) {
  const msg = (e && e.message) || String(e);
  return /AADSTS65001|AADSTS90094|AADSTS900941|consent_required|interaction_required/.test(msg);
}

// Turn an MSAL/Entra failure into something that names the fix. These are the setup
// mistakes this app can actually produce; anything else falls through unchanged.
export function describeAuthError(e) {
  const msg = (e && e.message) || String(e);
  const uri = appRedirectUri();
  if (/AADSTS9002326/.test(msg))
    return `This app's redirect URI is registered under the wrong platform in Entra. It must be added under "Single-page application", not "Web" or "Mobile & desktop applications". (${uri})`;
  if (/AADSTS50011|redirect_uri/i.test(msg))
    return `${uri} is not a registered redirect URI. Add it to the app registration under Authentication -> Single-page application.`;
  if (isConsentError(e))
    return 'That registration has no consent for Azure Storage. Add the delegated permission Azure Storage -> user_impersonation to it in Entra; if your tenant blocks user consent, an admin grants it once from the registration\'s API permissions page.';
  if (/AADSTS700016|unauthorized_client/.test(msg))
    return 'That application ID is not an app this tenant can sign in to. Check the clientId, and that the registration lives in the tenant you signed in against.';
  if (/AADSTS50020/.test(msg))
    return 'That account cannot sign in here. Use a work or school (Entra) account — personal Microsoft accounts have no OneLake.';
  if (/redirect_in_iframe|BrowserAuthError: redirect_in_iframe/.test(msg))
    return 'Sign-in cannot run inside the Fabric portal frame. Open this app in its own browser tab.';
  return msg;
}

// Pick the provider. 'none' must be explicit — no clientId is not a request for anonymous
// access, it just means nobody has named a registration yet.
export function createAuth(cfg = {}, { onStatus, onExpired } = {}) {
  if (cfg.auth === 'none') return createNoAuth();
  if (!cfg.clientId) {
    // The ordinary first run. app.js opens the registration form on the strength of an empty
    // cfg.clientId, so this message is only a backstop for a path that reaches the provider.
    return createConfigErrorAuth(
      'This app has no Entra registration of its own. Point it at one in your tenant to reach ' +
      'OneLake — the sign-in screen asks for it, and README.md has the two-minute recipe.',
      'unconfigured'
    );
  }
  if (!(cfg.authority || cfg.tenantId)) {
    return createConfigErrorAuth(
      'A clientId is set but the authority is missing, so this app cannot get a OneLake token. ' +
      'See "Signing in" in README.md.'
    );
  }
  return createMsalAuth(cfg, { onExpired });
}
