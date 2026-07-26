// Runtime config, served as-is to the deployed app (build.mjs copies site/ -> dist/).
//
// These identifiers are TRACKED IN GIT ON PURPOSE. The `clientId` of an Entra SPA public
// client is not a secret — MSAL puts it in the URL of every sign-in redirect, so it is
// public the moment anyone loads the page. There is no client secret anywhere in this app
// (SPA + PKCE doesn't use one). Committing it is what makes a fresh clone deploy a working
// app instead of a silently unauthenticated one.
//
// The registration is MULTI-TENANT (`authority: "organizations"`), so anyone with a work or
// school account can sign in with their own identity and see their own OneLake. It is not
// publisher-verified yet, and many tenants' consent policy blocks user consent to an
// unverified app from another directory with "Need admin approval". Two answers, both
// offered on the sign-in gate: an admin grants consent once (one URL), or the user points
// the app at their own registration with ?clientId=…&tenantId=… (see auth.js).
window.ONELAKE_STUDIO_CONFIG = {
  // 'msal' = Entra sign-in + OneLake bearer token. 'none' = no auth (public data only).
  auth: "msal",

  // "OneLake Studio" SPA registration in projectscontrols.com, multi-tenant.
  clientId: "cbc29592-5f49-45ac-8a69-ca6d7030ab74",
  // 'organizations' = any work/school tenant signs in against its own directory. A tenant
  // GUID here instead would pin the app to one directory.
  authority: "organizations",

  // Optional: pre-fill the lakehouse path box, e.g. "myworkspace/mylakehouse.Lakehouse".
  defaultLakehouse: "",
};
