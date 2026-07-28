// Runtime config, served as-is to the deployed app (build.mjs copies site/ -> dist/).
//
// `clientId` is EMPTY BY DESIGN. This app ships no Entra registration of its own — reaching
// OneLake means pointing it at a registration in your own tenant, which the sign-in gate asks
// for on first use and remembers (see the bring-your-own block in auth.js). A registration is
// a standing capability in whoever's directory consents to it, and the app that reads your
// lakehouse should be one you control: your tenant, your redirect URIs, your revocation.
//
// Setting `clientId` here is still supported and is the right move for a private fork or an
// internal deploy — an org-owned registration, pinned by putting the tenant GUID in
// `authority`. A value here becomes the default; a user's own choice still overrides it.
//
// Nothing in this file is a secret. The clientId of an Entra SPA public client is public the
// moment anyone loads the page (MSAL puts it in every sign-in URL), and SPA + PKCE uses no
// client secret. See "Signing in" in README.md for the registration recipe.
window.ONELAKE_STUDIO_CONFIG = {
  // 'msal' = Entra sign-in + OneLake bearer token. 'none' = no auth (public data only).
  auth: "msal",

  // No built-in registration: the user supplies one. See README.md.
  clientId: "",
  // Default authority when only a clientId is given. 'organizations' = sign in against your
  // own work/school directory; a tenant GUID here instead pins the app to one directory.
  authority: "organizations",

  // Optional: pre-fill the lakehouse path box, e.g. "myworkspace/mylakehouse.Lakehouse".
  defaultLakehouse: "",
};
