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
const { openPanel, closePanel } = require('./panel');

// The same scope site/auth.js asks MSAL for. OneLake accepts tokens in the storage
// audience only, and this one covers both the data reads and the Iceberg catalog.
const SCOPES = ['https://storage.azure.com/user_impersonation', 'offline_access'];

function scopesFor() {
  const tenant = vscode.workspace.getConfiguration('onelakeStudio').get('tenantId', '').trim();
  // A guest in someone else's tenant has to say so; the home tenant is the default.
  return tenant ? [...SCOPES, `VSCODE_TENANT:${tenant}`] : SCOPES;
}

// `options` is passed straight through: the command handler asks with createIfNone (and,
// for a switch, clearSessionPreference), while the proxy's per-request calls ask for
// neither. That matters — DuckDB fires requests in bursts, and a prompt per request
// would be unusable.
function getToken(options) {
  return vscode.authentication.getSession('microsoft', scopesFor(), options)
    .then(s => (s && s.accessToken) || null, () => null);
}

let proxy = null;

async function ensureProxy(context) {
  if (!proxy) {
    proxy = await startProxy({ getToken: () => getToken({ createIfNone: false }) });
    context.subscriptions.push({ dispose: () => proxy && proxy.close() });
  }
  return proxy;
}

async function show(context, options) {
  const token = await getToken(options);
  if (!token) {
    vscode.window.showWarningMessage(
      'OneLake Studio needs a Microsoft account to reach OneLake. Sign-in was cancelled.');
    return;
  }
  await openPanel(context, await ensureProxy(context));
}

async function activate(context) {
  // The activity-bar view is empty by design — its whole content is the welcome buttons in
  // package.json. Registering a provider anyway, because a contributed view with none logs
  // a warning on every activation.
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('onelakeStudio.start', {
      getChildren: () => [],
      getTreeItem: item => item,
    }),

    vscode.commands.registerCommand('onelakeStudio.open', async () => {
      try {
        await show(context, { createIfNone: true });
      } catch (e) {
        vscode.window.showErrorMessage(`OneLake Studio could not start: ${(e && e.message) || e}`);
      }
    }),

    // VS Code owns the account, so an extension cannot sign anyone out — that is the
    // Accounts menu in the bottom left. What it CAN do is stop reusing the remembered
    // choice, which is what someone with two tenants actually wants.
    vscode.commands.registerCommand('onelakeStudio.switchAccount', async () => {
      try {
        // Closed before asking: whichever account is picked, the panel on screen belongs to
        // the previous one, and its cached tables should not survive the switch.
        closePanel();
        await show(context, { createIfNone: true, clearSessionPreference: true });
      } catch (e) {
        vscode.window.showErrorMessage(`Could not switch account: ${(e && e.message) || e}`);
      }
    }),

    // Covers the other direction: signing out from the Accounts menu, or a token revoked
    // elsewhere. The proxy picks up whatever is current on its next request by itself, so
    // this only exists to make the failure a sentence instead of a wall of 401s.
    vscode.authentication.onDidChangeSessions(async e => {
      if (e.provider.id !== 'microsoft' || !proxy) return;
      if (!await getToken({ createIfNone: false })) {
        closePanel();
        vscode.window.showInformationMessage(
          'OneLake Studio signed out — the Microsoft account is no longer available.');
      }
    }),
  );
}

function deactivate() {
  return proxy ? proxy.close() : undefined;
}

module.exports = { activate, deactivate };
