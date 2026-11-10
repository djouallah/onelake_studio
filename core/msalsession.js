'use strict';
// =============================================================================
// msalsession.js — a session with no editor to ask for one
// =============================================================================
// What signin.js asks of an account provider, answered by MSAL. No app registration: this signs in as
// the Azure CLI's public client, which is also what Microsoft's Azure Identity SDK does when it's given
// no client id. Tested on real tenants, for the storage, Fabric and Power BI audiences alike.
//
// A session's account id is MSAL's homeAccountId, as it is in VS Code's provider, so the same person
// has one account key (signin.js) and one cache, with VS Code open or not.
// =============================================================================

const { spawn } = require('node:child_process');

const CLIENT_ID = '04b07795-8ddb-461a-bbee-02f9e1bf7b46';
const NO_ANSWER = /network|fetch failed|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONN|socket hang up/i;

const DONE_PAGE = '<!doctype html><title>OneLake Studio</title><p>Signed in to OneLake Studio. You can close this tab.</p>';
const FAILED_PAGE = '<!doctype html><title>OneLake Studio</title><p>OneLake Studio could not sign in. The command line says why.</p>';

// The system's browser, however it is set up. A URL is an argument here, never a shell's to read.
async function openInBrowser(url) {
  const [cmd, args] = process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
}

// This client asks for a resource's .default: what the tenants it was tested on granted.
const scopesFor = scopes => scopes.filter(s => s !== 'offline_access').map(s => s.replace(/\/user_impersonation$/, '/.default'));

const sessionOf = r => ({ accessToken: r.accessToken, account: { id: r.account.homeAccountId, label: r.account.username } });

/**
 * @param {object} o
 * @param {() => string} o.tenant  the tenant asked for, or '' for the account's own
 * @param {{ read: Function, write: Function, clear: Function }} o.store  tokenstore.js
 * @param {(url: string) => Promise<void>} [o.openBrowser]
 * @param {() => object} [o.msal]  the library, which only a sign-in needs: stands in for it in a test
 */
function createMsalSession({ tenant, store, openBrowser = openInBrowser, msal = () => require('@azure/msal-node') }) {
  let app = null, appAuthority = null;

  function application() {
    const authority = `https://login.microsoftonline.com/${tenant() || 'organizations'}`;
    if (app && appAuthority === authority) return app;
    const { PublicClientApplication } = msal();
    appAuthority = authority;
    app = new PublicClientApplication({
      auth: { clientId: CLIENT_ID, authority },
      cache: {
        cachePlugin: {
          beforeCacheAccess: async c => { const text = await store.read(); if (text) c.tokenCache.deserialize(text); },
          afterCacheAccess: async c => { if (c.cacheHasChanged) await store.write(c.tokenCache.serialize()); },
        },
      },
    });
    return app;
  }

  /** As VS Code's provider answers: a session, or null when asking would need a person. */
  async function session(scopes, { createIfNone = false, account = null, clearSessionPreference = false } = {}) {
    const wanted = scopesFor(scopes);
    const pca = application();
    const accounts = await pca.getTokenCache().getAllAccounts();
    const found = account ? accounts.find(a => a.homeAccountId === account.id) : accounts[0];
    // Switch Account asks for a choice, not for whoever was last.
    if (found && !clearSessionPreference) {
      try { return sessionOf(await pca.acquireTokenSilent({ scopes: wanted, account: found })); }
      catch (e) {
        // No answer says nothing about who is signed in. Anything else needs them to sign in again.
        if (NO_ANSWER.test(`${e && e.errorCode} ${e && e.message}`)) throw e;
      }
    }
    if (!createIfNone) return null;
    const r = await pca.acquireTokenInteractive({
      scopes: wanted, openBrowser,
      ...(account ? { loginHint: account.label } : { prompt: 'select_account' }),
      successTemplate: DONE_PAGE, errorTemplate: FAILED_PAGE,
    });
    // One account at a time: the one just signed in as is the one asked for next.
    if (!account) {
      const cache = pca.getTokenCache();
      for (const a of await cache.getAllAccounts()) if (a.homeAccountId !== r.account.homeAccountId) await cache.removeAccount(a);
    }
    return sessionOf(r);
  }

  return {
    session,
    /** One account at a time: the one just signed in as. */
    async keepOnly(id) {
      const cache = application().getTokenCache();
      for (const a of await cache.getAllAccounts()) if (a.homeAccountId !== id) await cache.removeAccount(a);
    },
    async clear() {
      await store.clear();
      app = null;
    },
  };
}

module.exports = { createMsalSession, scopesFor, CLIENT_ID };
