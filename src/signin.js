'use strict';
// =============================================================================
// signin.js — who is signed in, and the tokens that come with it
// =============================================================================
// The account belongs to whoever hands in `session`: (scopes, options) => a session, as
// VS Code's account provider answers. Everything else here is what this extension
// decides about it: when to ask, how long a token is held, and whose cache it means.
// =============================================================================

const { createHash } = require('node:crypto');
const { createTokenHold } = require('./http');

// OneLake accepts tokens in the storage
// audience only, and this one covers both the data reads and the Iceberg catalog. It is
// the only scope sign-in asks for; the Fabric API's (below) is asked for separately, and
// only once someone expands a workspace's semantic models.
const SCOPES = ['https://storage.azure.com/user_impersonation', 'offline_access'];

// `options` is passed straight through: the command handler asks with createIfNone (and,
// for a switch, clearSessionPreference), while the per-request calls ask for neither.
// That matters — reads come in bursts, and a prompt per request would be unusable.
//
// VS Code owns the account, so Sign Out cannot remove it: it makes this extension stop asking for
// it, until something asks with createIfNone, which only a sign-in does (show() never prompts
// after a Sign Out, or while an account's cache is known). The decision outlives the window: a new
// one asks for no session and sends nothing to OneLake until someone signs in.
const SIGNED_OUT_KEY = 'onelakeStudio.signedOut';
const LAST_ACCOUNT_KEY = 'onelakeStudio.lastAccount';

const TOKEN_TTL_MS = 60_000;
const FABRIC_AUDIENCES = [
  'https://api.fabric.microsoft.com/.default',
  'https://analysis.windows.net/powerbi/api/.default',
];
// The SQL endpoint's audience: a DirectQuery semantic model's credentials (fabricmodel.js).
const SQL_AUDIENCE = 'https://database.windows.net/.default';

const isCancel = e => /cancel|did not consent/i.test(String((e && e.message) || e));

/**
 * @param {object} o
 * @param {(scopes: string[], options?: object) => Thenable<object>} o.session  the account provider
 * @param {() => ({ get: Function, update: Function } | null)} o.memento  what outlives a window
 * @param {() => string} o.tenant  the tenant asked for, or '' for the home one
 * @param {object} o.connectivity  connectivity.js
 * @param {(line: string) => void} o.log
 */
function createSignIn({ session, memento, tenant, connectivity, log }) {
  const signedOutByChoice = () => !!(memento() && memento().get(SIGNED_OUT_KEY, false));
  function getSession(options) {
    const signingIn = !!(options && options.createIfNone);
    if (!signingIn && signedOutByChoice()) return Promise.resolve(null);
    return session(SCOPES, options).then(s => {
      if (s && signingIn && memento()) memento().update(SIGNED_OUT_KEY, false);
      return s;
    });
  }

  // Why the last sign-in produced no token. A null used to mean "cancelled" whatever the
  // cause, so a wrong tenant or a provider failure told the user they had cancelled.
  let lastAuthError = null;

  function getToken(options) {
    return getSession(options).then(
      s => { lastAuthError = null; return (s && s.accessToken) || null; },
      e => {
        lastAuthError = e;
        log(`sign-in failed: ${(e && e.message) || e}`);
        return null;
      });
  }

  // Which identity the cache and the engine currently belong to. Hashed, so the
  // directory name says nothing about who the user is.
  function accountKey(session) {
    if (!session || !session.account) return null;
    const now = tenant();
    return createHash('sha256')
      .update(`${session.account.id}|${now}`).digest('hex').slice(0, 16);
  }

  // Which account the saved queries belong to, as their folder's name: its sign-in name and the
  // tenant setting, readable on disk (unlike accountKey's hash) — the queries are the user's own.
  function queryAccountOf(session) {
    if (!session || !session.account) return null;
    const now = tenant();
    return `${session.account.label}${now ? ` (${now})` : ''}`.replace(/[\\/:*?"<>|]+/g, '_');
  }

  // The account this machine last signed in with, in the tenant the setting names now, so its cache
  // can still be shown with no session: { key, queries }, or null.
  function knownAccount() {
    const last = memento() && memento().get(LAST_ACCOUNT_KEY, null);
    return last && last.tenant === tenant() ? last : null;
  }
  function rememberAccount(session) {
    const key = accountKey(session);
    if (!key || !memento()) return;
    const now = { key, queries: queryAccountOf(session), tenant: tenant() };
    // Every click comes through here, and this goes to disk.
    const was = memento().get(LAST_ACCOUNT_KEY);
    if (!was || was.key !== now.key || was.queries !== now.queries || was.tenant !== now.tenant) memento().update(LAST_ACCOUNT_KEY, now);
  }

  // getSession is an RPC into the account provider; asked once per request, that lookup —
  // not OneLake, not DuckDB — was most of a burst's wait. So the token is held briefly in
  // memory: long enough to collapse a burst, short enough that a stale one costs a single
  // retry (catalog.js and the engine ask again with `fresh` after a 401). Anything that can
  // change the answer clears it outright.
  const storageHold = createTokenHold(TOKEN_TTL_MS);

  function forgetToken() { storageHold.forget(); fabricHold.forget(); fabricAudience = null; appHold.forget(); sqlHold.forget(); tokenAsked = null; }

  // What is being asked of the account provider, for the burst behind the first to share.
  let tokenAsked = null;
  async function hostToken({ fresh = false } = {}) {
    // No internet: a refresh could only hang, and nothing is about to use the token.
    if (connectivity.noInternet()) return storageHold.any();
    if (!fresh && storageHold.recent()) return storageHold.recent();
    if (!fresh && tokenAsked) return tokenAsked;
    const asked = storageHold.turn();
    const asking = getToken({ createIfNone: false }).then(token => {
      storageHold.keep(asked, token);
      return token;
    }).finally(() => { if (tokenAsked === asking) tokenAsked = null; });
    if (!fresh) tokenAsked = asking;
    return asking;
  }

  // The Fabric REST API — semantic models live there, not in OneLake. It takes a token in
  // its own audience, or in Power BI's, which it also accepts; whichever VS Code's account
  // provider will issue is remembered for the session. Asked for the SAME account the
  // storage session belongs to, so the tree can never list one user's models and write into
  // another user's lakehouse.
  let fabricAudience = null;
  const fabricHold = createTokenHold(TOKEN_TTL_MS);

  // A session in `aud` for the account the storage session belongs to, never another one.
  async function sameAccountSession(aud, createIfNone, storage) {
    return session([aud, 'offline_access'], { createIfNone, account: storage.account });
  }

  async function fabricToken({ fresh = false, createIfNone = false } = {}) {
    if (!fresh && !createIfNone && fabricHold.recent()) return fabricHold.recent();
    const asked = fabricHold.turn();
    const storage = await getSession({ createIfNone: false }).catch(() => null);
    if (!storage) return null;
    let lastErr = null;
    for (const aud of fabricAudience ? [fabricAudience] : FABRIC_AUDIENCES) {
      try {
        const s = await sameAccountSession(aud, createIfNone, storage);
        if (s) {
          if (fabricHold.keep(asked, s.accessToken)) fabricAudience = aud;
          return s.accessToken;
        }
      } catch (e) {
        lastErr = e;
        log(`fabric sign-in (${aud}) failed: ${(e && e.message) || e}`);
        if (isCancel(e)) return null;   // said no once; do not ask again for the other audience
      }
    }
    if (lastErr) throw lastErr;
    return null;
  }

  // Export to Fabric's token (fabricapp.js): the Fabric API's own audience, never Power BI's —
  // the app item's workload routes are the Fabric API's. The same account as the storage
  // session, as fabricToken asks. `createIfNone` on the button's click, which may prompt.
  const appHold = createTokenHold(TOKEN_TTL_MS);
  async function appToken({ fresh = false, createIfNone = false } = {}) {
    if (!fresh && !createIfNone && appHold.recent()) return appHold.recent();
    const asked = appHold.turn();
    const storage = await getSession({ createIfNone: false }).catch(() => null);
    if (!storage) return null;
    const s = await sameAccountSession(FABRIC_AUDIENCES[0], createIfNone, storage);
    const token = s ? s.accessToken : null;
    appHold.keep(asked, token);
    return token;
  }

  // The SQL endpoint's token (fabricmodel.js), for the same account as the storage session.
  const sqlHold = createTokenHold(TOKEN_TTL_MS);
  async function sqlToken({ fresh = false, createIfNone = false } = {}) {
    if (!fresh && !createIfNone && sqlHold.recent()) return sqlHold.recent();
    const asked = sqlHold.turn();
    const storage = await getSession({ createIfNone: false }).catch(() => null);
    if (!storage) return null;
    const s = await sameAccountSession(SQL_AUDIENCE, createIfNone, storage);
    const token = s ? s.accessToken : null;
    sqlHold.keep(asked, token);
    return token;
  }

  return {
    getSession, getToken, hostToken, fabricToken, appToken, sqlToken, forgetToken,
    signedOutByChoice, accountKey, queryAccountOf, knownAccount, rememberAccount,
    lastAuthError: () => lastAuthError,
    // VS Code owns the account, so this is all a Sign Out can do.
    markSignedOut: () => memento().update(SIGNED_OUT_KEY, true),
  };
}

module.exports = { createSignIn, SCOPES };
