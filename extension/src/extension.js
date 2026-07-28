'use strict';
// =============================================================================
// extension.js — activation, and the reason this extension exists
// =============================================================================
// The web app cannot sign a user in without them first registering an Entra SPA
// application in their own tenant, and there is no way around that in a browser:
// Entra only sends CORS headers for auth-code+PKCE against an `spa`-typed redirect
// URI, so device code flow is not available to a page either.
//
// In VS Code none of that applies. getSession('microsoft', …) goes through VS Code's
// own first-party application, which can impersonate for Azure resources — so the
// user signs in with the same prompt they already use for GitHub, and registers
// nothing. `offline_access` is what makes the session survive a reload; without it
// the refresh token is not issued and every restart is a fresh sign-in.
// =============================================================================

const vscode = require('vscode');
const { startProxy } = require('./proxy');
const { openPanel } = require('./panel');

// The same scope site/auth.js asks MSAL for. OneLake accepts tokens in the storage
// audience only, and this one covers both the data reads and the Iceberg catalog.
const SCOPES = ['https://storage.azure.com/user_impersonation', 'offline_access'];

function scopesFor() {
  const tenant = vscode.workspace.getConfiguration('onelakeStudio').get('tenantId', '').trim();
  // A guest in someone else's tenant needs to say so; the home tenant is the default.
  return tenant ? [...SCOPES, `VSCODE_TENANT:${tenant}`] : SCOPES;
}

// createIfNone only on the first call, from the command handler. The proxy's per-request
// calls must never prompt: DuckDB fires requests in bursts, and a prompt per request
// would be unusable.
function getToken(createIfNone) {
  return vscode.authentication.getSession('microsoft', scopesFor(), { createIfNone })
    .then(s => (s && s.accessToken) || null, () => null);
}

let proxy = null;

async function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('onelakeStudio.open', async () => {
      try {
        const token = await getToken(true);
        if (!token) {
          vscode.window.showWarningMessage(
            'OneLake Studio needs a Microsoft account to reach OneLake. Sign-in was cancelled.');
          return;
        }
        if (!proxy) {
          proxy = await startProxy({ getToken: () => getToken(false) });
          context.subscriptions.push({ dispose: () => proxy && proxy.close() });
        }
        await openPanel(context, proxy);
      } catch (e) {
        vscode.window.showErrorMessage(`OneLake Studio could not start: ${(e && e.message) || e}`);
      }
    }),
    // Signing out, or switching account, invalidates whatever the panel is holding. The
    // proxy picks the new token up by itself on the next request; this is only here so the
    // failure is a sentence rather than a wall of 401s.
    vscode.authentication.onDidChangeSessions(e => {
      if (e.provider.id === 'microsoft' && proxy) {
        vscode.window.setStatusBarMessage('OneLake Studio: Microsoft account changed', 4000);
      }
    }),
  );
}

function deactivate() {
  return proxy ? proxy.close() : undefined;
}

module.exports = { activate, deactivate };
