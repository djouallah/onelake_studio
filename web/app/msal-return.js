// =============================================================================
// msal-return.js — this page as MSAL's redirect bridge
// =============================================================================
// MSAL 5 receives every sign-in answer through a "redirect bridge": the page Entra sends
// the browser back to calls broadcastResponseToMainFrame(), which hands the answer to the
// window that asked — over a BroadcastChannel for a popup or a silent-renewal iframe
// (Entra serves its pages with COOP, which leaves a popup no other way back), and through
// sessionStorage plus a navigation for a full-page redirect.
//
// The redirect URI every user registered is the app's own address, so the app page IS the
// bridge: when it loads with an authorization answer in its URL it does the bridge's job
// and nothing else — app.js sees ONELAKE_MSAL_BRIDGE and does not boot. A new
// redirect.html would have meant every existing app registration had to be edited.
//
// The bridge receives the raw authorization code, so it is loaded from this site's own
// vendored copy (cdn.js) — never a CDN — on a deployed build.
//
// A module that runs before app.js (index.html lists it first), and decides synchronously.
// =============================================================================
import { PINS, npmModule } from "./cdn.js";

const answer = (() => {
  const read = s => new URLSearchParams(s.replace(/^[#?]/, ""));
  for (const p of [read(window.location.hash), read(window.location.search)]) {
    if (p.has("state") && (p.has("code") || p.has("error"))) return true;
  }
  return false;
})();

if (answer) {
  window.ONELAKE_MSAL_BRIDGE = true;
  // MSAL retitles the page too, but only once its module has loaded; until then the tab and
  // the history entry would show the URL — authorization code included.
  document.title = "Signing in — OneLake Studio";
  import(npmModule(`${PINS.msal}/redirect-bridge`))
    .then(m => m.broadcastResponseToMainFrame())
    .catch(e => {
      console.error("[auth] could not hand the sign-in back:", e);
      document.body.textContent = "Sign-in could not be completed in this window. Close it and try again.";
    });
}
