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

// --- Bring-your-own registration --------------------------------------------
// This app's registration is multi-tenant but not publisher-verified, so a tenant on
// the recommended consent policy answers "Need admin approval" until an admin grants
// consent once. That shouldn't be a dead end: anyone can point the app at their own
// SPA registration instead, with no deploy and no fork.
//
//   ?clientId=<guid>&tenantId=<guid>   -> use that registration from now on
//
// Kept in localStorage because MSAL's redirect returns to the bare redirect URI and
// drops the query string — and because the choice should survive a later visit.
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
// A URL parameter wins and is persisted; otherwise the saved override wins over the
// built-in registration. Returns { ...cfg, byo } so the UI can say which one is in use.
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

// One-click fix for a tenant that blocks user consent: an admin opens this, signs in,
// and grants the Azure Storage permission for the whole tenant, once.
export function adminConsentUrl(cfg) {
  return 'https://login.microsoftonline.com/organizations/adminconsent' +
    `?client_id=${encodeURIComponent(cfg.clientId)}` +
    `&redirect_uri=${encodeURIComponent(appRedirectUri())}`;
}

// Treat a token this close to expiry as already gone. Loading a table can mean dozens
// of parquet fetches over several minutes; renewing up front beats failing half way.
const EXPIRY_SKEW_MS = 5 * 60 * 1000;

// --- No-auth provider: everything is already accessible. ---
function createNoAuth() {
  return {
    mode: 'none',
    async ensureSession() { return true; },
    getHeaders() { return {}; },
    getUserId() { return 'anonymous'; },
    async refresh() { return true; },
  };
}

// --- Misconfigured provider: msal was asked for but the identifiers are missing. ---
// Fails loudly and early. The alternative (falling back to no-auth) produces a UI that
// looks signed-in and then answers every OneLake request with a bare HTTP 401.
function createConfigErrorAuth(message) {
  return {
    mode: 'error',
    async ensureSession() { throw new Error(message); },
    getHeaders() { return {}; },
    getUserId() { return null; },
    async refresh() { return false; },
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

  // --- Token bridge to the service worker (sw.js) ---------------------------
  // DuckDB range-reads parquet straight from OneLake URLs, and its API can't set
  // headers, so sw.js signs those requests instead. It only ever holds the token in
  // memory, so push it on every change and answer 'need-token' if the worker was
  // restarted and lost it.
  // Cache Storage is the durable channel: the browser terminates an idle service worker
  // whenever it likes (reliably so during DuckDB's multi-MB WASM download), and a token
  // kept only in its memory is gone by the time the parquet reads start. postMessage is
  // kept as the fast path for the common case.
  function publishToken() {
    try {
      const c = navigator.serviceWorker && navigator.serviceWorker.controller;
      if (c) c.postMessage({ type: 'onelake-token', token: _token });
    } catch (_) { /* no service worker — reads will 401 and say so */ }
    try {
      caches.open('onelake-token').then(c =>
        _token ? c.put('/__onelake_token', new Response(_token)) : c.delete('/__onelake_token')
      ).catch(() => {});
    } catch (_) { /* ditto */ }
  }
  try {
    navigator.serviceWorker.addEventListener('message', e => {
      if (e.data && e.data.type === 'need-token') publishToken();
    });
    // A ServiceWorkerContainer buffers message events until startMessages() is called when
    // you use addEventListener rather than .onmessage — without this the worker's
    // 'need-token' request is never answered and its reads go out unauthenticated.
    navigator.serviceWorker.startMessages();
    // A controller can arrive after we already hold a token (first load, or an update).
    navigator.serviceWorker.addEventListener('controllerchange', publishToken);
  } catch (_) { /* ditto */ }

  // MSAL hands back `expiresOn` as a Date; fall back to a conservative 50 minutes if a
  // response ever omits it (OneLake tokens are ~60-90 min).
  function keep(result) {
    _token = result.accessToken;
    _expiresAt = result.expiresOn ? result.expiresOn.getTime() : Date.now() + 50 * 60 * 1000;
    publishToken();
  }
  function haveToken() {
    return !!_token && Date.now() < _expiresAt - EXPIRY_SKEW_MS;
  }
  function drop() {
    _token = null;
    _expiresAt = 0;
    publishToken();   // stop the worker signing reads with a token we know is dead
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
  async function acquire(interactive) {
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
    // Called by the data layer when OneLake answers 401/403. The current token is known bad,
    // so drop it before re-acquiring — otherwise acquire() would hand the same dead token
    // straight back and the retry would fail identically.
    async refresh() {
      drop();
      let ok = false;
      try { ok = await acquire(false); } catch (e) { ok = false; }
      // Silent renewal failed (refresh token expired / account removed): the session is over
      // and only a full interactive sign-in can fix it. Let the UI re-gate rather than letting
      // the caller surface an opaque HTTP error.
      if (!ok && onExpired) { try { onExpired(); } catch (e) { /* UI callback must not throw here */ } }
      return ok;
    },
  };
}

// Does this failure mean "your tenant hasn't consented to this app"? That case gets an
// actionable block on the gate (admin-consent URL + bring-your-own registration) rather
// than a sentence, so app.js needs to recognise it. AADSTS50020 is here too: a foreign
// unverified app can surface the block as "user account does not exist in tenant".
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
    return 'Your tenant has not consented to this app\'s Azure Storage permission. An Entra admin can grant it once for everyone, or you can sign in with your own app registration.';
  if (/AADSTS700016|unauthorized_client/.test(msg))
    return 'That application ID is not an app this tenant can sign in to. Check the clientId.';
  if (/AADSTS50020/.test(msg))
    return 'That account cannot sign in here. Use a work or school (Entra) account — personal Microsoft accounts have no OneLake.';
  if (/redirect_in_iframe|BrowserAuthError: redirect_in_iframe/.test(msg))
    return 'Sign-in cannot run inside the Fabric portal frame. Open this app in its own browser tab.';
  return msg;
}

// Pick the provider. 'none' must be explicit — a missing clientId/authority is a broken
// deploy, not a request for anonymous access, so it gets the loud 'error' provider.
export function createAuth(cfg = {}, { onStatus, onExpired } = {}) {
  if (cfg.auth === 'none') return createNoAuth();
  if (!cfg.clientId || !(cfg.authority || cfg.tenantId)) {
    return createConfigErrorAuth(
      'site/config.js is missing clientId or authority, so this app cannot get a OneLake token. ' +
      'See the "Entra setup" section of README.md.'
    );
  }
  return createMsalAuth(cfg, { onExpired });
}
