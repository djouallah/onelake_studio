// Runtime config, served as-is to the deployed app (build.mjs copies site/ -> dist/).
//
// These identifiers are TRACKED IN GIT ON PURPOSE. The `clientId` of an Entra SPA public
// client is not a secret — MSAL puts it in the URL of every sign-in redirect, so it is
// public the moment anyone loads the page. There is no client secret anywhere in this app
// (SPA + PKCE doesn't use one). Committing it is what makes a fresh clone deploy a working
// app instead of a silently unauthenticated one.
//
// The registration is SINGLE-TENANT, in the same tenant as the OneLake data, and that is
// deliberate: this tenant's consent policy (microsoft-user-default-recommended) lets a user
// self-consent to Azure Storage for an app registered in their own directory, but blocks
// unverified apps from any other directory with "Need admin approval". A multi-tenant app
// registered elsewhere cannot be signed into here without an Entra admin. So users register
// nothing and need no admin — they click Sign in and accept one consent prompt.
//
// Forking this into another tenant? Replace both values with your own SPA registration's
// Application (client) ID and Directory (tenant) ID.
window.RAYFIN_WASM_CONFIG = {
  // 'msal' = Entra sign-in + OneLake bearer token. 'none' = no auth (public data only).
  auth: "msal",

  clientId: "43d4d19c-e393-4020-9b31-b3c3b272af3a",
  tenantId: "4a86d5bb-4173-45ee-bfd5-a3b56ee2d3d5",

  // Optional: pre-fill the lakehouse path box, e.g. "myworkspace/mylakehouse.Lakehouse".
  defaultLakehouse: "",
};
