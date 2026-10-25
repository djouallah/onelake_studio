// =============================================================================
// auth.js — the panel's sign-in: there is none
// =============================================================================
// Inside VS Code the page holds no credential at all. The extension host signs every
// OneLake read (src/proxy.js, and native DuckDB in src/engine-host.js) with VS Code's own
// Microsoft account, and panel.js injects `auth: 'none'`. So the whole MSAL provider the
// website needs (site/auth.js) never ran here — it was 450 lines shipped in every vsix and
// reachable by nothing.
//
// What remains is the same SURFACE app.js imports from the website's auth.js, so the two
// apps keep one shape: a provider that is always "signed in", and harmless answers for the
// registration helpers app.js only reaches on the website's sign-in screen.
// =============================================================================

// The page's own address, minus index.html — what app.js reloads to.
export function appRedirectUri() {
  return window.location.origin + window.location.pathname.replace(/index\.html$/, '');
}

// No registration exists in the panel; the config is taken as injected.
export function resolveConfig(base = {}) {
  return { ...base, byo: false };
}
export function saveOverride() {}
export function clearOverride() {}

export function isConsentError() { return false; }
export function describeAuthError(e) { return (e && e.message) || String(e); }

// Always 'none' here. Kept as a function so app.js reads the same as the website's.
export function createAuth() {
  return {
    mode: 'none',
    async ensureSession() { return true; },
    getHeaders() { return {}; },
    getUserId() { return null; },
    async refresh() { return true; },
    async signOut() {},
    async forgetDurableToken() {},
  };
}
