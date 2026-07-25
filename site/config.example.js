// LOCAL DEV ONLY. Copy this file to `config.js` (same folder) and fill in values.
// config.js is gitignored so your identifiers stay out of the repo.
//
// When deployed to Microsoft Fabric via Rayfin, you do NOT need this file:
// Rayfin's managed auth (services.auth.fabric.enabled in rayfin/rayfin.yml)
// injects window.RAYFIN_WASM_CONFIG with a managed clientId/tenantId, and you
// sign in with your own Entra identity — no app registration required.
//
// For localhost development there is no Rayfin host to inject config, so register
// a throwaway Entra SPA app (public client, redirect URI http://localhost:5173)
// with the delegated permission Azure Storage / user_impersonation, and put its
// ids here.
window.RAYFIN_WASM_CONFIG = {
  // 'msal' = Entra ID sign-in + OneLake bearer token. 'none' = no auth (public data).
  // If omitted, inferred: 'msal' when clientId+tenantId are set, otherwise 'none'.
  auth: "msal",

  clientId: "<your-entra-spa-app-client-id>",
  tenantId: "<your-entra-tenant-id>",

  // Optional: pre-fill the lakehouse path box, e.g.
  //   "myworkspace/mylakehouse.Lakehouse"
  defaultLakehouse: "",
};
