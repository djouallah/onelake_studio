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
// REDIRECT auth (not popup): the coi-serviceworker sets COOP: same-origin to get
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
      redirectUri: window.location.origin,
    },
    cache: { cacheLocation: 'localStorage' },
  };

  let _msalApp = null;
  let _token = null;
  let _expiresAt = 0;

  // MSAL hands back `expiresOn` as a Date; fall back to a conservative 50 minutes if a
  // response ever omits it (OneLake tokens are ~60-90 min).
  function keep(result) {
    _token = result.accessToken;
    _expiresAt = result.expiresOn ? result.expiresOn.getTime() : Date.now() + 50 * 60 * 1000;
  }
  function haveToken() {
    return !!_token && Date.now() < _expiresAt - EXPIRY_SKEW_MS;
  }
  function drop() {
    _token = null;
    _expiresAt = 0;
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

// Turn an MSAL/Entra failure into something that names the fix. These are the setup
// mistakes this app can actually produce; anything else falls through unchanged.
export function describeAuthError(e) {
  const msg = (e && e.message) || String(e);
  const origin = window.location.origin;
  if (/AADSTS9002326/.test(msg))
    return `This app's redirect URI is registered under the wrong platform in Entra. It must be added under "Single-page application", not "Web" or "Mobile & desktop applications". (${origin})`;
  if (/AADSTS50011|redirect_uri/i.test(msg))
    return `${origin} is not a registered redirect URI. Add it to the app registration under Authentication -> Single-page application.`;
  if (/AADSTS65001|AADSTS90094|consent_required/.test(msg))
    return 'Admin consent for the Azure Storage "user_impersonation" permission has not been granted for this tenant. An Entra admin needs to grant it once on the app registration.';
  if (/AADSTS700016|unauthorized_client/.test(msg))
    return 'The clientId in config.js is not an application this tenant can sign in to. Check clientId.';
  if (/AADSTS50020/.test(msg))
    return 'That account cannot sign in here. Use a work or school (Entra) account — personal Microsoft accounts have no OneLake.';
  if (/redirect_in_iframe|BrowserAuthError: redirect_in_iframe/.test(msg))
    return 'Sign-in cannot run inside the Fabric portal frame. Open this app in its own browser tab.';
  return msg;
}

// Pick the provider. 'none' must be explicit — a missing clientId/tenantId is a broken
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
