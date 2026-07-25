// Runtime config, served as-is to the deployed app (build.mjs copies site/ -> dist/).
//
// These identifiers are TRACKED IN GIT ON PURPOSE. The `clientId` of an Entra SPA public
// client is not a secret — MSAL puts it in the URL of every sign-in redirect, so it is
// public the moment anyone loads the page. There is no client secret anywhere in this app
// (SPA + PKCE doesn't use one). Committing it is what makes a fresh clone deploy a working
// app instead of a silently unauthenticated one.
//
// The registration is MULTI-TENANT, so `authority` is 'organizations' rather than a tenant
// GUID: any work/school account signs in against its own directory and reads OneLake with
// its own permissions. Users register nothing. First sign-in from a tenant other than the
// app's home tenant shows a one-time consent prompt ("Access Azure Storage as you"); see
// README.md for the admin-consent URL that removes it org-wide.
//
// Forking this? Replace clientId with your own SPA registration's Application (client) ID.
window.RAYFIN_WASM_CONFIG = {
  // 'msal' = Entra sign-in + OneLake bearer token. 'none' = no auth (public data only).
  auth: "msal",

  clientId: "cbc29592-5f49-45ac-8a69-ca6d7030ab74",

  // 'organizations' = any Entra tenant (multi-tenant app). Use a tenant GUID to pin
  // sign-in to a single directory.
  authority: "organizations",

  // Optional: pre-fill the lakehouse path box, e.g. "myworkspace/mylakehouse.Lakehouse".
  defaultLakehouse: "",
};
